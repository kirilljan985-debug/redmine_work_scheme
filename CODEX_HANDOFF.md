# Передача Redmine Work Scheme — v0.5.5 (2026-10-28)

Сначала читать AGENTS.md, PLAN.md и git status/log. Полный навык установлен
в `~/.codex/skills/redmine-plugin-dev/SKILL.md`; CODEX_REDMINE_SKILL.md — выжимка.

## Фактическое состояние

Сенсорный патч Zcode — отдельный коммит `4192fb8`. Его сессия закончилась
28 октября в 12:14 МСК по лимиту использования, посреди Ruby-коллекций.
Codex исправил контракт парсера и завершил мульти-схемы, tests/dev/README.
Статус коммитов/push/CI смотреть в актуальном PLAN.md и git.

## Формат (заменяет прежний дизайн extra_schemes)

Всё хранится в единственном `Setting.plugin_redmine_work_scheme['json']`:
одиночная схема в прежнем формате либо wrapper
`{"schemes":[{"id":"main","title":"Основная","json":{...}},...]}`.
Причина: сохранение настроек перезаписывает весь хэш. Максимум 10 схем
вместе с основной и общий лимит 60 КБ. Первая — main, удалить её нельзя.
`Scheme.parse_collection` возвращает `{collection:, errors:}` при успехе;
`from_settings` выдаёт `{data:, errors:}` для рендера (plain или wrapper).

Viewer: вкладки, сброс playback и новая загрузка counts; stale response
не меняет выбранную схему. Основные stage URL прежние, дополнительные —
`/work_scheme/stages/:scheme_id/:id`; неизвестная схема → 404.
Editor: вкладки, add start→end + сценарий, delete с подтверждением, сохранение
локальных правок всех вкладок, при переключении сброс undo/capture/selection.
Save/download всей коллекции; изменения во время save остаются dirty.

## Проверки

jsdom 70/70, standalone unit-файл 40 тестов / 208 assertions. Интеграция с
Redmine/Additionals и eager-loading — только CI (5 джоб). Dev v=103:
`/dev/preview.html?multi=1`, `/dev/editor.html?multi=1`. Локальный сервер —
`python -m http.server 8123 --bind 127.0.0.1` из корня плагина.

Продолжение: посмотреть CI и текущую точку AGENTS/PLAN. Пользователю после
зелёного CI — git pull + рестарт на живой машине; проверить Nextouch.
`.zcode/` не коммитить. Пароли/креды не писать в файлы и чат.
