# frozen_string_literal: true

# Optional integration with Additionals. The file is loaded only when the
# additionals dashboard-block extension is available.
module DashboardBlocks
  class WorkSchemeBlock < Base
    block_id 'work_scheme'
    label :ws_label_scheme
    dashboards :welcome
    partial 'work_scheme/block'
    setting :width, type: :integer, label: :ws_block_width, min: 30, max: 100, default: 100
    setting :height, type: :integer, label: :ws_block_height, min: 200, max: 1200, default: 420

    def scheme
      json = Setting.plugin_redmine_work_scheme
      json = json['json'] if json.is_a?(Hash)
      json = RedmineWorkScheme::DefaultScheme.json if json.to_s.strip.empty?
      RedmineWorkScheme::Scheme.parse(json)
    rescue StandardError
      RedmineWorkScheme::Scheme.parse(RedmineWorkScheme::DefaultScheme.json)
    end
  end
end
