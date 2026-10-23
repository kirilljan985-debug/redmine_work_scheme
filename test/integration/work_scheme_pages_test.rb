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
    assert_select 'script.ws-data'
    assert_match 'Заказчик', response.body
    assert_match 'Опытная эксплуатация', response.body
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

  test 'save endpoint rejects non-admin' do
    log_user 'jsmith', 'jsmith'
    post '/work_scheme/save', params: { json: '{"nodes": []}' }
    assert_response :forbidden
  end
end
