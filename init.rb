# frozen_string_literal: true

# Redmine Work Scheme
# Интерактивная схема процесса работы отдела: SVG-схема на главной странице
# (блок для дашборда additionals), подсказки, страницы этапов, проигрывание
# сценариев, живые счётчики по задачам Redmine.
require 'redmine'
require_relative 'lib/redmine_work_scheme/scheme'
require_relative 'lib/redmine_work_scheme/default_scheme'

Redmine::Plugin.register :redmine_work_scheme do
  name 'Work Scheme'
  author 'kirilljan985-debug'
  description 'Interactive scheme of the department process: SVG scheme with tooltips, stage pages, scenario playback and live issue counters.'
  version '0.5.3'
  url 'https://github.com/kirilljan985-debug/redmine_work_scheme'
  author_url 'https://github.com/kirilljan985-debug'
  requires_redmine version_or_higher: '6.0.0'

  settings default: { 'json' => RedmineWorkScheme::DefaultScheme.json },
           partial: 'settings/work_scheme'

  # Кнопка «Схема» в шапке НЕ регистрируется через menu :top_menu — по
  # решению пользователя она добавляется кастомной ссылкой в настройках
  # темы ModernLayout (sidebar settings → custom links, адрес /work_scheme).
end

# Блок дашборда additionals: два поколения API. 4.7+ — класс в
# lib/dashboard_blocks через RedminePluginKit::Loader; 4.6 — патч
# DashboardContent (lib/redmine_work_scheme/patches). Каталог классов без
# объявления исключается из автозагрузки — иначе eager-загрузка production
# падает на отсутствии DashboardBlocks::Base (рестарт-луп Redmine).
if Redmine::Plugin.installed?(:additionals) &&
   defined?(RedminePluginKit::Loader) && defined?(DashboardBlocks::Base)
  loader = RedminePluginKit::Loader.new plugin_id: 'redmine_work_scheme'
  loader.extends %w[dashboard_blocks]
elsif Redmine::Plugin.installed?(:additionals) && defined?(DashboardContent)
  # legacy-additionals: классов DashboardBlocks::Base нет, каталог блоков
  # убрать из автозагрузки, а блок добавить патчем. after_initialize —
  # паттерн с производственным доказательством на живой additionals 4.6
  # (redmine_web_window); повторный include/prepend — no-op.
  Rails.autoloaders.main.ignore File.expand_path('lib/dashboard_blocks', __dir__)
  require_relative 'lib/redmine_work_scheme/patches/dashboard_content_patch'
  Rails.application.config.after_initialize do
    next unless defined?(DashboardContent)
    DashboardContent.include RedmineWorkScheme::Patches::DashboardContentPatch
  end
else
  Rails.autoloaders.main.ignore File.expand_path('lib/dashboard_blocks', __dir__)
end
