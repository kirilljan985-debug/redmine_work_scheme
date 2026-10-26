require File.expand_path('../../test_helper', __FILE__)

# Интеграционные проверки блока дашборда additionals. Выполняются только в
# окружении, где additionals установлен и загрузил наш блок (CI-джоба
# «additionals»). Guard — по DashboardBlocks::Base: defined? на pending-autoload
# Zeitwerk в Redmine 7 возвращает "constant" (грабль скилла, раздел 3), поэтому
# проверять сам WorkSchemeBlock так нельзя — без additionals он «определён»,
# но падает при первом обращении.
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
end
