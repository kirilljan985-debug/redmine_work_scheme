/*
 * Redmine Work Scheme: визуальный редактор схемы (страница /work_scheme/edit).
 * Требует work_scheme.js (window.WorkScheme.View).
 * Возможности: выбор узлов/стрелок, правка всех свойств, добавление/удаление
 * узлов и стрелок, разворот направления, изгиб (bend), редактирование сценариев,
 * сохранение на сервер (POST /work_scheme/save) и выгрузка JSON.
 */
(function () {
  'use strict';

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

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
      swap: root.getAttribute('data-label-swap') || 'Развернуть',
      del: root.getAttribute('data-label-delete') || 'Удалить',
      node: root.getAttribute('data-label-node') || 'Узел',
      edge: root.getAttribute('data-label-edge') || 'Стрелка',
      scenarios: root.getAttribute('data-label-scenarios') || 'Сценарии',
      stepsHint: root.getAttribute('data-label-steps-hint') || 'id узлов через запятую',
      bend: root.getAttribute('data-label-bend') || 'Изгиб',
      more: root.getAttribute('data-more-label') || 'Подробнее'
    };
    var dataEl = root.querySelector('script.ws-data');
    if (!dataEl) return; // страница показывает ошибки валидации
    var scheme = JSON.parse(dataEl.textContent);
    var View = window.WorkScheme.View;
    this.view = new View(root.querySelector('.ws-container'), scheme);
    this.view.editMode = true;      // перетаскивание узлов включено
    this.view.showCoordPanel = false; // панель координат не нужна — есть полноценный редактор
    this.sel = null;                // {type:'node', id} | {type:'edge', key}
    this.pendingFrom = null;        // режим добавления стрелки: id исходного узла
    this.seq = this.maxNodeSeq() + 1;
    this.redraw();
    this.wire();
    this.renderScenarios();
  }

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
    // подсветка выбранного элемента
    if (self.sel && self.sel.type === 'node') {
      var g = self.view.container.querySelector('.ws-node[data-id="' + self.sel.id + '"]');
      if (g) g.classList.add('ws-selected');
    }
    if (self.sel && self.sel.type === 'edge') {
      var p = self.view.pathByEdge[self.sel.key];
      if (p) p.classList.add('ws-selected');
    }
    self.addHitPaths();
  };

  /* Прозрачные широкие дорожки поверх стрелок — чтобы легко кликать */
  Editor.prototype.addHitPaths = function () {
    var self = this;
    var svg = self.view.container.querySelector('svg');
    if (!svg) return;
    self.view.edges.forEach(function (edge) {
      var base = self.view.pathByEdge[edge.from + '>' + edge.to];
      if (!base) return;
      var hit = base.cloneNode();
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '14');
      hit.setAttribute('fill', 'none');
      hit.removeAttribute('marker-end');
      hit.setAttribute('class', 'ws-edge-hit' + (self.sel && self.sel.type === 'edge' && self.sel.key === edge.from + '>' + edge.to ? ' ws-selected' : ''));
      hit.addEventListener('click', function (ev) {
        ev.stopPropagation();
        self.selectEdge(edge.from + '>' + edge.to);
      });
      self.view.overlay.appendChild(hit);
    });
  };

  Editor.prototype.wire = function () {
    var self = this;
    var container = self.view.container;

    container.addEventListener('click', function (ev) {
      var nodeGroup = ev.target.closest ? ev.target.closest('.ws-node') : null;
      if (nodeGroup) { self.selectNode(nodeGroup.getAttribute('data-id')); return; }
      if (ev.target.closest && ev.target.closest('.ws-edge-hit')) return; // свой обработчик
      if (ev.target === container.querySelector('svg')) { self.deselect(); }
    });

    document.getElementById('ws-add-node').textContent = self.labels.addNode;
    document.getElementById('ws-add-node').addEventListener('click', function () { self.addNode(); });

    var addEdgeBtn = document.getElementById('ws-add-edge');
    addEdgeBtn.textContent = self.labels.addEdge;
    addEdgeBtn.title = self.labels.addEdgeHint;
    addEdgeBtn.addEventListener('click', function () {
      self.pendingFrom = null;
      addEdgeBtn.classList.toggle('ws-active');
      self.setStatus(self.labels.addEdgeHint, '');
    });

    document.getElementById('ws-add-scenario').textContent = '+ ' + self.labels.scenarios;
    document.getElementById('ws-add-scenario').addEventListener('click', function () {
      self.view.scheme.scenarios = self.view.scheme.scenarios || [];
      self.view.scheme.scenarios.push({ id: 'scenario' + (self.view.scheme.scenarios.length + 1), title: 'Сценарий', steps: [] });
      self.renderScenarios();
    });

    var saveBtn = document.getElementById('ws-save');
    saveBtn.textContent = self.labels.save;
    saveBtn.addEventListener('click', function () { self.save(); });

    var dlBtn = document.getElementById('ws-download');
    dlBtn.textContent = self.labels.download;
    dlBtn.addEventListener('click', function () { self.download(); });
  };

  Editor.prototype.setStatus = function (text, cls) {
    var el = document.getElementById('ws-save-status');
    el.innerHTML = '';
    var span = document.createElement('span');
    span.className = cls || '';
    span.textContent = text;
    el.appendChild(span);
  };

  Editor.prototype.deselect = function () {
    this.sel = null;
    document.getElementById('ws-obj-panel').innerHTML = '<em>' + this.labels.node + ' / ' + this.labels.edge + '</em>';
    this.redraw();
  };

  Editor.prototype.selectNode = function (id) {
    var self = this;
    if (self.pendingFrom) {
      // режим добавления стрелки: первый клик — источник, второй — цель
      if (!self.pendingFrom.from) {
        self.pendingFrom.from = id;
        self.setStatus(self.labels.addEdgeHint + ' [from: ' + id + ']', '');
        return;
      }
      if (self.pendingFrom.from === id) return;
      var edge = {
        from: self.pendingFrom.from, to: id, label: '', dashed: false,
        route: 'straight', fromSide: '', toSide: '', bend: 50
      };
      self.view.edges.push(edge);
      self.pendingFrom = null;
      var btn = document.getElementById('ws-add-edge');
      if (btn) btn.classList.remove('ws-active');
      self.redraw();
      self.selectEdge(edge.from + '>' + edge.to);
      return;
    }
    self.sel = { type: 'node', id: id };
    self.renderNodePanel();
    self.redraw();
  };

  Editor.prototype.selectEdge = function (key) {
    this.sel = { type: 'edge', key: key };
    this.renderEdgePanel();
    this.redraw();
  };

  Editor.prototype.selectedNode = function () {
    var self = this;
    return self.sel && self.sel.type === 'node' ? self.view.byId[self.sel.id] : null;
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
    head.textContent = self.labels.node + ': ' + n.id;
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

    field('id', n.id, function () {}, false, true);
    field('title', n.title, function (v) { n.title = v; self.redraw(); });
    var typeWrap = document.createElement('div');
    typeWrap.className = 'ws-field';
    var typeLabel = document.createElement('label');
    typeLabel.textContent = 'type';
    var typeSel = document.createElement('select');
    ['start', 'process', 'decision', 'end'].forEach(function (t) {
      var o = document.createElement('option');
      o.value = t; o.textContent = t;
      if (n.type === t) o.selected = true;
      typeSel.appendChild(o);
    });
    typeSel.addEventListener('change', function () { n.type = typeSel.value; self.redraw(); });
    typeWrap.appendChild(typeLabel); typeWrap.appendChild(typeSel); panel.appendChild(typeWrap);

    field('dept', n.dept, function (v) { n.dept = v; });
    field('description', n.description, function (v) { n.description = v; }, true);
    field('page', n.page, function (v) { n.page = v; }, true);
    field('url', n.url, function (v) { n.url = v; });
    field('query_id', n.queryId, function (v) {
      var q = parseInt(v, 10);
      n.queryId = isFinite(q) && q > 0 ? q : null;
    });

    var geom = document.createElement('div');
    geom.className = 'ws-field ws-geom';
    [['x', 'x'], ['y', 'y'], ['w', 'w'], ['h', 'h']].forEach(function (pair) {
      var input = document.createElement('input');
      input.type = 'number'; input.value = n[pair[0]]; input.title = pair[1];
      input.addEventListener('change', function () {
        n[pair[0]] = num(input.value, n[pair[0]]);
        self.redraw();
      });
      geom.appendChild(input);
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
    self.deselect();
  };

  Editor.prototype.addNode = function () {
    var self = this;
    var id = 'n' + (self.seq++);
    var node = {
      id: id, type: 'process', title: id, dept: '', description: '', page: '', url: '',
      queryId: null, x: 60 + (self.seq % 5) * 30, y: 60 + (self.seq % 4) * 24, w: 140, h: 56
    };
    self.view.nodes.push(node);
    self.view.byId[id] = node;
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

    var nodeOptions = function (selectedId, onchg) {
      var sel = document.createElement('select');
      self.view.nodes.forEach(function (n) {
        var o = document.createElement('option');
        o.value = n.id; o.textContent = n.title + ' (' + n.id + ')';
        if (n.id === selectedId) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { onchg(sel.value); });
      return sel;
    };

    var rowFrom = document.createElement('div');
    rowFrom.className = 'ws-field';
    rowFrom.appendChild(nodeOptions(e.from, function (v) { e.from = v; self.sel.key = e.from + '>' + e.to; self.redraw(); self.renderEdgePanel(); }));
    var lblFrom = document.createElement('label'); lblFrom.textContent = 'from'; rowFrom.insertBefore(lblFrom, rowFrom.firstChild);
    panel.appendChild(rowFrom);

    var rowTo = document.createElement('div');
    rowTo.className = 'ws-field';
    rowTo.appendChild(nodeOptions(e.to, function (v) { e.to = v; self.sel.key = e.from + '>' + e.to; self.redraw(); self.renderEdgePanel(); }));
    var lblTo = document.createElement('label'); lblTo.textContent = 'to'; rowTo.insertBefore(lblTo, rowTo.firstChild);
    panel.appendChild(rowTo);

    field('label', e.label, function (v) { e.label = v; self.redraw(); });

    var sideSel = function (value, onchg) {
      var sel = document.createElement('select');
      ['', 'left', 'right', 'top', 'bottom'].forEach(function (s) {
        var o = document.createElement('option');
        o.value = s; o.textContent = s === '' ? 'auto' : s;
        if (value === s) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { onchg(sel.value); self.redraw(); });
      return sel;
    };
    var rowFs = document.createElement('div'); rowFs.className = 'ws-field';
    var lblFs = document.createElement('label'); lblFs.textContent = 'from_side';
    rowFs.appendChild(lblFs); rowFs.appendChild(sideSel(e.fromSide, function (v) { e.fromSide = v; }));
    panel.appendChild(rowFs);
    var rowTs = document.createElement('div'); rowTs.className = 'ws-field';
    var lblTs = document.createElement('label'); lblTs.textContent = 'to_side';
    rowTs.appendChild(lblTs); rowTs.appendChild(sideSel(e.toSide, function (v) { e.toSide = v; }));
    panel.appendChild(rowTs);

    var routeWrap = document.createElement('div');
    routeWrap.className = 'ws-field';
    var routeLabel = document.createElement('label');
    routeLabel.textContent = 'route';
    var routeSel = document.createElement('select');
    [['straight', 'straight'], ['arc', 'arc'], ['elbow', 'elbow']].forEach(function (pair) {
      var o = document.createElement('option');
      o.value = pair[0]; o.textContent = pair[1];
      if (e.route === pair[0]) o.selected = true;
      routeSel.appendChild(o);
    });
    routeSel.addEventListener('change', function () { e.route = routeSel.value; self.redraw(); });
    routeWrap.appendChild(routeLabel); routeWrap.appendChild(routeSel);
    panel.appendChild(routeWrap);

    var dashedWrap = document.createElement('div');
    dashedWrap.className = 'ws-field';
    var dashedCheck = document.createElement('input');
    dashedCheck.type = 'checkbox'; dashedCheck.checked = e.dashed === true;
    dashedCheck.addEventListener('change', function () { e.dashed = dashedCheck.checked; self.redraw(); });
    var dashedLabel = document.createElement('label');
    dashedLabel.textContent = 'dashed (пунктир)';
    dashedWrap.appendChild(dashedCheck); dashedWrap.appendChild(dashedLabel);
    panel.appendChild(dashedWrap);

    if (e.route === 'arc' || e.route === 'elbow') {
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
      title.type = 'text'; title.value = scenario.title; title.placeholder = 'title';
      title.addEventListener('change', function () { scenario.title = title.value; });
      row.appendChild(title);

      var steps = document.createElement('input');
      steps.type = 'text'; steps.value = (scenario.steps || []).join(', ');
      steps.placeholder = self.labels.stepsHint;
      steps.addEventListener('change', function () {
        scenario.steps = steps.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      });
      row.appendChild(steps);

      var del = document.createElement('button');
      del.type = 'button'; del.textContent = '×';
      del.title = self.labels.del;
      del.addEventListener('click', function () {
        self.view.scheme.scenarios.splice(index, 1);
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
      nodes: self.view.nodes.map(function (n) {
        return {
          id: n.id, type: n.type, title: n.title, dept: n.dept,
          description: n.description, page: n.page, url: n.url,
          query_id: n.queryId || null,
          x: n.x, y: n.y, w: n.w, h: n.h
        };
      }),
      edges: self.view.edges.map(function (e) {
        return {
          from: e.from, to: e.to, label: e.label, dashed: e.dashed === true,
          route: e.route, from_side: e.fromSide || '', to_side: e.toSide || '',
          bend: num(e.bend, 50)
        };
      }),
      scenarios: self.view.scheme.scenarios || []
    };
  };

  Editor.prototype.save = function () {
    var self = this;
    if (!self.saveUrl) { self.setStatus('save url не задан', 'err'); return; }
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
      return resp.json().then(function (data) { return { status: resp.status, data: data }; });
    }).then(function (res) {
      if (res.status === 200 && res.data.ok) {
        self.setStatus('✓ ' + self.labels.saved, 'ok');
      } else {
        var errs = (res.data && res.data.errors) || ['HTTP ' + res.status];
        self.setStatus(errs.join('; '), 'err');
      }
    }).catch(function (e) {
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
