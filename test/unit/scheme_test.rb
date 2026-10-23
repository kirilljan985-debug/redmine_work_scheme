require File.expand_path('../../test_helper', __FILE__)

class RedmineWorkSchemeSchemeTest < ActiveSupport::TestCase
  test 'parses default scheme without errors' do
    parsed = RedmineWorkScheme::Scheme.parse(RedmineWorkScheme::DefaultScheme.json)
    assert_empty parsed[:errors]
    assert_not_nil parsed[:data]
    assert_equal 10, parsed[:data]['nodes'].length
    assert_equal 10, parsed[:data]['edges'].length
    assert_equal 2, parsed[:data]['scenarios'].length
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
    assert_nil node['query_id']
    edge = parsed[:data]['edges'].first
    assert_equal false, edge['dashed']
    assert_equal 'straight', edge['route']
    assert_equal '', edge['from_side']
    assert_equal '', edge['to_side']
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

  private

  def valid_scheme_json_with_nodes(nodes, edges = [])
    { 'nodes' => nodes, 'edges' => edges, 'scenarios' => [] }.to_json
  end
end
