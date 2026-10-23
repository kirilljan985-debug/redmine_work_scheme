# Контроллер схемы: полная страница схемы и страницы этапов.
class WorkSchemeController < ApplicationController
  layout 'base'

  helper :work_scheme

  def show
    @scheme = parsed_scheme
  end

  def stage
    scheme = parsed_scheme
    @node = scheme[:data] && RedmineWorkScheme::Scheme.node(scheme[:data], params[:id])
    if @node.nil? || @node['page'].blank?
      render_404
      return
    end
  rescue StandardError
    render_404
  end

  private

  def parsed_scheme
    RedmineWorkScheme::Scheme.parse(settings_json)
  end

  def settings_json
    setting = Setting.plugin_redmine_work_scheme
    setting.is_a?(Hash) ? setting['json'] : nil
  rescue StandardError
    nil
  end
end
