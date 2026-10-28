# Сжатый навык: разработка плагинов Redmine 6/7 (для агента Codex)

Дистиллят навыка `redmine-plugin-dev` + опыт трёх живых плагинов:
**redmine_progress_bars**, **redmine_work_scheme** (этот репо),
**redmine_web_window**. Читай как чек-лист; порядок разделов = порядок работы.
Живой контекст этого репозитория — `AGENTS.md` и `PLAN.md`.

## 0. Разведка до кода

1. Выясни целевую версию Redmine. Redmine 7 = Rails 8 + Propshaft + Ruby 3.2+;
   по умолчанию цель — `7.0-stable` + `master` (CI-матрица), минимум 6.0.
2. Склонируй исходники ядра и сверяй всё по ним, не по памяти:
   `git clone --depth 1 --branch 7.0-stable https://github.com/redmine/redmine.git`.
   Хуки — grep `call_hook(` по `app/views/**`; API плагинов —
   `lib/redmine/plugin.rb`, `plugin_loader.rb`; тесты —
   `rake redmine:plugins:test NAME=<id>`.
3. Ищи готовое (redmine.org/plugins, GitHub). Мёртвый аналог (отстаёт на 2+
   мажора) — не дорабатывай: пиши свой, заимствуя только идею.
4. Лицензия: своё — MIT. Скопировал вью ядра — файл производный от GPL:
   заголовок «based on Redmine X.Y file, GPL-2.0-or-later» + упоминание в README.

## 1. Скелет

- Корень репо = корень плагина; имя папки при clone = plugin id. Установка =
  clone в `redmine/plugins/<id>` + рестарт. Без миграций и гемов без нужды.
- `init.rb`: `Redmine::Plugin.register :<id>` — name, version,
  `requires_redmine version_or_higher: '6.0.0'`, при нужде
  `settings default: {...}, partial: 'settings/<id>'`.
- `lib/<id>/*.rb` — чистая логика БЕЗ Rails (`module_function`, свои тексты
  ошибок) — тестируется minitest без Redmine; тонкий AR-слой рядом.
- **Путь файла = имя константы** для Zeitwerk:
  `patches/dashboard_content_patch.rb` → `Id::Patches::DashboardContentPatch`.
- `assets/stylesheets|javascripts` подхватываются сами (Propshaft в 7;
  при первом deploy — `rake assets:precompile`).

## 2. Правила кода

- Права и видимость всегда: `User.current.allowed_to?(:view_x, project)`,
  скоупы `.visible`. Плагин не показывает данные, которых пользователь не
  видел бы в ядре.
- Хуки вместо переопределения вью. Override — только если хука нет: шаблон
  копируй ИЗ ИСХОДНИКОВ целевой ветки, минимальный диф, GPL-заголовок;
  при мажоре Redmine сверять с ядром заново.
- JS: ванильный, офлайн (никаких CDN), без сборки. `render()` обязан очищать
  контейнер (иначе дубли); init через DOMContentLoaded + `window.X = {init}`;
  try/catch на уровне контейнера (ошибка JS не ломает страницу Redmine);
  все поля опциональны с молчаливой деградацией.
- Настройки: чтение `Setting.plugin_<id>['ключ']`; валидацию показывай и в
  настройках, и на страницах плагина — битый конфиг не роняет Redmine.
- Save-эндпоинт: POST, проверка admin/права, валидация, запись в Setting;
  CSRF — заголовок `X-CSRF-Token` из `meta[name=csrf-token]`; ошибки —
  JSON + 422. Лимит размера: настройки живут в MySQL TEXT — не прыгать
  выше ~60 КБ, лишнее отклонять валидатором.

## 3. Главная ловушка — ERB-экранирование JSON в `<script>`

`<%= %>` внутри `<script type="application/json">` экранирует кавычки в
`&quot;`; `<script>` — raw-text, сущности не декодируются → `JSON.parse`
падает, и фича мертва на живом Redmine **при зелёном CI** (CI не исполняет
JS, dev-превью пишет JSON в DOM мимо ERB — дефект структурно невидим).

- JSON в `<script>` — только `<%== %>` + замена `<` на `\u003c`
  (защита от выхода из тега).
- В HTML-атрибутах кавычки — литеральные в шаблоне, `<%= %>` только вокруг
  значений (иначе ломается и style-атрибут).
- Проверка — интеграционный тест: вытащи содержимое тега из `response.body`
  и `JSON.parse` его (assert_select декодирует сущности и маскирует дефект).
- `erb -x` врёт на `<%==` и блочных формах `<%= form ... do %>` — не чинить,
  сверять с ядром/тестом.

## 4. Eager-загрузка production (цена ошибки — рестарт-луп контейнера)

Тестовая среда eager-load НЕ делает — production-краши тесты не ловят.
На каждой CI-джобе обязателен шаг:

```yaml
- name: Eager-load smoke check (как production)
  run: RAILS_ENV=test bundle exec rails runner 'Rails.application.eager_load!; puts :EAGER_OK'
```

Три правила для `lib/`:
1. Путь файла буквально = имя константы.
2. Класс, объявляемый только при наличии зависимости, начинает файл с
   `return unless defined?(ЧужаяЗависимость::База)`.
3. Файл без константы уронит eager («expected file to define constant») —
   исключай каталог: `Rails.autoloaders.main.ignore(...)`.

Симптом на живой машине: «uninitialized constant …» в `docker logs`,
рестарт-луп при зелёном CI.

## 5. Тесты (minitest в окружении Redmine)

- `test/test_helper.rb` → require ядерного `test_helper`. Юнит — чистая
  логика на Struct-заглушках + 1–2 теста на реальных моделях; интеграция —
  `Redmine::IntegrationTest`, `fixtures :all`: страницы, права, save
  (валид/невалид/чужой), 404, битые настройки не роняют страницу.
- Грабли:
  - `log_user` — ОДИН на тест (второй падает на живой сессии);
  - `assert_match` с русским текстом — только `/.../i`;
  - гвардить тест-файл по зависимости только по ЧУЖОЙ константе
    (`defined?(DashboardBlocks::Base)`); `defined?` на pending-autoload
    Zeitwerk врёт (`"constant"`);
  - эталоны с `User.current` — тем же методом модели при явно выставленном
    `User.current` (`Issue.visible(user).count` ≠ base_scope запроса);
  - валидатор при ошибках отдаёт `data: nil` — ассерты на данные только
    после `assert_empty errors`;
  - числа клампить ДО `find_by` (`find_by(id: Bignum)` → RangeError);
  - неверный `require ../`-путь валит ВЕСЬ файл («тесты не обнаружены»);
  - Redmine 7 (Rails 8): `assert_nothing_raised` не принимает класс
    исключения.

## 6. CI (GitHub Actions)

- Матрица `['7.0-stable', 'master']`, ubuntu-latest; шаги: checkout → clone
  Redmine → mv в `plugins/<id>` → **database.yml ДО bundle install** (состав
  гемов зависит от адаптера) → setup-ruby → bundle → secret token + migrate →
  `redmine:plugins:test` с `tee` в лог.
- Последний шаг «Report failure details» `if: failure()` — хвост тестового
  лога в `::error::` (аннотации видны на странице прогона без логина, сами
  логи — нет; API без токена отдаёт аннотации пустыми).
- Интеграция с additionals — отдельная джоба: PostgreSQL-сервис (additionals
  ≥ 4.7 не работает под sqlite), `redmine:plugins:migrate` (иначе нет таблиц
  дашбордов); легаси-версия additionals — ОТДЕЛЬНОЙ джобой (`clone --branch
  4.6.0`), там исполняется легаси-ветка кода.
- `node --check` по всем .js отдельным шагом; `timeout-minutes`;
  `permissions: contents: read`; `concurrency` c cancel-in-progress.
- Push с Windows флапает по DNS: `for i in {1..6}; do git push && break; sleep 10; done`
  (`git push` без пайпа, иначе код возврата теряется). Ответы GitHub API
  парси пайпом в python (файлы в `/tmp` MSYS Windows-python не видит).
  Push тега тоже запускает CI.

## 7. Локальная проверка без Redmine (Windows)

Полный Redmine локально обычно не поднимается (нативные гемы требуют MSYS2) —
авторитетная среда = CI. Локально:

- `ruby -c *.rb`; `node --check *.js`; чистая логика — временный
  minitest-файл с `$LOAD_PATH.unshift "lib"`.
- **Dev-превью — главный инструмент**: `dev/*.html` грузит тот же JS с
  данными из `dev/*.json`; `python -m http.server 8123` из папки плагина.
  При каждой правке JS поднимай `?v=N` в html — кэш отдаёт старый скрипт
  (и поднимай ЕЩЁ РАЗ, если правил после первого поднятия).
- Windows: `ruby -e '...кириллица...'` падает (IBM866) — кириллицу только
  через файлы; curl-пейлоады только ASCII; Ruby на PATH:
  `export PATH="/c/Ruby34-x64/bin:$PATH"`.
- Встроенный браузер агента: повторный goto в той же вкладке → ERR_ABORTED
  (открывай новую вкладку); фоновая вкладка троттлится намертво (rAF стоит,
  таймеры ~1 с) — анимации в ней не мерить, состояние проверять выборкой.

## 8. Additionals: блоки дашбордов — ДВА поколения API

Выбор по факту `defined?(DashboardBlocks::Base)`: класс-система с 4.7.0
(релизных тегов 4.7 нет, main = 4.7.0-main), 4.6.0 и старее — легаси.

**4.7+**: класс `lib/dashboard_blocks/<id>_block.rb < Base`
(`block_id`/`label`/`partial`/`setting ...`); подключение в init.rb
ОБЯЗАТЕЛЬНО через `RedminePluginKit::Loader.new(plugin_id:).extends %w[dashboard_blocks]` —
без объявления additionals падает UndeclaredError; лоадер сам исключает
каталог из eager. Синхронный блок — без `async` (страницу грузит браузер).

**Легаси 4.0–4.6**: патч `block_definitions` (prepend через Concern),
включение ТОЛЬКО из `config.after_initialize` (`to_prepare` в init.rb
плагина до тестов не применялся — рабочий паттерн after_initialize);
каталог `lib/dashboard_blocks` — `Rails.autoloaders.main.ignore`;
шестерёнка блока переключает скрытый `div id="<block>-settings"`, форму
рисует твой партиал (`remote_form_tag`, имена полей `settings[<block>][ключ]`,
образец — `_text.html.slim` ядра additionals).

- Партиал блока — общий для поколений (локали dashboard/settings/block...),
  ветвится только форма настроек; локальные vars от хелпера additionals
  гвардить `defined?` (тест без локали ловит NameError).
- Кламп ≠ дефолт: height 99999 → max; дефолт — только при ≤0. Ассерты не путать.
- `ApplicationController.render` НЕ подключает хелперы additionals и имеет
  ПУСТОЙ `request.path` ('' — truthy в Ruby! back-параметры через `.presence`);
  конкретный путь — `ApplicationController.renderer.new('PATH_INFO' => '/x')`.
- С `/additionals` главная («/») — их дашборд; в тестах ходить на страницы
  плагина, не на `/`.

## 9. Wiki-макросы (план А вставки контента поверх всех версий additionals)

`Redmine::WikiFormatting::Macros.register` — API стабилен от 1.x до 7.x.
Аргументы приходят массивом (Redmine режет строку по запятым вне кавычек).
Валидации обязательны: схема URL `%r{\Ahttps?://}i` (иначе XSS через
`javascript:`), числовые параметры с диапазоном и дефолтом, `html_escape`
всего, что попадает в атрибуты. Тест: `exec_macro` на holder-классе с
`Definitions`.

## 10. JS-фронт (опыт work_scheme)

- Два «строителя» на одном контейнере → двойной render и гонка fetch:
  init скипает контейнеры редактора; fetch-колбэки проверяют, что их DOM
  ещё прицеплен. **Detached-гварды пересчитывать при ЛЮБОМ структурном
  изменении DOM** (переносишь svg в canvas — меняется `parentNode`-гвард).
- Undo-история снимков: `history[0]` — несгораемый базовый снимок; undo
  восстанавливает предпоследний и схлопывает вершину. Инварианты стеков
  проявляются только на ПОВТОРНЫХ циклах — тестируй циклами, не «туда-обратно».
- Drag через `getScreenCTM` (клиентские пиксели ≠ юниты viewBox).
- Оверлей поверх SVG с `pointer-events: none`: интерактивным элементам
  внутри — явный `pointer-events: stroke/auto`, иначе hit-тест мёртв.
- Временные элементы при перетаскивании — `pointer-events: none`, иначе
  `elementFromPoint` видит их вместо цели.
- Автотёмные режимы (`prefers-color-scheme: dark`, классы ядра) конфликтуют
  с явными темами — удалять сразу; диагноз начинать с `matchMedia` в браузере.
- Производительность слабых устройств: lite-профиль (без фильтров/хвостов,
  ~30 fps), `auto` = эвристика (ядра/память/сенсорный экран) + адаптация по
  замерам кадров; пересчитывать режим на каждом `render()` (селект редактора
  применяется без пересоздания View).
- Сенсорные экраны (ТВ/панели): detect по `matchMedia('(hover: none)')` с
  запаской `ontouchstart`; первый тап показывает подсказку/меню, навигация
  только явными кнопками; тач-зоны ≥ 44 px; document-click скрытие с
  очисткой обработчика при повторных render.

## 11. Сопровождение репозитория

- Память проекта — `AGENTS.md` (правила, статус, грабли), живой план —
  `PLAN.md` (архив — `PLAN_HISTORY.md`). Любое изменение: ДО — задача и
  критерии готовности в PLAN; ПОСЛЕ — факт, проверки, CI в оба файла.
- В репо может работать параллельный агент: `git status` + `git log` до
  правок; чужой незакоммиченный код не трогать и не коммитить; `git add`
  адресно (доки отдельно от кода).
- Изменение = коммит + push + зелёный CI (≈4–5 мин); «готово» — только после
  зелёного CI. README: установка, формат конфига, «если данных нет — не
  падает», тесты, совместимость, лицензия.
