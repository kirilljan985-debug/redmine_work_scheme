# frozen_string_literal: true

require 'json'

module RedmineWorkScheme
  # Разбор и валидация схемы из настроек плагина (JSON-строка).
  # Чистая логика без Rails-зависимостей — покрывается обычным minitest.
  module Scheme
    NODE_TYPES = %w(start process decision end).freeze
    EDGE_SIDES = %w(left right top bottom).freeze
    EDGE_ROUTES = %w(straight arc elbow u).freeze
    ICONS = %w(user document search decision certificate gear rocket).freeze
    TEXT_FAMILIES = %w(sans-serif serif monospace).freeze
    TEXT_WEIGHTS = %w(normal bold).freeze
    THEMES = %w(classic ocean graphite warm paper).freeze
    # Качество отрисовки: auto — эвристика+адаптация на клиенте, high/lite —
    # жёсткое указание (lite отключает фильтры/анимации и хвост маркера).
    PERFORMANCE_MODES = %w(auto high lite).freeze
    DEFAULT_NODE_WIDTH = 140
    DEFAULT_NODE_HEIGHT = 56
    # Нижняя граница геометрии: нулевой/отрицательный размер даёт невидимый
    # rect и NaN в анимации проигрывания (длина пути 0).
    MIN_NODE_SIZE = 20
    # Коллекция схем: максимум записей в wrapper {"schemes": [...]}; лимит
    # общего размера строки — на контроллере (MAX_SCHEME_KB).
    MAX_SCHEMES = 10

    module_function

    # Единый источник схемы из настроек плагина: страница, блок 4.7+ и
    # legacy-блок 4.6 читают одинаково. Пустое значение отдаёт схему по
    # умолчанию; битый JSON возвращается как есть (errors + data: nil) —
    # страница и блок показывают ошибку админу, а не молча подменяют схему.
    # Коллекция из нескольких схем отдаётся как wrapper {"schemes": [...]};
    # одиночная схема (в т.ч. единственная запись коллекции) — как раньше.
    def from_settings
      setting = Setting.plugin_redmine_work_scheme
      setting = setting['json'] if setting.is_a?(Hash)
      json = setting.to_s.strip.empty? ? RedmineWorkScheme::DefaultScheme.json : setting
      parsed = parse_collection(json)
      return parsed if parsed[:errors].any? || parsed[:collection].nil?

      data = parsed[:collection].size == 1 ? parsed[:collection][0]['data'] : wrapper_data(parsed[:collection])
      result(data, [])
    rescue StandardError
      parse(RedmineWorkScheme::DefaultScheme.json)
    end

    # Коллекция без свёртки одиночной записи: страница этапа ищет узел по
    # scheme_id (маршрут stages/:scheme_id/:id), легаси-ссылки — без него.
    def from_settings_collection
      setting = Setting.plugin_redmine_work_scheme
      setting = setting['json'] if setting.is_a?(Hash)
      json = setting.to_s.strip.empty? ? RedmineWorkScheme::DefaultScheme.json : setting
      parse_collection(json)
    rescue StandardError
      parse_collection(RedmineWorkScheme::DefaultScheme.json)
    end

    # Возвращает {data: нормализованная схема или nil, errors: [строки]}
    def parse(json_string)
      str = json_string.to_s
      return result(nil, [message_for(:ws_error_empty)]) if str.strip.empty?

      raw =
        begin
          JSON.parse(str)
        rescue JSON::ParserError => e
          return result(nil, [interpolate(message_for(:ws_error_invalid_json), message: e.message)])
        end
      normalize_raw(raw)
    rescue StandardError => e
      result(nil, [interpolate(message_for(:ws_error_unexpected), message: e.message)])
    end

    # Коллекция схем: одиночная схема оборачивается в одну запись (id "main",
    # legacy-ссылки stages/:id ведут на неё), wrapper {"schemes": [...]}
    # разбирается поэлементно. All-or-nothing: одна битая схема — ошибка всей
    # коллекции (иначе молча пропала бы часть вкладок).
    def parse_collection(json_string)
      str = json_string.to_s
      return result(nil, [message_for(:ws_error_empty)]) if str.strip.empty?

      raw =
        begin
          JSON.parse(str)
        rescue JSON::ParserError => e
          return result(nil, [interpolate(message_for(:ws_error_invalid_json), message: e.message)])
        end
      return result(nil, [message_for(:ws_error_not_object)]) unless raw.is_a?(Hash)

      return parse_collection_raw(raw) if raw.key?('schemes')

      parsed = normalize_raw(raw)
      return result(nil, parsed[:errors]) if parsed[:errors].any?

      { collection: [{ 'id' => 'main', 'title' => parsed[:data]['title'], 'data' => parsed[:data] }], errors: [] }
    rescue StandardError => e
      result(nil, [interpolate(message_for(:ws_error_unexpected), message: e.message)])
    end

    def normalize_raw(raw)
      return result(nil, [message_for(:ws_error_not_object)]) unless raw.is_a?(Hash)

      errors = []
      nodes = normalize_nodes(raw['nodes'], errors)
      edges = normalize_edges(raw['edges'], nodes, errors)
      scenarios = normalize_scenarios(raw['scenarios'], nodes, errors)
      if errors.any?
        result(nil, errors)
      else
        result(
          {
            'title' => raw['title'].to_s.strip,
            'theme' => THEMES.include?(raw['theme'].to_s) ? raw['theme'].to_s : 'classic',
            'performance' => PERFORMANCE_MODES.include?(raw['performance'].to_s) ? raw['performance'].to_s : 'auto',
            'nodes' => nodes,
            'edges' => edges,
            'scenarios' => scenarios
          },
          []
        )
      end
    end

    def parse_collection_raw(raw)
      unless raw['schemes'].is_a?(Array)
        return result(nil, [message_for(:ws_error_schemes_not_array)])
      end
      if raw.key?('nodes') || raw.key?('edges')
        return result(nil, [message_for(:ws_error_scheme_mixed)])
      end
      list = raw['schemes']
      return result(nil, [message_for(:ws_error_schemes_empty)]) if list.empty?
      if list.size > MAX_SCHEMES
        return result(nil, [interpolate(message_for(:ws_error_schemes_too_many), limit: MAX_SCHEMES)])
      end

      errors = []
      seen = {}
      entries = []
      list.each_with_index do |item, index|
        unless item.is_a?(Hash)
          errors << interpolate(message_for(:ws_error_scheme_item_not_object), index: index + 1)
          next
        end
        unless item['title'].nil? || item['title'].is_a?(String)
          errors << 'Название схемы должно быть строкой.'
          next
        end
        id = item['id'].to_s.strip
        if id.empty?
          errors << interpolate(message_for(:ws_error_scheme_item_no_id), index: index + 1)
          next
        end
        unless id =~ /\A[A-Za-z0-9_-]+\z/
          errors << interpolate(message_for(:ws_error_scheme_item_bad_id), id: id)
          next
        end
        if seen[id]
          errors << interpolate(message_for(:ws_error_scheme_item_dup_id), id: id)
          next
        end

        parsed =
          if item['json'].is_a?(Hash)
            normalize_raw(item['json'])
          elsif item['json'].is_a?(String)
            parse(item['json'])
          else
            result(nil, [interpolate(message_for(:ws_error_scheme_item_no_json), id: id)])
          end
        if parsed[:errors].any?
          title = item['title'].to_s.strip
          title = id if title.empty?
          parsed[:errors].each do |message|
            errors << interpolate(message_for(:ws_error_scheme_item_invalid), title: title, message: message)
          end
          next
        end

        seen[id] = true
        title = item['title'].to_s.strip
        title = parsed[:data]['title'] if title.empty?
        title = "Схема #{index + 1}" if title.empty?
        parsed[:data]['title'] = title
        entries << { 'id' => id, 'title' => title, 'data' => parsed[:data] }
      end
      if entries.any? && entries.first['id'] != 'main'
        errors << 'Первая схема коллекции должна иметь id "main".'
      end
      errors.any? ? result(nil, errors) : { collection: entries, errors: [] }
    end

    # Wrapper-данные коллекции для встраивания в страницу (та же форма, что
    # хранится в настройках и постит редактор).
    def wrapper_data(collection)
      { 'schemes' => collection.map { |entry| { 'id' => entry['id'], 'title' => entry['title'], 'json' => entry['data'] } } }
    end

    # Узел из коллекции: scheme_id задаётся маршрутом stages/:scheme_id/:id
    # для доп-схем; пустой — первая запись; неизвестный — nil (легаси-ссылки
    # stages/:id всегда указывают на первую схему).
    def collection_node(collection, scheme_id, node_id)
      return nil unless collection.is_a?(Array) && collection.any?
      entry = collection.find { |e| e['id'] == scheme_id } unless scheme_id.to_s.empty?
      entry = collection.first if scheme_id.to_s.empty?
      return nil unless entry
      node(entry['data'], node_id)
    end

    # Узел по id (nil, если нет)
    def node(data, id)
      return nil unless data.is_a?(Hash)
      data['nodes'].find { |n| n['id'] == id }
    end

    # Исходящие связи узла
    def outgoing_edges(data, id)
      return [] unless data.is_a?(Hash)
      data['edges'].select { |e| e['from'] == id }
    end

    # Сценарий по id
    def scenario(data, id)
      return nil unless data.is_a?(Hash)
      data['scenarios'].find { |s| s['id'] == id }
    end

    # JSON для встраивания в страницу: экранируем "</" чтобы не сломать <script>
    def safe_json(data)
      data.to_json.gsub('<', '\u003c')
    end

    def normalize_nodes(raw_nodes, errors)
      unless raw_nodes.is_a?(Array) && raw_nodes.any?
        errors << message_for(:ws_error_no_nodes)
        return []
      end

      seen = {}
      raw_nodes.each_with_index.map do |raw, index|
        unless raw.is_a?(Hash)
          errors << interpolate(message_for(:ws_error_node_not_object), index: index + 1)
          next nil
        end
        node = normalize_node(raw, index, seen, errors)
        seen[node['id']] = true if node
        node
      end.compact
    end

    def normalize_node(raw, index, seen, errors)
      id = raw['id'].to_s.strip
      if id.empty?
        errors << interpolate(message_for(:ws_error_node_no_id), index: index + 1)
        return nil
      end
      unless id =~ /\A[A-Za-z0-9_-]+\z/
        errors << interpolate(message_for(:ws_error_node_bad_id), id: id)
        return nil
      end
      if seen[id]
        errors << interpolate(message_for(:ws_error_node_dup_id), id: id)
        return nil
      end

      type = raw['type'].to_s.strip
      type = 'process' if type.empty?
      unless NODE_TYPES.include?(type)
        errors << interpolate(message_for(:ws_error_node_bad_type), id: id, type: type)
        return nil
      end

      title = raw['title'].to_s.strip
      if title.empty?
        errors << interpolate(message_for(:ws_error_node_no_title), id: id)
        return nil
      end

      url = raw['url'].to_s.strip
      # Допустимы http(s)-ссылки и адреса от корня сайта (например, Wiki);
      # protocol-relative "//host" ведёт на чужой домен — тоже отклоняем,
      # как и javascript:/data: — это href клика по узлу.
      unless url.empty? || url =~ %r{\Ahttps?://}i ||
             (url.start_with?('/') && !url.start_with?('//'))
        errors << interpolate(message_for(:ws_error_node_bad_url), id: id, url: url)
        return nil
      end

      {
        'id' => id,
        'type' => type,
        'title' => title,
        'dept' => raw['dept'].to_s.strip,
        'description' => raw['description'].to_s.strip,
        'page' => raw['page'].to_s,
        'url' => url,
        'icon' => ICONS.include?(raw['icon'].to_s.strip) ? raw['icon'].to_s.strip : '',
        'query_id' => positive_int_or_nil(raw['query_id']),
        'font_size' => text_size(raw['font_size'], 12),
        'font_weight' => TEXT_WEIGHTS.include?(raw['font_weight'].to_s) ? raw['font_weight'].to_s : 'normal',
        'font_family' => TEXT_FAMILIES.include?(raw['font_family'].to_s) ? raw['font_family'].to_s : 'sans-serif',
        'text_color' => normalize_text_color(raw['text_color'], errors, index, :node),
        'x' => int_value(raw['x'], 0),
        'y' => int_value(raw['y'], 0),
        'w' => [int_value(raw['w'], DEFAULT_NODE_WIDTH), MIN_NODE_SIZE].max,
        'h' => [int_value(raw['h'], DEFAULT_NODE_HEIGHT), MIN_NODE_SIZE].max
      }
    end

    def normalize_edges(raw_edges, nodes, errors)
      return [] if raw_edges.nil?
      unless raw_edges.is_a?(Array)
        errors << message_for(:ws_error_edges_not_array)
        return []
      end

      ids = nodes.map { |n| n['id'] }
      seen_pairs = {}
      raw_edges.each_with_index.map do |raw, index|
        unless raw.is_a?(Hash)
          errors << interpolate(message_for(:ws_error_edge_not_object), index: index + 1)
          next nil
        end
        from = raw['from'].to_s.strip
        to = raw['to'].to_s.strip
        unless ids.include?(from) && ids.include?(to)
          errors << interpolate(message_for(:ws_error_edge_bad_nodes), index: index + 1, from: from, to: to)
          next nil
        end
        from_side = normalize_side(raw['from_side'])
        to_side = normalize_side(raw['to_side'])
        if from_side == :invalid || to_side == :invalid
          errors << interpolate(message_for(:ws_error_edge_bad_side),
                           index: index + 1, side: from_side == :invalid ? raw['from_side'] : raw['to_side'])
          next nil
        end
        # Повтор пары ломает проигрывание: путь ребра перезаписывается последним.
        # Пара регистрируется после по-рёберных проверок — отброшенное ребро
        # не должно давать второму такому же ложную ошибку «повтор связи».
        if seen_pairs.key?("#{from}>#{to}")
          errors << interpolate(message_for(:ws_error_edge_dup), index: index + 1, from: from, to: to)
          next nil
        end
        seen_pairs["#{from}>#{to}"] = true
        route = raw['route'].to_s.strip
        route = 'straight' unless EDGE_ROUTES.include?(route)
        bend = int_value(raw['bend'], 50)
        bend = 0 if bend.negative?
        bend = 200 if bend > 200
        {
          'from' => from,
          'to' => to,
          'label' => raw['label'].to_s.strip,
          'color' => normalize_color(raw['color'], errors, index),
          'label_font_size' => text_size(raw['label_font_size'], 11),
          'label_font_weight' => TEXT_WEIGHTS.include?(raw['label_font_weight'].to_s) ? raw['label_font_weight'].to_s : 'normal',
          'label_font_family' => TEXT_FAMILIES.include?(raw['label_font_family'].to_s) ? raw['label_font_family'].to_s : 'sans-serif',
          'label_text_color' => normalize_text_color(raw['label_text_color'], errors, index, :edge),
          'dashed' => normalize_dashed(raw['dashed'], errors, index),
          'route' => route,
          'from_side' => from_side,
          'to_side' => to_side,
          'bend' => bend
        }
      end.compact
    end

    def normalize_scenarios(raw_scenarios, nodes, errors)
      return [] if raw_scenarios.nil?
      unless raw_scenarios.is_a?(Array)
        errors << message_for(:ws_error_scenarios_not_array)
        return []
      end

      ids = nodes.map { |n| n['id'] }
      seen = {}
      raw_scenarios.each_with_index.map do |raw, index|
        unless raw.is_a?(Hash)
          errors << interpolate(message_for(:ws_error_scenario_not_object), index: index + 1)
          next nil
        end
        id = raw['id'].to_s.strip
        steps = raw['steps'].is_a?(Array) ? raw['steps'].map { |s| s.to_s.strip } : []
        unknown = steps.reject { |s| ids.include?(s) }
        if id.empty? || raw['title'].to_s.strip.empty? || steps.empty? || unknown.any?
          errors << interpolate(message_for(:ws_error_scenario_invalid), index: index + 1, unknown: unknown.join(', '))
          next nil
        end
        # Тот же формат, что у id узлов: id попадает в data-атрибуты и
        # подсказки редактора — произвольные символы там не предусмотрены.
        unless id =~ /\A[A-Za-z0-9_-]+\z/
          errors << interpolate(message_for(:ws_error_scenario_bad_id), id: id)
          next nil
        end
        if seen[id]
          errors << interpolate(message_for(:ws_error_scenario_dup_id), id: id)
          next nil
        end
        seen[id] = true
        {
          'id' => id,
          'title' => raw['title'].to_s.strip,
          'steps' => steps
        }
      end.compact
    end

    def normalize_side(value)
      side = value.to_s.strip.downcase
      return '' if side.empty?
      EDGE_SIDES.include?(side) ? side : :invalid
    end

    # Булево поле; строковые "true"/"false" принимаем (JSON часто правят
    # руками), остальное — явная ошибка вместо молчаливого false.
    def normalize_dashed(value, errors, index)
      return true if value == true
      return false if value.nil? || value == false
      normalized = value.to_s.strip.downcase
      return normalized == 'true' if %w(true false).include?(normalized)
      errors << interpolate(message_for(:ws_error_edge_bad_dashed), index: index + 1)
      false
    end

    def normalize_color(value, errors, index)
      color = value.to_s.strip
      return '' if color.empty?
      return color if color =~ /\A#[0-9a-fA-F]{6}\z/

      errors << interpolate(message_for(:ws_error_edge_bad_color), index: index + 1)
      ''
    end

    def normalize_text_color(value, errors, index, kind)
      color = value.to_s.strip
      return '' if color.empty?
      return color if color =~ /\A#[0-9a-fA-F]{6}\z/

      key = kind == :node ? :ws_error_bad_text_color_node : :ws_error_bad_text_color_edge
      errors << interpolate(message_for(key), index: index + 1)
      ''
    end

    def text_size(value, default)
      size = int_value(value, default)
      [[size, 8].max, 32].min
    end

    # Верхняя граница отсекает значения вне диапазона колонки БД, чтобы
    # query_id из конфига не ломал find_by в counts.
    def positive_int_or_nil(value)
      int = int_value(value, 0)
      int.positive? && int <= 999_999_999 ? int : nil
    end

    def int_value(value, default)
      case value
      when Integer then value
      when Numeric then value.round
      when String then value.strip =~ /\A-?\d+\z/ ? value.strip.to_i : default
      else default
      end
    end

    def result(data, errors)
      { data: data, errors: errors }
    end

    # Валидатор не зависит от Rails; тексты ошибок берём из замороженных
    # русских строк, чтобы parse можно было звать без I18n-окружения.
    MESSAGES = {
      'ws_error_empty' => 'Схема не задана.',
      'ws_error_invalid_json' => 'Некорректный JSON: %{message}',
      'ws_error_not_object' => 'JSON должен быть объектом.',
      'ws_error_unexpected' => 'Неожиданная ошибка: %{message}',
      'ws_error_no_nodes' => 'В схеме нет узлов (массив "nodes").',
      'ws_error_node_not_object' => 'Узел №%{index} — не объект.',
      'ws_error_node_no_id' => 'Узел №%{index} без поля "id".',
      'ws_error_node_bad_id' => 'Узел "%{id}": id может содержать только латиницу, цифры, "-" и "_".',
      'ws_error_node_dup_id' => 'Дубликат узла "%{id}".',
      'ws_error_node_bad_type' => 'Узел "%{id}": недопустимый тип "%{type}" (допустимо: start, process, decision, end).',
      'ws_error_node_no_title' => 'Узел "%{id}" без поля "title".',
      'ws_error_node_bad_url' => 'Узел "%{id}": url должен начинаться с http://, https:// или "/" (задано: "%{url}").',
      'ws_error_edges_not_array' => '"edges" должен быть массивом.',
      'ws_error_edge_not_object' => 'Стрелка №%{index} — не объект.',
      'ws_error_edge_bad_nodes' => 'Стрелка №%{index} ссылается на неизвестные узлы (from: "%{from}", to: "%{to}").',
      'ws_error_edge_dup' => 'Стрелка №%{index}: повтор стрелки "%{from}" → "%{to}".',
      'ws_error_edge_bad_side' => 'Стрелка №%{index}: недопустимая сторона "%{side}" (допустимо: left, right, top, bottom или пусто).',
      'ws_error_edge_bad_color' => 'Стрелка №%{index}: цвет должен быть в формате #RRGGBB или пустым.',
      'ws_error_edge_bad_dashed' => 'Стрелка №%{index}: dashed должен быть true или false (допускаются строковые "true"/"false").',
      'ws_error_bad_text_color_node' => 'Узел №%{index}: цвет текста должен быть в формате #RRGGBB или пустым.',
      'ws_error_bad_text_color_edge' => 'Стрелка №%{index}: цвет текста должен быть в формате #RRGGBB или пустым.',
      'ws_error_scenarios_not_array' => '"scenarios" должен быть массивом.',
      'ws_error_scenario_not_object' => 'Сценарий №%{index} — не объект.',
      'ws_error_scenario_invalid' => 'Сценарий №%{index} заполнен неверно (нужны id, title и steps существующих узлов; неизвестные узлы: %{unknown}).',
      'ws_error_scenario_bad_id' => 'Сценарий "%{id}": id может содержать только латиницу, цифры, "-" и "_".',
      'ws_error_scenario_dup_id' => 'Дубликат сценария "%{id}".',
      'ws_error_schemes_not_array' => '"schemes" должен быть массивом.',
      'ws_error_schemes_empty' => 'В коллекции нет ни одной схемы.',
      'ws_error_schemes_too_many' => 'Схем в коллекции больше %{limit}.',
      'ws_error_scheme_mixed' => 'Нельзя смешивать "schemes" с полями одиночной схемы ("nodes"/"edges").',
      'ws_error_scheme_item_not_object' => 'Элемент №%{index} коллекции — не объект.',
      'ws_error_scheme_item_no_id' => 'Элемент №%{index} коллекции без поля "id".',
      'ws_error_scheme_item_bad_id' => 'Схема "%{id}": id может содержать только латиницу, цифры, "-" и "_".',
      'ws_error_scheme_item_dup_id' => 'Дубликат id схемы "%{id}".',
      'ws_error_scheme_item_no_json' => 'Схема "%{id}": нет поля "json" с самой схемой.',
      'ws_error_scheme_item_invalid' => 'Схема "%{title}": %{message}'
    }.freeze

    def message_for(key)
      MESSAGES[key.to_s] || key.to_s
    end

    def interpolate(template, values)
      template.gsub(/%\{(\w+)\}/) { values[$1.to_sym].to_s }
    end
  end
end
