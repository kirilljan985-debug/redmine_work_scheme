/*
 * Redmine Work Scheme: визуальный редактор схемы (страница /work_scheme/edit).
 * Требует work_scheme.js (window.WorkScheme.View).
 * Возможности: выбор узлов/стрелок, правка всех свойств (по-русски),
 * добавление/удаление узлов и стрелок, перетаскивание концов стрелок для
 * перепривязки к другому блоку, разворот направления, изгиб (bend),
 * редактирование сценариев, сохранение на сервер и выгрузка JSON.
 */
(function () {
  'use strict';

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  var NODE_TYPES = [['start', 'Старт'], ['process', 'Процесс'], ['decision', 'Решение (ромб)'], ['end', 'Финиш']];
  var ROUTES = [['straight', 'Линия'], ['arc', 'Дуга (изгиб)'], ['elbow', 'Угловатая (колено)'], ['u', 'П‑образная']];
  var SIDES = [['', 'авто'], ['left', 'слева'], ['right', 'справа'], ['top', 'сверху'], ['bottom', 'снизу']];

  function Editor(root) {
    this.root = root;
    this.saveUrl = root.getAttribute('data-save-url') || '';
    this.labels = {
      save: root.getAttribute('data-label-save') || 'Сохранить схему',
      saved: root.getAttribute('data-label-saved') || 'Схема сохранена',
      download: root.getAttribute('data-label-download') || 'Скачать JSON',
      addNode: root.getAttribute('data-label-add-node') || 'Добавить узел',
      addEdge: root.getAttribute('data-label-add-edge') || 'Добавить стрелку',
      addEdgeHint: root.getAttribute('data-label-add-edge-hint') || 'Кликните исходный узел, затем целевой',
      swap: root.getAttribute('data-label-swap') || 'Развернуть направление',
      del: root.getAttribute('data-label-delete') || 'Удалить',
      node: root.getAttribute('data-label-node') || 'Узел',
      edge: root.getAttribute('data-label-edge') || 'Стрелка',
      scenarios: root.getAttribute('data-label-scenarios') || 'Сценарии',
      stepsHint: root.getAttribute('data-label-steps-hint') || 'id узлов через запятую',
      bend: root.getAttribute('data-label-bend') || 'Изгиб',
      edgeColor: root.getAttribute('data-label-edge-color') || 'Цвет стрелки'
    };
    var dataEl = root.querySelector('script.ws-data');
    if (!dataEl || !dataEl.textContent.trim()) return; // данные загрузятся асинхронно в dev-превью
    var scheme = JSON.parse(dataEl.textContent);
    var View = window.WorkScheme.View;
    this.view = new View(root.querySelector('.ws-container'), scheme);
    root.setAttribute('data-ws-theme', scheme.theme || 'classic');
    this.view.editMode = true;        // перетаскивание узлов включено
    this.sel = null;                  // {type:'node', id} | {type:'edge', key}
    this.selectedIds = [];
    this.dirty = false;
    this.history = [JSON.stringify(this.serialize())];
    this.future = [];
    this.pendingFrom = null;          // режим добавления стрелки: {from: id}
    this.activeScenarioId = null;     // сценарий, который собирается кликами по узлам
    this.seq = this.maxNodeSeq() + 1;
    this.redraw();
    this.wire();
    this.renderScenarios();
    this.wirePalette();
    this.wireTitle();
    this.wireTheme();
  }

  Editor.prototype.wireTitle = function () {
    var self = this;
    var input = this.root.querySelector('#ws-title');
    if (!input) return;
    input.value = self.view.scheme.title || 'Схема';
    input.addEventListener('input', function () {
      self.view.scheme.title = input.value;
      var heading = document.querySelector('#ws-editor-heading');
      if (heading) heading.textContent = input.value || 'Схема';
    });
  };

  Editor.prototype.wireTheme = function () {
    var self = this;
    var input = this.root.querySelector('#ws-theme');
    if (!input) return;
    input.value = self.view.scheme.theme || 'classic';
    input.addEventListener('change', function () {
      self.view.scheme.theme = input.value;
      self.root.setAttribute('data-ws-theme', input.value);
      self.view.container.setAttribute('data-ws-theme', input.value);
      self.markDirty();
      self.redraw();
    });
  };

  Editor.prototype.markDirty = function () {
    var current = JSON.stringify(this.serialize());
    if (this.history[this.history.length - 1] !== current) this.history.push(current);
    this.future = [];
    this.dirty = true;
    this.setStatus('Есть несохранённые изменения', 'dirty');
  };

  Editor.prototype.restoreSnapshot = function (snapshot) {
    var data;
    try { data = JSON.parse(snapshot); } catch (_) { return; }
    var View = window.WorkScheme.View;
    this.view = new View(this.root.querySelector('.ws-container'), data);
    this.view.editMode = true;
    this.view.render();
    this.seq = this.maxNodeSeq() + 1;
    this.sel = null;
    this.selectedIds = [];
    this.root.classList.remove('ws-object-focus');
    var titleInput = this.root.querySelector('#ws-title');
    if (titleInput) titleInput.value = data.title || 'Схема';
    var themeInput = this.root.querySelector('#ws-theme');
    if (themeInput) themeInput.value = data.theme || 'classic';
    this.root.setAttribute('data-ws-theme', data.theme || 'classic');
    this.renderScenarios();
    this.dirty = true;
    this.setStatus('Есть несохранённые изменения', 'dirty');
  };

  Editor.prototype.undo = function () {
    if (!this.history.length) return;
    // markDirty пишет в историю уже применённое состояние; если вершина равна
    // текущему — снимаем её, иначе первый Ctrl+Z будет холостым.
    var current = JSON.stringify(this.serialize());
    if (this.history[this.history.length - 1] === current) this.history.pop();
    if (!this.history.length) return;
    this.future.push(current);
    this.restoreSnapshot(this.history.pop());
  };

  Editor.prototype.redo = function () {
    if (!this.future.length) return;
    this.history.push(JSON.stringify(this.serialize()));
    this.restoreSnapshot(this.future.pop());
  };

  Editor.prototype.alignNodes = function (axis) {
    var nodes = this.selectedNodes();
    if (nodes.length < 2) {
      this.setStatus('Выберите минимум два блока через Shift+клик', '');
      return;
    }
    var value = axis === 'x'
      ? nodes.reduce(function (sum, n) { return sum + n.x + n.w / 2; }, 0) / nodes.length
      : nodes.reduce(function (sum, n) { return sum + n.y + n.h / 2; }, 0) / nodes.length;
    nodes.forEach(function (node) {
      if (axis === 'x') node.x = Math.round(value - node.w / 2);
      else node.y = Math.round(value - node.h / 2);
    });
    this.markDirty();
    this.redraw();
  };

  Editor.prototype.distributeNodes = function (axis) {
    var nodes = this.selectedNodes().slice().sort(function (a, b) {
      return axis === 'x' ? a.x - b.x : a.y - b.y;
    });
    if (nodes.length < 3) {
      this.setStatus('Выберите минимум три блока через Shift+клик', '');
      return;
    }
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    var start = axis === 'x' ? first.x + first.w / 2 : first.y + first.h / 2;
    var end = axis === 'x' ? last.x + last.w / 2 : last.y + last.h / 2;
    var step = (end - start) / (nodes.length - 1);
    nodes.slice(1, -1).forEach(function (node, index) {
      if (axis === 'x') node.x = Math.round(start + step * (index + 1) - node.w / 2);
      else node.y = Math.round(start + step * (index + 1) - node.h / 2);
    });
    this.markDirty();
    this.redraw();
  };

  Editor.prototype.checkOverlaps = function () {
    var self = this;
    var overlaps = [];
    self.view.nodes.forEach(function (a, i) {
      self.view.nodes.slice(i + 1).forEach(function (b) {
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) overlaps.push([a.id, b.id]);
      });
    });
    self.view.container.querySelectorAll('.ws-node-overlap').forEach(function (el) { el.classList.remove('ws-node-overlap'); });
    overlaps.forEach(function (pair) {
      pair.forEach(function (id) {
        var el = self.view.nodeEl(id);
        if (el) el.classList.add('ws-node-overlap');
      });
    });
    if (overlaps.length && !self.dirty) self.setStatus('Пересечение блоков: ' + overlaps.length, 'warn');
  };

  Editor.prototype.duplicateSelected = function () {
    var node = this.selectedNode();
    if (!node) return;
    var copy = JSON.parse(JSON.stringify(node));
    copy.id = 'n' + (this.seq++);
    copy.x += 24; copy.y += 24;
    this.view.nodes.push(copy);
    this.view.byId[copy.id] = copy;
    this.sel = { type: 'node', id: copy.id };
    this.selectedIds = [copy.id];
    this.markDirty();
    this.renderNodePanel();
    this.redraw();
  };

  Editor.prototype.maxNodeSeq = function () {
    var max = 0;
    this.view.nodes.forEach(function (n) {
      var m = /^n(\d+)$/.exec(n.id);
      if (m) max = Math.max(max, Number(m[1]));
    });
    return max;
  };

  Editor.prototype.redraw = function () {
    var self = this;
    self.view.render();
    if (self.sel && self.sel.type === 'node') {
      self.selectedIds.forEach(function (id) {
        var g = self.view.nodeEl(id);
        if (g) g.classList.add('ws-selected');
      });
    }
    if (self.sel && self.sel.type === 'edge') {
      var p = self.view.pathByEdge[self.sel.key];
      if (p) p.classList.add('ws-selected');
    }
    self.addHitPaths();
    if (self.sel && self.sel.type === 'edge') self.addEdgeHandles();
    if (self.sel && self.sel.type === 'node') self.addResizeHandle();
    self.checkOverlaps();
  };

  /* Маркер в правом нижнем углу выбранного блока — изменение w/h мышкой. */
  Editor.prototype.addResizeHandle = function () {
    var self = this;
    var node = self.selectedNode();
    if (!node) return;
    var svg = self.view.container.querySelector('svg');
    if (!svg) return;
    var minW = node.type === 'decision' ? 90 : 80;
    var minH = node.type === 'decision' ? 64 : 42;
    var handles = [
      ['nw', node.x, node.y], ['n', node.x + node.w / 2, node.y], ['ne', node.x + node.w, node.y],
      ['e', node.x + node.w, node.y + node.h / 2], ['se', node.x + node.w, node.y + node.h],
      ['s', node.x + node.w / 2, node.y + node.h], ['sw', node.x, node.y + node.h],
      ['w', node.x, node.y + node.h / 2]
    ];
    handles.forEach(function (item) {
      var handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      handle.setAttribute('x', item[1] - 6);
      handle.setAttribute('y', item[2] - 6);
      handle.setAttribute('width', 12);
      handle.setAttribute('height', 12);
      handle.setAttribute('rx', 3);
      handle.setAttribute('class', 'ws-resize-handle ws-resize-' + item[0]);
      handle.setAttribute('data-resize', item[0]);
      handle.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var start = self.svgPoint(ev.clientX, ev.clientY);
        var x = node.x, y = node.y, width = node.w, height = node.h;
        var onMove = function (moveEv) {
          var p = self.svgPoint(moveEv.clientX, moveEv.clientY);
          var dx = p.x - start.x, dy = p.y - start.y;
          if (item[0].indexOf('w') !== -1) {
            var nextW = Math.max(minW, width - dx);
            node.x = x + width - nextW;
            node.w = nextW;
          } else if (item[0].indexOf('e') !== -1) {
            node.w = Math.max(minW, width + dx);
          }
          if (item[0].indexOf('n') !== -1) {
            var nextH = Math.max(minH, height - dy);
            node.y = y + height - nextH;
            node.h = nextH;
          } else if (item[0].indexOf('s') !== -1) {
            node.h = Math.max(minH, height + dy);
          }
          self.markDirty();
          self.redraw();
        };
        var onUp = function () {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
      svg.appendChild(handle);
    });
  };

  /* Прозрачные широкие дорожки поверх стрелок — чтобы легко кликать */
  Editor.prototype.addHitPaths = function () {
    var self = this;
    var svg = self.view.container.querySelector('svg');
    if (!svg) return;
    self.view.edges.forEach(function (edge) {
      var base = self.view.pathByEdge[edge.from + '>' + edge.to];
      if (!base) return;
      var key = edge.from + '>' + edge.to;
      var hit = base.cloneNode();
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '14');
      hit.setAttribute('fill', 'none');
      hit.removeAttribute('marker-end');
      hit.setAttribute('data-edge', key);
      hit.setAttribute('class', 'ws-edge-hit' + (self.sel && self.sel.type === 'edge' && self.sel.key === key ? ' ws-selected' : ''));
      hit.addEventListener('click', function (ev) {
        ev.stopPropagation();
        self.selectEdge(key);
      });
      self.view.overlay.appendChild(hit);
    });
  };

  /* Оранжевые маркеры на концах выбранной стрелки — за них тянут, чтобы перепривязать */
  Editor.prototype.addEdgeHandles = function () {
    var self = this;
    var edge = self.selectedEdge();
    if (!edge) return;
    var a = self.view.byId[edge.from];
    var b = self.view.byId[edge.to];
    if (!a || !b) return;
    var sides = self.view.sidesFor(a, b, edge);
    var s = self.view.anchor(a, sides[0]);
    var t = self.view.anchor(b, sides[1]);
    var svg = self.view.container.querySelector('svg');
    if (!svg) return;

    var mk = function (point, end) {
      var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', point.x);
      c.setAttribute('cy', point.y);
      c.setAttribute('r', 7);
      c.setAttribute('class', 'ws-handle');
      c.setAttribute('data-end', end);
      c.addEventListener('pointerdown', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        self.dragEdgeEnd(edge, end, ev);
      });
      svg.appendChild(c);
    };
    mk(s, 'from');
    mk(t, 'to');
  };

  Editor.prototype.svgPoint = function (clientX, clientY) {
    var svg = this.view.container.querySelector('svg');
    var pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };

  /* Перетаскивание конца стрелки: тянем маркер на другой блок — перепривязка */
  Editor.prototype.dragEdgeEnd = function (edge, end, ev) {
    var self = this;
    var svg = self.view.container.querySelector('svg');
    var NS = 'http://www.w3.org/2000/svg';
    var startPt = self.svgPoint(ev.clientX, ev.clientY);
    var opposite = end === 'from'
      ? self.view.anchor(self.view.byId[edge.to], (self.view.sidesFor(self.view.byId[edge.from], self.view.byId[edge.to], edge))[1])
      : self.view.anchor(self.view.byId[edge.from], (self.view.sidesFor(self.view.byId[edge.from], self.view.byId[edge.to], edge))[0]);

    var tempLine = document.createElementNS(NS, 'line');
    tempLine.setAttribute('x1', opposite.x);
    tempLine.setAttribute('y1', opposite.y);
    tempLine.setAttribute('x2', startPt.x);
    tempLine.setAttribute('y2', startPt.y);
    tempLine.setAttribute('class', 'ws-temp-line');
    var tempDot = document.createElementNS(NS, 'circle');
    tempDot.setAttribute('r', 8);
    tempDot.setAttribute('cx', startPt.x);
    tempDot.setAttribute('cy', startPt.y);
    tempDot.setAttribute('class', 'ws-temp-dot');
    self.view.overlay.appendChild(tempLine);
    self.view.overlay.appendChild(tempDot);

    var targetId = null;

    var onMove = function (moveEv) {
      var p = self.svgPoint(moveEv.clientX, moveEv.clientY);
      tempLine.setAttribute('x2', p.x);
      tempLine.setAttribute('y2', p.y);
      tempDot.setAttribute('cx', p.x);
      tempDot.setAttribute('cy', p.y);
      var el = document.elementFromPoint(moveEv.clientX, moveEv.clientY);
      var group = el && el.closest ? el.closest('.ws-node') : null;
      var newTarget = group ? group.getAttribute('data-id') : null;
      if (newTarget !== targetId) {
        Array.prototype.forEach.call(self.view.container.querySelectorAll('.ws-drop-target'), function (x) {
          x.classList.remove('ws-drop-target');
        });
        if (group && newTarget !== (end === 'from' ? edge.to : edge.from)) {
          group.classList.add('ws-drop-target');
        }
        targetId = newTarget;
      }
    };

    var onUp = function () {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      Array.prototype.forEach.call(self.view.container.querySelectorAll('.ws-drop-target'), function (x) {
        x.classList.remove('ws-drop-target');
      });
      tempLine.remove();
      tempDot.remove();
      if (!targetId) { self.redraw(); return; }
      if (end === 'to' && targetId !== edge.from) {
        edge.to = targetId;
        edge.toSide = '';
      } else if (end === 'from' && targetId !== edge.to) {
        edge.from = targetId;
        edge.fromSide = '';
      } else {
        self.redraw();
        return;
      }
      self.markDirty();
      self.sel = { type: 'edge', key: edge.from + '>' + edge.to };
      self.redraw();
      self.renderEdgePanel();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  Editor.prototype.wire = function () {
    var self = this;
    var container = self.view.container;

    var markFormDirty = function (ev) {
      if (ev.target.closest && (ev.target.closest('.ws-field') || ev.target.closest('.ws-scenario-row') || ev.target.id === 'ws-title')) self.markDirty();
    };
    self.root.addEventListener('input', markFormDirty);
    self.root.addEventListener('change', markFormDirty);
    self.root.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) self.redo(); else self.undo();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') {
        ev.preventDefault(); self.redo(); return;
      }
      var node = self.selectedNode();
      if (!node || ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
      var delta = ev.shiftKey ? 10 : 2;
      if (ev.key === 'ArrowLeft') node.x -= delta;
      else if (ev.key === 'ArrowRight') node.x += delta;
      else if (ev.key === 'ArrowUp') node.y -= delta;
      else if (ev.key === 'ArrowDown') node.y += delta;
      else return;
      ev.preventDefault(); self.markDirty(); self.redraw();
    });

    container.addEventListener('click', function (ev) {
      var nodeGroup = ev.target.closest ? ev.target.closest('.ws-node') : null;
      if (nodeGroup) { self.selectNode(nodeGroup.getAttribute('data-id'), ev.shiftKey); return; }
      if (ev.target.closest && ev.target.closest('.ws-edge-hit')) return; // свой обработчик
      if (ev.target === container.querySelector('svg')) { self.deselect(); }
    });

    var addNodeBtn = document.getElementById('ws-add-node');
    if (addNodeBtn) {
      addNodeBtn.textContent = self.labels.addNode;
      addNodeBtn.addEventListener('click', function () { self.addNode(); });
    }

    var addEdgeBtn = document.getElementById('ws-add-edge');
    if (addEdgeBtn) {
      addEdgeBtn.textContent = self.labels.addEdge;
      addEdgeBtn.title = self.labels.addEdgeHint;
      addEdgeBtn.addEventListener('click', function () {
        self.pendingFrom = { from: null };
        addEdgeBtn.classList.add('ws-active');
        self.setStatus(self.labels.addEdgeHint, '');
      });
    }

    var addScenarioBtn = document.getElementById('ws-add-scenario');
    if (addScenarioBtn) {
      addScenarioBtn.textContent = '+ ' + self.labels.scenarios;
      addScenarioBtn.addEventListener('click', function () {
        self.view.scheme.scenarios = self.view.scheme.scenarios || [];
        var scenario = { id: 'scenario' + (self.view.scheme.scenarios.length + 1), title: 'Сценарий', steps: [] };
        self.view.scheme.scenarios.push(scenario);
        self.activeScenarioId = scenario.id;
        self.root.classList.add('ws-scenario-capture');
        self.markDirty();
        self.renderScenarios();
        self.setStatus('Кликом добавляйте блоки в сценарий', 'dirty');
      });
    }

    var saveBtn = document.getElementById('ws-save');
    if (saveBtn) {
      saveBtn.textContent = self.labels.save;
      saveBtn.addEventListener('click', function () { self.save(); });
    }

    var dlBtn = document.getElementById('ws-download');
    if (dlBtn) {
      dlBtn.textContent = self.labels.download;
      dlBtn.addEventListener('click', function () { self.download(); });
    }

    var undoBtn = document.getElementById('ws-undo');
    var redoBtn = document.getElementById('ws-redo');
    if (undoBtn) undoBtn.addEventListener('click', function () { self.undo(); });
    if (redoBtn) redoBtn.addEventListener('click', function () { self.redo(); });
    var alignX = document.getElementById('ws-align-x');
    var alignY = document.getElementById('ws-align-y');
    if (alignX) alignX.addEventListener('click', function () { self.alignNodes('x'); });
    if (alignY) alignY.addEventListener('click', function () { self.alignNodes('y'); });
    var distX = document.getElementById('ws-distribute-x');
    var distY = document.getElementById('ws-distribute-y');
    if (distX) distX.addEventListener('click', function () { self.distributeNodes('x'); });
    if (distY) distY.addEventListener('click', function () { self.distributeNodes('y'); });
    var duplicate = document.getElementById('ws-duplicate');
    if (duplicate) duplicate.addEventListener('click', function () { self.duplicateSelected(); });
  };

  Editor.prototype.wirePalette = function () {
    var self = this;
    var container = self.view.container;
    var items = document.querySelectorAll('#ws-editor .ws-palette-item');
    Array.prototype.forEach.call(items, function (item) {
      item.addEventListener('dragstart', function (ev) {
        ev.dataTransfer.effectAllowed = 'copy';
        ev.dataTransfer.setData('text/plain', JSON.stringify({
          kind: item.getAttribute('data-palette-kind'),
          type: item.getAttribute('data-node-type') || '',
          route: item.getAttribute('data-edge-route') || 'straight',
          dashed: item.getAttribute('data-edge-dashed') === 'true',
          fromSide: item.getAttribute('data-edge-from-side') || '',
          toSide: item.getAttribute('data-edge-to-side') || '',
          bend: num(item.getAttribute('data-edge-bend'), 50),
          icon: item.getAttribute('data-icon') || ''
        }));
        item.classList.add('ws-dragging');
      });
      item.addEventListener('dragend', function () { item.classList.remove('ws-dragging'); });
    });
    container.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      container.classList.add('ws-palette-over');
    });
    container.addEventListener('dragleave', function () { container.classList.remove('ws-palette-over'); });
    container.addEventListener('drop', function (ev) {
      ev.preventDefault();
      container.classList.remove('ws-palette-over');
      var raw = ev.dataTransfer.getData('text/plain');
      var item;
      try { item = JSON.parse(raw); } catch (_) { return; }
      var target = ev.target.closest ? ev.target.closest('.ws-node') : null;
      if (item.kind === 'icon' && target) {
        var iconNode = self.view.byId[target.getAttribute('data-id')];
        if (iconNode) { iconNode.icon = item.icon; self.markDirty(); self.redraw(); }
        return;
      }
      if (item.kind === 'node') {
        self.addPaletteNode(item.type, ev.clientX, ev.clientY);
        return;
      }
      if (item.kind === 'edge' && target) {
        var targetId = target.getAttribute('data-id');
        if (self.selectedNode() && self.selectedNode().id !== targetId) {
          self.addPaletteEdge(item.route, item.dashed, self.selectedNode().id, targetId, item.fromSide, item.toSide, item.bend);
        } else {
          self.pendingFrom = { from: targetId, palette: item };
          self.setStatus('Стрелка готова: выберите блок-цель', '');
        }
      }
    });
  };

  Editor.prototype.addPaletteNode = function (type, clientX, clientY) {
    var self = this;
    var p = self.svgPoint(clientX, clientY);
    var id = 'n' + (self.seq++);
    var titles = { start: 'Старт', process: 'Процесс', decision: 'Решение', end: 'Финиш' };
    var node = { id: id, type: type || 'process', title: titles[type] || 'Процесс', dept: '', description: '', page: '', url: '', icon: '', queryId: null,
      fontSize: 12, fontWeight: 'normal', fontFamily: 'sans-serif', textColor: '',
      x: Math.max(0, Math.round(p.x - 70)), y: Math.max(0, Math.round(p.y - 28)), w: 140, h: 56 };
    if (node.type === 'decision') { node.w = 150; node.h = 88; }
    self.view.nodes.push(node);
    self.markDirty();
    self.view.byId[id] = node;
    self.selectNode(id);
  };

  Editor.prototype.addPaletteEdge = function (route, dashed, from, to, fromSide, toSide, bend) {
    var self = this;
    var edge = { from: from, to: to, label: '', color: '', dashed: dashed === true, route: route || 'straight', fromSide: fromSide || '', toSide: toSide || '', bend: num(bend, 50) };
    self.view.edges.push(edge);
    self.markDirty();
    self.pendingFrom = null;
    self.setStatus('', '');
    self.redraw();
    self.selectEdge(edge.from + '>' + edge.to);
  };

  Editor.prototype.setStatus = function (text, cls) {
    var el = document.getElementById('ws-save-status');
    if (!el) return;
    el.innerHTML = '';
    var span = document.createElement('span');
    span.className = cls || '';
    span.textContent = text;
    el.appendChild(span);
  };

  Editor.prototype.deselect = function () {
    this.sel = null;
    this.selectedIds = [];
    this.root.classList.remove('ws-object-focus');
    var panel = document.getElementById('ws-obj-panel');
    if (panel) panel.innerHTML = '<em>Кликните узел или стрелку на схеме</em>';
    this.redraw();
  };

  Editor.prototype.selectNode = function (id, additive) {
    var self = this;
    if (self.pendingFrom) {
      if (!self.pendingFrom.from) {
        self.pendingFrom.from = id;
        self.setStatus(self.labels.addEdgeHint + ' [откуда: ' + id + ']', '');
        return;
      }
      if (self.pendingFrom.from === id) return;
      var palette = self.pendingFrom.palette;
      if (palette) {
        self.addPaletteEdge(palette.route, palette.dashed, self.pendingFrom.from, id, palette.fromSide, palette.toSide, palette.bend);
        return;
      }
      var edge = { from: self.pendingFrom.from, to: id, label: '', dashed: false, route: 'straight', fromSide: '', toSide: '', bend: 50 };
      self.view.edges.push(edge); self.pendingFrom = null;
      var btn = document.getElementById('ws-add-edge');
      if (btn) btn.classList.remove('ws-active');
      self.setStatus('', '');
      self.redraw();
      self.selectEdge(edge.from + '>' + edge.to);
      return;
    }
    if (self.activeScenarioId) {
      var capture = (self.view.scheme.scenarios || []).filter(function (s) { return s.id === self.activeScenarioId; })[0];
      if (capture) {
        capture.steps = capture.steps || [];
        if (capture.steps[capture.steps.length - 1] !== id) {
          capture.steps.push(id);
          self.markDirty();
        }
        self.selectedIds = [];
        self.sel = null;
        self.root.classList.remove('ws-object-focus');
        self.root.classList.add('ws-scenario-capture');
        self.renderScenarios();
        self.redraw();
        return;
      }
    }
    if (additive) {
      var index = self.selectedIds.indexOf(id);
      if (index === -1) self.selectedIds.push(id); else self.selectedIds.splice(index, 1);
      if (!self.selectedIds.length) { self.deselect(); return; }
      self.sel = { type: 'node', id: self.selectedIds[0] };
    } else {
      self.selectedIds = [id];
      self.sel = { type: 'node', id: id };
    }
    self.root.classList.add('ws-object-focus');
    self.renderNodePanel();
    self.redraw();
  };

  Editor.prototype.selectEdge = function (key) {
    this.selectedIds = [];
    this.sel = { type: 'edge', key: key };
    this.root.classList.add('ws-object-focus');
    this.renderEdgePanel();
    this.redraw();
  };

  Editor.prototype.selectedNode = function () {
    var self = this;
    return self.sel && self.sel.type === 'node' ? self.view.byId[self.sel.id] : null;
  };

  Editor.prototype.selectedNodes = function () {
    var self = this;
    var ids = self.selectedIds.length ? self.selectedIds : (self.sel && self.sel.type === 'node' ? [self.sel.id] : []);
    return ids.map(function (id) { return self.view.byId[id]; }).filter(Boolean);
  };

  Editor.prototype.selectedEdge = function () {
    var self = this;
    if (!self.sel || self.sel.type !== 'edge') return null;
    return self.view.edges.filter(function (e) { return e.from + '>' + e.to === self.sel.key; })[0] || null;
  };

  /* ---- Панель свойств узла ---- */

  Editor.prototype.renderNodePanel = function () {
    var self = this;
    var n = self.selectedNode();
    var panel = document.getElementById('ws-obj-panel');
    if (!n) { panel.innerHTML = ''; return; }
    panel.innerHTML = '';

    var head = document.createElement('h4');
    head.textContent = self.labels.node + ': ' + n.title + ' [' + n.id + ']';
    panel.appendChild(head);

    var field = function (labelText, value, onchg, isArea, readonly) {
      var wrap = document.createElement('div');
      wrap.className = 'ws-field';
      var label = document.createElement('label');
      label.textContent = labelText;
      wrap.appendChild(label);
      var input = document.createElement(isArea ? 'textarea' : 'input');
      if (!isArea) input.type = 'text';
      input.value = value === null || value === undefined ? '' : value;
      if (readonly) input.readOnly = true;
      input.addEventListener('change', function () { onchg(input.value); });
      wrap.appendChild(input);
      panel.appendChild(wrap);
      return input;
    };

    field('ID (не меняется)', n.id, function () {}, false, true);
    field('Заголовок', n.title, function (v) { n.title = v; self.redraw(); });

    var textStyle = document.createElement('div');
    textStyle.className = 'ws-text-style';
    var styleLabel = document.createElement('strong');
    styleLabel.textContent = 'Текст на схеме';
    textStyle.appendChild(styleLabel);
    var size = document.createElement('input');
    size.type = 'number'; size.min = '8'; size.max = '32'; size.value = n.fontSize;
    size.setAttribute('aria-label', 'Размер шрифта');
    size.addEventListener('change', function () { n.fontSize = Math.max(8, Math.min(32, num(size.value, 12))); self.redraw(); });
    textStyle.appendChild(size);
    var weight = document.createElement('select');
    [['normal', 'Обычный'], ['bold', 'Жирный']].forEach(function (pair) { var o = document.createElement('option'); o.value = pair[0]; o.textContent = pair[1]; if (n.fontWeight === pair[0]) o.selected = true; weight.appendChild(o); });
    weight.setAttribute('aria-label', 'Начертание');
    weight.addEventListener('change', function () { n.fontWeight = weight.value; self.redraw(); });
    textStyle.appendChild(weight);
    var family = document.createElement('select');
    [['sans-serif', 'Без засечек'], ['serif', 'С засечками'], ['monospace', 'Моноширинный']].forEach(function (pair) { var o = document.createElement('option'); o.value = pair[0]; o.textContent = pair[1]; if (n.fontFamily === pair[0]) o.selected = true; family.appendChild(o); });
    family.setAttribute('aria-label', 'Семейство шрифта');
    family.addEventListener('change', function () { n.fontFamily = family.value; self.redraw(); });
    textStyle.appendChild(family);
    var textColor = document.createElement('input');
    textColor.type = 'color'; textColor.value = /^#[0-9a-f]{6}$/i.test(n.textColor || '') ? n.textColor : '#1a232b';
    textColor.setAttribute('aria-label', 'Цвет текста');
    textColor.addEventListener('input', function () { n.textColor = textColor.value; self.redraw(); });
    textStyle.appendChild(textColor);
    panel.appendChild(textStyle);

    var typeWrap = document.createElement('div');
    typeWrap.className = 'ws-field';
    var typeLabel = document.createElement('label');
    typeLabel.textContent = 'Тип';
    var typeSel = document.createElement('select');
    NODE_TYPES.forEach(function (pair) {
      var o = document.createElement('option');
      o.value = pair[0]; o.textContent = pair[1];
      if (n.type === pair[0]) o.selected = true;
      typeSel.appendChild(o);
    });
    typeSel.addEventListener('change', function () { n.type = typeSel.value; self.redraw(); });
    typeWrap.appendChild(typeLabel); typeWrap.appendChild(typeSel); panel.appendChild(typeWrap);

    field('Отдел (в подсказке)', n.dept, function (v) { n.dept = v; });
    field('Описание — подсказка при наведении', n.description, function (v) { n.description = v; }, true);
    field('Страница этапа (wiki-текст, открывается кликом)', n.page, function (v) { n.page = v; }, true);
    field('Ссылка (вместо страницы этапа)', n.url, function (v) { n.url = v; });
    field('ID запроса — живой счётчик', n.queryId, function (v) {
      var q = parseInt(v, 10);
      n.queryId = isFinite(q) && q > 0 ? q : null;
    });

    var geom = document.createElement('div');
    geom.className = 'ws-field ws-geom';
    [['x', 'X'], ['y', 'Y'], ['w', 'Ширина'], ['h', 'Высота']].forEach(function (pair) {
      var cell = document.createElement('label');
      cell.className = 'ws-geom-cell';
      var caption = document.createElement('span');
      caption.textContent = pair[1];
      cell.appendChild(caption);
      var input = document.createElement('input');
      input.type = 'number'; input.value = n[pair[0]]; input.setAttribute('aria-label', pair[1]);
      input.addEventListener('change', function () {
        n[pair[0]] = num(input.value, n[pair[0]]);
        self.redraw();
      });
      cell.appendChild(input);
      geom.appendChild(cell);
    });
    panel.appendChild(geom);

    var del = document.createElement('button');
    del.type = 'button';
    del.textContent = self.labels.del;
    del.addEventListener('click', function () { self.deleteNode(n.id); });
    panel.appendChild(del);
  };

  Editor.prototype.deleteNode = function (id) {
    var self = this;
    self.view.nodes = self.view.nodes.filter(function (n) { return n.id !== id; });
    self.view.edges = self.view.edges.filter(function (e) { return e.from !== id && e.to !== id; });
    (self.view.scheme.scenarios || []).forEach(function (s) {
      s.steps = s.steps.filter(function (step) { return step !== id; });
    });
    delete self.view.byId[id];
    self.markDirty();
    self.deselect();
  };

  Editor.prototype.addNode = function () {
    var self = this;
    var id = 'n' + (self.seq++);
    var node = {
      id: id, type: 'process', title: id, dept: '', description: '', page: '', url: '', icon: '',
      queryId: null, x: 60 + (self.seq % 5) * 30, y: 60 + (self.seq % 4) * 24, w: 140, h: 56
    };
    self.view.nodes.push(node);
    self.view.byId[id] = node;
    self.markDirty();
    self.selectNode(id);
  };

  /* ---- Панель свойств стрелки ---- */

  Editor.prototype.renderEdgePanel = function () {
    var self = this;
    var e = self.selectedEdge();
    var panel = document.getElementById('ws-obj-panel');
    if (!e) { panel.innerHTML = ''; return; }
    panel.innerHTML = '';

    var head = document.createElement('h4');
    head.textContent = self.labels.edge + ': ' + e.from + ' → ' + e.to;
    panel.appendChild(head);

    var hint = document.createElement('div');
    hint.className = 'ws-panel-hint';
    hint.textContent = 'Тяните оранжевые точки на концах стрелки, чтобы привязать её к другому блоку.';
    panel.appendChild(hint);

    var field = function (labelText, value, onchg, isArea) {
      var wrap = document.createElement('div');
      wrap.className = 'ws-field';
      var label = document.createElement('label');
      label.textContent = labelText;
      wrap.appendChild(label);
      var input = document.createElement(isArea ? 'textarea' : 'input');
      if (!isArea) input.type = 'text';
      input.value = value === null || value === undefined ? '' : value;
      input.addEventListener('change', function () { onchg(input.value); });
      wrap.appendChild(input);
      panel.appendChild(wrap);
      return input;
    };

    var selectField = function (labelText, options, value, onchg) {
      var wrap = document.createElement('div');
      wrap.className = 'ws-field';
      var label = document.createElement('label');
      label.textContent = labelText;
      wrap.appendChild(label);
      var sel = document.createElement('select');
      options.forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0]; o.textContent = pair[1];
        if (value === pair[0]) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { onchg(sel.value); });
      wrap.appendChild(sel);
      panel.appendChild(wrap);
      return sel;
    };

    var nodeSelect = function (labelText, selectedId, onchg) {
      var options = self.view.nodes.map(function (n) {
        return [n.id, n.title + ' (' + n.id + ')'];
      });
      var sel = selectField(labelText, options, selectedId, function (v) { onchg(v); });
      return sel;
    };

    nodeSelect('Откуда (блок)', e.from, function (v) {
      e.from = v; self.sel.key = e.from + '>' + e.to;
      self.redraw(); self.renderEdgePanel();
    });
    nodeSelect('Куда (блок)', e.to, function (v) {
      e.to = v; self.sel.key = e.from + '>' + e.to;
      self.redraw(); self.renderEdgePanel();
    });

    field('Подпись на стрелке', e.label, function (v) { e.label = v; self.redraw(); });

    var labelStyle = document.createElement('div');
    labelStyle.className = 'ws-text-style';
    var labelStyleTitle = document.createElement('strong');
    labelStyleTitle.textContent = 'Текст подписи';
    labelStyle.appendChild(labelStyleTitle);
    var labelSize = document.createElement('input');
    labelSize.type = 'number'; labelSize.min = '8'; labelSize.max = '32'; labelSize.value = e.labelFontSize;
    labelSize.setAttribute('aria-label', 'Размер шрифта подписи');
    labelSize.addEventListener('change', function () { e.labelFontSize = Math.max(8, Math.min(32, num(labelSize.value, 11))); self.redraw(); });
    labelStyle.appendChild(labelSize);
    var labelWeight = document.createElement('select');
    [['normal', 'Обычный'], ['bold', 'Жирный']].forEach(function (pair) { var o = document.createElement('option'); o.value = pair[0]; o.textContent = pair[1]; if (e.labelFontWeight === pair[0]) o.selected = true; labelWeight.appendChild(o); });
    labelWeight.setAttribute('aria-label', 'Начертание подписи');
    labelWeight.addEventListener('change', function () { e.labelFontWeight = labelWeight.value; self.redraw(); });
    labelStyle.appendChild(labelWeight);
    var labelFamily = document.createElement('select');
    [['sans-serif', 'Без засечек'], ['serif', 'С засечками'], ['monospace', 'Моноширинный']].forEach(function (pair) { var o = document.createElement('option'); o.value = pair[0]; o.textContent = pair[1]; if (e.labelFontFamily === pair[0]) o.selected = true; labelFamily.appendChild(o); });
    labelFamily.setAttribute('aria-label', 'Семейство шрифта подписи');
    labelFamily.addEventListener('change', function () { e.labelFontFamily = labelFamily.value; self.redraw(); });
    labelStyle.appendChild(labelFamily);
    var labelColor = document.createElement('input');
    labelColor.type = 'color'; labelColor.value = /^#[0-9a-f]{6}$/i.test(e.labelTextColor || '') ? e.labelTextColor : '#45505a';
    labelColor.setAttribute('aria-label', 'Цвет подписи');
    labelColor.addEventListener('input', function () { e.labelTextColor = labelColor.value; self.redraw(); });
    labelStyle.appendChild(labelColor);
    panel.appendChild(labelStyle);

    var colorWrap = document.createElement('div');
    colorWrap.className = 'ws-field';
    var colorLabel = document.createElement('label');
    colorLabel.textContent = self.labels.edgeColor;
    colorWrap.appendChild(colorLabel);
    var color = document.createElement('input');
    color.type = 'color';
    color.value = /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#7a8691';
    color.addEventListener('input', function () { e.color = color.value; self.redraw(); });
    colorWrap.appendChild(color);
    panel.appendChild(colorWrap);

    selectField('Форма', ROUTES, e.route, function (v) {
      e.route = v; self.redraw(); self.renderEdgePanel();
    });

    selectField('Стрелка выходит (сторона)', SIDES, e.fromSide, function (v) { e.fromSide = v; self.redraw(); });
    selectField('Стрелка входит (сторона)', SIDES, e.toSide, function (v) { e.toSide = v; self.redraw(); });

    var dashedWrap = document.createElement('div');
    dashedWrap.className = 'ws-field';
    var dashedCheck = document.createElement('input');
    dashedCheck.type = 'checkbox'; dashedCheck.checked = e.dashed === true; dashedCheck.id = 'ws-dashed-check';
    dashedCheck.addEventListener('change', function () { e.dashed = dashedCheck.checked; self.redraw(); });
    var dashedLabel = document.createElement('label');
    dashedLabel.setAttribute('for', 'ws-dashed-check');
    dashedLabel.textContent = 'Пунктирная линия';
    dashedWrap.appendChild(dashedCheck); dashedWrap.appendChild(dashedLabel);
    panel.appendChild(dashedWrap);

    if (e.route === 'arc' || e.route === 'elbow' || e.route === 'u') {
      var bendWrap = document.createElement('div');
      bendWrap.className = 'ws-field';
      var bendLabel = document.createElement('label');
      bendLabel.textContent = self.labels.bend + ' (' + e.bend + ')';
      var bend = document.createElement('input');
      bend.type = 'range'; bend.min = '0'; bend.max = '100'; bend.value = String(num(e.bend, 50));
      bend.addEventListener('input', function () {
        e.bend = num(bend.value, 50);
        bendLabel.textContent = self.labels.bend + ' (' + e.bend + ')';
        self.redraw();
      });
      bendWrap.appendChild(bendLabel); bendWrap.appendChild(bend);
      panel.appendChild(bendWrap);
    }

    var rowBtns = document.createElement('div');
    rowBtns.className = 'ws-field';
    var swap = document.createElement('button');
    swap.type = 'button';
    swap.textContent = self.labels.swap;
    swap.addEventListener('click', function () {
      var f = e.from; e.from = e.to; e.to = f;
      self.sel.key = e.from + '>' + e.to;
      self.redraw(); self.renderEdgePanel();
    });
    rowBtns.appendChild(swap);
    var del = document.createElement('button');
    del.type = 'button';
    del.textContent = self.labels.del;
    del.addEventListener('click', function () {
      self.view.edges = self.view.edges.filter(function (x) { return x !== e; });
      self.markDirty();
      self.deselect();
    });
    rowBtns.appendChild(del);
    panel.appendChild(rowBtns);
  };

  /* ---- Сценарии ---- */

  Editor.prototype.renderScenarios = function () {
    var self = this;
    var list = document.getElementById('ws-scenarios-list');
    list.innerHTML = '';
    (self.view.scheme.scenarios || []).forEach(function (scenario, index) {
      var row = document.createElement('div');
      row.className = 'ws-scenario-row';

      var title = document.createElement('input');
      title.type = 'text'; title.value = scenario.title; title.placeholder = 'Название';
      title.addEventListener('change', function () { scenario.title = title.value; });
      row.appendChild(title);

      var steps = document.createElement('input');
      steps.type = 'text'; steps.value = (scenario.steps || []).join(', ');
      steps.placeholder = 'Шаги: ' + self.labels.stepsHint;
      steps.addEventListener('change', function () {
        scenario.steps = steps.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      });
      row.appendChild(steps);

      var capture = document.createElement('button');
      capture.type = 'button';
      capture.className = 'ws-scenario-capture-button' + (self.activeScenarioId === scenario.id ? ' ws-active' : '');
      capture.textContent = self.activeScenarioId === scenario.id ? 'Готово' : 'Кликом';
      capture.title = 'Собрать шаги кликом по блокам';
      capture.addEventListener('click', function () {
        if (self.activeScenarioId === scenario.id) {
          self.activeScenarioId = null;
          self.root.classList.remove('ws-scenario-capture');
          self.setStatus('', '');
        } else {
          self.activeScenarioId = scenario.id;
          self.root.classList.add('ws-scenario-capture');
          self.setStatus('Кликом добавляйте блоки в сценарий', 'dirty');
        }
        self.renderScenarios();
      });
      row.appendChild(capture);

      var del = document.createElement('button');
      del.type = 'button'; del.textContent = '×';
      del.title = self.labels.del;
      del.addEventListener('click', function () {
        self.view.scheme.scenarios.splice(index, 1);
        if (self.activeScenarioId === scenario.id) {
          self.activeScenarioId = null;
          self.root.classList.remove('ws-scenario-capture');
        }
        self.markDirty();
        self.renderScenarios();
      });
      row.appendChild(del);

      list.appendChild(row);
    });
  };

  /* ---- Сериализация и сохранение ---- */

  Editor.prototype.serialize = function () {
    var self = this;
    return {
      title: self.view.scheme.title || 'Схема',
      theme: self.view.scheme.theme || 'classic',
      nodes: self.view.nodes.map(function (n) {
        return {
          id: n.id, type: n.type, title: n.title, dept: n.dept,
          description: n.description, page: n.page, url: n.url, icon: n.icon || '',
          query_id: n.queryId || null,
          font_size: n.fontSize || 12, font_weight: n.fontWeight || 'normal', font_family: n.fontFamily || 'sans-serif', text_color: n.textColor || '',
          x: n.x, y: n.y, w: n.w, h: n.h
        };
      }),
      edges: self.view.edges.map(function (e) {
        return {
          from: e.from, to: e.to, label: e.label, color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '',
          label_font_size: e.labelFontSize || 11, label_font_weight: e.labelFontWeight || 'normal', label_font_family: e.labelFontFamily || 'sans-serif', label_text_color: e.labelTextColor || '', dashed: e.dashed === true,
          route: e.route, from_side: e.fromSide || '', to_side: e.toSide || '',
          bend: num(e.bend, 50)
        };
      }),
      scenarios: self.view.scheme.scenarios || []
    };
  };

  Editor.prototype.save = function () {
    var self = this;
    if (!self.saveUrl) { self.setStatus('Адрес сохранения не задан (dev-превью)', 'err'); return; }
    var saveButton = document.getElementById('ws-save');
    if (saveButton) saveButton.disabled = true;
    var csrf = document.querySelector('meta[name="csrf-token"]');
    var body = new URLSearchParams();
    body.append('json', JSON.stringify(self.serialize(), null, 2));
    fetch(self.saveUrl, {
      method: 'POST',
      headers: {
        'X-CSRF-Token': csrf ? csrf.getAttribute('content') : '',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      body: body
    }).then(function (resp) {
      // Сервер может ответить не-JSON (например, HTML 500) — не падаем на parse
      return resp.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (_) { data = null; }
        return { status: resp.status, data: data };
      });
    }).then(function (res) {
      if (res.status === 200 && res.data && res.data.ok) {
        self.dirty = false;
        self.setStatus('✓ ' + self.labels.saved, 'ok');
      } else {
        var errs = (res.data && res.data.errors) || ['HTTP ' + res.status];
        self.setStatus(errs.join('; '), 'err');
      }
      if (saveButton) saveButton.disabled = false;
    }).catch(function (e) {
      if (saveButton) saveButton.disabled = false;
      self.setStatus(String(e), 'err');
    });
  };

  Editor.prototype.download = function () {
    var self = this;
    var blob = new Blob([JSON.stringify(self.serialize(), null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'work_scheme.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  function init() {
    var root = document.getElementById('ws-editor');
    if (!root || !window.WorkScheme || !window.WorkScheme.View) return;
    try {
      new Editor(root);
    } catch (e) {
      if (window.console && console.error) console.error('Work Scheme editor:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
