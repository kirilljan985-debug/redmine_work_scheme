require File.expand_path('../../test_helper', __FILE__)

# Интеграционные проверки блока дашборда additionals. Выполняются только в
# окружении, где additionals установлен и загрузил наш блок (CI-джоба
# «additionals»); в обычной матрице файл-блок исключён из автозагрузки,
# условие ложно и тесты просто не объявляются.
if defined?(DashboardBlocks::WorkSchemeBlock)
  class RedmineWorkSchemeAdditionalsTest < Redmine::IntegrationTest
    fixtures :all

    test 'dashboard block is registered' do
      assert_equal DashboardBlocks::WorkSchemeBlock, DashboardBlocks.find('work_scheme')
      assert_equal 'work_scheme', DashboardBlocks::WorkSchemeBlock.block_id
    end

    test 'block settings and scheme fallback work' do
      block = DashboardBlocks::WorkSchemeBlock.new(nil)
      assert_equal 100, block.width
      assert_equal 420, block.height
      parsed = block.scheme
      assert parsed[:errors].empty?, "unexpected scheme errors: #{parsed[:errors].join('; ')}"
      assert parsed[:data]['nodes'].any?
    end
  end
end
