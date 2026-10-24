# frozen_string_literal: true

# Optional integration with Additionals. The file is loaded only when the
# additionals dashboard-block extension is available.
module DashboardBlocks
  class WorkSchemeBlock < Base
    block_id 'work_scheme'
    label :ws_label_scheme
    dashboards :welcome
    partial 'work_scheme/block'
    no_settings!

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
