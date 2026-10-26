require File.expand_path('../../test_helper', __FILE__)

class RedmineWorkSchemeSchemeTest < ActiveSupport::TestCase
  test 'parses default scheme without errors' do
    parsed = RedmineWorkScheme::Scheme.parse(RedmineWorkScheme::DefaultScheme.json)
    assert_empty parsed[:errors]
    assert_not_nil parsed[:data]
    assert_equal 10, parsed[:data]['nodes'].length
    assert_equal 10, parsed[:data]['edges'].length
    assert_equal 3, parsed[:data]['scenarios'].length
  end

  test 'empty scheme returns error' do
    parsed = RedmineWorkScheme::Scheme.parse('')
    assert_nil parsed[:data]
    assert parsed[:errors].any?
  end

  test 'broken json returns error' do
    parsed = RedmineWorkScheme::Scheme.parse('{ not json')
    assert_nil parsed[:data]
    assert parsed[:errors].first.include?('JSON')
  end

  test 'non-object json returns error' do
    parsed = RedmineWorkScheme::Scheme.parse('[1,2]')
    assert_nil parsed[:data]
    assert parsed[:errors].any?
  end

  test 'duplicate node id returns error' do
    json = valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0 },
       { 'id' => 'a', 'title' => 'A2', 'x' => 10, 'y' => 10 }]
    )
    parsed = RedmineWorkScheme::Scheme.parse(json)
    assert parsed[:errors].first.include?('a')
  end

  test 'edge to unknown node returns error' do
    json = valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0 }],
      [{ 'from' => 'a', 'to' => 'ghost' }]
    )
    parsed = RedmineWorkScheme::Scheme.parse(json)
    assert parsed[:errors].any? { |e| e.include?('ghost') }
  end

  test 'invalid node type returns error' do
    json = valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'type' => 'cloud', 'title' => 'A', 'x' => 0, 'y' => 0 }]
    )
    parsed = RedmineWorkScheme::Scheme.parse(json)
    assert parsed[:errors].any? { |e| e.include?('cloud') }
  end

  test 'defaults are applied' do
    json = valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => '12', 'y' => 30 }],
      [{ 'from' => 'a', 'to' => 'a' }]
    )
    parsed = RedmineWorkScheme::Scheme.parse(json)
    assert_empty parsed[:errors]
    node = parsed[:data]['nodes'].first
    assert_equal 'process', node['type']
    assert_equal RedmineWorkScheme::Scheme::DEFAULT_NODE_WIDTH, node['w']
    assert_equal RedmineWorkScheme::Scheme::DEFAULT_NODE_HEIGHT, node['h']
    assert_equal 12, node['font_size']
    assert_equal 'normal', node['font_weight']
    assert_equal 'sans-serif', node['font_family']
    assert_nil node['query_id']
    edge = parsed[:data]['edges'].first
    assert_equal false, edge['dashed']
    assert_equal 'straight', edge['route']
    assert_equal '', edge['from_side']
    assert_equal '', edge['to_side']
    assert_equal '', edge['color']
  end

  test 'node and edge text styles are normalized' do
    parsed = RedmineWorkScheme::Scheme.parse({
      'nodes' => [{ 'id' => 'a', 'title' => 'A', 'font_size' => 40, 'font_weight' => 'bold', 'font_family' => 'serif', 'text_color' => '#123456' }],
      'edges' => [{ 'from' => 'a', 'to' => 'a', 'label' => 'L', 'label_font_size' => 8, 'label_font_weight' => 'bold', 'label_font_family' => 'monospace', 'label_text_color' => '#abcdef' }],
      'scenarios' => []
    }.to_json)
    assert_empty parsed[:errors]
    node = parsed[:data]['nodes'].first
    edge = parsed[:data]['edges'].first
    assert_equal 32, node['font_size']
    assert_equal 'serif', node['font_family']
    assert_equal '#123456', node['text_color']
    assert_equal 8, edge['label_font_size']
    assert_equal 'monospace', edge['label_font_family']
    assert_equal '#abcdef', edge['label_text_color']
  end

  test 'edge color accepts hex and rejects invalid values' do
    parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A' }],
      [{ 'from' => 'a', 'to' => 'a', 'color' => '#12AbEF' }]
    ))
    assert_empty parsed[:errors]
    assert_equal '#12AbEF', parsed[:data]['edges'].first['color']

    parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A' }],
      [{ 'from' => 'a', 'to' => 'a', 'color' => 'red' }]
    ))
    assert parsed[:errors].any? { |e| e.include?('цвет') }
  end

  test 'arc route is preserved' do
    json = valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0 }],
      [{ 'from' => 'a', 'to' => 'a', 'route' => 'arc', 'dashed' => true }]
    )
    parsed = RedmineWorkScheme::Scheme.parse(json)
    assert_equal 'arc', parsed[:data]['edges'].first['route']
  end

  test 'elbow route and explicit sides are preserved' do
    json = valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0 }],
      [{ 'from' => 'a', 'to' => 'a', 'route' => 'elbow', 'from_side' => 'Bottom', 'to_side' => 'right' }]
    )
    parsed = RedmineWorkScheme::Scheme.parse(json)
    assert_empty parsed[:errors]
    edge = parsed[:data]['edges'].first
    assert_equal 'elbow', edge['route']
    assert_equal 'bottom', edge['from_side']
    assert_equal 'right', edge['to_side']
  end

  test 'u route is preserved' do
    json = valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0 },
       { 'id' => 'b', 'title' => 'B', 'x' => 200, 'y' => 0 }],
      [{ 'from' => 'a', 'to' => 'b', 'route' => 'u', 'bend' => 80 }]
    )
    parsed = RedmineWorkScheme::Scheme.parse(json)
    assert_empty parsed[:errors]
    assert_equal 'u', parsed[:data]['edges'].first['route']
  end

  test 'invalid side returns error' do
    json = valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0 }],
      [{ 'from' => 'a', 'to' => 'a', 'from_side' => 'diagonal' }]
    )
    parsed = RedmineWorkScheme::Scheme.parse(json)
    assert parsed[:errors].any? { |e| e.include?('diagonal') }
  end

  test 'scenario with unknown node returns error' do
    parsed = RedmineWorkScheme::Scheme.parse(<<~JSON)
      {"nodes": [{"id": "a", "title": "A", "x": 0, "y": 0}],
       "edges": [],
       "scenarios": [{"id": "s1", "title": "S", "steps": ["a", "ghost"]}]}
    JSON
    assert parsed[:errors].any? { |e| e.include?('ghost') }
  end

  test 'node and scenario finders' do
    parsed = RedmineWorkScheme::Scheme.parse(RedmineWorkScheme::DefaultScheme.json)
    data = parsed[:data]
    assert_equal 'Заказчик', RedmineWorkScheme::Scheme.node(data, 'customer')['title']
    assert_nil RedmineWorkScheme::Scheme.node(data, 'nope')
    assert_equal 1, RedmineWorkScheme::Scheme.outgoing_edges(data, 'customer').length
    assert_equal 'Успешное прохождение', RedmineWorkScheme::Scheme.scenario(data, 'success')['title']
    assert_equal 14, RedmineWorkScheme::Scheme.scenario(data, 'rework_cycle')['steps'].length
  end

  test 'query_id accepts only positive integers' do
    json = valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0, 'query_id' => 'abc' },
       { 'id' => 'b', 'title' => 'B', 'x' => 0, 'y' => 0, 'query_id' => -5 },
       { 'id' => 'c', 'title' => 'C', 'x' => 0, 'y' => 0, 'query_id' => 7 }]
    )
    parsed = RedmineWorkScheme::Scheme.parse(json)
    assert_empty parsed[:errors]
    by_id = parsed[:data]['nodes'].index_by { |n| n['id'] }
    assert_nil by_id['a']['query_id']
    assert_nil by_id['b']['query_id']
    assert_equal 7, by_id['c']['query_id']
  end

  test 'theme accepts known values and defaults when omitted' do
    parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0 }]
    ))
    assert_equal 'classic', parsed[:data]['theme']

    parsed = RedmineWorkScheme::Scheme.parse(
      { 'theme' => 'graphite', 'nodes' => [{ 'id' => 'a', 'title' => 'A' }], 'edges' => [], 'scenarios' => [] }.to_json
    )
    assert_empty parsed[:errors]
    assert_equal 'graphite', parsed[:data]['theme']
  end

  test 'unknown theme safely falls back to classic' do
    parsed = RedmineWorkScheme::Scheme.parse(
      { 'theme' => 'neon', 'nodes' => [{ 'id' => 'a', 'title' => 'A' }], 'edges' => [], 'scenarios' => [] }.to_json
    )
    assert_empty parsed[:errors]
    assert_equal 'classic', parsed[:data]['theme']
  end

  test 'performance accepts known values and defaults to auto' do
    parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 0, 'y' => 0 }]
    ))
    assert_equal 'auto', parsed[:data]['performance']

    %w(lite high).each do |mode|
      parsed = RedmineWorkScheme::Scheme.parse(
        { 'performance' => mode, 'nodes' => [{ 'id' => 'a', 'title' => 'A' }], 'edges' => [], 'scenarios' => [] }.to_json
      )
      assert_empty parsed[:errors]
      assert_equal mode, parsed[:data]['performance']
    end
  end

  test 'unknown performance safely falls back to auto' do
    parsed = RedmineWorkScheme::Scheme.parse(
      { 'performance' => 'turbo', 'nodes' => [{ 'id' => 'a', 'title' => 'A' }], 'edges' => [], 'scenarios' => [] }.to_json
    )
    assert_empty parsed[:errors]
    assert_equal 'auto', parsed[:data]['performance']
  end

  test 'url accepts http(s) and site-relative links only' do
    [['https://example.com/x', 'https://example.com/x'],
     ['http://example.com', 'http://example.com'],
     ['/projects/demo/wiki/help', '/projects/demo/wiki/help'],
     ['', '']].each do |raw, expected|
      parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
        [{ 'id' => 'a', 'title' => 'A', 'url' => raw }]
      ))
      assert_empty parsed[:errors], "url #{raw.inspect} must pass"
      assert_equal expected, parsed[:data]['nodes'].first['url']
    end

    ['javascript:alert(1)', 'data:text/html,x', '//evil.com/x'].each do |raw|
      parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
        [{ 'id' => 'a', 'title' => 'A', 'url' => raw }]
      ))
      assert parsed[:errors].any? { |e| e.include?('a') }, "url #{raw.inspect} must be rejected"
    end
  end

  test 'duplicate edge pair returns error' do
    parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A' }, { 'id' => 'b', 'title' => 'B' }],
      [{ 'from' => 'a', 'to' => 'b' }, { 'from' => 'a', 'to' => 'b' }]
    ))
    assert parsed[:errors].any?, 'duplicate edge pair must be rejected'
    assert_nil parsed[:data], 'scheme with errors must not produce data'

    parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A' }, { 'id' => 'b', 'title' => 'B' }],
      [{ 'from' => 'a', 'to' => 'b' }, { 'from' => 'b', 'to' => 'a' }]
    ))
    assert_empty parsed[:errors], 'reverse pair is a different edge and must pass'
    assert_equal 2, parsed[:data]['edges'].length
  end

  test 'edge rejected for bad side does not mark its pair as duplicate' do
    parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A' }, { 'id' => 'b', 'title' => 'B' }],
      [{ 'from' => 'a', 'to' => 'b', 'from_side' => 'diagonal' }, { 'from' => 'a', 'to' => 'b' }]
    ))
    assert_equal 1, parsed[:errors].size, 'only the bad-side error is expected'
    assert parsed[:errors].first.include?('diagonal')
  end

  test 'duplicate scenario id returns error' do
    parsed = RedmineWorkScheme::Scheme.parse({
      'nodes' => [{ 'id' => 'a', 'title' => 'A' }],
      'edges' => [],
      'scenarios' => [{ 'id' => 's', 'title' => 'S1', 'steps' => ['a'] },
                       { 'id' => 's', 'title' => 'S2', 'steps' => ['a'] }]
    }.to_json)
    assert parsed[:errors].any? { |e| e.include?('s') }
  end

  test 'url edges: uppercase scheme, bare slash and stripped value' do
    [['HTTPS://EXAMPLE.COM/X', 'HTTPS://EXAMPLE.COM/X'],
     ['/', '/'],
     [' /x', '/x']].each do |raw, expected|
      parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
        [{ 'id' => 'a', 'title' => 'A', 'url' => raw }]
      ))
      assert_empty parsed[:errors], "url #{raw.inspect} must pass"
      assert_equal expected, parsed[:data]['nodes'].first['url']
    end
  end

  test 'numeric clamps: bend, font size, float coordinates, huge query_id' do
    parsed = RedmineWorkScheme::Scheme.parse(valid_scheme_json_with_nodes(
      [{ 'id' => 'a', 'title' => 'A', 'x' => 20.5, 'font_size' => 5, 'query_id' => 999_999_999_999_999 },
       { 'id' => 'b', 'title' => 'B' }],
      [{ 'from' => 'a', 'to' => 'a', 'bend' => 300 }, { 'from' => 'a', 'to' => 'b', 'route' => 'u', 'bend' => -5 }]
    ))
    assert_empty parsed[:errors]
    node = parsed[:data]['nodes'].first
    assert_equal 21, node['x'], 'float coordinates round'
    assert_equal 8, node['font_size'], 'font size lower clamp'
    assert_nil node['query_id'], 'query_id beyond DB range becomes nil'
    assert_equal 200, parsed[:data]['edges'][0]['bend'], 'bend upper clamp'
    assert_equal 0, parsed[:data]['edges'][1]['bend'], 'bend lower clamp'
  end

  test 'nodes and edges of wrong type return errors' do
    parsed = RedmineWorkScheme::Scheme.parse({ 'nodes' => 'x', 'edges' => [], 'scenarios' => [] }.to_json)
    assert parsed[:errors].any?
    parsed = RedmineWorkScheme::Scheme.parse({ 'nodes' => [{ 'id' => 'a', 'title' => 'A' }], 'edges' => 'x', 'scenarios' => [] }.to_json)
    assert parsed[:errors].any?
  end

  private

  def valid_scheme_json_with_nodes(nodes, edges = [])
    { 'nodes' => nodes, 'edges' => edges, 'scenarios' => [] }.to_json
  end
end
