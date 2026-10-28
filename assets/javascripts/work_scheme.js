/*
 * Redmine Work Scheme: SVG-рендерер схемы (vanilla JS, без внешних зависимостей).
 * Рисует узлы (start/process/decision/end), связи (прямые/дуги, с подписями),
 * показывает подсказки при наведении; клик по узлу открывает страницу этапа.
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICONS = ['user', 'document', 'search', 'decision', 'certificate', 'gear', 'rocket'];
  var THEME_CANVAS = {
    classic: '#f3f7fa',
    ocean: '#e7f5fb',
    graphite: '#111820',
    warm: '#fbf3e9',
    paper: '#f4f1e8'
  };

  // Кэш живых счётчиков на страницу: один fetch на набор query_id,
  // повторные рендеры и undo/redo редактора переиспользуют ответ.
  var countsCache = {};
  var countsRequests = {};
  var countsSerial = 0;

  function svgEl(name, attrs, text) {
    var el = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (var key in attrs) {
        if (attrs[key] !== undefined && attrs[key] !== null) el.setAttribute(key, attrs[key]);
      }
    }
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  // Слабое устройство по эвристике браузера: мало ядер или мало памяти.
  // Поля могут отсутствовать (Firefox не даёт deviceMemory) — тогда фактор 0.
  function weakDevice() {
    var nav = window.navigator;
    var cores = nav.hardwareConcurrency || 0;
    var mem = nav.deviceMemory || 0;
    return (cores > 0 && cores <= 4) || (mem > 0 && mem <= 4);
  }

  function wrapText(text, maxChars) {
    var words = String(text || '').split(/\s+/).filter(function (w) { return w.length > 0; });
    var lines = [];
    var current = '';
    words.forEach(function (word) {
      if (current && (current + ' ' + word).length > maxChars) {
        lines.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    });
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  function WorkSchemeView(container, scheme) {
    var previous = container.__wsViewInstance;
    if (previous) previous.destroy();
    container.__wsViewInstance = this;
    this.container = container;
    this.schemes = scheme && Array.isArray(scheme.schemes) ? scheme.schemes : null;
    this.activeSchemeIndex = 0;
    scheme = this.schemes ? this.schemes[0].json : (scheme || {});
    this.scheme = scheme;
    this.container.setAttribute('data-ws-theme', this.scheme.theme || 'classic');
    this.stageBase = container.getAttribute('data-stage-base-url') || '';
    this.countsUrl = container.getAttribute('data-counts-url') || '';
    this.queryBase = container.getAttribute('data-query-base-url') || '';
    this.counts = {};
    this.setScheme(scheme);
    this.pathByEdge = {};
    this._adaptiveLite = false;
    this.applyPerformanceMode();
    this.frameTimes = [];
    this.lastFrameTs = 0;
    this.playing = false;
    this.playbackSpeed = 0.5;
    this.reworkTriggered = false;
    this.playbackTrail = null;
    this.playbackHistory = [];
    this.playbackSuccess = null;
    this.playbackTimeline = null;
    this.zoom = 1;
    this.timers = [];
    this.editMode = false;
    this.viewerMode = !container.closest('#ws-editor');
    this._fitMode = this.viewerMode;
    this.refreshSeconds = 0;
    this._countsSequence = 0;
    if (this.viewerMode) this.attachViewerEvents();
    this.render();
    this.loadCounts();
  }

  WorkSchemeView.prototype.destroy = function () {
    this.resetPlayback();
    this._destroyed = true;
    this._countsSequence++;
    clearTimeout(this._countsTimer);
    clearTimeout(this._countsTimeout);
    if (this._countsAbort) this._countsAbort.abort();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._onFullscreen) document.removeEventListener('fullscreenchange', this._onFullscreen);
    if (this._onEscape) document.removeEventListener('keydown', this._onEscape);
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
    this.leaveFullscreen();
    if (this._onDocHide) document.removeEventListener('click', this._onDocHide);
    if (this._onContainerMove) this.container.removeEventListener('mousemove', this._onContainerMove);
  };

  WorkSchemeView.prototype.setScheme = function (scheme) {
    this.scheme = scheme;
    this.container.setAttribute('data-ws-theme', scheme.theme || 'classic');
    this.nodes = (scheme.nodes || []).map(function (raw) {
      return {
        id: String(raw.id || ''),
        type: raw.type || 'process',
        title: String(raw.title || ''),
        dept: String(raw.dept || ''),
        description: String(raw.description || ''),
        page: String(raw.page || ''),
        url: String(raw.url || ''),
        icon: ICONS.indexOf(raw.icon) !== -1 ? raw.icon : '',
        queryId: raw.query_id || null,
        fontSize: Math.max(8, Math.min(32, num(raw.font_size, 12))),
        fontWeight: raw.font_weight === 'bold' ? 'bold' : 'normal',
        fontFamily: raw.font_family === 'serif' ? 'serif' : (raw.font_family === 'monospace' ? 'monospace' : 'sans-serif'),
        textColor: /^#[0-9a-f]{6}$/i.test(String(raw.text_color || '').trim()) ? String(raw.text_color).trim() : '',
        x: num(raw.x, 0),
        y: num(raw.y, 0),
        w: Math.max(1, num(raw.w, 140)),
        h: Math.max(1, num(raw.h, 56))
      };
    });
    this.edges = (scheme.edges || []).map(function (raw) {
      return {
        from: String(raw.from || ''),
        to: String(raw.to || ''),
        label: String(raw.label || ''),
        color: /^#[0-9a-f]{6}$/i.test(String(raw.color || '').trim()) ? String(raw.color).trim() : '',
        dashed: raw.dashed === true,
        route: raw.route === 'arc' ? 'arc' : (raw.route === 'elbow' ? 'elbow' : (raw.route === 'u' ? 'u' : 'straight')),
        fromSide: raw.from_side || '',
        toSide: raw.to_side || '',
        bend: num(raw.bend, 50)
        ,labelFontSize: Math.max(8, Math.min(32, num(raw.label_font_size, 11))),
        labelFontWeight: raw.label_font_weight === 'bold' ? 'bold' : 'normal',
        labelFontFamily: raw.label_font_family === 'serif' ? 'serif' : (raw.label_font_family === 'monospace' ? 'monospace' : 'sans-serif'),
        labelTextColor: /^#[0-9a-f]{6}$/i.test(String(raw.label_text_color || '').trim()) ? String(raw.label_text_color).trim() : ''
      };
    });
    this.byId = {};
    this.nodes.forEach(function (node) { this.byId[node.id] = node; }, this);
  };

  WorkSchemeView.prototype.switchScheme = function (index) {
    if (!this.schemes || !this.schemes[index] || index === this.activeSchemeIndex) return;
    this.resetPlayback();
    // Даже вкладка без query_id должна снять loading прежнего запроса:
    // иначе возвращение к нему оставит кнопку обновления заблокированной.
    this._countsSequence++;
    this._countsLoading = false;
    clearTimeout(this._countsTimer);
    clearTimeout(this._countsTimeout);
    if (this._countsAbort) this._countsAbort.abort();
    this.activeSchemeIndex = index;
    this.setScheme(this.schemes[index].json);
    this.counts = {};
    this.countsUpdatedAt = null;
    this.countsError = false;
    this._fitMode = this.viewerMode;
    this.zoom = 1;
    this.render();
    this.loadCounts();
  };

  WorkSchemeView.prototype.buildSchemeTabs = function () {
    if (!this.schemes || this.schemes.length < 2) return;
    var self = this;
    var tabs = document.createElement('div');
    tabs.className = 'ws-scheme-tabs';
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', self.container.getAttribute('data-label-schemes') || 'Schemes');
    self.schemes.forEach(function (entry, index) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ws-scheme-tab';
      button.textContent = entry.title || entry.json.title || entry.id;
      button.setAttribute('aria-pressed', String(index === self.activeSchemeIndex));
      button.addEventListener('click', function () {
        self.switchScheme(index);
        var current = self.container.querySelectorAll('.ws-scheme-tab')[index];
        if (current) current.focus();
      });
      tabs.appendChild(button);
    });
    self.container.insertBefore(tabs, self.container.firstChild);
  };

  WorkSchemeView.prototype.stagePage = function (node) {
    var entry = this.schemes && this.schemes[this.activeSchemeIndex];
    var id = this.schemeId || (entry && entry.id);
    return this.stageBase + (id && id !== 'main' ? encodeURIComponent(id) + '/' : '') + encodeURIComponent(node.id);
  };

  // lite: без фильтров/пульсаций/хвоста, ~30 fps; auto может уйти в lite
  // на лету по замерам кадров (engageLite). Пересчитывается при каждом
  // render() — так селект «Производительность» в редакторе применяется
  // сразу, а не после пересоздания View.
  WorkSchemeView.prototype.applyPerformanceMode = function () {
    this.performanceMode = ['high', 'lite'].indexOf(this.scheme.performance) !== -1 ? this.scheme.performance : 'auto';
    if (this.performanceMode === 'high') this.lite = false;
    else if (this.performanceMode === 'lite') this.lite = true;
    // сенсорные панели/ТВ — слабые устройства по определению: в auto уводим
    // их в lite сразу, не дожидаясь адаптивного замера кадров
    else this.lite = weakDevice() || this._adaptiveLite || detectTouch();
    this.container.classList.toggle('ws-lite', this.lite);
  };

  WorkSchemeView.prototype.nodeCenter = function (node) {
    return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  };

  // Перевод клиентских координат в систему координат SVG. Без getScreenCTM
  // drag меряет экранные пиксели и применяет их как юниты viewBox — на узкой
  // колонке (масштаб ≠ 1) узел отстаёт от курсора и прыгает при отпускании.
  WorkSchemeView.prototype.svgPoint = function (clientX, clientY) {
    var svg = this.svg;
    if (!svg || !svg.createSVGPoint || !svg.getScreenCTM) return null;
    var matrix = svg.getScreenCTM();
    if (!matrix) return null;
    var pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(matrix.inverse());
  };

  // Безопасный поиск группы узла: id приходит из JSON схемы, поэтому
  // экранируем его для селектора и глотаем ошибку вместо падения рендера.
  WorkSchemeView.prototype.nodeEl = function (id) {
    var escaped = id;
    if (window.CSS && CSS.escape) escaped = CSS.escape(id);
    try {
      return this.container.querySelector('.ws-node[data-id="' + escaped + '"]');
    } catch (e) {
      return null;
    }
  };

  WorkSchemeView.prototype.anchor = function (node, side) {
    var c = this.nodeCenter(node);
    if (side === 'right') return { x: node.x + node.w, y: c.y };
    if (side === 'left') return { x: node.x, y: c.y };
    if (side === 'top') return { x: c.x, y: node.y };
    return { x: c.x, y: node.y + node.h }; // bottom
  };

  WorkSchemeView.prototype.sidesFor = function (a, b, edge) {
    var ac = this.nodeCenter(a);
    var bc = this.nodeCenter(b);
    var auto;
    if (Math.abs(ac.y - bc.y) < 20) {
      auto = ac.x <= bc.x ? ['right', 'left'] : ['left', 'right'];
    } else if (Math.abs(ac.x - bc.x) < 20) {
      auto = ac.y <= bc.y ? ['bottom', 'top'] : ['top', 'bottom'];
    } else if (Math.abs(ac.x - bc.x) > Math.abs(ac.y - bc.y)) {
      auto = ac.x < bc.x ? ['right', 'left'] : ['left', 'right'];
    } else {
      auto = ac.y < bc.y ? ['bottom', 'top'] : ['top', 'bottom'];
    }
    if (!edge) return auto;
    return [edge.fromSide || auto[0], edge.toSide || auto[1]];
  };

  WorkSchemeView.prototype.bounds = function () {
    var self = this;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    self.nodes.forEach(function (node) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.w);
      maxY = Math.max(maxY, node.y + node.h);
    });
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 300, maxY: 120 };
    // Облачко «Готово» поднимается на 54 юнита над финишным блоком — не даём
    // viewBox срезать его верх (актуально для end-узла в верхнем ряду).
    self.nodes.forEach(function (node) {
      if (node.type === 'end') minY = Math.min(minY, node.y - 54);
    });
    // Дуги поверх схемы могут выходить за границы узлов — учитываем их вылет
    // (формула подъёма должна совпадать с edgePath, включая масштаб bend/50)
    self.edges.forEach(function (edge) {
      if (edge.route !== 'arc' && edge.route !== 'u') return;
      var a = self.byId[edge.from];
      var b = self.byId[edge.to];
      if (!a || !b) return;
      var lift;
      if (edge.route === 'u') {
        lift = 26 + num(edge.bend, 50);
      } else {
        var baseLift = Math.max(46, Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) / 4);
        lift = baseLift * (edge.bend / 50);
      }
      minY = Math.min(minY, Math.min(a.y, b.y) - lift - 14);
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  };

  WorkSchemeView.prototype.edgePath = function (edge) {
    var a = this.byId[edge.from];
    var b = this.byId[edge.to];
    if (!a || !b) return null;
    var sides = this.sidesFor(a, b, edge);
    var s = this.anchor(a, sides[0]);
    var t = this.anchor(b, sides[1]);
    var labelPoint;

    if (edge.route === 'arc') {
      var topA = this.anchor(a, 'top');
      var topB = this.anchor(b, 'top');
      var baseLift = Math.max(46, Math.abs(topA.x - topB.x) / 4);
      var lift = baseLift * (edge.bend / 50);
      var y = Math.min(topA.y, topB.y) - lift;
      labelPoint = { x: (topA.x + topB.x) / 2, y: y };
      return {
        d: 'M ' + topA.x + ' ' + topA.y +
           ' C ' + topA.x + ' ' + y + ', ' + topB.x + ' ' + y + ', ' + topB.x + ' ' + topB.y,
        label: labelPoint
      };
    }

    if (edge.route === 'u') {
      var uLift = 26 + num(edge.bend, 50);
      var uY = Math.min(s.y, t.y) - uLift;
      labelPoint = { x: (s.x + t.x) / 2, y: uY };
      return {
        d: 'M ' + s.x + ' ' + s.y + ' L ' + s.x + ' ' + uY +
           ' L ' + t.x + ' ' + uY + ' L ' + t.x + ' ' + t.y,
        label: labelPoint
      };
    }

    if (edge.route === 'elbow') {
      var gap = 26;
      var p1 = this.offsetPoint(s, sides[0], gap);
      var p2 = this.offsetPoint(t, sides[1], gap);
      var bendRatio = Math.min(100, Math.max(0, edge.bend)) / 100;
      var verticalFrom = sides[0] === 'top' || sides[0] === 'bottom';
      var verticalTo = sides[1] === 'top' || sides[1] === 'bottom';
      var mid;

      if (verticalFrom && verticalTo) {
        mid = { x: (p1.x + p2.x) / 2, y: p1.y + (p2.y - p1.y) * bendRatio };
        labelPoint = { x: mid.x, y: mid.y };
        return {
          d: 'M ' + s.x + ' ' + s.y + ' L ' + p1.x + ' ' + p1.y +
             ' L ' + p1.x + ' ' + mid.y + ' L ' + p2.x + ' ' + mid.y +
             ' L ' + p2.x + ' ' + p2.y + ' L ' + t.x + ' ' + t.y,
          label: labelPoint
        };
      }
      if (!verticalFrom && !verticalTo) {
        mid = { x: p1.x + (p2.x - p1.x) * bendRatio, y: (p1.y + p2.y) / 2 };
        labelPoint = { x: mid.x, y: mid.y };
        return {
          d: 'M ' + s.x + ' ' + s.y + ' L ' + p1.x + ' ' + p1.y +
             ' L ' + mid.x + ' ' + p1.y + ' L ' + mid.x + ' ' + p2.y +
             ' L ' + p2.x + ' ' + p2.y + ' L ' + t.x + ' ' + t.y,
          label: labelPoint
        };
      }
      if (verticalFrom && !verticalTo) {
        var corner1 = { x: p1.x, y: p2.y };
        labelPoint = { x: (p1.x + p2.x) / 2, y: p2.y };
        return {
          d: 'M ' + s.x + ' ' + s.y + ' L ' + p1.x + ' ' + p1.y +
             ' L ' + corner1.x + ' ' + corner1.y +
             ' L ' + p2.x + ' ' + p2.y + ' L ' + t.x + ' ' + t.y,
          label: labelPoint
        };
      }
      var corner2 = { x: p2.x, y: p1.y };
      labelPoint = { x: p2.x, y: (p1.y + p2.y) / 2 };
      return {
        d: 'M ' + s.x + ' ' + s.y + ' L ' + p1.x + ' ' + p1.y +
           ' L ' + corner2.x + ' ' + corner2.y +
           ' L ' + p2.x + ' ' + p2.y + ' L ' + t.x + ' ' + t.y,
        label: labelPoint
      };
    }

    var mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
    return { d: 'M ' + s.x + ' ' + s.y + ' L ' + t.x + ' ' + t.y, label: mid };
  };

  WorkSchemeView.prototype.offsetPoint = function (point, side, gap) {
    if (side === 'right') return { x: point.x + gap, y: point.y };
    if (side === 'left') return { x: point.x - gap, y: point.y };
    if (side === 'top') return { x: point.x, y: point.y - gap };
    return { x: point.x, y: point.y + gap }; // bottom
  };

  WorkSchemeView.prototype.render = function () {
    var self = this;
    // очистка предыдущего рендера (svg, панели управления, правки, подсказки)
    var dataEl = self.container.querySelector('script.ws-data');
    Array.prototype.slice.call(self.container.children).forEach(function (child) {
      if (child !== dataEl) self.container.removeChild(child);
    });
    self.applyPerformanceMode();
    var bounds = self.bounds();
    var pad = 34;
    var width = bounds.maxX - bounds.minX + pad * 2;
    var height = bounds.maxY - bounds.minY + pad * 2;
    self.canvasRatio = height / width;
    var viewBox = (bounds.minX - pad) + ' ' + (bounds.minY - pad) + ' ' + width + ' ' + height;

    var canvas = document.createElement('div');
    canvas.className = 'ws-canvas';
    self.canvas = canvas;

    var svg = svgEl('svg', {
      viewBox: viewBox,
      role: 'img',
      'aria-label': 'scheme'
    });
    svg.style.maxWidth = 'none';
    canvas.style.width = (this.zoom * 100) + '%';
    var markerId = 'ws-arrow-' + Math.random().toString(36).slice(2, 8);

    var defs = svgEl('defs');
    var gradientId = 'ws-bg-' + Math.random().toString(36).slice(2, 8);
    var gridId = 'ws-grid-' + Math.random().toString(36).slice(2, 8);
    var gradient = svgEl('linearGradient', { id: gradientId, x1: '0%', y1: '0%', x2: '100%', y2: '0%' });
    gradient.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#f8fbfd' }));
    gradient.appendChild(svgEl('stop', { offset: '55%', 'stop-color': '#f3f7fa' }));
    gradient.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#edf4f8' }));
    defs.appendChild(gradient);
    var grid = svgEl('pattern', { id: gridId, width: 32, height: 32, patternUnits: 'userSpaceOnUse' });
    grid.appendChild(svgEl('path', { d: 'M 32 0 L 0 0 0 32', fill: 'none', stroke: '#8aa0ad', 'stroke-width': 0.6, opacity: 0.14 }));
    defs.appendChild(grid);
    var marker = svgEl('marker', {
      id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse'
    });
    marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#7a8691' }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    var backgroundColor = THEME_CANVAS[self.scheme.theme] || THEME_CANVAS.classic;
    var background = svgEl('rect', {
      x: bounds.minX - pad, y: bounds.minY - pad,
      width: width, height: height,
      rx: 18, ry: 18,
      'class': 'ws-process-background',
      fill: backgroundColor
    });
    svg.appendChild(background);
    svg.appendChild(svgEl('rect', {
      x: bounds.minX - pad, y: bounds.minY - pad,
      width: width, height: height,
      rx: 18, ry: 18,
      'class': 'ws-process-grid',
      fill: 'url(#' + gridId + ')'
    }));

    var edgeGroup = svgEl('g', { 'class': 'ws-edges' });
    var labelGroup = svgEl('g', { 'class': 'ws-edge-labels' });
    self.edges.forEach(function (edge) {
      var drawn = self.edgePath(edge);
      if (!drawn) return;
      var pathAttrs = {
        d: drawn.d,
        'class': 'ws-edge' + (edge.dashed ? ' ws-edge-dashed' : ''),
        stroke: edge.color || undefined,
        'data-edge': edge.from + '>' + edge.to,
        'marker-end': 'url(#' + markerId + ')'
      };
      var pathEl = svgEl('path', pathAttrs);
      if (edge.color) pathEl.style.stroke = edge.color;
      edgeGroup.appendChild(pathEl);
      self.pathByEdge[edge.from + '>' + edge.to] = pathEl;
      if (edge.label) {
        labelGroup.appendChild(svgEl('text', {
          x: drawn.label.x, y: drawn.label.y - 4,
          'text-anchor': 'middle', 'class': 'ws-edge-label',
          'font-size': edge.labelFontSize + 'px',
          'font-weight': edge.labelFontWeight,
          'font-family': edge.labelFontFamily,
          fill: edge.labelTextColor || undefined
        }, edge.label));
      }
    });
    svg.appendChild(edgeGroup);

    var nodeGroup = svgEl('g', { 'class': 'ws-nodes' });
    self.nodes.forEach(function (node) {
      nodeGroup.appendChild(self.renderNode(node));
    });
    svg.appendChild(nodeGroup);
    // Подписи связей — поверх узлов, чтобы не затирались
    svg.appendChild(labelGroup);

    // Слой-оверлей: маркер, хвост, бейджи и «Готово» живут в отдельном
    // маленьком svg поверх основного — их перерисовка в кадре не задевает
    // большую статичную картину (главный источник лагов на слабых машинах).
    canvas.appendChild(svg);
    var overlaySvg = svgEl('svg', {
      viewBox: viewBox,
      'class': 'ws-overlay-svg',
      'aria-hidden': 'true'
    });
    self.overlay = svgEl('g', { 'class': 'ws-overlay' });
    overlaySvg.appendChild(self.overlay);
    canvas.appendChild(overlaySvg);

    self.viewport = null;
    if (self.viewerMode) {
      self.viewport = document.createElement('div');
      self.viewport.className = 'ws-viewport';
      self.viewport.setAttribute('tabindex', '0');
      self.viewport.setAttribute('aria-label', self.label('pan', 'Область схемы: перемещение пальцем'));
      self.viewport.appendChild(canvas);
      self.container.appendChild(self.viewport);
      self.attachPan();
    } else self.container.appendChild(canvas);
    self.svg = svg;
    self.overlaySvg = overlaySvg;
    self.attachTooltip();
    self.buildControls();
    self.buildSchemeTabs();

    if (self.editMode) {
      self.container.classList.add('ws-edit-mode');
      self.attachDrag();
    } else {
      self.container.classList.remove('ws-edit-mode');
    }

    self.renderBadges();
    if (self.viewerMode) self.layoutViewport();
  };

  WorkSchemeView.prototype.renderNode = function (node) {
    var group = svgEl('g', {
      'class': 'ws-node ws-node-' + node.type,
      'data-id': node.id,
      tabindex: '0',
      role: 'link'
    });
    var cx = node.x + node.w / 2;
    var cy = node.y + node.h / 2;

    if (node.type === 'decision') {
      group.appendChild(svgEl('polygon', {
        points: cx + ',' + node.y + ' ' + (node.x + node.w) + ',' + cy + ' ' +
                cx + ',' + (node.y + node.h) + ' ' + node.x + ',' + cy
      }));
    } else {
      group.appendChild(svgEl('rect', {
        x: node.x, y: node.y, width: node.w, height: node.h,
        rx: node.type === 'start' ? 20 : 8, ry: node.type === 'start' ? 20 : 8
      }));
    }

    if (node.icon) {
      selfAppendIcon(group, node.icon,
        node.type === 'decision' ? cx : node.x + 18,
        node.type === 'decision' ? node.y + 16 : node.y + 18);
    }

    var textX = cx + (node.icon && node.type !== 'decision' ? 9 : 0);
    var maxChars = node.type === 'decision' ? Math.max(7, Math.floor(140 / node.fontSize)) : Math.max(7, Math.floor((node.w - (node.icon ? 28 : 0)) / (node.fontSize * 0.6)));
    var lines = wrapText(node.title, maxChars);
    var lineHeight = Math.max(11, Math.round(node.fontSize * 1.2));
    var startY = cy - ((lines.length - 1) * lineHeight) / 2 + 4;
    lines.forEach(function (line, index) {
      group.appendChild(svgEl('text', {
        x: textX, y: startY + index * lineHeight,
        'text-anchor': 'middle',
        'font-size': node.fontSize + 'px',
        'font-weight': node.fontWeight,
        'font-family': node.fontFamily,
        fill: node.textColor || undefined
      }, line));
    });
    return group;
  };

  function selfAppendIcon(group, name, x, y) {
    var icon = svgEl('g', { 'class': 'ws-node-icon ws-icon-' + name, transform: 'translate(' + x + ' ' + y + ')' });
    var attrs = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    if (name === 'user') {
      icon.appendChild(svgEl('circle', { cx: 0, cy: -4, r: 3, fill: 'currentColor', stroke: 'none' }));
      icon.appendChild(svgEl('path', Object.assign({}, attrs, { d: 'M -6 7 C -5 1, 5 1, 6 7' })));
    } else if (name === 'document') {
      icon.appendChild(svgEl('rect', Object.assign({}, attrs, { x: -5, y: -7, width: 10, height: 14, rx: 1 })));
      icon.appendChild(svgEl('path', Object.assign({}, attrs, { d: 'M -2 -2 H 3 M -2 2 H 3' })));
    } else if (name === 'search') {
      icon.appendChild(svgEl('circle', Object.assign({}, attrs, { cx: -1, cy: -2, r: 4 })));
      icon.appendChild(svgEl('path', Object.assign({}, attrs, { d: 'M 2 1 L 6 5' })));
    } else if (name === 'decision') {
      icon.appendChild(svgEl('path', Object.assign({}, attrs, { d: 'M 0 -7 L 5 0 L 0 7 L -5 0 Z' })));
      icon.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 1.2, fill: 'currentColor', stroke: 'none' }));
    } else if (name === 'certificate') {
      icon.appendChild(svgEl('circle', Object.assign({}, attrs, { cx: 0, cy: -1, r: 5 })));
      icon.appendChild(svgEl('path', Object.assign({}, attrs, { d: 'M -2 3 L -3 8 L 0 6 L 3 8 L 2 3' })));
    } else if (name === 'gear') {
      icon.appendChild(svgEl('circle', Object.assign({}, attrs, { cx: 0, cy: 0, r: 5 })));
      icon.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 1.5, fill: 'currentColor', stroke: 'none' }));
      for (var i = 0; i < 4; i += 1) {
        var a = i * Math.PI / 2;
        icon.appendChild(svgEl('line', Object.assign({}, attrs, { x1: Math.cos(a) * 5, y1: Math.sin(a) * 5, x2: Math.cos(a) * 7, y2: Math.sin(a) * 7 })));
      }
    } else if (name === 'rocket') {
      icon.appendChild(svgEl('path', Object.assign({}, attrs, { d: 'M 0 -7 C 5 -4, 5 2, 0 5 C -5 2, -5 -4, 0 -7 Z' })));
      icon.appendChild(svgEl('circle', { cx: 0, cy: -2, r: 1.2, fill: 'currentColor', stroke: 'none' }));
      icon.appendChild(svgEl('path', Object.assign({}, attrs, { d: 'M -2 5 L -3 8 M 2 5 L 3 8' })));
    }
    group.appendChild(icon);
  }

  /* ---- Проигрывание сценариев ---- */

  WorkSchemeView.prototype.label = function (name, fallback) {
    var value = this.container.getAttribute('data-label-' + name);
    return value || fallback;
  };

  WorkSchemeView.prototype.buildControls = function () {
    var self = this;
    var scenarios = self.scheme.scenarios || [];

    var controls = document.createElement('div');
    controls.className = 'ws-controls';

    var zoom = document.createElement('div');
    zoom.className = 'ws-zoom-controls';
    var zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'ws-zoom-out';
    zoomOut.textContent = '−';
    zoomOut.title = self.label('zoom-out', 'Уменьшить');
    zoomOut.setAttribute('aria-label', zoomOut.title);
    zoomOut.addEventListener('click', function () { self.setZoom(self.zoom - 0.1); });
    zoom.appendChild(zoomOut);
    var zoomFit = document.createElement('button');
    zoomFit.type = 'button';
    zoomFit.className = 'ws-zoom-fit';
    zoomFit.textContent = self.label('zoom-fit', 'Вписать схему');
    zoomFit.title = self.label('zoom-fit', 'Вписать в блок');
    zoomFit.setAttribute('aria-label', zoomFit.title);
    zoomFit.addEventListener('click', function () { self.fitScheme(); });
    zoom.appendChild(zoomFit);
    var zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'ws-zoom-in';
    zoomIn.textContent = '+';
    zoomIn.title = self.label('zoom-in', 'Увеличить');
    zoomIn.setAttribute('aria-label', zoomIn.title);
    zoomIn.addEventListener('click', function () { self.setZoom(self.zoom + 0.1); });
    zoom.appendChild(zoomIn);
    controls.appendChild(zoom);
    if (self.viewerMode) self.buildViewerControls(controls);

    if (!scenarios.length) {
      self.container.insertBefore(controls, self.container.firstChild);
      var empty = document.createElement('div');
      empty.className = 'ws-empty-note';
      empty.textContent = self.label('no-scenarios', 'Сценарии проигрывания пока не добавлены.');
      self.container.insertBefore(empty, self.viewport || self.canvas);
      self.zoomControls = zoom;
      return;
    }

    var select = document.createElement('select');
    select.className = 'ws-scenario-select';
    scenarios.forEach(function (scenario) {
      var option = document.createElement('option');
      option.value = scenario.id;
      option.textContent = scenario.title;
      select.appendChild(option);
    });
    select.addEventListener('change', function () {
      var selected = scenarios.filter(function (scenario) { return scenario.id === select.value; })[0];
      // смена сценария посреди проигрывания: без сброса статус остаётся от
      // старого сценария, а таймлайн нового красится по чужому индексу
      self.resetPlayback();
      self.renderPlaybackTimeline(selected);
    });
    controls.appendChild(select);

    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'ws-play button';
    play.textContent = self.label('play', 'Проиграть');
    play.addEventListener('click', function () { self.play(select.value); });
    controls.appendChild(play);

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ws-reset';
    reset.textContent = self.label('reset', 'Сброс');
    reset.addEventListener('click', function () { self.resetPlayback(); });
    controls.appendChild(reset);

    var speedLabel = document.createElement('label');
    speedLabel.className = 'ws-speed-label';
    speedLabel.textContent = self.label('speed', 'Скорость');
    var speed = document.createElement('select');
    speed.className = 'ws-speed-select';
    speed.setAttribute('aria-label', speedLabel.textContent);
    [0.25, 0.5, 1].forEach(function (value) {
      var option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value * 2).replace('.', ',') + '×';
      if (value === self.playbackSpeed) option.selected = true;
      speed.appendChild(option);
    });
    speed.addEventListener('change', function () {
      var value = Number(speed.value);
      if (isFinite(value) && value > 0) self.playbackSpeed = value;
    });
    controls.appendChild(speedLabel);
    controls.appendChild(speed);

    var editUrl = self.container.getAttribute('data-edit-url') || '';
    if (editUrl) {
      var editLink = document.createElement('a');
      editLink.className = 'ws-edit-link button';
      editLink.href = editUrl;
      editLink.textContent = self.label('edit-page', 'Редактор схемы');
      controls.appendChild(editLink);
    }

    var status = document.createElement('div');
    status.className = 'ws-playback-status';
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    status.hidden = true;
    self.container.insertBefore(controls, self.container.firstChild);
    status.className = 'ws-playback-status ws-playback-status-below';
    var timeline = document.createElement('div');
    timeline.className = 'ws-playback-timeline';
    timeline.setAttribute('aria-label', self.label('progress', 'Прогресс сценария'));
    if (self.canvas) {
      self.container.insertBefore(status, self.viewport || self.canvas);
      self.container.insertBefore(timeline, self.viewport || self.canvas);
    }
    else self.container.appendChild(status);
    self.playButton = play;
    self.playbackStatus = status;
    self.playbackTimeline = timeline;
    self.speedSelect = speed;
    self.zoomControls = zoom;
    self.renderPlaybackTimeline(scenarios[0]);
  };

  WorkSchemeView.prototype.setZoom = function (value, fitting) {
    this._fitMode = !!fitting;
    this.zoom = Math.max(0.001, Math.min(4, Number(value) || 1));
    var canvas = this.canvas || this.container.querySelector('.ws-canvas');
    if (canvas) {
      canvas.style.width = (this.zoom * 100) + '%';
      if (this.viewport) {
        var width = (this.viewport.offsetWidth || this.viewport.clientWidth) * this.zoom;
        canvas.style.width = Math.floor(width) + 'px';
        canvas.style.height = Math.floor(width * this.canvasRatio) + 'px';
      }
    }
    var level = this.container.querySelector('.ws-zoom-level');
    if (level) level.textContent = Math.round(this.zoom * 100) + '%';
  };

  WorkSchemeView.prototype.fitScheme = function () {
    if (!this.viewport) return this.setZoom(1);
    var width = this.viewport.offsetWidth || this.viewport.clientWidth;
    var height = this.viewport.offsetHeight || this.viewport.clientHeight;
    if (!width || !height) return;
    this.setZoom(Math.min(1, height / (width * this.canvasRatio)), true);
    this.viewport.scrollLeft = 0;
    this.viewport.scrollTop = 0;
  };

  WorkSchemeView.prototype.layoutViewport = function () {
    if (!this.viewport) return;
    var chromeHeight = 0;
    Array.prototype.forEach.call(this.container.children, function (child) {
      if (child.matches('.ws-controls, .ws-scheme-tabs, .ws-playback-status, .ws-playback-timeline, .ws-empty-note') && !child.hidden) {
        chromeHeight += child.getBoundingClientRect().height + 10;
      }
    });
    this.container.style.setProperty('--ws-controls-height', chromeHeight + 'px');
    if (this._fitMode) this.fitScheme();
    else this.setZoom(this.zoom);
  };

  WorkSchemeView.prototype.attachViewerEvents = function () {
    var self = this;
    self._onResize = function () { if (!self._destroyed) self.layoutViewport(); };
    self._onFullscreen = function () {
      if (document.fullscreenElement !== self.container && !self._fallbackFullscreen) self.setFullscreenState(false);
      self.layoutViewport();
    };
    self._onEscape = function (event) {
      if (event.key === 'Escape' && self._fallbackFullscreen) self.leaveFullscreen();
    };
    self._onVisibility = function () {
      clearTimeout(self._countsTimer);
      if (!document.hidden) self.scheduleCounts();
    };
    window.addEventListener('resize', self._onResize);
    document.addEventListener('fullscreenchange', self._onFullscreen);
    document.addEventListener('keydown', self._onEscape);
    document.addEventListener('visibilitychange', self._onVisibility);
    if (window.ResizeObserver) {
      self._resizeObserver = new window.ResizeObserver(self._onResize);
      self._resizeObserver.observe(self.container);
    }
  };

  WorkSchemeView.prototype.setFullscreenState = function (enabled) {
    this.container.classList.toggle('ws-fullscreen', enabled);
    var button = this.container.querySelector('.ws-fullscreen-toggle');
    if (button) {
      button.textContent = enabled ? this.label('fullscreen-exit', 'Выйти из полного экрана') : this.label('fullscreen', 'На весь экран');
      button.setAttribute('aria-pressed', String(enabled));
    }
    this.layoutViewport();
  };

  WorkSchemeView.prototype.leaveFullscreen = function () {
    this._fullscreenRequest = false;
    if (document.fullscreenElement === this.container && document.exitFullscreen) {
      var result = document.exitFullscreen();
      if (result && result.catch) result.catch(function () {});
    }
    if (this._fallbackFullscreen) {
      document.body.style.overflow = this._bodyOverflow || '';
      this._fallbackFullscreen = false;
    }
    this.setFullscreenState(false);
  };

  WorkSchemeView.prototype.toggleFullscreen = function () {
    var self = this;
    if (self.container.classList.contains('ws-fullscreen')) return self.leaveFullscreen();
    function fallback() {
      if (self._destroyed || !self._fullscreenRequest) return;
      Array.prototype.forEach.call(document.querySelectorAll('.ws-fullscreen'), function (container) {
        if (container.__wsViewInstance) container.__wsViewInstance.leaveFullscreen();
      });
      self._bodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      self._fallbackFullscreen = true;
      self.setFullscreenState(true);
      self.fitScheme();
    }
    self._fullscreenRequest = true;
    if (self.container.requestFullscreen && document.fullscreenEnabled !== false) {
      try {
        var request = self.container.requestFullscreen();
        if (request && request.then) request.then(function () {
          if (self._destroyed || !self._fullscreenRequest) return self.leaveFullscreen();
          self.setFullscreenState(true);
          self.fitScheme();
        }).catch(fallback);
        else { self.setFullscreenState(true); self.fitScheme(); }
      } catch (e) { fallback(); }
    } else fallback();
  };

  // Нативный touch-scroll сохраняет прокрутку страницы у границы полотна.
  // После движения блокируем только синтетический click; обычный тап остаётся.
  WorkSchemeView.prototype.attachPan = function () {
    var self = this;
    var viewport = self.viewport;
    var start = null;
    viewport.addEventListener('touchstart', function (event) {
      var touch = event.touches[0];
      start = touch ? { x: touch.clientX, y: touch.clientY } : null;
      self._panMoved = false;
      self._suppressTapUntil = 0;
    }, { passive: true });
    viewport.addEventListener('touchmove', function (event) {
      var touch = event.touches[0];
      if (start && touch && (Math.abs(touch.clientX - start.x) > 8 || Math.abs(touch.clientY - start.y) > 8)) {
        self._panMoved = true;
        self._suppressTapUntil = Date.now() + 800;
        var tooltip = self.container.querySelector('.ws-tooltip');
        if (tooltip) tooltip.style.display = 'none';
      }
    }, { passive: true });
    viewport.addEventListener('touchend', function () {
      if (self._panMoved) self._suppressTapUntil = Date.now() + 800;
      start = null;
    }, { passive: true });
    viewport.addEventListener('touchcancel', function () { start = null; }, { passive: true });
    viewport.addEventListener('click', function (event) {
      if (Date.now() < (self._suppressTapUntil || 0)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  };

  WorkSchemeView.prototype.buildViewerControls = function (controls) {
    var self = this;
    var level = document.createElement('span');
    level.className = 'ws-zoom-level';
    level.textContent = Math.round(self.zoom * 100) + '%';
    controls.querySelector('.ws-zoom-controls').appendChild(level);
    var fullscreen = document.createElement('button');
    fullscreen.type = 'button';
    fullscreen.className = 'ws-fullscreen-toggle';
    var expanded = self.container.classList.contains('ws-fullscreen');
    fullscreen.textContent = expanded ? self.label('fullscreen-exit', 'Выйти из полного экрана') : self.label('fullscreen', 'На весь экран');
    fullscreen.setAttribute('aria-pressed', String(expanded));
    fullscreen.addEventListener('click', function () { self.toggleFullscreen(); });
    controls.appendChild(fullscreen);
    if (!self.countsUrl || !self.nodes.some(function (node) { return parseInt(node.queryId, 10) > 0; })) return;
    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'ws-counts-refresh';
    refresh.textContent = self.label('counts-refresh', 'Обновить счётчики');
    refresh.addEventListener('click', function () { self.loadCounts(true); });
    controls.appendChild(refresh);
    var label = document.createElement('label');
    label.className = 'ws-counts-auto-label';
    label.appendChild(document.createTextNode(self.label('counts-auto', 'Обновление')));
    var interval = document.createElement('select');
    interval.className = 'ws-counts-interval';
    interval.setAttribute('aria-label', self.label('counts-auto', 'Обновление'));
    [[0, 'counts-manual', 'Вручную'], [30, 'counts-30s', '30 с'], [60, 'counts-1m', '1 мин'], [300, 'counts-5m', '5 мин']].forEach(function (entry) {
      var option = document.createElement('option');
      option.value = String(entry[0]);
      option.textContent = self.label(entry[1], entry[2]);
      option.selected = self.refreshSeconds === entry[0];
      interval.appendChild(option);
    });
    interval.addEventListener('change', function () {
      self.refreshSeconds = Number(interval.value);
      self.scheduleCounts();
    });
    label.appendChild(interval);
    controls.appendChild(label);
    var status = document.createElement('span');
    status.className = 'ws-counts-status';
    status.setAttribute('aria-live', 'polite');
    controls.appendChild(status);
    self.updateCountsStatus();
  };

  WorkSchemeView.prototype.updateCountsStatus = function () {
    var status = this.container.querySelector('.ws-counts-status');
    if (status) {
      var time = this.countsUpdatedAt ? this.countsUpdatedAt.toLocaleTimeString() : '';
      status.textContent = this.countsError ? this.label('counts-error', 'Не удалось обновить') + (time ? ' · ' + this.label('counts-updated', 'Обновлено') + ' ' + time : '') :
        (time ? this.label('counts-updated', 'Обновлено') + ' ' + time : '');
    }
    var button = this.container.querySelector('.ws-counts-refresh');
    if (button) button.disabled = !!this._countsLoading;
  };

  WorkSchemeView.prototype.scheduleCounts = function () {
    var self = this;
    clearTimeout(self._countsTimer);
    if (!self.viewerMode || self._destroyed || self._countsLoading || !self.refreshSeconds || document.hidden ||
        !self.countsUrl || !self.nodes.some(function (node) { return parseInt(node.queryId, 10) > 0; })) return;
    self._countsTimer = setTimeout(function () {
      if (self.container.isConnected) self.loadCounts(true);
    }, self.refreshSeconds * 1000);
  };

  WorkSchemeView.prototype.playbackDelay = function (ms) {
    return Math.max(0, Math.round(ms / (this.playbackSpeed || 1)));
  };

  WorkSchemeView.prototype.updatePlaybackStatus = function (scenario, index, node, total, done) {
    var status = this.playbackStatus;
    if (!status) return;
    status.hidden = false;
    var title = scenario && scenario.title ? scenario.title : '';
    var stage = node ? (node.title || node.id) : '';
    var prefix = done ? this.label('playback-done', 'Готово') : this.label('playback-step', 'Этап');
    status.textContent = prefix + ': ' + stage + (title ? ' · ' + title : '') +
      (total ? ' (' + Math.min(index + 1, total) + '/' + total + ')' : '');
    this.updatePlaybackTimeline(index, done);
  };

  WorkSchemeView.prototype.renderPlaybackTimeline = function (scenario) {
    if (!this.playbackTimeline) return;
    this.playbackTimeline.innerHTML = '';
    if (!scenario || !scenario.steps || !scenario.steps.length) return;
    var self = this;
    scenario.steps.forEach(function (id, index) {
      var node = self.byId[id];
      var item = document.createElement('span');
      item.className = 'ws-timeline-step';
      item.setAttribute('data-step', String(index));
      item.title = node ? (node.title || node.id) : id;
      item.textContent = String(index + 1);
      self.playbackTimeline.appendChild(item);
    });
  };

  WorkSchemeView.prototype.updatePlaybackTimeline = function (index, done) {
    if (!this.playbackTimeline) return;
    Array.prototype.forEach.call(this.playbackTimeline.querySelectorAll('.ws-timeline-step'), function (item, itemIndex) {
      item.classList.toggle('ws-timeline-done', itemIndex < index || (done && itemIndex === index));
      item.classList.toggle('ws-timeline-current', itemIndex === index && !done);
    });
  };

  /* ---- Режим правки: перетаскивание узлов и координаты ---- */

  WorkSchemeView.prototype.attachDrag = function () {
    var self = this;
    Array.prototype.forEach.call(self.container.querySelectorAll('.ws-node'), function (group) {
      var node = self.byId[group.getAttribute('data-id')];
      if (!node) return;
      group.addEventListener('pointerdown', function (event) {
        if (!self.editMode) return;
        if (self.container.closest && self.container.closest('.ws-scenario-capture')) return;
        event.preventDefault();
        var start = self.svgPoint(event.clientX, event.clientY);
        if (!start) return;
        var startNode = { x: node.x, y: node.y };

        var onMove = function (ev) {
          var p = self.svgPoint(ev.clientX, ev.clientY);
          if (!p) return;
          var dx = p.x - start.x;
          var dy = p.y - start.y;
          group.setAttribute('transform', 'translate(' + dx + ',' + dy + ')');
          group._wsDrag = { x: dx, y: dy };
        };
        var onUp = function () {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          var delta = group._wsDrag || { x: 0, y: 0 };
          delete group._wsDrag;
          // Вид могли пересоздать (undo/redo во время drag): его canvas уже
          // отцеплён — повторный render вставил бы устаревшую картину в контейнер
          if (!self.canvas || self.canvas.parentNode !== self.container) return;
          if (delta.x || delta.y) {
            node.x = Math.round((startNode.x + delta.x) / 2) * 2;
            node.y = Math.round((startNode.y + delta.y) / 2) * 2;
            self.render();
            // редактор вешает хук: вернуть выделение, hit-пути и dirty
            if (typeof self.onNodeDragEnd === 'function') self.onNodeDragEnd();
          }
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    });
  };

  WorkSchemeView.prototype.timer = function (fn, ms) {
    var self = this;
    var id = window.setTimeout(function () {
      self.timers = self.timers.filter(function (t) { return t !== id; });
      fn();
    }, ms);
    self.timers.push(id);
  };

  WorkSchemeView.prototype.play = function (scenarioId) {
    var self = this;
    self.resetPlayback();
    var scenario = (self.scheme.scenarios || []).filter(function (s) { return s.id === scenarioId; })[0];
    if (!scenario || !scenario.steps.length) return;

    self.playing = true;
    self.container.classList.add('ws-playback-focus');
    self.reworkTriggered = false;
    if (self.playButton) self.playButton.disabled = true;

    var steps = scenario.steps;
    var index = 0;
    // холст мог остаться прокрученным от прошлого просмотра: тогда первый
    // блок был за левым краем узкого контейнера (дашборд-блок) и проигрывание
    // выглядело как старт со второго блока — центрируем первый шаг
    var firstNode = self.byId[steps[0]];
    if (firstNode) self.focusPlaybackNode(firstNode);

    var step = function () {
      if (!self.playing) return;
      if (index >= steps.length) {
        var finalNode = self.byId[steps[steps.length - 1]];
        var completedScheme = finalNode && finalNode.type === 'end';
        self.updatePlaybackStatus(scenario, steps.length - 1, finalNode, steps.length, completedScheme);
        self.markNodeComplete(finalNode);
        self.settlePlaybackToken(finalNode, function () {
          if (completedScheme) {
            self.showSuccessBubble(finalNode);
            self.animateCompletionChain();
          }
          self.finishPlayback();
        });
        return;
      }
      var node = self.byId[steps[index]];
      if (!node) { index += 1; step(); return; }
      self.updatePlaybackStatus(scenario, index, node, steps.length, false);

      var pathEl = null;
      var prev = null;
      if (index > 0) {
        prev = self.byId[steps[index - 1]];
        if (prev) pathEl = self.pathByEdge[prev.id + '>' + node.id];
      }
      if (pathEl) {
        var isRework = !self.reworkTriggered && steps.slice(0, index).indexOf(node.id) !== -1;
        if (isRework) self.reworkTriggered = true;
        if (isRework) self.beginRework(prev); else self.markNodeComplete(prev);
        if (prev && prev.type === 'decision') self.showDecisionBranches(prev, node);
        // рыжая подсветка цели — сразу на старте ребра (вернуто по решению
        // пользователя); камера кадрирует цель мгновенно и больше не трогает
        // холст до конца анимации, поэтому схему под маркером не сдвигает
        self.focusPlaybackNode(node);
        self.highlightNode(node);
        self.showPlaybackToken(prev, true);
        self.highlightEdge(pathEl, isRework);
        var afterEdge = function () {
          if (isRework) self.resetRouteStates(); else self.markEdgeComplete(pathEl);
          self.showPlaybackToken(node, true);
          index += 1;
          self.timer(step, self.playbackDelay(node.type === 'decision' ? 1050 : 420));
        };
        self.animateMarker(pathEl, node, afterEdge, prev);
      } else {
        self.highlightNode(node);
        self.showPlaybackToken(node);
        index += 1;
        self.timer(step, self.playbackDelay(node.type === 'decision' ? 1050 : 850));
      }
    };
    self.timer(step, self.playbackDelay(150));
  };

  WorkSchemeView.prototype.highlightNode = function (node) {
    var group = this.nodeEl(node.id);
    if (group) group.classList.add('ws-node-active');
    this.focusPlaybackNode(node);
  };

  WorkSchemeView.prototype.showDecisionBranches = function (decision, chosen) {
    var self = this;
    var outgoing = self.edges.filter(function (edge) { return edge.from === decision.id; });
    outgoing.forEach(function (edge) {
      var path = self.pathByEdge[edge.from + '>' + edge.to];
      if (!path) return;
      path.classList.add('ws-edge-branch-option');
      if (edge.to === chosen.id) path.classList.add('ws-edge-branch-selected');
    });
    self.timer(function () {
      outgoing.forEach(function (edge) {
        var path = self.pathByEdge[edge.from + '>' + edge.to];
        if (path) path.classList.remove('ws-edge-branch-option', 'ws-edge-branch-selected');
      });
    }, self.playbackDelay(720));
  };

  WorkSchemeView.prototype.markNodeComplete = function (node) {
    if (!node) return;
    var group = this.nodeEl(node.id);
    if (group) {
      group.classList.remove('ws-node-active', 'ws-node-rework');
      group.classList.add('ws-node-complete', 'ws-node-history');
    }
  };

  WorkSchemeView.prototype.beginRework = function (node) {
    var self = this;
    Array.prototype.forEach.call(self.container.querySelectorAll('.ws-node-complete'), function (el) {
      el.classList.remove('ws-node-complete', 'ws-node-history');
    });
    Array.prototype.forEach.call(self.container.querySelectorAll('.ws-edge-complete'), function (el) {
      el.classList.remove('ws-edge-complete');
      el.style.strokeDasharray = '';
      el.style.strokeDashoffset = '';
    });
    if (node) {
      var group = self.nodeEl(node.id);
      if (group) {
        group.classList.remove('ws-node-active');
        group.classList.add('ws-node-rework');
      }
    }
  };

  WorkSchemeView.prototype.resetRouteStates = function () {
    var self = this;
    Array.prototype.forEach.call(self.container.querySelectorAll('.ws-node-active, .ws-node-complete, .ws-node-history, .ws-node-rework'), function (el) {
      el.classList.remove('ws-node-active', 'ws-node-complete', 'ws-node-history', 'ws-node-rework');
    });
    Array.prototype.forEach.call(self.container.querySelectorAll('.ws-edge-active, .ws-edge-complete, .ws-edge-rework'), function (el) {
      el.classList.remove('ws-edge-active', 'ws-edge-complete', 'ws-edge-rework');
      el.style.strokeDasharray = '';
      el.style.strokeDashoffset = '';
    });
    Array.prototype.forEach.call(self.container.querySelectorAll('.ws-edge-branch-option, .ws-edge-branch-selected'), function (el) {
      el.classList.remove('ws-edge-branch-option', 'ws-edge-branch-selected');
    });
  };

  WorkSchemeView.prototype.highlightEdge = function (pathEl, rework) {
    pathEl.classList.add('ws-edge-active', 'ws-edge-drawing');
    if (rework) pathEl.classList.add('ws-edge-rework');
    // В lite рисуем ребро сразу: dash-перерисовки дороги, у возвратной ветки
    // своя CSS-анимация потока. Иначе путь прорисовывается в такт маркеру —
    // animateMarker двигает stroke-dashoffset по прогрессу движения.
    if (this.lite || rework) return;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var length = pathEl.getTotalLength ? pathEl.getTotalLength() : 0;
    if (reduced || !(length > 0)) return;
    pathEl._wsDrawLength = length;
    pathEl.style.strokeDasharray = length + ' ' + length;
    pathEl.style.strokeDashoffset = String(length);
  };

  WorkSchemeView.prototype.markEdgeComplete = function (pathEl) {
    if (!pathEl) return;
    pathEl.classList.remove('ws-edge-drawing');
    pathEl.classList.add('ws-edge-complete');
    // inline-dash побеждал бы CSS-пунктир ws-edge-dashed — чистим оба свойства
    pathEl._wsDrawLength = null;
    pathEl.style.strokeDasharray = '';
    pathEl.style.strokeDashoffset = '';
  };

  WorkSchemeView.prototype.showPlaybackToken = function (node, preservePoint) {
    var self = this;
    if (!self.playbackToken || !self.playbackToken.parentNode) {
      var group = svgEl('g', { 'class': 'ws-playback-token' });
      self.playbackTrail = [];
      self.playbackTrailPath = null;
      if (!self.lite) {
        self.playbackTrailPath = svgEl('path', { 'class': 'ws-marker-trail-line' });
        group.appendChild(self.playbackTrailPath);
        [8, 6, 4].forEach(function (radius, index) {
          var trail = svgEl('circle', { r: radius, 'class': 'ws-marker-trail ws-marker-trail-' + index });
          group.appendChild(trail);
          self.playbackTrail.push(trail);
        });
      }
      group.appendChild(svgEl('path', { d: 'M 0 -7 L 11 0 L 0 7 Z', 'class': 'ws-marker-direction' }));
      group.appendChild(svgEl('circle', { r: 10, 'class': 'ws-marker' }));
      self.overlay.appendChild(group);
      self.playbackToken = group;
      self.playbackHistory = [];
    }
    if (preservePoint && self.playbackPoint) {
      self.setPlaybackPoint(self.playbackPoint);
      return;
    }
    var center = self.nodeCenter(node);
    self.setPlaybackPoint(center);
  };

  WorkSchemeView.prototype.setPlaybackPoint = function (point) {
    if (!this.playbackToken || !point) return;
    // Кольцевая запись вместо unshift+slice: ноль лишнего мусора в кадре.
    var history = this.playbackHistory;
    history.push({ x: point.x, y: point.y });
    if (history.length > 7) history.shift();
    this.playbackToken.setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ')');
    if (this.playbackTrail && this.playbackTrail.length) {
      var last = history.length - 1;
      this.playbackTrail.forEach(function (trail, index) {
        var sample = history[Math.max(0, last - (index + 1) * 2)] || point;
        trail.setAttribute('transform', 'translate(' + (sample.x - point.x) + ' ' + (sample.y - point.y) + ')');
      });
    }
    if (this.playbackTrailPath) {
      var d = '';
      for (var i = history.length - 1; i >= 0; i -= 1) {
        d += (i === history.length - 1 ? 'M ' : 'L ') + (history[i].x - point.x) + ' ' + (history[i].y - point.y) + ' ';
      }
      this.playbackTrailPath.setAttribute('d', d);
    }
    this.playbackPoint = { x: point.x, y: point.y };
  };

  // Адаптация в auto: копим длительности кадров; если средняя больше ~34 мс
  // (ниже 30 fps), один раз переводим view в lite — обратно не дёргаем.
  WorkSchemeView.prototype.noteFrameTime = function (timestamp) {
    if (this.performanceMode !== 'auto' || this.lite) return;
    if (this.lastFrameTs) this.frameTimes.push(timestamp - this.lastFrameTs);
    this.lastFrameTs = timestamp;
    // скользящее окно: массив живёт столько же, сколько страница, и без
    // ограничения растёт вместе с ценой пересчёта среднего на каждом кадре
    if (this.frameTimes.length > 20) this.frameTimes.shift();
    if (this.frameTimes.length < 20) return;
    var sum = 0;
    this.frameTimes.forEach(function (value) { sum += value; });
    if (sum / this.frameTimes.length > 34) this.engageLite();
  };

  WorkSchemeView.prototype.engageLite = function () {
    this._adaptiveLite = true;
    this.lite = true;
    this.frameTimes = [];
    this.container.classList.add('ws-lite');
  };

  // Пропуск кадров до ~30 fps в lite: rAF тикает чаще, чем нужно слабой машине.
  WorkSchemeView.prototype.frameDue = function (timestamp) {
    if (!this.lite) return true;
    if (timestamp - this.lastFrameTs < 33) return false;
    this.lastFrameTs = timestamp;
    return true;
  };

  // Камера проигрывания: мгновенная прокрутка к узлу. Только 'auto':
  // плавная прокрутка во время анимации маркера сдвигает схему под ним —
  // в узком контейнере (дашборд-блок) это выглядело как «маркер едет не
  // по стрелке», подсветка цели «убегала» вперёд, а цепочка плавных
  // прокруток на каждом шаге подвешивала анимацию.
  WorkSchemeView.prototype.focusPlaybackNode = function (node) {
    var scroller = this.viewport || this.container;
    if (!node || !scroller || !scroller.scrollTo) return;
    var svg = this.container.querySelector('svg');
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal.width) return;
    var view = svg.viewBox.baseVal;
    var rect = svg.getBoundingClientRect();
    var scale = rect.width / view.width;
    var target = (node.x + node.w / 2 - view.x) * scale;
    scroller.scrollTo({ left: Math.max(0, target - scroller.clientWidth / 2),
      top: this.viewport ? Math.max(0, (node.y + node.h / 2 - view.y) * scale - scroller.clientHeight / 2) : scroller.scrollTop });
  };

  WorkSchemeView.prototype.showSuccessBubble = function (node) {
    var self = this;
    if (!node || !self.overlay) return;
    if (self.playbackSuccess) self.playbackSuccess.remove();
    var center = self.nodeCenter(node);
    var doneText = self.label('playback-done', 'Готово');
    var group = svgEl('g', { 'class': 'ws-playback-success', 'aria-label': doneText });
    group.appendChild(svgEl('path', {
      d: 'M ' + (center.x - 72) + ' ' + (node.y - 42) + ' Q ' + (center.x - 72) + ' ' + (node.y - 54) + ' ' + (center.x - 60) + ' ' + (node.y - 54) + ' L ' + (center.x + 60) + ' ' + (node.y - 54) + ' Q ' + (center.x + 72) + ' ' + (node.y - 54) + ' ' + (center.x + 72) + ' ' + (node.y - 42) + ' L ' + (center.x + 72) + ' ' + (node.y - 24) + ' Q ' + (center.x + 72) + ' ' + (node.y - 14) + ' ' + (center.x + 60) + ' ' + (node.y - 14) + ' L ' + (center.x - 60) + ' ' + (node.y - 14) + ' Q ' + (center.x - 72) + ' ' + (node.y - 14) + ' ' + (center.x - 72) + ' ' + (node.y - 24) + ' Z',
      'class': 'ws-success-bubble'
    }));
    group.appendChild(svgEl('circle', { cx: center.x - 46, cy: node.y - 34, r: 8, 'class': 'ws-success-icon' }));
    group.appendChild(svgEl('path', { d: 'M ' + (center.x - 50) + ' ' + (node.y - 34) + ' l 3 3 l 6 -7', 'class': 'ws-success-check' }));
    group.appendChild(svgEl('text', { x: center.x + 14, y: node.y - 29, 'text-anchor': 'middle', 'class': 'ws-success-label' }, doneText));
    self.overlay.appendChild(group);
    self.playbackSuccess = group;
  };

  WorkSchemeView.prototype.animateCompletionChain = function () {
    var self = this;
    if (self.lite) return; // финальный флеш — чистая анимация фильтров, в lite не нужна
    var items = Array.prototype.slice.call(self.container.querySelectorAll('.ws-node-complete, .ws-edge-complete'));
    items.forEach(function (item, index) {
      self.timer(function () { item.classList.add('ws-completion-flash'); }, index * 55);
      self.timer(function () { item.classList.remove('ws-completion-flash'); }, index * 55 + 520);
    });
  };

  WorkSchemeView.prototype.settlePlaybackToken = function (node, done) {
    var self = this;
    if (!node) { done(); return; }
    if (!self.playbackToken || !self.playbackToken.parentNode) {
      self.showPlaybackToken(node);
      done();
      return;
    }
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var from = self.playbackPoint || self.nodeCenter(node);
    var to = self.nodeCenter(node);
    var duration = reduced ? 0 : self.playbackDelay(420);
    var start = null;
    var tick = function (timestamp) {
      if (!self.playing) return;
      self.noteFrameTime(timestamp);
      if (!self.frameDue(timestamp)) {
        window.requestAnimationFrame(tick);
        return;
      }
      if (start === null) start = timestamp;
      var linear = duration === 0 ? 1 : Math.min(1, (timestamp - start) / duration);
      var progress = linear * linear * (3 - 2 * linear);
      self.setPlaybackPoint({
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress
      });
      if (progress < 1) window.requestAnimationFrame(tick);
      else { self.showPlaybackToken(node, true); done(); }
    };
    if (duration === 0) tick(0); else window.requestAnimationFrame(tick);
  };

  WorkSchemeView.prototype.animateMarker = function (pathEl, node, done, transitNode) {
    var self = this;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var marker = self.playbackToken;
    if (!marker) { self.showPlaybackToken(node); marker = self.playbackToken; }
    var total = pathEl.getTotalLength();
    // Вырожденное ребро (нулевой размер узла): пути нет — просто завершаем
    // шаг, иначе length/total даёт NaN и цепочка rAF умирает с заблокированной
    // кнопкой «Проиграть»
    if (!(total > 0)) { done(); return; }
    var duration = reduced ? 0 : this.playbackDelay(900);
    var start = null;
    var startPoint = pathEl.getPointAtLength(0);
    var fromPoint = self.playbackPoint || startPoint;
    var bridgeDistance = Math.hypot(fromPoint.x - startPoint.x, fromPoint.y - startPoint.y);
    var bridgeDuration = reduced || bridgeDistance < 1 ? 0 : this.playbackDelay(420);
    var bridgeStart = null;
    var center = transitNode ? self.nodeCenter(transitNode) : {
      x: (fromPoint.x + startPoint.x) / 2,
      y: (fromPoint.y + startPoint.y) / 2
    };
    // This control point makes the quadratic curve pass exactly through center at t=0.5.
    var control = {
      x: 2 * center.x - (fromPoint.x + startPoint.x) / 2,
      y: 2 * center.y - (fromPoint.y + startPoint.y) / 2
    };

    // Предвыборка пути: 65 точек за один проход вместо двух getPointAtLength
    // на каждый кадр — нативный вызов недёшев на слабых устройствах.
    var SAMPLES = 64;
    var samples = [];
    for (var i = 0; i <= SAMPLES; i += 1) {
      samples.push(pathEl.getPointAtLength(total * i / SAMPLES));
    }
    var sampleAt = function (length) {
      var pos = Math.max(0, Math.min(SAMPLES, length / total * SAMPLES));
      var index = Math.floor(pos);
      if (index >= SAMPLES) return samples[SAMPLES];
      var a = samples[index];
      var b = samples[index + 1];
      var t = pos - index;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    };

    var ease = function (value) {
      return value * value * (3 - 2 * value);
    };

    var curve = function (a, c, b, progress) {
      var inverse = 1 - progress;
      return {
        x: inverse * inverse * a.x + 2 * inverse * progress * c.x + progress * progress * b.x,
        y: inverse * inverse * a.y + 2 * inverse * progress * c.y + progress * progress * b.y
      };
    };

    var move = function (point) {
      self.setPlaybackPoint({ x: point.x, y: point.y });
    };
    var direction = marker && marker.querySelector('.ws-marker-direction');
    var lastAngle = null;
    // Поворот дешевле брать раз в несколько кадров и только при заметном
    // изменении угла — это отдельная мутация атрибута на каждый тик.
    var rotate = function (point, nextPoint) {
      if (!direction || !nextPoint || self.lite) return;
      var angle = Math.atan2(nextPoint.y - point.y, nextPoint.x - point.x) * 180 / Math.PI;
      if (lastAngle !== null && Math.abs(angle - lastAngle) < 3) return;
      lastAngle = angle;
      direction.setAttribute('transform', 'rotate(' + angle + ')');
    };

    var tick = function (timestamp) {
      if (!self.playing) return;
      self.noteFrameTime(timestamp);
      if (!self.frameDue(timestamp)) {
        window.requestAnimationFrame(tick);
        return;
      }
      if (start === null) start = timestamp;
      var linear = duration === 0 ? 1 : Math.min(1, (timestamp - start) / duration);
      // Smoothstep keeps the marker from snapping at the beginning/end of an edge.
      var progress = linear * linear * (3 - 2 * linear);
      var length = total * progress;
      var point = sampleAt(length);
      move(point);
      // прорисовка ребра синхронно с маркером: фронт штриха ровно под ним
      if (pathEl._wsDrawLength) {
        pathEl.style.strokeDashoffset = String(pathEl._wsDrawLength * (1 - progress));
      }
      rotate(point, sampleAt(Math.min(total, length + 2)));
      if (progress < 1) {
        window.requestAnimationFrame(tick);
      } else {
        done();
      }
    };
    var bridge = function (timestamp) {
      if (!self.playing) return;
      self.noteFrameTime(timestamp);
      if (!self.frameDue(timestamp)) {
        window.requestAnimationFrame(bridge);
        return;
      }
      if (bridgeStart === null) bridgeStart = timestamp;
      var linear = bridgeDuration === 0 ? 1 : Math.min(1, (timestamp - bridgeStart) / bridgeDuration);
      var progress = ease(linear);
      move(curve(fromPoint, control, startPoint, progress));
      if (progress < 1) {
        window.requestAnimationFrame(bridge);
      } else if (duration === 0) {
        tick(0);
      } else {
        window.requestAnimationFrame(tick);
      }
    };
    if (bridgeDuration === 0 && duration === 0) {
      move(startPoint);
      tick(0);
    } else if (bridgeDuration === 0) {
      move(startPoint);
      window.requestAnimationFrame(tick);
    } else {
      window.requestAnimationFrame(bridge);
    }
  };

  WorkSchemeView.prototype.finishPlayback = function () {
    var self = this;
    self.playing = false;
    if (self.playButton) self.playButton.disabled = false;
    // Финальная подсветка гаснет сама через пару секунд
    self.timer(function () { self.clearHighlights(); }, 5000);
  };

  WorkSchemeView.prototype.clearHighlights = function () {
    var self = this;
    self.resetRouteStates();
    self.container.classList.remove('ws-playback-focus');
    var token = self.playbackToken;
    if (token) token.remove();
    self.playbackToken = null;
    if (self.playbackSuccess) self.playbackSuccess.remove();
    self.playbackSuccess = null;
    self.playbackTrail = null;
    self.playbackTrailPath = null;
    self.playbackHistory = [];
    self.playbackPoint = null;
  };

  WorkSchemeView.prototype.resetPlayback = function () {
    var self = this;
    self.playing = false;
    self.timers.forEach(function (id) { window.clearTimeout(id); });
    self.timers = [];
    if (self.playButton) self.playButton.disabled = false;
    self.clearHighlights();
    if (self.playbackStatus) {
      self.playbackStatus.hidden = true;
      self.playbackStatus.textContent = '';
    }
    self.updatePlaybackTimeline(-1, false);
  };

  WorkSchemeView.prototype.stageTarget = function (node) {
    if (!node) return '';
    var queryId = parseInt(node.queryId, 10);
    if (queryId > 0 && this.queryBase) return this.queryBase + '?query_id=' + queryId;
    if (node.url) return node.url;
    if (node.page && this.stageBase) return this.stagePage(node);
    return '';
  };

  /* Цель ссылки «Подробнее» — описание этапа. query_id сознательно не
     участвует: иначе при заполненных счётчиках wiki-страницы этапов
     недостижимы ни из подсказки, ни откуда-либо ещё. */
  WorkSchemeView.prototype.pageTarget = function (node) {
    if (!node) return '';
    if (node.url) return node.url;
    if (node.page && this.stageBase) return this.stagePage(node);
    return '';
  };

  /* ---- Живые счётчики задач по query_id ---- */

  WorkSchemeView.prototype.loadCounts = function (force) {
    var self = this;
    clearTimeout(self._countsTimer);
    if (!self.countsUrl || !window.fetch) return;
    var ids = {};
    self.nodes.forEach(function (node) {
      var id = parseInt(node.queryId, 10);
      if (id > 0) ids[id] = true;
    });
    var list = Object.keys(ids).sort(function (a, b) { return Number(a) - Number(b); });
    if (!list.length) return;
    var cacheKey = self.countsUrl + '?ids=' + list.join(',');
    if (self._countsLoading && self._countsScheme === self.scheme) return;
    var sequence = ++self._countsSequence;
    self._countsLoading = false;
    if (self._countsAbort) self._countsAbort.abort();
    clearTimeout(self._countsTimeout);
    if (!force && Object.prototype.hasOwnProperty.call(countsCache, cacheKey)) {
      self.counts = countsCache[cacheKey].counts;
      self.countsUpdatedAt = countsCache[cacheKey].updatedAt;
      self.countsError = false;
      self.renderBadges();
      self.updateCountsStatus();
      self.scheduleCounts();
      return;
    }
    var requestedScheme = self.scheme;
    self._countsScheme = requestedScheme;
    self._countsLoading = true;
    self.updateCountsStatus();
    var requestId = ++countsSerial;
    countsRequests[cacheKey] = requestId;
    var controller = window.AbortController ? new window.AbortController() : null;
    self._countsAbort = controller;
    var timeout;
    var request = window.fetch(self.countsUrl + '?ids=' + encodeURIComponent(list.join(',')), {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
      headers: { 'Accept': 'application/json' }
    }).then(function (response) {
      if (!response.ok) throw new Error('counts response');
      return response.json();
    });
    var deadline = new Promise(function (resolve, reject) {
      timeout = setTimeout(function () {
        if (controller) controller.abort();
        reject(new Error('counts timeout'));
      }, 15000);
      self._countsTimeout = timeout;
    });
    function current() {
      return !self._destroyed && self._countsSequence === sequence && self.scheme === requestedScheme &&
        self.container.__wsViewInstance === self && self.container.contains(self.canvas);
    }
    function settled() {
      clearTimeout(timeout);
      if (!current()) return;
      self._countsLoading = false;
      self.updateCountsStatus();
      self.scheduleCounts();
    }
    return Promise.race([request, deadline]).then(function (data) {
      if (!data || !data.counts || typeof data.counts !== 'object' || Array.isArray(data.counts)) throw new Error('counts data');
      var counts = data.counts;
      var updatedAt = new Date();
      if (countsRequests[cacheKey] === requestId) countsCache[cacheKey] = { counts: counts, updatedAt: updatedAt };
      if (!current()) return;
      self.counts = counts;
      self.countsUpdatedAt = updatedAt;
      self.countsError = false;
      self.renderBadges();
    }).catch(function () {
      if (current()) self.countsError = true;
    }).then(settled);
  };

  WorkSchemeView.prototype.renderBadges = function () {
    var self = this;
    Array.prototype.forEach.call(self.container.querySelectorAll('.ws-badge'), function (badge) {
      badge.remove();
    });
    if (!self.overlay) return;
    self.nodes.forEach(function (node) {
      var queryId = parseInt(node.queryId, 10);
      var count = queryId > 0 ? self.counts[String(queryId)] : null;
      if (count === null || count === undefined) return;
      var badge = svgEl('g', { 'class': 'ws-badge' });
      badge.appendChild(svgEl('circle', {
        cx: node.x + node.w - 8, cy: node.y - 8, r: 11
      }));
      badge.appendChild(svgEl('text', {
        x: node.x + node.w - 8, y: node.y - 4.5, 'text-anchor': 'middle'
      }, String(count)));
      self.overlay.appendChild(badge);
    });
  };

  /* Сенсорные экраны (интерактивные ТВ и планшеты): hover нет, тап по блоку
     не должен сразу уводить со страницы — подсказка с кнопками вместо
     навигации. Приоритет — (hover: none); ontouchstart только как запаска
     для старых WebView без matchMedia. */
  function detectTouch() {
    try {
      if (window.matchMedia && window.matchMedia('(hover: none)').matches) return true;
    } catch (e) { /* jsdom и старые WebView без matchMedia */ }
    return typeof window.ontouchstart !== 'undefined';
  }

  WorkSchemeView.prototype.attachTooltip = function () {
    var self = this;
    if (self.container.closest && self.container.closest('#ws-editor')) return;
    var touchMode = detectTouch();
    if (touchMode && self.container.classList) self.container.classList.add('ws-touch');
    // render() вызывается повторно (undo/redo, пересоздание View) — прежний
    // mousemove-обработчик надо снять с контейнера, иначе они копятся
    if (self._onContainerMove) self.container.removeEventListener('mousemove', self._onContainerMove);
    var tooltip = document.createElement('div');
    tooltip.className = 'ws-tooltip';
    self.container.appendChild(tooltip);
    var hideTimer = null;

    function cancelHide() {
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = null;
    }

    function scheduleHide() {
      cancelHide();
      hideTimer = window.setTimeout(function () {
        tooltip.style.display = 'none';
      }, 180);
    }

    function hideNow() {
      cancelHide();
      tooltip.style.display = 'none';
    }

    function show(node, event) {
      var html = '<div class="ws-tooltip-title"></div>';
      tooltip.innerHTML = html;
      tooltip.querySelector('.ws-tooltip-title').textContent = node.title;
      if (node.dept) {
        var dept = document.createElement('div');
        dept.className = 'ws-tooltip-dept';
        dept.textContent = node.dept;
        tooltip.appendChild(dept);
      }
      if (node.description) {
        var desc = document.createElement('div');
        desc.className = 'ws-tooltip-desc';
        desc.textContent = node.description;
        tooltip.appendChild(desc);
      }
      var queryId = parseInt(node.queryId, 10);
      var count = queryId > 0 ? self.counts[String(queryId)] : null;
      if (count !== null && count !== undefined) {
        var countLine = document.createElement('div');
        countLine.className = 'ws-tooltip-count';
        countLine.textContent = self.label('tasks', 'Задач') + ': ' + count;
        tooltip.appendChild(countLine);
      }
      if (touchMode && queryId > 0 && self.queryBase) {
        // сенсор: навигация только явными кнопками подсказки
        var tasksLink = document.createElement('a');
        tasksLink.className = 'ws-tooltip-tasks';
        tasksLink.href = self.queryBase + '?query_id=' + queryId;
        tasksLink.textContent = self.label('tasks', 'Задач') +
          (count !== null && count !== undefined ? ': ' + count : '');
        tooltip.appendChild(tasksLink);
      }
      var target = self.pageTarget(node);
      if (target) {
        var more = document.createElement('a');
        more.className = 'ws-tooltip-more';
        more.href = target;
        more.textContent = self.container.getAttribute('data-more-label') || 'Подробнее';
        tooltip.appendChild(more);
      }
      if (touchMode) {
        var close = document.createElement('button');
        close.className = 'ws-tooltip-close';
        close.type = 'button';
        close.setAttribute('aria-label', '×');
        close.textContent = '×';
        close.addEventListener('click', function (event) {
          event.stopPropagation();
          hideNow();
        });
        tooltip.appendChild(close);
      }
      tooltip.style.display = 'block';
      move(event);
    }

    function move(event) {
      var rect = self.container.getBoundingClientRect();
      var x = event.clientX - rect.left + 14;
      var y = event.clientY - rect.top + 14;
      var maxX = rect.width - tooltip.offsetWidth - 8;
      var maxY = rect.height - tooltip.offsetHeight - 8;
      tooltip.style.left = Math.max(4, Math.min(x, maxX)) + 'px';
      tooltip.style.top = Math.max(4, Math.min(y, maxY)) + 'px';
    }

    tooltip.addEventListener('mouseenter', cancelHide);
    tooltip.addEventListener('mouseleave', scheduleHide);

    if (touchMode) {
      // тап мимо блока и подсказки прячет её; на клики самих блоков это
      // не срабатывает — они останавливают всплытие
      if (self._onDocHide) document.removeEventListener('click', self._onDocHide);
      self._onDocHide = function (event) {
        if (!tooltip.contains(event.target) &&
            !(event.target.closest && event.target.closest('.ws-node'))) hideNow();
      };
      document.addEventListener('click', self._onDocHide);
    }
    self._onContainerMove = function (event) {
      var group = event.target.closest ? event.target.closest('.ws-node') : null;
      if (group) move(event);
    };
    self.container.addEventListener('mousemove', self._onContainerMove);
    Array.prototype.forEach.call(self.container.querySelectorAll('.ws-node'), function (group) {
      var id = group.getAttribute('data-id');
      var node = self.byId[id];
      if (!node) return;
      group.addEventListener('mouseenter', function (event) {
        if (touchMode) return;
        cancelHide();
        show(node, event);
      });
      group.addEventListener('mouseleave', scheduleHide);
      group.addEventListener('click', function (event) {
        if (self.editMode) return; // в режиме правки клик не уводит со страницы
        if (touchMode) {
          // на сенсорном экране первый тап показывает подсказку с кнопками —
          // сам блок не уводит со страницы, всплытие остановлено, чтобы
          // документный обработчик тут же не спрятал подсказку
          if (event && event.stopPropagation) event.stopPropagation();
          cancelHide();
          show(node, event);
          return;
        }
        var target = self.stageTarget(node);
        if (target) window.location.href = target;
      });
      // role="link" + tabindex обещают клавиатурную навигацию — Enter/Space
      group.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (self.editMode) return;
        var target = self.stageTarget(node);
        if (!target) return;
        event.preventDefault();
        window.location.href = target;
      });
    });
  };

  function init() {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-work-scheme]'),
      function (container) {
        // редактор строит свой View на этом же контейнере — не дублируем
        // (иначе второй render и два fetch счётчиков с гонкой бейджей)
        if (container.closest && container.closest('#ws-editor')) return;
        try {
          var dataEl = container.querySelector('script.ws-data');
          if (!dataEl) return;
          if (!dataEl.textContent.trim()) return;
          var scheme = JSON.parse(dataEl.textContent);
          if (!scheme || (!scheme.schemes && (!scheme.nodes || !scheme.nodes.length))) return;
          new WorkSchemeView(container, scheme);
        } catch (e) {
          if (window.console && console.error) console.error('Work Scheme:', e);
        }
      }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.WorkScheme = { init: init, View: WorkSchemeView };
})();
