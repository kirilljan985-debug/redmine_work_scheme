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
    DEFAULT_NODE_WIDTH = 140
    DEFAULT_NODE_HEIGHT = 56

    module_function

    # Возвращает {data: нормализованная схема или nil, errors: [строки]}
    def parse(json_string)
      str = json_string.to_s
      return result(nil, [I18n_error(:ws_error_empty)]) if str.strip.empty?

      raw =
        begin
          JSON.parse(str)
        rescue JSON::ParserError => e
          return result(nil, [format(I18n_error(:ws_error_invalid_json), message: e.message)])
        end
      return result(nil, [I18n_error(:ws_error_not_object)]) unless raw.is_a?(Hash)

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
            'nodes' => nodes,
            'edges' => edges,
            'scenarios' => scenarios
          },
          []
        )
      end
    rescue StandardError => e
      result(nil, [format(I18n_error(:ws_error_unexpected), message: e.message)])
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
        errors << I18n_error(:ws_error_no_nodes)
        return []
      end

      seen = {}
      raw_nodes.each_with_index.map do |raw, index|
        unless raw.is_a?(Hash)
          errors << format(I18n_error(:ws_error_node_not_object), index: index + 1)
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
        errors << format(I18n_error(:ws_error_node_no_id), index: index + 1)
        return nil
      end
      unless id =~ /\A[A-Za-z0-9_-]+\z/
        errors << format(I18n_error(:ws_error_node_bad_id), id: id)
        return nil
      end
      if seen[id]
        errors << format(I18n_error(:ws_error_node_dup_id), id: id)
        return nil
      end

      type = raw['type'].to_s.strip
      type = 'process' if type.empty?
      unless NODE_TYPES.include?(type)
        errors << format(I18n_error(:ws_error_node_bad_type), id: id, type: type)
        return nil
      end

      title = raw['title'].to_s.strip
      if title.empty?
        errors << format(I18n_error(:ws_error_node_no_title), id: id)
        return nil
      end

      {
        'id' => id,
        'type' => type,
        'title' => title,
        'dept' => raw['dept'].to_s.strip,
        'description' => raw['description'].to_s.strip,
        'page' => raw['page'].to_s,
        'url' => raw['url'].to_s.strip,
        'icon' => ICONS.include?(raw['icon'].to_s.strip) ? raw['icon'].to_s.strip : '',
        'query_id' => positive_int_or_nil(raw['query_id']),
        'font_size' => text_size(raw['font_size'], 12),
        'font_weight' => TEXT_WEIGHTS.include?(raw['font_weight'].to_s) ? raw['font_weight'].to_s : 'normal',
        'font_family' => TEXT_FAMILIES.include?(raw['font_family'].to_s) ? raw['font_family'].to_s : 'sans-serif',
        'text_color' => normalize_text_color(raw['text_color'], errors, index, :node),
        'x' => int_value(raw['x'], 0),
        'y' => int_value(raw['y'], 0),
        'w' => int_value(raw['w'], DEFAULT_NODE_WIDTH),
        'h' => int_value(raw['h'], DEFAULT_NODE_HEIGHT)
      }
    end

    def normalize_edges(raw_edges, nodes, errors)
      return [] if raw_edges.nil?
      unless raw_edges.is_a?(Array)
        errors << I18n_error(:ws_error_edges_not_array)
        return []
      end

      ids = nodes.map { |n| n['id'] }
      raw_edges.each_with_index.map do |raw, index|
        unless raw.is_a?(Hash)
          errors << format(I18n_error(:ws_error_edge_not_object), index: index + 1)
          next nil
        end
        from = raw['from'].to_s.strip
        to = raw['to'].to_s.strip
        unless ids.include?(from) && ids.include?(to)
          errors << format(I18n_error(:ws_error_edge_bad_nodes), index: index + 1, from: from, to: to)
          next nil
        end
        from_side = normalize_side(raw['from_side'])
        to_side = normalize_side(raw['to_side'])
        if from_side == :invalid || to_side == :invalid
          errors << format(I18n_error(:ws_error_edge_bad_side),
                           index: index + 1, side: from_side == :invalid ? raw['from_side'] : raw['to_side'])
          next nil
        end
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
          'dashed' => raw['dashed'] == true,
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
        errors << I18n_error(:ws_error_scenarios_not_array)
        return []
      end

      ids = nodes.map { |n| n['id'] }
      seen = {}
      raw_scenarios.each_with_index.map do |raw, index|
        unless raw.is_a?(Hash)
          errors << format(I18n_error(:ws_error_scenario_not_object), index: index + 1)
          next nil
        end
        id = raw['id'].to_s.strip
        steps = raw['steps'].is_a?(Array) ? raw['steps'].map { |s| s.to_s.strip } : []
        unknown = steps.reject { |s| ids.include?(s) }
        if id.empty? || raw['title'].to_s.strip.empty? || steps.empty? || unknown.any?
          errors << format(I18n_error(:ws_error_scenario_invalid), index: index + 1, unknown: unknown.join(', '))
          next nil
        end
        if seen[id]
          errors << format(I18n_error(:ws_error_scenario_dup_id), id: id)
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

    def normalize_color(value, errors, index)
      color = value.to_s.strip
      return '' if color.empty?
      return color if color =~ /\A#[0-9a-fA-F]{6}\z/

      errors << format(I18n_error(:ws_error_edge_bad_color), index: index + 1)
      ''
    end

    def normalize_text_color(value, errors, index, kind)
      color = value.to_s.strip
      return '' if color.empty?
      return color if color =~ /\A#[0-9a-fA-F]{6}\z/

      errors << format(I18n_error(:ws_error_bad_text_color), index: index + 1, kind: kind == :node ? 'узла' : 'связи')
      ''
    end

    def text_size(value, default)
      size = int_value(value, default)
      [[size, 8].max, 32].min
    end

    def positive_int_or_nil(value)
      int = int_value(value, 0)
      int.positive? ? int : nil
    end

    def int_value(value, default)
      case value
      when Integer then value
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
      'ws_error_edges_not_array' => '"edges" должен быть массивом.',
      'ws_error_edge_not_object' => 'Связь №%{index} — не объект.',
      'ws_error_edge_bad_nodes' => 'Связь №%{index} ссылается на неизвестные узлы (from: "%{from}", to: "%{to}").',
      'ws_error_edge_bad_side' => 'Связь №%{index}: недопустимая сторона "%{side}" (допустимо: left, right, top, bottom или пусто).',
      'ws_error_edge_bad_color' => 'Связь №%{index}: цвет должен быть в формате #RRGGBB или пустым.',
      'ws_error_bad_text_color' => 'Элемент №%{index} (%{kind}): цвет текста должен быть в формате #RRGGBB или пустым.',
      'ws_error_scenarios_not_array' => '"scenarios" должен быть массивом.',
      'ws_error_scenario_not_object' => 'Сценарий №%{index} — не объект.',
      'ws_error_scenario_invalid' => 'Сценарий №%{index} заполнен неверно (нужны id, title и steps существующих узлов; неизвестные узлы: %{unknown}).',
      'ws_error_scenario_dup_id' => 'Дубликат сценария "%{id}".'
    }.freeze

    def I18n_error(key)
      MESSAGES[key.to_s] || key.to_s
    end

    def format(template, values)
      template.gsub(/%\{(\w+)\}/) { values[$1.to_sym].to_s }
    end
  end
end
