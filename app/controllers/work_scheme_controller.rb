# Контроллер схемы: страница схемы, страницы этапов, визуальный редактор.
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

  # Визуальный редактор схемы (только администратор)
  def edit
    unless User.current.admin?
      redirect_to work_scheme_path
      flash[:error] = l(:ws_error_admin_only)
      return
    end
    @scheme = parsed_scheme
  end

  # Сохранение схемы из редактора (только администратор)
  def save
    unless User.current.admin?
      render json: { errors: [l(:ws_error_admin_only)] }, status: :forbidden
      return
    end
    json_str = params[:json].to_s
    parsed = RedmineWorkScheme::Scheme.parse(json_str)
    if parsed[:errors].any?
      render json: { errors: parsed[:errors] }, status: :unprocessable_entity
      return
    end
    Setting.plugin_redmine_work_scheme = { 'json' => json_str }
    render json: { ok: true }
  rescue StandardError => e
    Rails.logger.error("Work Scheme save failed: #{e.message}")
    render json: { errors: [e.message] }, status: :internal_server_error
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
