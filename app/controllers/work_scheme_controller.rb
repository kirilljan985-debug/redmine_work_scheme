# frozen_string_literal: true

# Контроллер схемы: страница схемы, страницы этапов, визуальный редактор.
class WorkSchemeController < ApplicationController
  layout 'base'

  # Колонка settings.value — TEXT (64 КБ в MySQL): на не-strict MySQL лишний
  # хвост тихо обрезался бы при записи. Явный лимит честнее ошибки БД.
  MAX_SCHEME_KB = 60

  def show
    @scheme = parsed_scheme
  end

  # Живые счётчики: число задач сохранённых запросов для бейджей на схеме.
  # Отвечает только по запросам, видимым текущему пользователю; недоступные,
  # несуществующие и некорректные id молча отсутствуют в ответе.
  def counts
    # верхняя граница отсекает Bignum: ActiveRecord на id вне диапазона
    # колонки бросает RangeError ещё на find_by
    ids = Array(params[:ids]).join(',').split(',').map { |value| value.to_i }
                             .uniq.select { |id| id.between?(1, 2**62) }.first(100)
    counts = {}
    ids.each do |id|
      query = IssueQuery.find_by(id: id)
      next if query.nil? || !query.visible?
      begin
        counts[id.to_s] = query.issue_count
      rescue StandardError
        # битый запрос не должен ронять ответ — счётчик просто отсутствует
      end
    end
    render json: { counts: counts }
  end

  def stage
    scheme = parsed_scheme
    @node = scheme[:data] && RedmineWorkScheme::Scheme.node(scheme[:data], params[:id])
    if @node.nil? || @node['page'].blank?
      render_404
      return
    end
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
    if json_str.bytesize > MAX_SCHEME_KB * 1024
      render json: { errors: [l(:ws_error_scheme_too_large,
                                  size: (json_str.bytesize.to_f / 1024).ceil,
                                  limit: MAX_SCHEME_KB)] },
             status: :unprocessable_entity
      return
    end
    parsed = RedmineWorkScheme::Scheme.parse(json_str)
    if parsed[:errors].any?
      render json: { errors: parsed[:errors] }, status: :unprocessable_entity
      return
    end
    Setting.plugin_redmine_work_scheme = { 'json' => json_str }
    render json: { ok: true }
  rescue StandardError => e
    Rails.logger.error("Work Scheme save failed: #{e.message}")
    render json: { errors: [l(:ws_error_save_failed)] }, status: :internal_server_error
  end

  private

  def parsed_scheme
    RedmineWorkScheme::Scheme.from_settings
  end
end
