# frozen_string_literal: true

# Optional integration with Additionals. The file is loaded only when the
# additionals dashboard-block extension is available.
module DashboardBlocks
  class WorkSchemeBlock < Base
    block_id 'work_scheme'
    label :ws_label_scheme
    # В additionals 4.7+ ровно два типа дашбордов; схема глобальная, поэтому
    # блок предлагается и на главной, и на дашборде проекта.
    dashboards :welcome, :project
    partial 'work_scheme/block'
    setting :width, type: :integer, label: :ws_block_width, min: 30, max: 100, default: 100
    setting :height, type: :integer, label: :ws_block_height, min: 200, max: 1200, default: 420

    def scheme
      RedmineWorkScheme::Scheme.from_settings
    end
  end
end
