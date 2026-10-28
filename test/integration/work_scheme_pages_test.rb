require File.expand_path('../../test_helper', __FILE__)

class RedmineWorkSchemePagesTest < Redmine::IntegrationTest
  fixtures :all

  teardown do
    Setting.where(name: 'plugin_redmine_work_scheme').delete_all
    Setting.clear_cache
  end

  test 'scheme page renders container with scheme data' do
    log_user 'admin', 'admin'
    get '/work_scheme'
    assert_response :success
    assert_select 'div.ws-container[data-work-scheme]'
    # modern-layout включён атрибутом на самом контейнере (страница и
    # dashboard-блок) — регрессия: атрибут был только в dev-превью
    assert_select 'div.ws-container[data-layout="modern"]'
    assert_select 'script.ws-data'
    assert_select 'div.ws-container[data-counts-url="/work_scheme/counts"]'
    assert_select 'div.ws-container[data-query-base-url="/issues"]'
    assert_match 'Заказчик', response.body
    assert_match 'Опытная эксплуатация', response.body
  end

  test 'scheme data script contains raw parseable JSON' do
    # Регрессия P0: <%= %> экранировал кавычки в &quot;, внутри <script> они не
    # декодируются и JSON.parse падал — схема не рисовалась на живом Redmine.
    log_user 'admin', 'admin'
    get '/work_scheme'
    assert_response :success
    script = response.body[/<script type="application\/json" class="ws-data">(.*?)<\/script>/m, 1]
    assert script.present?, 'ws-data script not found'
    assert_not script.include?('&quot;'), 'JSON inside <script> must not be HTML-escaped'
    data = JSON.parse(script)
    assert data['nodes'].any?
    assert_equal 'Заказчик', data['nodes'].first['title']
  end

  test 'scheme page hides editor link for non-admin' do
    log_user 'jsmith', 'jsmith'
    get '/work_scheme'
    assert_response :success
    assert_select 'div.ws-container[data-work-scheme]'
    assert_select 'div.ws-container[data-edit-url=""]'
  end

  test 'scheme page and counts endpoint are accessible anonymously' do
    # тест рассчитывает на публичный доступ; на инсталляции с принудительным
    # логином он был бы ложным — фиксируем настройку явно и восстанавливаем
    previous = Setting.login_required
    Setting.login_required = false
    get '/work_scheme'
    assert_response :success
    get '/work_scheme/counts?ids='
    assert_response :success
    assert_equal({}, JSON.parse(@response.body)['counts'])
  ensure
    Setting.login_required = previous
  end

  test 'stage page renders wiki text for node' do
    log_user 'admin', 'admin'
    get '/work_scheme/stages/analyze'
    assert_response :success
    assert_select 'h2', text: 'ОПИ: анализ ТЗ'
    assert_select 'div.wiki'
    assert_match /отдел программной инженерии/i, response.body
  end

  test 'unknown stage returns 404' do
    log_user 'admin', 'admin'
    get '/work_scheme/stages/nonexistent'
    assert_response :not_found
  end

  test 'node without page returns 404 and broken settings do not crash' do
    # Схема с узлом без страницы и с некорректным узлом без title:
    # страница этапа должна отдать 404, страница схемы — показать ошибки без краша
    Setting.plugin_redmine_work_scheme = {
      'json' => {
        'nodes' => [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0 }],
        'edges' => [],
        'scenarios' => []
      }.to_json
    }
    log_user 'admin', 'admin'
    get '/work_scheme/stages/a'
    assert_response :not_found

    Setting.plugin_redmine_work_scheme = { 'json' => '{ broken' }
    get '/work_scheme'
    assert_response :success
    assert_select 'div.flash.error'
  end

  test 'editor page redirects non-admin' do
    log_user 'jsmith', 'jsmith'
    get '/work_scheme/edit'
    assert_redirected_to '/work_scheme'
  end

  test 'editor page renders for admin' do
    log_user 'admin', 'admin'
    get '/work_scheme/edit'
    assert_response :success
    assert_select '#ws-editor'
    assert_select 'script.ws-data'
    assert_select '#ws-editor .ws-container[data-counts-url="/work_scheme/counts"]'
  end

  test 'editor back link returns to validated back path' do
    log_user 'admin', 'admin'
    # из блока дашборда: редактор получил back='/' — «К схеме» ведёт на дашборд
    get '/work_scheme/edit?back=%2F'
    assert_response :success
    assert_select "a[href='/']"
    get '/work_scheme/edit?back=%2Fprojects%2Fdemo'
    assert_response :success
    assert_select "a[href='/projects/demo']"
    # невалидный back (внешний хост, двойной слэш) отбрасывается
    get '/work_scheme/edit?back=//evil.com'
    assert_response :success
    assert_select "a[href='//evil.com']", count: 0
    assert_select "a[href='/work_scheme']"
  end

  test 'counts endpoint returns counts only for queries visible to user' do
    public_query = IssueQuery.create!(name: 'WS public query', visibility: Query::VISIBILITY_PUBLIC, user_id: 1)
    hidden_query = IssueQuery.create!(name: 'WS hidden query', visibility: Query::VISIBILITY_PRIVATE, user_id: 1)

    log_user 'jsmith', 'jsmith'
    get "/work_scheme/counts?ids=#{public_query.id},#{hidden_query.id},999999,abc"
    assert_response :success
    counts = JSON.parse(@response.body)['counts']
    assert counts.key?(public_query.id.to_s)
    assert_not counts.key?(hidden_query.id.to_s), 'чужой приватный запрос не должен считаться'
    assert_not counts.key?('999999')
    assert_not counts.key?('abc')
  end

  test 'counts endpoint returns private query for its owner' do
    hidden_query = IssueQuery.create!(name: 'WS hidden query', visibility: Query::VISIBILITY_PRIVATE, user_id: 1)

    log_user 'admin', 'admin'
    get "/work_scheme/counts?ids=#{hidden_query.id}"
    assert_response :success
    counts = JSON.parse(@response.body)['counts']
    assert counts.key?(hidden_query.id.to_s)
  end

  test 'counts endpoint returns empty counts for empty ids' do
    log_user 'jsmith', 'jsmith'
    get '/work_scheme/counts?ids='
    assert_response :success
    assert_equal({}, JSON.parse(@response.body)['counts'])
  end

  test 'counts endpoint accepts array-style ids and survives id flood' do
    public_query = IssueQuery.create!(name: 'WS public query', visibility: Query::VISIBILITY_PUBLIC, user_id: 1)
    overflow_query = IssueQuery.create!(name: 'WS overflow query', visibility: Query::VISIBILITY_PUBLIC, user_id: 1)
    flood = (1..150).map { |i| "99999999#{i}" }.join('&ids[]=')
    # существующие несуществующие id в диапазоне колонки: занимают слоты лимита
    far = 900_000_000_000
    slots = (1..100).map { |i| far + i }

    log_user 'jsmith', 'jsmith'
    get "/work_scheme/counts?ids[]=#{public_query.id}&ids[]=#{public_query.id}"
    assert_response :success
    counts = JSON.parse(@response.body)['counts']
    # query.issue_count считает для User.current; вне запроса он уже не jsmith,
    # поэтому эталон берём тем же методом модели и тем же пользователем
    User.current = User.find_by_login('jsmith')
    assert_equal public_query.issue_count, counts[public_query.id.to_s]
    User.current = nil

    get "/work_scheme/counts?ids[]=#{flood}"
    assert_response :success, 'flood of oversized ids must not produce 500'

    # лимит первых 100: 100 дальних id + валидный запрос 101-м — уже за лимитом
    get "/work_scheme/counts?ids[]=#{(slots + [overflow_query.id]).join('&ids[]=')}"
    assert_response :success
    counts = JSON.parse(@response.body)['counts']
    assert_not counts.key?(overflow_query.id.to_s), 'ids beyond the first 100 must be dropped'

    get "/work_scheme/counts?ids[]=#{(slots[0, 99] + [overflow_query.id, slots[99]]).join('&ids[]=')}"
    assert_response :success
    counts = JSON.parse(@response.body)['counts']
    assert counts.key?(overflow_query.id.to_s), 'id at position 100 must still be counted'
  end

  test 'save endpoint validates and stores scheme' do
    log_user 'admin', 'admin'
    new_scheme = {
      'nodes' => [{ 'id' => 's1', 'type' => 'start', 'title' => 'Старт редактора', 'x' => 10, 'y' => 10 }],
      'edges' => [],
      'scenarios' => []
    }.to_json
    post '/work_scheme/save', params: { json: new_scheme }
    assert_response :success
    assert_equal true, JSON.parse(@response.body)['ok']
    assert_match 'Старт редактора', Setting.plugin_redmine_work_scheme['json']

    # невалидная схема — 422 и ошибки, настройки не меняются
    post '/work_scheme/save', params: { json: '{"nodes": []}' }
    assert_response :unprocessable_entity
    assert JSON.parse(@response.body)['errors'].any?
    assert_match 'Старт редактора', Setting.plugin_redmine_work_scheme['json']
  end

  test 'save endpoint rejects oversized scheme before hitting the DB' do
    # колонка settings.value — TEXT (64 КБ в MySQL): лимит должен отсекать
    # раньше записи, иначе на не-strict MySQL JSON тихо обрезался бы
    log_user 'admin', 'admin'
    big_scheme = {
      'nodes' => [{ 'id' => 'big', 'type' => 'start', 'title' => 'Большая схема', 'description' => 'x' * 70_000 }],
      'edges' => [],
      'scenarios' => []
    }.to_json
    assert_operator big_scheme.bytesize, :>, 64 * 1024
    post '/work_scheme/save', params: { json: big_scheme }
    assert_response :unprocessable_entity
    assert JSON.parse(@response.body)['errors'].any?
  end

  test 'save endpoint rejects non-admin' do
    log_user 'jsmith', 'jsmith'
    post '/work_scheme/save', params: { json: '{"nodes": []}' }
    assert_response :forbidden
  end
  test 'collection save renders viewer editor settings and scoped stage pages' do
    log_user 'admin', 'admin'
    main = JSON.parse(RedmineWorkScheme::DefaultScheme.json)
    extra = JSON.parse(RedmineWorkScheme::DefaultScheme.json)
    extra['nodes'].find { |n| n['id'] == 'analyze' }['page'] = 'Support-only description'
    raw = { 'schemes' => [
      { 'id' => 'main', 'title' => 'Main', 'json' => main },
      { 'id' => 'support', 'title' => 'Support', 'json' => extra }
    ] }
    post '/work_scheme/save', params: { json: raw.to_json }
    assert_response :success
    ['/work_scheme', '/work_scheme/edit'].each do |url|
      get url
      assert_response :success
      script = response.body[/<script type="application\/json" class="ws-data">(.*?)<\/script>/m, 1]
      data = JSON.parse(script)
      assert_equal 2, data['schemes'].size
      assert data['schemes'].last['json']['nodes'].any?
    end
    get '/settings/plugin/redmine_work_scheme'
    assert_response :success
    assert_select 'div.flash.error', count: 0
    get '/work_scheme/stages/support/analyze'
    assert_response :success
    assert_match 'Support-only description', response.body
    get '/work_scheme/stages/analyze'
    assert_response :success
    assert_not response.body.include?('Support-only description')
    get '/work_scheme/stages/missing/analyze'
    assert_response :not_found
    get '/work_scheme/stages/support/missing'
    assert_response :not_found
    stored = Setting.plugin_redmine_work_scheme['json']
    raw['schemes'][1]['json']['nodes'] = []
    post '/work_scheme/save', params: { json: raw.to_json }
    assert_response :unprocessable_entity
    assert_equal stored, Setting.plugin_redmine_work_scheme['json']
  end

  test 'collection total size is limited' do
    log_user 'admin', 'admin'
    main = JSON.parse(RedmineWorkScheme::DefaultScheme.json)
    main['nodes'].first['description'] = 'x' * 32_000
    raw = { 'schemes' => [{ 'id' => 'main', 'json' => main }, { 'id' => 'extra', 'json' => main }] }
    post '/work_scheme/save', params: { json: raw.to_json }
    assert_response :unprocessable_entity
  end

end
