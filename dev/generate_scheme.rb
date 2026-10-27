# frozen_string_literal: true

# Регенерирует dev/scheme.json из схемы по умолчанию, чтобы dev-превью
# не расходилось с DefaultScheme при её изменениях. Запуск из корня плагина:
#   ruby dev/generate_scheme.rb
# (путь берём относительным: абсолютный с кириллицей в require_relative
# не резолвится на Windows-консоли — см. грабли в AGENTS.md)
require 'json'
require './lib/redmine_work_scheme/default_scheme'

data = JSON.parse(RedmineWorkScheme::DefaultScheme.json)
# относительный путь: __dir__ с кириллицей в имени папки не резолвится
path = 'dev/scheme.json'
File.write(path, JSON.pretty_generate(data) + "\n")
puts "regenerated #{path} (#{data['nodes'].length} nodes, #{data['edges'].length} edges)"
