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
    this.container = container;
    this.scheme = scheme || {};
    this.container.setAttribute('data-ws-theme', this.scheme.theme || 'classic');
    this.stageBase = container.getAttribute('data-stage-base-url') || '';
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
        w: num(raw.w, 140),
        h: num(raw.h, 56)
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
    this.pathByEdge = {};
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
    this.render();
  }

  WorkSchemeView.prototype.nodeCenter = function (node) {
    return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
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
    // Дуги поверх схемы могут выходить за границы узлов — учитываем их вылет
    self.edges.forEach(function (edge) {
      if (edge.route !== 'arc' && edge.route !== 'u') return;
      var a = self.byId[edge.from];
      var b = self.byId[edge.to];
      if (!a || !b) return;
      var lift = edge.route === 'u' ? 26 + num(edge.bend, 50) : Math.max(46, Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) / 4);
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
    var bounds = self.bounds();
    var pad = 34;
    var width = bounds.maxX - bounds.minX + pad * 2;
    var height = bounds.maxY - bounds.minY + pad * 2;

    var svg = svgEl('svg', {
      viewBox: (bounds.minX - pad) + ' ' + (bounds.minY - pad) + ' ' + width + ' ' + height,
      role: 'img',
      'aria-label': 'scheme'
    });
    svg.style.maxWidth = 'none';
    svg.style.width = (this.zoom * 100) + '%';
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

    self.overlay = svgEl('g', { 'class': 'ws-overlay' });
    svg.appendChild(self.overlay);

    self.container.appendChild(svg);
    self.attachTooltip();
    self.buildControls();

    if (self.editMode) {
      self.container.classList.add('ws-edit-mode');
      self.attachDrag();
      if (self.showCoordPanel !== false) self.buildEditPanel();
    } else {
      self.container.classList.remove('ws-edit-mode');
      var oldPanel = self.container.querySelector('.ws-edit-panel');
      if (oldPanel) oldPanel.remove();
    }
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
    zoomFit.textContent = '100%';
    zoomFit.title = self.label('zoom-fit', 'Вписать в блок');
    zoomFit.setAttribute('aria-label', zoomFit.title);
    zoomFit.addEventListener('click', function () { self.setZoom(1); });
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

    if (!scenarios.length) {
      self.container.insertBefore(controls, self.container.firstChild);
      var empty = document.createElement('div');
      empty.className = 'ws-empty-note';
      empty.textContent = 'Сценарии проигрывания пока не добавлены.';
      self.container.insertBefore(empty, self.container.querySelector('svg'));
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
    var svg = self.container.querySelector('svg');
    var timeline = document.createElement('div');
    timeline.className = 'ws-playback-timeline';
    timeline.setAttribute('aria-label', 'Прогресс сценария');
    if (svg) {
      self.container.insertBefore(status, svg);
      self.container.insertBefore(timeline, svg);
    }
    else self.container.appendChild(status);
    self.playButton = play;
    self.playbackStatus = status;
    self.playbackTimeline = timeline;
    self.speedSelect = speed;
    self.zoomControls = zoom;
    self.renderPlaybackTimeline(scenarios[0]);
  };

  WorkSchemeView.prototype.setZoom = function (value) {
    this.zoom = Math.max(0.6, Math.min(1.8, Number(value) || 1));
    var svg = this.container.querySelector('svg');
    if (svg) svg.style.width = (this.zoom * 100) + '%';
    var fit = this.container.querySelector('.ws-zoom-fit');
    if (fit) fit.textContent = Math.round(this.zoom * 100) + '%';
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
        var startX = event.clientX;
        var startY = event.clientY;

        var onMove = function (ev) {
          var dx = ev.clientX - startX;
          var dy = ev.clientY - startY;
          group.setAttribute('transform', 'translate(' + dx + ',' + dy + ')');
          group._wsDrag = { x: dx, y: dy };
        };
        var onUp = function () {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          var delta = group._wsDrag || { x: 0, y: 0 };
          delete group._wsDrag;
          if (delta.x || delta.y) {
            node.x = Math.round((node.x + delta.x) / 2) * 2;
            node.y = Math.round((node.y + delta.y) / 2) * 2;
            self.render();
          }
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    });
  };

  WorkSchemeView.prototype.buildEditPanel = function () {
    var self = this;
    var panel = document.createElement('div');
    panel.className = 'ws-edit-panel';

    var title = document.createElement('div');
    title.className = 'ws-edit-title';
    title.textContent = self.label('coords', 'Координаты узлов — перенесите x/y в настройки схемы:');
    panel.appendChild(title);

    var textarea = document.createElement('textarea');
    textarea.className = 'ws-edit-textarea';
    textarea.readOnly = true;
    textarea.rows = 8;
    textarea.value = self.nodes.map(function (node) {
      return JSON.stringify({ id: node.id, x: node.x, y: node.y, w: node.w, h: node.h });
    }).join('\n');
    panel.appendChild(textarea);

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ws-copy';
    copy.textContent = self.label('copy', 'Копировать');
    copy.addEventListener('click', function () {
      textarea.focus();
      textarea.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
      if (!copied && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textarea.value);
        copied = true;
      }
      copy.textContent = copied ? '✓' : self.label('copy', 'Копировать');
      self.timer(function () {
        copy.textContent = self.label('copy', 'Копировать');
      }, 1200);
    });
    panel.appendChild(copy);

    self.container.appendChild(panel);
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
    var group = this.container.querySelector('.ws-node[data-id="' + node.id + '"]');
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
    var group = this.container.querySelector('.ws-node[data-id="' + node.id + '"]');
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
      var group = self.container.querySelector('.ws-node[data-id="' + node.id + '"]');
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
    this.animateEnergyPulse(pathEl, rework);
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var length = pathEl.getTotalLength ? pathEl.getTotalLength() : 0;
    if (length > 0) {
      pathEl.style.strokeDasharray = length + ' ' + length;
      pathEl.style.strokeDashoffset = reduced ? '0' : String(length);
      if (!reduced) window.requestAnimationFrame(function () {
        pathEl.style.strokeDashoffset = '0';
      });
    }
  };

  WorkSchemeView.prototype.animateEnergyPulse = function (pathEl, rework) {
    var self = this;
    var total = pathEl.getTotalLength ? pathEl.getTotalLength() : 0;
    if (!total || !self.overlay) return;
    var pulse = svgEl('circle', { r: 9, 'class': 'ws-energy-pulse' + (rework ? ' ws-energy-pulse-rework' : '') });
    self.overlay.appendChild(pulse);
    var start = null;
    var duration = self.playbackDelay(620);
    var tick = function (timestamp) {
      if (!self.playing) { if (pulse.parentNode) pulse.remove(); return; }
      if (start === null) start = timestamp;
      var progress = Math.min(1, (timestamp - start) / duration);
      var point = pathEl.getPointAtLength(total * progress);
      pulse.setAttribute('cx', point.x);
      pulse.setAttribute('cy', point.y);
      pulse.setAttribute('r', String(9 + progress * 5));
      if (progress < 1) window.requestAnimationFrame(tick);
      else if (pulse.parentNode) pulse.remove();
    };
    window.requestAnimationFrame(tick);
  };

  WorkSchemeView.prototype.markEdgeComplete = function (pathEl) {
    if (!pathEl) return;
    pathEl.classList.remove('ws-edge-drawing');
    pathEl.classList.add('ws-edge-complete');
    pathEl.style.strokeDashoffset = '0';
  };

  WorkSchemeView.prototype.showPlaybackToken = function (node, preservePoint) {
    var self = this;
    if (!self.playbackToken || !self.playbackToken.parentNode) {
      var group = svgEl('g', { 'class': 'ws-playback-token' });
      self.playbackTrail = [];
      self.playbackTrailPath = svgEl('path', { 'class': 'ws-marker-trail-line' });
      group.appendChild(self.playbackTrailPath);
      [8, 6, 4].forEach(function (radius, index) {
        var trail = svgEl('circle', { r: radius, 'class': 'ws-marker-trail ws-marker-trail-' + index });
        group.appendChild(trail);
        self.playbackTrail.push(trail);
      });
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
    this.playbackHistory.unshift({ x: point.x, y: point.y });
    this.playbackHistory = this.playbackHistory.slice(0, 7);
    this.playbackToken.setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ')');
    if (this.playbackTrail) this.playbackTrail.forEach(function (trail, index) {
      var sample = this.playbackHistory[Math.min((index + 1) * 2, this.playbackHistory.length - 1)] || point;
      trail.setAttribute('transform', 'translate(' + (sample.x - point.x) + ' ' + (sample.y - point.y) + ')');
    }, this);
    if (this.playbackTrailPath) {
      this.playbackTrailPath.setAttribute('d', this.playbackHistory.map(function (sample, index) {
        return (index ? 'L ' : 'M ') + (sample.x - point.x) + ' ' + (sample.y - point.y);
      }).join(' '));
    }
    this.playbackPoint = { x: point.x, y: point.y };
  };

  WorkSchemeView.prototype.focusPlaybackNode = function (node) {
    if (!node || !this.container || !this.container.scrollTo) return;
    var svg = this.container.querySelector('svg');
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal.width) return;
    var view = svg.viewBox.baseVal;
    var rect = svg.getBoundingClientRect();
    var scale = rect.width / view.width;
    var target = (node.x + node.w / 2 - view.x) * scale;
    var left = target - this.container.clientWidth / 2;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.container.scrollTo({ left: Math.max(0, left), behavior: reduced ? 'auto' : 'smooth' });
  };

  WorkSchemeView.prototype.showSuccessBubble = function (node) {
    var self = this;
    if (!node || !self.overlay) return;
    if (self.playbackSuccess) self.playbackSuccess.remove();
    var center = self.nodeCenter(node);
    var group = svgEl('g', { 'class': 'ws-playback-success', 'aria-label': 'Готово' });
    group.appendChild(svgEl('path', {
      d: 'M ' + (center.x - 72) + ' ' + (node.y - 42) + ' Q ' + (center.x - 72) + ' ' + (node.y - 54) + ' ' + (center.x - 60) + ' ' + (node.y - 54) + ' L ' + (center.x + 60) + ' ' + (node.y - 54) + ' Q ' + (center.x + 72) + ' ' + (node.y - 54) + ' ' + (center.x + 72) + ' ' + (node.y - 42) + ' L ' + (center.x + 72) + ' ' + (node.y - 24) + ' Q ' + (center.x + 72) + ' ' + (node.y - 14) + ' ' + (center.x + 60) + ' ' + (node.y - 14) + ' L ' + (center.x - 60) + ' ' + (node.y - 14) + ' Q ' + (center.x - 72) + ' ' + (node.y - 14) + ' ' + (center.x - 72) + ' ' + (node.y - 24) + ' Z',
      'class': 'ws-success-bubble'
    }));
    group.appendChild(svgEl('circle', { cx: center.x - 46, cy: node.y - 34, r: 8, 'class': 'ws-success-icon' }));
    group.appendChild(svgEl('path', { d: 'M ' + (center.x - 50) + ' ' + (node.y - 34) + ' l 3 3 l 6 -7', 'class': 'ws-success-check' }));
    group.appendChild(svgEl('text', { x: center.x + 14, y: node.y - 29, 'text-anchor': 'middle', 'class': 'ws-success-label' }, 'Готово'));
    self.overlay.appendChild(group);
    self.playbackSuccess = group;
  };

  WorkSchemeView.prototype.animateCompletionChain = function () {
    var self = this;
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
    var rotate = function (point, nextPoint) {
      var direction = self.playbackToken && self.playbackToken.querySelector('.ws-marker-direction');
      if (direction && nextPoint) direction.setAttribute('transform', 'rotate(' + (Math.atan2(nextPoint.y - point.y, nextPoint.x - point.x) * 180 / Math.PI) + ')');
    };

    var tick = function (timestamp) {
      if (!self.playing) return;
      if (start === null) start = timestamp;
      var linear = duration === 0 ? 1 : Math.min(1, (timestamp - start) / duration);
      // Smoothstep keeps the marker from snapping at the beginning/end of an edge.
      var progress = linear * linear * (3 - 2 * linear);
      var point = pathEl.getPointAtLength(total * progress);
      move(point);
      rotate(point, pathEl.getPointAtLength(Math.min(total, total * progress + 2)));
      if (progress < 1) {
        window.requestAnimationFrame(tick);
      } else {
        self.timer(function () {}, self.playbackDelay(350));
        done();
      }
    };
    var bridge = function (timestamp) {
      if (!self.playing) return;
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
    if (node.url) return node.url;
    if (node.page && this.stageBase) return this.stageBase + node.id;
    return '';
  };

  WorkSchemeView.prototype.attachTooltip = function () {
    var self = this;
    if (self.container.closest && self.container.closest('#ws-editor')) return;
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
      var target = self.stageTarget(node);
      if (target) {
        var more = document.createElement('a');
        more.className = 'ws-tooltip-more';
        more.href = target;
        more.textContent = self.container.getAttribute('data-more-label') || 'Подробнее';
        tooltip.appendChild(more);
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

    self.container.addEventListener('mousemove', function (event) {
      var group = event.target.closest ? event.target.closest('.ws-node') : null;
      if (group) move(event);
    });
    Array.prototype.forEach.call(self.container.querySelectorAll('.ws-node'), function (group) {
      var id = group.getAttribute('data-id');
      var node = self.byId[id];
      if (!node) return;
      group.addEventListener('mouseenter', function (event) {
        cancelHide();
        show(node, event);
      });
      group.addEventListener('mouseleave', scheduleHide);
      group.addEventListener('click', function () {
        if (self.editMode) return; // в режиме правки клик не уводит со страницы
        var target = self.stageTarget(node);
        if (target) window.location.href = target;
      });
    });
  };

  function init() {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-work-scheme]'),
      function (container) {
        try {
          var dataEl = container.querySelector('script.ws-data');
          if (!dataEl) return;
          if (!dataEl.textContent.trim()) return;
          var scheme = JSON.parse(dataEl.textContent);
          if (!scheme || !scheme.nodes || !scheme.nodes.length) return;
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
