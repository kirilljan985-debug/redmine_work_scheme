require File.expand_path('../../test_helper', __FILE__)

# Интеграционные проверки блока дашборда additionals. Выполняются только в
# окружении, где additionals установлен и загрузил наш блок. Два поколения
# API: класс-система (4.7+, джоба «additionals») и легаси-патч
# DashboardContent (4.6, джоба «legacy-additionals»). Guard — по ЧУЖИМ
# константам: defined? на pending-autoload Zeitwerk в Redmine 7 возвращает
# "constant" (грабль скилла, раздел 3), поэтому свой WorkSchemeBlock так
# проверять нельзя — без additionals он «определён», но падает при первом
# обращении.
if defined?(DashboardBlocks::Base)
  class RedmineWorkSchemeAdditionalsTest < Redmine::IntegrationTest
    fixtures :all

    test 'dashboard block is registered' do
      assert_equal DashboardBlocks::WorkSchemeBlock, DashboardBlocks.find('work_scheme')
      assert_equal 'work_scheme', DashboardBlocks::WorkSchemeBlock.block_id
    end

    test 'dashboard block is offered on welcome and project dashboards' do
      assert DashboardBlocks::WorkSchemeBlock.offered_on?(:welcome)
      assert DashboardBlocks::WorkSchemeBlock.offered_on?(:project)
    end

    test 'block scheme falls back to default scheme' do
      # Схема — собственный метод блока, dashboard-контекст не нужен.
      # Типизированные ридеры настроек (width/height) требуют реального
      # dashboard_content (делегируют project) — за пределами этого теста.
      block = DashboardBlocks::WorkSchemeBlock.new(nil)
      parsed = block.scheme
      assert parsed[:errors].empty?, "unexpected scheme errors: #{parsed[:errors].join('; ')}"
      assert parsed[:data]['nodes'].any?
    end
  end
elsif defined?(DashboardContent)
  class RedmineWorkSchemeAdditionalsLegacyTest < Redmine::IntegrationTest
    fixtures :all

    test 'legacy patch registers the dashboard block' do
      assert DashboardContent.include?(RedmineWorkScheme::Patches::DashboardContentPatch)
      definitions = DashboardContent.new.block_definitions
      assert definitions.key?('work_scheme')
      assert_equal 'work_scheme/block', definitions['work_scheme'][:partial]
    end
  end
end

if defined?(DashboardContent)
  # Рендер партиала во всех контекстах через standalone-renderer. Общий для
  # обоих поколений: легаси-локали (block/settings) и локаль страницы (scheme)
  # не зависят от поколения. Ветку формы настроек проверяем через партиал
  # work_scheme/settings напрямую: standalone-renderer не подключает хелперы
  # additionals (remote_form_tag), в реальном дашборде они есть (проверено
  # по обоим клонам).
  class WorkSchemeBlockPartialRenderTest < ActiveSupport::TestCase
    test 'legacy locals render container with clamped default style' do
      rendered = ApplicationController.render partial: 'work_scheme/block',
                                              locals: { block: 'work_scheme',
                                                        settings: { width: 'junk', height: 0 } }
      assert_includes rendered, 'data-work-scheme'
      assert_includes rendered, 'ws-additionals-block'
      assert_includes rendered, '--ws-block-width: 100%'
      assert_includes rendered, '--ws-block-height: 420px'
      assert_includes rendered, '<script type="application/json"'
    end

    test 'legacy oversized settings are clamped to limits' do
      rendered = ApplicationController.render partial: 'work_scheme/block',
                                              locals: { block: 'work_scheme',
                                                        settings: { width: 500, height: 99_999 } }
      assert_includes rendered, '--ws-block-width: 100%'
      assert_includes rendered, '--ws-block-height: 1200px'
    end

    test 'legacy settings values survive clamping' do
      rendered = ApplicationController.render partial: 'work_scheme/block',
                                              locals: { block: 'work_scheme',
                                                        settings: { width: 55, height: 700 } }
      assert_includes rendered, '--ws-block-width: 55%'
      assert_includes rendered, '--ws-block-height: 700px'
    end

    test 'legacy locals without dashboard render container and no form' do
      # В реальном рендере additionals всегда передаёт local dashboard;
      # партиал обязан не падать и без него (defined?-гвард ветки формы).
      rendered = ApplicationController.render partial: 'work_scheme/block',
                                              locals: { block: 'work_scheme',
                                                        settings: { width: 55 } }
      assert_includes rendered, 'data-work-scheme'
      assert_not_includes rendered, 'id="work_scheme-settings"'
    end

    test 'settings partial renders clamped fields with matched ids' do
      rendered = ApplicationController.render partial: 'work_scheme/settings',
                                              locals: { block: 'work_scheme',
                                                        settings: { width: 55 } }
      assert_includes rendered, 'id="settings_work_scheme_width"'
      assert_includes rendered, 'name="settings[work_scheme][width]"'
      assert_includes rendered, 'value="55"'
      assert_includes rendered, 'id="settings_work_scheme_height"'
      assert_includes rendered, 'min="30"'
      assert_includes rendered, 'max="1200"'
    end

    test 'page locals render without additionals block class' do
      parsed = RedmineWorkScheme::Scheme.from_settings
      rendered = ApplicationController.render partial: 'work_scheme/block', locals: { scheme: parsed }
      assert_includes rendered, 'data-work-scheme'
      assert_includes rendered, 'data-layout="modern"', 'modern layout must be enabled on the scheme container'
      assert_not_includes rendered, 'ws-additionals-block'
    end
  end
end
