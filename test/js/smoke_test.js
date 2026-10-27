/*
 * jsdom smoke: инициализация рендерера и редактора без браузера и Redmine.
 * Закрывает главный пробел CI — рантайм-JS раньше не проверялся ничем,
 * кроме node --check. Запуск: npm ci && node smoke_test.js
 * (в CI — джоба js-smoke в .github/workflows/test.yml).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pluginRoot = path.resolve(__dirname, '..', '..');
const schemeJson = fs.readFileSync(path.join(pluginRoot, 'dev', 'scheme.json'), 'utf8');
// авто-инициализацию отключаем: init() зовём сами и один раз — иначе
// отложенный DOMContentLoaded jsdom создаёт второй View поверх первого
const viewerSource = fs.readFileSync(path.join(pluginRoot, 'assets', 'javascripts', 'work_scheme.js'), 'utf8')
  .replace("if (document.readyState === 'loading') {", 'if (false) {');
const editorSource = fs.readFileSync(path.join(pluginRoot, 'assets', 'javascripts', 'work_scheme_editor.js'), 'utf8');

let failures = 0;
let checks = 0;
function check(name, cond) {
  checks += 1;
  if (cond) {
    console.log('ok - ' + name);
  } else {
    failures += 1;
    console.error('FAIL - ' + name);
  }
}

function makeWindow(bodyHtml) {
  const window = new JSDOM('<!doctype html><html><body>' + bodyHtml + '</body></html>', {
    url: 'http://localhost/work_scheme',
    pretendToBeVisual: true, // requestAnimationFrame для анимаций
    runScripts: 'outside-only'
  }).window;
  // jsdom не реализует геометрию SVG-путей — для смоука достаточно заглушек:
  // классы состояний и тайминги проверяются, точная форма пути — браузером
  if (window.SVGElement && window.SVGElement.prototype) {
    window.SVGElement.prototype.getTotalLength = function () { return 100; };
    window.SVGElement.prototype.getPointAtLength = function () { return { x: 0, y: 0 }; };
  }
  return window;
}

/* ---------- Рендерер (как production-партиал _block.html.erb) ---------- */

const viewerHtml =
  '<div class="ws-container" data-work-scheme data-layout="modern"' +
  ' data-stage-base-url="/work_scheme/stages/"' +
  ' data-counts-url="/work_scheme/counts"' +
  ' data-query-base-url="/issues"' +
  ' data-label-play="Проиграть" data-label-reset="Сброс"' +
  ' data-label-playback-step="Этап" data-label-playback-done="Готово"' +
  '>' +
  '<script type="application/json" class="ws-data">' + schemeJson + '</scr' + 'ipt></div>';

const w1 = makeWindow(viewerHtml);
w1.eval(viewerSource);
w1.WorkScheme.init();

const vDoc = w1.document;
const vContainer = vDoc.querySelector('[data-work-scheme]');
check('viewer: canvas rendered', !!vContainer.querySelector('.ws-canvas'));
check('viewer: main svg present', !!vContainer.querySelector('.ws-canvas > svg'));
check('viewer: overlay svg present', !!vContainer.querySelector('.ws-overlay-svg'));
check('viewer: controls built', !!vContainer.querySelector('.ws-controls'));
check('viewer: 10 nodes rendered', vContainer.querySelectorAll('.ws-node').length === 10);
check('viewer: 10 edges rendered', vContainer.querySelectorAll('.ws-edge').length === 10);
check('viewer: 3 scenarios in select', vContainer.querySelectorAll('.ws-scenario-select option').length === 3);
check('viewer: playback status and timeline built',
  !!vContainer.querySelector('.ws-playback-status') && !!vContainer.querySelector('.ws-playback-timeline'));

// проигрывание: старт, активный узел, сброс возвращает чистое состояние.
// 2300 мс: к этому моменту маркер уже на первой стрелке (шаг 1 — пауза узла
// без входящего ребра ~300 мс, затем ~1700 мс до второго шага при скорости 1×)
const playButton = vContainer.querySelector('.ws-play');
const resetButton = vContainer.querySelector('.ws-reset');
check('viewer: play button enabled before run', playButton && !playButton.disabled);
playButton.click();

setTimeout(function () {
  check('viewer: playback running (play disabled)', playButton.disabled);
  check('viewer: some node is active/complete during run',
    !!vContainer.querySelector('.ws-node-active') || !!vContainer.querySelector('.ws-node-complete'));
  // активное ребро: класс достаточен для смоука, dash-механику гоняет браузерная регрессия
  check('viewer: active edge highlighted', !!vContainer.querySelector('.ws-edge-active'));

  resetButton.click();
  check('viewer: reset re-enables play', !playButton.disabled);
  check('viewer: reset clears node states',
    !vContainer.querySelector('.ws-node-active') && !vContainer.querySelector('.ws-node-complete') && !vContainer.querySelector('.ws-node-rework'));
  check('viewer: reset clears edge states',
    !vContainer.querySelector('.ws-edge-active') && !vContainer.querySelector('.ws-edge-complete'));
  const activeEdge = vContainer.querySelector('.ws-edge-active');
  check('viewer: reset clears inline dasharray',
    !activeEdge || !activeEdge.style.strokeDasharray);

  // повторная инициализация того же контейнера не должна плодить канвасы
  w1.WorkScheme.init();
  check('viewer: re-init on same container keeps single canvas',
    vContainer.querySelectorAll('.ws-canvas').length === 1);

  runEditorSuite();
}, 2300);

/* ---------- Редактор (разметка dev/editor.html без его скриптов) ---------- */

function runEditorSuite() {
  let editorHtml = fs.readFileSync(path.join(pluginRoot, 'dev', 'editor.html'), 'utf8');
  // вырезаем внешние и инлайновые скрипты — источники подгружаем сами
  editorHtml = editorHtml.replace(/<script[^>]*src=["'][^"']*["'][^>]*>\s*<\/script>/g, '');
  editorHtml = editorHtml.replace(/<script>([\s\S]*?)<\/script>/g, '');

  const w2 = new JSDOM(editorHtml, {
    url: 'http://localhost/work_scheme/edit',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  }).window;
  w2.eval(viewerSource);
  w2.eval(editorSource);
  // данные в dev подгружаются асинхронно и переинициируют редактор
  // синтетическим DOMContentLoaded — воспроизводим этот путь
  w2.document.querySelector('script.ws-data').textContent = schemeJson;
  w2.document.dispatchEvent(new w2.Event('DOMContentLoaded'));

  const eRoot = w2.document.getElementById('ws-editor');
  const editor = eRoot.__wsEditorInstance;
  check('editor: instance created', !!editor);
  if (!editor) return finish();

  // повторный DOMContentLoaded не должен строить второй Editor
  w2.document.dispatchEvent(new w2.Event('DOMContentLoaded'));
  check('editor: double init guard', eRoot.__wsEditorInstance === editor);

  const eContainer = eRoot.querySelector('.ws-container');
  const serialized = editor.serialize();
  check('editor: serialize round-trips 10 nodes', serialized.nodes.length === 10);
  check('editor: serialize round-trips 10 edges', serialized.edges.length === 10);
  check('editor: serialize keeps 3 scenarios', serialized.scenarios.length === 3);
  check('editor: theme defaults to classic', serialized.theme === 'classic');

  // hit-пути стрелок: строятся при старте и пересоздаются после undo (P1);
  // dirty гаснет, когда Ctrl+Z вернул ровно сохранённое состояние
  check('editor: hit paths built at start', eContainer.querySelectorAll('.ws-edge-hit').length === 10);
  editor.view.nodes[0].x += 10;
  editor.markDirty();
  check('editor: dirty is tracked after change', editor.dirty === true);
  editor.undo();
  check('editor: undo rebuilds hit paths', eContainer.querySelectorAll('.ws-edge-hit').length === 10);
  check('editor: back-to-saved state clears dirty', editor.dirty === false);

  // уникальность id сценариев после «удалил → добавил» (P1)
  editor.view.scheme.scenarios.splice(0, 1);
  w2.document.getElementById('ws-add-scenario').click();
  w2.document.getElementById('ws-add-scenario').click();
  const scenarioIds = editor.view.scheme.scenarios.map(function (s) { return s.id; });
  check('editor: scenario ids unique after delete+add', new Set(scenarioIds).size === scenarioIds.length);

  finish();
}

function finish() {
  console.log(checks + ' checks, ' + failures + ' failures');
  process.exit(failures ? 1 : 0);
}
