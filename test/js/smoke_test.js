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
// подставляем query_id первому узлу (customer): проверяем, что «Подробнее»
// при заполненном счётчике ведёт на страницу этапа, а не в задачи
const schemeJsonWithQuery = schemeJson.replace('"query_id": null', '"query_id": 17');
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
  // jsdom хардкодит window.ontouchstart = null (IDL-атрибут: присвоение
  // undefined конвертируется в null), из-за запаски detectTouch каждое окно
  // считалось бы сенсорным — десктоп эмулируем удалением свойства
  delete window.ontouchstart;
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
  '<script type="application/json" class="ws-data">' + schemeJsonWithQuery + '</scr' + 'ipt></div>';

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

// pageTarget/stageTarget: клик ведёт в задачи (query_id приоритетнее),
// «Подробнее» — всегда описание этапа (url/page), query_id игнорирует
const protoView = Object.create(w1.WorkScheme.View.prototype);
protoView.stageBase = '/work_scheme/stages/';
protoView.queryBase = '/issues';
const linkedNode = { id: 'x', page: 'text', queryId: 17 };
check('proto: stageTarget prefers query_id', protoView.stageTarget(linkedNode) === '/issues?query_id=17');
check('proto: pageTarget ignores query_id', protoView.pageTarget(linkedNode) === '/work_scheme/stages/x');
const plainNode = { id: 'y', page: 'text', queryId: null };
check('proto: stageTarget falls back to stage page', protoView.stageTarget(plainNode) === '/work_scheme/stages/y');
check('proto: pageTarget falls back to stage page', protoView.pageTarget(plainNode) === '/work_scheme/stages/y');
check('proto: pageTarget empty without url/page', protoView.pageTarget({ id: 'z' }) === '');

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

  // подсказка на десктопе: «Подробнее» — страница этапа даже при заполненном
  // query_id; кнопки «Задачи» в подсказке нет (навигация — кликом по блоку)
  const firstNode = vContainer.querySelector('.ws-node');
  firstNode.dispatchEvent(new w1.MouseEvent('mouseenter', { clientX: 40, clientY: 40 }));
  const tooltip = vContainer.querySelector('.ws-tooltip');
  check('viewer: tooltip shown on mouseenter', !!tooltip && tooltip.style.display === 'block');
  const moreLink = tooltip && tooltip.querySelector('.ws-tooltip-more');
  check('viewer: tooltip more links to stage page',
    !!moreLink && moreLink.getAttribute('href') === '/work_scheme/stages/customer');
  check('viewer: tooltip more never links to issues',
    !moreLink || moreLink.getAttribute('href').indexOf('/issues') === -1);
  check('viewer: no tasks button without touch',
    !!tooltip && !tooltip.querySelector('.ws-tooltip-tasks'));

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
  // запаска detectTouch: typeof null !== 'undefined', matchMedia в jsdom
  // ни одно совпадение не отдаёт — получаем сенсорный режим как на ТВ
  w2.ontouchstart = null;
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

  // ---- Сенсорный поток (ТВ/планшет): тап показывает подсказку с кнопками ----

  // отдельный вьюер вне #ws-editor (в редакторе тултипы отключены)
  w2.document.body.insertAdjacentHTML('beforeend',
    '<div class="ws-container" data-work-scheme' +
    ' data-stage-base-url="/work_scheme/stages/"' +
    ' data-query-base-url="/issues"' +
    '><scr' + 'ipt type="application/json" class="ws-data">' + schemeJsonWithQuery + '</scr' + 'ipt></div>');
  w2.WorkScheme.init();
  const allContainers = w2.document.querySelectorAll('[data-work-scheme]');
  const tContainer = allContainers[allContainers.length - 1];
  check('touch: viewer initialized outside editor', !!tContainer && !tContainer.closest('#ws-editor'));
  check('touch: container gets ws-touch class', tContainer.classList.contains('ws-touch'));
  // auto-производительность на сенсоре сразу уходит в lite
  check('touch: auto performance engages lite', tContainer.classList.contains('ws-lite'));

  tContainer.querySelector('.ws-node').dispatchEvent(
    new w2.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
  const tTooltip = tContainer.querySelector('.ws-tooltip');
  check('touch: tap shows tooltip', !!tTooltip && tTooltip.style.display === 'block');
  check('touch: tap did not navigate', w2.location.href === 'http://localhost/work_scheme/edit');
  const tTasks = tTooltip && tTooltip.querySelector('.ws-tooltip-tasks');
  check('touch: tasks button links to query', !!tTasks && tTasks.getAttribute('href') === '/issues?query_id=17');
  const tMore = tTooltip && tTooltip.querySelector('.ws-tooltip-more');
  check('touch: more links to stage page',
    !!tMore && tMore.getAttribute('href') === '/work_scheme/stages/customer');
  check('touch: close button present', !!tTooltip && !!tTooltip.querySelector('.ws-tooltip-close'));

  w2.document.body.dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
  check('touch: tap outside hides tooltip', !!tTooltip && tTooltip.style.display === 'none');

  runMultiSuite().then(runViewerToolsSuite).then(finish).catch(function (error) { console.error(error); process.exit(1); });
}

async function runMultiSuite() {
  const collection = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'dev', 'schemes.json'), 'utf8'));
  collection.schemes[0].json.nodes[0].query_id = 501;
  collection.schemes[1].json.nodes[0].query_id = 502;
  const w = makeWindow(viewerHtml.replace(schemeJsonWithQuery, JSON.stringify(collection)));
  w.eval(viewerSource);
  let pending = [];
  w.fetch = function (url) {
    return new Promise(function (resolve) { pending.push({ url, resolve }); });
  };
  w.WorkScheme.init();
  const container = w.document.querySelector('[data-work-scheme]');
  const view = container.__wsViewInstance;
  check('multi viewer: two tabs before controls', container.querySelectorAll('.ws-scheme-tab').length === 2 && container.firstElementChild.classList.contains('ws-scheme-tabs'));
  view.refreshSeconds = 60;
  view.play('success');
  container.querySelectorAll('.ws-scheme-tab')[1].click();
  check('multi viewer: switch resets playback', !view.playing && view.timers.length === 0);
  check('multi viewer: switch changes nodes and theme', view.nodes.length === 2 && container.getAttribute('data-ws-theme') === 'graphite');
  check('multi viewer: refresh interval survives switching', container.querySelector('.ws-counts-interval').value === '60');
  check('multi viewer: scoped page URL', view.pageTarget(view.nodes[0]) === '/work_scheme/stages/support/request');
  check('multi viewer: query target remains global', view.stageTarget(view.nodes[0]) === '/issues?query_id=502');
  check('multi viewer: counts requested for selected scheme', pending.length === 2 && pending[1].url.includes('502'));
  pending[1].resolve({ ok: true, json: () => Promise.resolve({ counts: { '502': 8 } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  pending[0].resolve({ ok: true, json: () => Promise.resolve({ counts: { '501': 99 } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  check('multi viewer: stale count does not replace selected counts', view.counts['502'] === 8 && !view.counts['501']);
  view.switchScheme(0);
  check('multi viewer: main keeps legacy page URL', view.pageTarget(view.nodes[0]) === '/work_scheme/stages/customer');
  check('multi viewer: cached main counts restored', view.counts['501'] === 99);
  view.loadCounts(true);
  view.schemes[1].json.nodes[0].query_id = null;
  view.switchScheme(1);
  check('multi viewer: no-query tab cancels previous loading state', !view._countsLoading && !container.querySelector('.ws-counts-refresh'));
  pending[2].resolve({ ok: true, json: () => Promise.resolve({ counts: { '501': 77 } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  view.switchScheme(0);
  check('multi viewer: returning from no-query tab unlocks refresh', !view._countsLoading && !container.querySelector('.ws-counts-refresh').disabled && view.counts['501'] === 77);

  let html = fs.readFileSync(path.join(pluginRoot, 'dev', 'editor.html'), 'utf8')
    .replace(/<script[^>]*src=["'][^"']*["'][^>]*>\s*<\/script>/g, '')
    .replace(/<script>([\s\S]*?)<\/script>/g, '');
  const ew = makeWindow(html);
  ew.eval(viewerSource);
  ew.eval(editorSource);
  ew.document.querySelector('script.ws-data').textContent = JSON.stringify(collection);
  ew.document.dispatchEvent(new ew.Event('DOMContentLoaded'));
  const root = ew.document.querySelector('#ws-editor');
  const editor = root.__wsEditorInstance;
  check('multi editor: collection initialized', editor && editor.schemes.length === 2);
  const saved = editor.savedJson;
  editor.switchScheme(1);
  editor.switchScheme(0);
  check('multi editor: switching alone stays clean', !editor.dirty && editor.savedJson === saved);
  editor.view.nodes[0].title = 'Edited main';
  editor.markDirty();
  editor.switchScheme(1);
  editor.view.nodes[0].title = 'Edited support';
  editor.markDirty();
  editor.switchScheme(0);
  check('multi editor: both tabs retain edits', editor.view.nodes[0].title === 'Edited main' && editor.schemes[1].json.nodes[0].title === 'Edited support');
  check('multi editor: switch resets undo history', editor.history.length === 1 && editor.future.length === 0);
  editor.deleteScheme();
  check('multi editor: main cannot be deleted', editor.schemes.length === 2);
  root.classList.add('ws-scenario-capture', 'ws-object-focus');
  editor.activeScenarioId = 'success';
  editor.pendingFrom = { from: 'customer' };
  editor.addScheme();
  check('multi editor: starter has valid path and scenario', editor.view.nodes.length === 2 && editor.view.edges.length === 1 && editor.view.scheme.scenarios[0].steps.length === 2);
  check('multi editor: switch clears selection and capture', !editor.activeScenarioId && !editor.pendingFrom && !root.classList.contains('ws-object-focus') && !root.classList.contains('ws-scenario-capture'));
  check('multi editor: adding marks collection dirty', editor.dirty && editor.serialize().schemes.length === 3);
  const newId = editor.schemes[editor.activeSchemeIndex].id;
  editor.deleteScheme();
  editor.addScheme();
  check('multi editor: ids stay unique after delete and add', new Set(editor.schemes.map(entry => entry.id)).size === 3);
  check('multi editor: deterministic id reuse is valid', editor.schemes[editor.activeSchemeIndex].id === newId);
  while (editor.schemes.length < 10) editor.addScheme();
  editor.addScheme();
  check('multi editor: maximum ten schemes', editor.schemes.length === 10 && root.querySelector('.ws-add-scheme').disabled);
  editor.saveUrl = '/work_scheme/save';
  let posted;
  let completeSave;
  ew.fetch = function (url, options) {
    posted = JSON.parse(options.body.get('json'));
    return new Promise(resolve => { completeSave = resolve; });
  };
  editor.save();
  check('multi editor: save posts entire collection', posted.schemes.length === 10 && posted.schemes[0].json.nodes[0].title === 'Edited main' && posted.schemes[1].json.nodes[0].title === 'Edited support');
  editor.view.nodes[0].title = 'Changed during save';
  editor.markDirty();
  completeSave({ status: 200, text: () => Promise.resolve('{"ok":true}') });
  await new Promise(resolve => setTimeout(resolve, 0));
  check('multi editor: edits during save remain dirty', editor.dirty);
  editor.save();
  completeSave({ status: 200, text: () => Promise.resolve('{"ok":true}') });
  await new Promise(resolve => setTimeout(resolve, 0));
  check('multi editor: successful collection save clears dirty', !editor.dirty);
  while (editor.schemes.length > 1) { editor.switchScheme(1); editor.deleteScheme(); }
  check('multi editor: deleting extras restores plain JSON', !!editor.serialize().nodes && !editor.serialize().schemes);
  w.close();
  ew.close();
}

async function runViewerToolsSuite() {
  const w = makeWindow(viewerHtml);
  w.ontouchstart = null;
  w.eval(viewerSource);
  const pending = [];
  w.fetch = function (url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); };
  w.WorkScheme.init();
  const container = w.document.querySelector('[data-work-scheme]');
  const view = container.__wsViewInstance;
  const viewport = view.viewport;
  Object.defineProperty(viewport, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(viewport, 'clientHeight', { value: 200, configurable: true });
  view.canvasRatio = 1;
  container.querySelector('.ws-zoom-fit').click();
  check('fit: tall scheme fits height as well as width', view.zoom === 0.25 && view.canvas.style.height === '200px');
  viewport.scrollLeft = 90;
  viewport.scrollTop = 60;
  view.fitScheme();
  check('fit: resets both scroll offsets', viewport.scrollLeft === 0 && viewport.scrollTop === 0);
  Object.defineProperty(viewport, 'clientWidth', { value: 400, configurable: true });
  view.layoutViewport();
  check('fit: follows viewport resize while fitted', view.zoom === 0.5);
  view.setZoom(2);
  view.layoutViewport();
  check('zoom: manual scale survives resize', view.zoom === 2 && view.canvas.style.height === '800px');
  check('viewport: controls stay outside scroller', !viewport.contains(container.querySelector('.ws-controls')));

  const full = container.querySelector('.ws-fullscreen-toggle');
  full.click();
  check('fullscreen: fallback expands and keeps exit button', container.classList.contains('ws-fullscreen') && full.getAttribute('aria-pressed') === 'true');
  check('fullscreen: tabs and controls stay inside expanded container', container.contains(full) && container.contains(viewport));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  check('fullscreen: Escape exits fallback and restores scrolling', !container.classList.contains('ws-fullscreen') && w.document.body.style.overflow === '');
  container.requestFullscreen = function () { return Promise.reject(new Error('denied')); };
  full.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  check('fullscreen: rejected API falls back safely', container.classList.contains('ws-fullscreen'));
  full.click();
  check('fullscreen: visible button exits', !container.classList.contains('ws-fullscreen'));
  container.requestFullscreen = function () {
    Object.defineProperty(w.document, 'fullscreenElement', { value: container, configurable: true });
    return Promise.resolve();
  };
  w.document.exitFullscreen = function () {
    Object.defineProperty(w.document, 'fullscreenElement', { value: null, configurable: true });
    w.document.dispatchEvent(new w.Event('fullscreenchange'));
    return Promise.resolve();
  };
  full.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  check('fullscreen: native API supported', container.classList.contains('ws-fullscreen') && w.document.fullscreenElement === container);
  await w.document.exitFullscreen();
  check('fullscreen: browser exit updates button and layout', !container.classList.contains('ws-fullscreen') && full.getAttribute('aria-pressed') === 'false');

  const node = container.querySelector('.ws-node');
  function touch(type, x, y) {
    const event = new w.Event(type, { bubbles: true });
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
    node.dispatchEvent(event);
  }
  touch('touchstart', 100, 100);
  touch('touchmove', 30, 30);
  touch('touchend');
  node.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  check('pan: swipe does not open tooltip', container.querySelector('.ws-tooltip').style.display !== 'block');
  touch('touchstart', 20, 20);
  touch('touchend');
  // Новый неподвижный тап не должен ждать истечения подавления старого свайпа.
  node.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  check('pan: fresh tap after swipe opens tooltip', container.querySelector('.ws-tooltip').style.display === 'block');

  const refresh = container.querySelector('.ws-counts-refresh');
  check('counts: initial request disables duplicate refresh', refresh.disabled && pending.length === 1);
  view.loadCounts(true);
  check('counts: in-flight request is not duplicated', pending.length === 1);
  pending[0].resolve({ ok: true, json: () => Promise.resolve({ counts: { '17': 4 } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  const updated = view.countsUpdatedAt;
  check('counts: success shows time and badge', !!updated && !refresh.disabled && container.querySelector('.ws-counts-status').textContent.includes(updated.toLocaleTimeString()) && container.querySelector('.ws-badge text').textContent === '4');
  refresh.click();
  check('counts: manual refresh bypasses cache', pending.length === 2 && pending[1].options.cache === 'no-store');
  pending[1].resolve({ ok: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  check('counts: HTTP failure retains previous values and success time', view.counts['17'] === 4 && view.countsUpdatedAt === updated && view.countsError && !refresh.disabled);
  refresh.click();
  pending[2].resolve({ ok: true, json: () => Promise.resolve({ counts: { '17': 0 } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  check('counts: recovery clears error and displays zero', !view.countsError && container.querySelector('.ws-badge text').textContent === '0');

  const scheduled = new Map();
  const originalTimeout = w.setTimeout.bind(w);
  const originalClear = w.clearTimeout.bind(w);
  let deadlineCallback;
  w.setTimeout = function (callback, ms) {
    if (ms === 15000) deadlineCallback = callback;
    if ([30000, 60000, 300000].includes(ms)) { const id = 100000 + scheduled.size; scheduled.set(id, { callback, ms }); return id; }
    return originalTimeout(callback, ms);
  };
  w.clearTimeout = function (id) { scheduled.delete(id); originalClear(id); };
  const interval = container.querySelector('.ws-counts-interval');
  check('counts: automatic refresh defaults to off', interval.value === '0' && !view._countsTimer);
  interval.value = '30';
  interval.dispatchEvent(new w.Event('change'));
  check('counts: interval schedules one timer', scheduled.size === 1 && [...scheduled.values()][0].ms === 30000);
  Object.defineProperty(w.document, 'hidden', { value: true, configurable: true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  check('counts: hidden page stops polling', scheduled.size === 0);
  Object.defineProperty(w.document, 'hidden', { value: false, configurable: true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  const tick = [...scheduled.values()][0].callback;
  scheduled.clear();
  tick();
  check('counts: timer requests fresh data', pending.length === 4 && refresh.disabled);
  pending[3].resolve({ ok: true, json: () => Promise.resolve({ counts: { '17': 6 } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  check('counts: poll reschedules after success', scheduled.size === 1 && view.counts['17'] === 6);
  refresh.click();
  deadlineCallback();
  await new Promise(resolve => setTimeout(resolve, 0));
  check('counts: timeout unlocks controls and retains values', !refresh.disabled && view.countsError && view.counts['17'] === 6 && scheduled.size === 1);
  pending[4].resolve({ ok: true, json: () => Promise.resolve({ counts: { '17': 900 } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  check('counts: response after timeout is ignored', view.counts['17'] === 6);
  interval.value = '0';
  interval.dispatchEvent(new w.Event('change'));
  check('counts: manual mode cancels interval', scheduled.size === 0);
  interval.value = '300';
  interval.dispatchEvent(new w.Event('change'));
  check('counts: five minute option schedules correct interval', scheduled.size === 1 && [...scheduled.values()][0].ms === 300000);
  full.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  view.destroy();
  check('lifecycle: destroy clears interval and fullscreen', scheduled.size === 0 && !container.classList.contains('ws-fullscreen'));
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  check('lifecycle: destroyed view does not restart polling', scheduled.size === 0);
  w.close();
}

function finish() {
  console.log(checks + ' checks, ' + failures + ' failures');
  process.exit(failures ? 1 : 0);
}
