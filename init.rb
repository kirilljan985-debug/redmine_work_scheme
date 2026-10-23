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
  version '0.1.0'
  url 'https://github.com/kirilljan985-debug/redmine_work_scheme'
  author_url 'https://github.com/kirilljan985-debug'
  requires_redmine version_or_higher: '6.0.0'

  settings default: { 'json' => RedmineWorkScheme::DefaultScheme.json },
           partial: 'settings/work_scheme'
end
