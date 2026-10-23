module WorkSchemeHelper
  # Куда ведёт клик по узлу: внешняя ссылка (url), страница этапа плагина
  # (page) или nil — тогда узел только с подсказкой.
  def ws_stage_target(node)
    return node['url'] if node['url'].present?
    return work_scheme_stage_path(node['id']) if node['page'].present?
    nil
  end
end
