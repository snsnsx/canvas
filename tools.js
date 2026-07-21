import {
  CELL,
  BOARD_W,
  PAGE_H,
  DEFAULT_PEN,
  DEFAULT_HL,
  SIZE_PRESETS,
  MAX_EXPORT_H,
  generateUUID
} from './storage.js';

export class ToolManager {
  constructor(storage, renderer, network, history) {
    this.storage = storage;
    this.renderer = renderer;
    this.network = network;
    this.history = history;

    this.activeStroke = null;
    this.drawPid = null;
    this.penActive = false;

    this.panPid = null;
    this.panStartY = 0;
    this.panStartCam = 0;
    this.panLastY = 0;
    this.panLastT = 0;
    this.panVel = 0;
    this.momRAF = null;

    this.dragPid = null;
    this.dragMode = null;
    this.dragOff = { x: 0, y: 0 };
    this.dragStart = null;

    this.lassoPid = null;
    this.lassoMode = null;
    this.lassoStart = null;
    this.lassoOriginal = null;

    this.sbTimer = null;

    this.fileInput = document.getElementById('fileInput');
    this.overlay = document.getElementById('overlay');
    this.vbar = document.getElementById('vbar');
    this.thumb = document.getElementById('thumb');
    this.stage = this.renderer.stage;
    this.eraserCursor = document.getElementById('eraserCursor');

    // Панель страниц (слева)
    this.pageIndicator = document.getElementById('pageIndicator');

    this.init();
  }

  init() {
    this.buildSwatches();
    this.buildSizes();
    this.syncTools();

    // Attach canvas events
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('pointercancel', (e) => this.onUp(e));
    this.overlay.addEventListener('pointerleave', () => {
      this.hideEraserCursor();
      this.network.sendCursorLeave();
    });
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());

    // Wheel/trackpad panning (вертикальная прокрутка)
    this.renderer.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.network.pauseAutoFocus();
      this.renderer.stopFocus();
      this.stopMomentum();
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      this.storage.cameraY += d / this.renderer.scale;
      this.renderer.clampCamera();
      this.renderer.scheduleRender();
      this.showScrollbar();
      this.hideScrollbarLater();
    }, { passive: false });

    // Buttons
    document.getElementById('eraserBtn').addEventListener('click', () => {
      this.storage.tool = 'eraser';
      this.syncTools();
    });
    document.getElementById('lassoBtn').addEventListener('click', () => {
      this.storage.tool = 'lasso';
      this.storage.selected = null;
      this.syncTools();
    });

    const gridBtn = document.getElementById('gridBtn');
    const gridMenu = document.getElementById('gridMenu');
    gridBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !gridMenu.classList.contains('open');
      gridMenu.classList.toggle('open', open);
      gridBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) this.positionGridMenu();
    });
    document.querySelectorAll('#gridMenu .btn').forEach(b => {
      b.addEventListener('click', () => {
        this.setGrid(b.dataset.grid);
        gridMenu.classList.remove('open');
        gridBtn.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('pointerdown', (e) => {
      if (!gridMenu.contains(e.target) && e.target !== gridBtn) {
        gridMenu.classList.remove('open');
        gridBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.getElementById('undoBtn').addEventListener('click', () => this.history.undo());
    document.getElementById('redoBtn').addEventListener('click', () => this.history.redo());
    document.getElementById('clearBtn').addEventListener('click', () => this.clearBoard());
    document.getElementById('imgBtn').addEventListener('click', () => this.fileInput.click());
    document.getElementById('exportBtn').addEventListener('click', () => this.exportPNG());
    window.addEventListener('gridChanged', () => this.syncTools());

    // Панель страниц (блокнот)
    document.getElementById('prevPageBtn')?.addEventListener('click', () => this.prevPage());
    document.getElementById('nextPageBtn')?.addEventListener('click', () => this.nextPage());
    document.getElementById('addPageBtn')?.addEventListener('click', () => this.addPage());
    document.getElementById('delPageBtn')?.addEventListener('click', () => this.deleteCurrentPage());
    // Обновление индикатора при изменениях страниц от удалённых клиентов / загрузки.
    window.addEventListener('pagesChanged', () => this.updatePageUI());
    this.updatePageUI();

    // Image Upload
    this.fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => this.addImage(reader.result);
      reader.readAsDataURL(f);
      this.fileInput.value = '';
    });

    // Вставка изображений: drag-and-drop файлов на холст
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.indexOf('image/') === 0);
      if (!files.length) return;
      e.preventDefault();
      this.addImageFiles(files, this.clientToWorld(e.clientX, e.clientY));
    });

    // Вставка изображений: Cmd/Ctrl+V из буфера обмена
    window.addEventListener('paste', (e) => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      this.addImageFiles(files);   // без точки — по центру видимой области
    });

    // Keyboard
    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    // Scrollbar drag
    this.initScrollbarDrag();

    // Disable zoom gestures in iOS
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => {
      document.addEventListener(ev, e => e.preventDefault());
    });
    document.addEventListener('dblclick', e => e.preventDefault());

    // Ладонь, лежащая на планшете во время письма пером, не должна запускать
    // нативное выделение содержимого страницы (страховка к user-select: none).
    this.stage.addEventListener('selectstart', e => e.preventDefault());

    // Пружинистый отклик на нажатие во всех тулбарах.
    this.initPressFx();
  }

  // --- Swatches & Size UI Builders ---

  buildSwatches() {
    const penWrap = document.getElementById('penColors');
    const hlWrap = document.getElementById('hlColors');
    if (!penWrap || !hlWrap) return;

    penWrap.innerHTML = '';
    hlWrap.innerHTML = '';

    this.storage.penColors.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.title = `Ручка — цвет ${i + 1} (удержание — сменить)`;
      b.setAttribute('aria-label', `Ручка, цвет ${i + 1}`);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<span class="dot" style="background:${c}"></span>`;
      b.addEventListener('click', () => {
        this.storage.tool = 'pen';
        this.storage.penIdx = i;
        this.syncTools();
      });
      this.attachLongPress(b, () => this.pickColor('pen', i));
      penWrap.appendChild(b);
    });

    this.storage.hlColors.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch hl';
      b.title = `Маркер — цвет ${i + 1} (удержание — сменить)`;
      b.setAttribute('aria-label', `Маркер, цвет ${i + 1}`);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<span class="dot" style="background:${c}"></span>`;
      b.addEventListener('click', () => {
        this.storage.tool = 'highlighter';
        this.storage.hlIdx = i;
        this.syncTools();
      });
      this.attachLongPress(b, () => this.pickColor('highlighter', i));
      hlWrap.appendChild(b);
    });
  }

  buildSizes() {
    const wrap = document.getElementById('sizes');
    if (!wrap) return;
    wrap.innerHTML = '';
    [6, 10, 15].forEach((px, i) => {
      const b = document.createElement('button');
      b.className = 'size';
      b.dataset.i = i;
      b.title = ['Тонко', 'Средне', 'Толсто'][i];
      b.setAttribute('aria-label', `Толщина: ${['тонко', 'средне', 'толсто'][i]}`);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<span class="pip" style="width:${px}px;height:${px}px"></span>`;
      b.addEventListener('click', () => {
        const t = (this.storage.tool === 'select' || this.storage.tool === 'lasso') ? 'pen' : this.storage.tool;
        if (this.storage.tool === 'select' || this.storage.tool === 'lasso') {
          this.storage.tool = 'pen';
        }
        this.storage.sizeIdx[t] = i;
        this.syncTools();
      });
      wrap.appendChild(b);
    });
  }

  syncTools() {
    if (this.storage.tool !== 'lasso' && this.storage.selection) {
      this.storage.selection = null;
      this.renderer.lassoPath = null;
      this.renderer.renderOverlay();
    }
    document.querySelectorAll('#penColors .swatch').forEach((b, i) => {
      const selected = this.storage.tool === 'pen' && i === this.storage.penIdx;
      b.classList.toggle('sel', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    document.querySelectorAll('#hlColors .swatch').forEach((b, i) => {
      const selected = this.storage.tool === 'highlighter' && i === this.storage.hlIdx;
      b.classList.toggle('sel', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });

    const eraserBtn = document.getElementById('eraserBtn');
    if (eraserBtn) {
      const selected = this.storage.tool === 'eraser';
      eraserBtn.classList.toggle('on', selected);
      eraserBtn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }

    const lassoBtn = document.getElementById('lassoBtn');
    if (lassoBtn) {
      const selected = this.storage.tool === 'lasso';
      lassoBtn.classList.toggle('on', selected);
      lassoBtn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }

    const st = (this.storage.tool === 'select' || this.storage.tool === 'lasso') ? 'pen' : this.storage.tool;
    document.querySelectorAll('#sizes .size').forEach((b, i) => {
      const selected = i === this.storage.sizeIdx[st];
      b.classList.toggle('sel', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    document.querySelectorAll('#gridMenu .btn').forEach(b => {
      const selected = b.dataset.grid === this.storage.gridType;
      b.classList.toggle('on', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    const currentGrid = document.querySelector(`#gridMenu .btn[data-grid="${this.storage.gridType}"]`);
    const gridBtn = document.getElementById('gridBtn');
    if (gridBtn && currentGrid) gridBtn.title = `Настройки фона: ${currentGrid.title}`;
    if (this.storage.tool !== 'eraser') this.hideEraserCursor();
    this.stage.classList.toggle('lasso', this.storage.tool === 'lasso');
    // Выделение изображения больше не привязано к инструменту «выделение»:
    // им можно управлять в любом инструменте, поэтому здесь его не сбрасываем.
  }

  positionGridMenu() {
    const btn = document.getElementById('gridBtn');
    const menu = document.getElementById('gridMenu');
    if (!btn || !menu) return;
    const r = btn.getBoundingClientRect();
    const menuW = menu.offsetWidth || 146;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menuW - 8, r.right - menuW))}px`;
    menu.style.top = `${Math.min(innerHeight - 48, r.bottom + 8)}px`;
  }

  setGrid(grid) {
    this.storage.gridType = grid;
    this.syncTools();
    this.renderer.renderBack();
    this.network.send({ type: 'changeGrid', payload: { grid } });
  }

  attachLongPress(el, cb) {
    let t = null, moved = false, sx = 0, sy = 0;
    el.addEventListener('pointerdown', e => {
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      t = setTimeout(() => {
        t = null;
        if (!moved) cb();
      }, 550);
    });
    el.addEventListener('pointermove', e => {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) moved = true;
    });
    const cancel = () => { if (t) { clearTimeout(t); t = null; } };
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); cb(); });
  }

  pickColor(kind, i) {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = (kind === 'pen' ? this.storage.penColors[i] : this.storage.hlColors[i]);
    inp.style.position = 'fixed';
    inp.style.left = '-9999px';
    document.body.appendChild(inp);

    inp.addEventListener('input', () => {
      if (kind === 'pen') {
        this.storage.penColors[i] = inp.value;
        this.storage.tool = 'pen';
        this.storage.penIdx = i;
      } else {
        this.storage.hlColors[i] = inp.value;
        this.storage.tool = 'highlighter';
        this.storage.hlIdx = i;
      }
      this.buildSwatches();
      this.syncTools();
    });
    inp.addEventListener('change', () => { setTimeout(() => inp.remove(), 0); });
    inp.click();
  }

  // --- Keyboard Shortcuts ---

  onKeyDown(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? this.history.redo() : this.history.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.history.redo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.storage.selection) {
        e.preventDefault();
        this.deleteLassoSelection();
      } else if (this.storage.selected) {
        e.preventDefault();
        this.deleteSelected();
      }
      return;
    }
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;

    switch (e.key.toLowerCase()) {
      case 'p': this.storage.tool = 'pen'; this.syncTools(); break;
      case 'h': this.storage.tool = 'highlighter'; this.syncTools(); break;
      case 'e': this.storage.tool = 'eraser'; this.syncTools(); break;
      case 'l':
        this.storage.tool = 'lasso';
        this.storage.selected = null;
        this.syncTools();
        this.renderer.renderOverlay();
        break;
      case 'arrowup':
        this.network.pauseAutoFocus();
        this.renderer.stopFocus();
        this.storage.cameraY -= 80 / this.renderer.scale;
        this.renderer.clampCamera();
        this.renderer.scheduleRender();
        this.showScrollbar();
        this.hideScrollbarLater();
        break;
      case 'arrowdown':
        this.network.pauseAutoFocus();
        this.renderer.stopFocus();
        this.storage.cameraY += 80 / this.renderer.scale;
        this.renderer.clampCamera();
        this.renderer.scheduleRender();
        this.showScrollbar();
        this.hideScrollbarLater();
        break;
      case 'home':
        this.network.pauseAutoFocus();
        this.renderer.stopFocus();
        this.storage.cameraY = 0;
        this.renderer.clampCamera();
        this.renderer.scheduleRender();
        break;
      case 'end':
        this.network.pauseAutoFocus();
        this.renderer.stopFocus();
        this.storage.cameraY = this.renderer.maxCamera();
        this.renderer.clampCamera();
        this.renderer.scheduleRender();
        break;
      case '[':
        this.prevPage();
        break;
      case ']':
        this.nextPage();
        break;
    }
  }

  // --- Pointer Handlers (Input Routing) ---

  pointerPos(e) {
    const r = this.overlay.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  pointerWorld(e) {
    const { sx, sy } = this.pointerPos(e);
    return {
      x: sx / this.renderer.scale,
      y: sy / this.renderer.scale + this.storage.cameraY
    };
  }

  isDrawingPointer(e) {
    return e.pointerType === 'pen' || e.pointerType === 'mouse';
  }

  sendIdleCursor(e) {
    if (!this.isDrawingPointer(e)) return;
    if (this.drawPid !== null || this.dragPid !== null || this.panPid !== null || this.lassoPid !== null) return;
    if (e.buttons && e.buttons !== 0) return;
    this.network.sendCursor(this.pointerWorld(e));
  }

  onDown(e) {
    this.network.pauseAutoFocus();
    this.renderer.stopFocus();
    if (e.pointerType === 'pen') this.penActive = true;
    this.updateEraserCursor(e);
    if (this.isDrawingPointer(e)) this.network.sendCursorLeave();

    if (this.storage.tool === 'lasso') {
      if (e.pointerType === 'touch' && this.penActive) return;
      if (this.lassoPid !== null || this.dragPid !== null || this.drawPid !== null) return;
      this.overlay.setPointerCapture(e.pointerId);
      this.beginLasso(e);
      return;
    }

    // Режим «выделение»: перо/мышь управляют изображениями
    if (this.storage.tool === 'select' && this.isDrawingPointer(e)) {
      this.overlay.setPointerCapture(e.pointerId);
      this.beginImageDrag(e);
      return;
    }

    // Инструменты рисования: перо/мышь рисуют. Но если есть выделенное
    // изображение и попали в его ручки или тело — двигаем/масштабируем/удаляем.
    // Управление картинкой доступно в любом инструменте, как и для пальца.
    if (this.isDrawingPointer(e)) {
      this.overlay.setPointerCapture(e.pointerId);
      if (this.storage.selected && this.beginImageDrag(e)) return;
      this.startStroke(e);
      return;
    }

    // Палец: прямое управление изображением, иначе — панорамирование (в любом инструменте)
    if (e.pointerType === 'touch') {
      if (this.penActive) return;                                             // отсечение ладони
      if (this.drawPid !== null || this.dragPid !== null || this.panPid !== null) return;
      this.overlay.setPointerCapture(e.pointerId);
      if (this.beginImageDrag(e)) return;                                     // попали в изображение/ручку
      this.startPan(e);
      return;
    }
  }

  onMove(e) {
    this.updateEraserCursor(e);
    if (e.pointerId === this.drawPid && this.activeStroke) {
      this.extendStroke(e);
      return;
    }
    if (e.pointerId === this.panPid) {
      this.movePan(e);
      return;
    }
    if (e.pointerId === this.dragPid && this.dragMode) {
      this.moveSelect(e);
      return;
    }
    if (e.pointerId === this.lassoPid) {
      this.moveLasso(e);
      return;
    }
    this.sendIdleCursor(e);
  }

  onUp(e) {
    if (e.pointerType === 'pen') this.penActive = false;
    if (e.pointerId === this.drawPid) this.endStroke();
    if (e.pointerId === this.panPid) this.endPan();
    if (e.pointerId === this.dragPid) this.endSelect();
    if (e.pointerId === this.lassoPid) this.endLasso();
    this.sendIdleCursor(e);
  }

  // --- Active Stroke Handlers ---

  startStroke(e) {
    this.network.pauseAutoFocus();
    // Рисование снимает выделение изображения
    if (this.storage.selected) {
      this.storage.selected = null;
      this.renderer.renderOverlay();
    }
    if (this.storage.selection) {
      this.storage.selection = null;
      this.renderer.renderOverlay();
    }

    this.drawPid = e.pointerId;
    const { sx, sy } = this.pointerPos(e);
    const col = this.storage.tool === 'pen'
      ? this.storage.penColors[this.storage.penIdx]
      : this.storage.tool === 'highlighter'
        ? this.storage.hlColors[this.storage.hlIdx]
        : '#000000';
    const sz = SIZE_PRESETS[this.storage.tool][this.storage.sizeIdx[this.storage.tool]];

    const strokeId = generateUUID();
    const wpt = {
      x: sx / this.renderer.scale,
      y: sy / this.renderer.scale + this.storage.cameraY,
      pressure: this.pointerPressure(e)
    };
    this.activeStroke = {
      id: strokeId,
      page: this.storage.currentPageId,
      tool: this.storage.tool,
      color: col,
      size: sz,
      points: [wpt]
    };

    // Активный штрих виден плановым рендерам, пока не завершён
    this.renderer.activeStroke = this.activeStroke;

    // Buffer and stream points
    this.network.startStroke(strokeId, this.storage.tool, col, sz, wpt, this.storage.currentPageId);
    this.renderer.renderActive(this.activeStroke);
  }

  extendStroke(e) {
    this.network.pauseAutoFocus(1200);
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const r = this.overlay.getBoundingClientRect();
    const k = this.renderer.scale;
    for (const ev of evs) {
      const pt = {
        x: (ev.clientX - r.left) / k,
        y: (ev.clientY - r.top) / k + this.storage.cameraY,
        pressure: this.pointerPressure(ev)
      };
      this.activeStroke.points.push(pt);
      this.network.bufferPoint(pt);
    }
    this.renderer.renderActive(this.activeStroke);
  }

  pointerPressure(e) {
    if (e.pointerType !== 'pen') return undefined;
    if (!Number.isFinite(e.pressure) || e.pressure <= 0) return undefined;
    return Math.max(0.05, Math.min(1, e.pressure));
  }

  endStroke() {
    if (this.activeStroke) {
      this.storage.computeBBox(this.activeStroke);
      const s = this.activeStroke;
      this.storage.strokes.push(s);

      this.network.endStroke(); // Flushes points and closes stroke

      this.renderer.drawStrokeTo(this.renderer.cacheCtx, s, this.storage.cameraY);
      this.renderer.blitInk();
      this.storage.extendBottom(s);

      // Save to local undo/redo history
      this.history.push({
        type: 'draw',
        id: s.id,
        stroke: s
      });
      this.network.sendCursor(s.points[s.points.length - 1]);
    }
    this.activeStroke = null;
    this.renderer.activeStroke = null;
    this.drawPid = null;
  }

  // --- Finger Panning with Inertia (вертикальное) ---

  startPan(e) {
    this.network.pauseAutoFocus();
    this.stopMomentum();
    this.renderer.stopFocus();
    this.panPid = e.pointerId;
    this.panStartY = e.clientY;
    this.panStartCam = this.storage.cameraY;
    this.panLastY = e.clientY;
    this.panLastT = performance.now();
    this.panVel = 0;
    this.showScrollbar();
  }

  movePan(e) {
    this.network.pauseAutoFocus(1200);
    const now = performance.now();
    const k = this.renderer.scale;
    this.storage.cameraY = this.panStartCam - (e.clientY - this.panStartY) / k;
    this.renderer.clampCamera();

    const dt = Math.max(1, now - this.panLastT);
    this.panVel = -((e.clientY - this.panLastY) / dt) / k; // мировых px/ms
    this.panLastY = e.clientY;
    this.panLastT = now;

    this.renderer.scheduleRender();
  }

  endPan() {
    this.panPid = null;
    if (Math.abs(this.panVel) > 0.02) this.startMomentum();
    else this.hideScrollbarLater();
  }

  startMomentum() {
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;

      this.storage.cameraY += this.panVel * dt;
      this.panVel *= Math.pow(0.94, dt / 16);

      const before = this.storage.cameraY;
      this.renderer.clampCamera();
      if (before !== this.storage.cameraY) this.panVel = 0;

      this.renderer.fullRender();

      if (Math.abs(this.panVel) > 0.02) {
        this.momRAF = requestAnimationFrame(step);
      } else {
        this.momRAF = null;
        this.hideScrollbarLater();
      }
    };
    this.momRAF = requestAnimationFrame(step);
  }

  stopMomentum() {
    if (this.momRAF) {
      cancelAnimationFrame(this.momRAF);
      this.momRAF = null;
    }
  }

  // --- Scrollbar Handling (вертикальный) ---

  showScrollbar() {
    this.vbar.classList.add('show');
    if (this.sbTimer) {
      clearTimeout(this.sbTimer);
      this.sbTimer = null;
    }
  }

  hideScrollbarLater() {
    if (this.sbTimer) clearTimeout(this.sbTimer);
    this.sbTimer = setTimeout(() => this.vbar.classList.remove('show'), 900);
  }

  // --- Eraser Cursor (кольцо, показывающее размер и положение ластика) ---

  updateEraserCursor(e) {
    const show = this.storage.tool === 'eraser'
      && (e.pointerType === 'mouse' || e.pointerType === 'pen');
    if (!show) { this.hideEraserCursor(); return; }
    if (!this.eraserCursor) return;

    const { sx, sy } = this.pointerPos(e);
    const worldSize = SIZE_PRESETS.eraser[this.storage.sizeIdx.eraser];
    const d = Math.max(6, worldSize * this.renderer.scale);   // диаметр в экранных px
    const c = this.eraserCursor;
    c.style.width = d + 'px';
    c.style.height = d + 'px';
    c.style.left = sx + 'px';
    c.style.top = sy + 'px';
    c.classList.add('show');
    this.stage.classList.add('erase');
  }

  hideEraserCursor() {
    if (this.eraserCursor) this.eraserCursor.classList.remove('show');
    if (this.stage) this.stage.classList.remove('erase');
  }

  initScrollbarDrag() {
    let id = null, grab = 0;
    this.thumb.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      this.network.pauseAutoFocus();
      this.renderer.stopFocus();
      this.stopMomentum();

      id = e.pointerId;
      grab = e.clientY - this.thumb.getBoundingClientRect().top;
      this.thumb.setPointerCapture(id);
      this.showScrollbar();
    });
    this.thumb.addEventListener('pointermove', e => {
      if (e.pointerId !== id) return;
      this.network.pauseAutoFocus(1200);
      const barRect = this.vbar.getBoundingClientRect();
      const th = this.thumb.offsetHeight;
      const maxTop = barRect.height - th;
      let top = Math.max(0, Math.min(maxTop, e.clientY - barRect.top - grab));

      this.storage.cameraY = this.renderer.maxCamera() * (top / (maxTop || 1));
      this.renderer.clampCamera();
      this.renderer.scheduleRender();
    });
    this.thumb.addEventListener('pointerup', e => {
      if (e.pointerId === id) {
        id = null;
        this.hideScrollbarLater();
      }
    });
  }

  // --- Lasso selection (strokes + images) ---

  beginLasso(e) {
    const world = this.pointerWorld(e);
    const screen = this.pointerPos(e);
    const bounds = this.renderer.selectionBounds(this.storage.selection);
    this.lassoPid = e.pointerId;

    if (bounds) {
      const k = this.renderer.scale;
      const deleteX = (bounds.x + bounds.w) * k + 14;
      const deleteY = (bounds.y - this.storage.cameraY) * k - 14;
      if (Math.hypot(screen.sx - deleteX, screen.sy - deleteY) <= 17) {
        this.deleteLassoSelection();
        this.lassoPid = null;
        return;
      }
      if (world.x >= bounds.x && world.x <= bounds.x + bounds.w && world.y >= bounds.y && world.y <= bounds.y + bounds.h) {
        this.lassoMode = 'move';
        this.lassoStart = world;
        this.lassoOriginal = this.snapshotSelection(this.storage.selection);
        return;
      }
    }

    this.storage.selection = null;
    this.lassoMode = 'draw';
    this.lassoStart = world;
    this.renderer.lassoPath = [world];
    this.renderer.renderOverlay();
  }

  moveLasso(e) {
    const world = this.pointerWorld(e);
    if (this.lassoMode === 'draw') {
      const path = this.renderer.lassoPath;
      const last = path[path.length - 1];
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= 2 / this.renderer.scale) {
        path.push(world);
        this.renderer.renderOverlay();
      }
      return;
    }
    if (this.lassoMode !== 'move' || !this.lassoOriginal) return;
    const dx = world.x - this.lassoStart.x;
    const dy = world.y - this.lassoStart.y;
    for (const item of this.lassoOriginal) {
      if (item.objectType === 'stroke') {
        item.object.points = item.before.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
        this.storage.computeBBox(item.object);
      } else {
        item.object.x = item.before.x + dx;
        item.object.y = item.before.y + dy;
      }
    }
    this.renderer.fullRender();
  }

  endLasso() {
    if (this.lassoMode === 'draw') {
      const path = this.renderer.lassoPath || [];
      if (path.length >= 3) {
        const cur = this.storage.currentPageId;
        const strokes = this.storage.strokes.filter(s => s.page === cur && (s.points || []).some(p => this.pointInPolygon(p, path)));
        const images = this.storage.images.filter(im => im.page === cur && this.pointInPolygon({ x: im.x + im.w / 2, y: im.y + im.h / 2 }, path));
        this.storage.selection = (strokes.length || images.length) ? { strokes, images } : null;
      }
      this.renderer.lassoPath = null;
    } else if (this.lassoMode === 'move' && this.lassoOriginal) {
      const items = this.lassoOriginal.map(item => ({
        id: item.object.id,
        objectType: item.objectType,
        before: item.before,
        after: item.objectType === 'stroke'
          ? { points: this.cloneStrokePoints(item.object.points) }
          : { x: item.object.x, y: item.object.y, w: item.object.w, h: item.object.h }
      }));
      const changed = items.some(item => item.objectType === 'stroke'
        ? item.before.points.some((p, i) => p.x !== item.after.points[i].x || p.y !== item.after.points[i].y)
        : item.before.x !== item.after.x || item.before.y !== item.after.y);
      if (changed) {
        this.storage.recomputeContentBottom();
        this.history.push({ type: 'batch_move', items });
        for (const item of this.lassoOriginal) this.broadcastRestore(item.object, item.objectType);
      }
    }
    this.lassoMode = null;
    this.lassoPid = null;
    this.lassoStart = null;
    this.lassoOriginal = null;
    this.renderer.fullRender();
  }

  pointInPolygon(point, polygon) {
    const px = point.x !== undefined ? point.x : point[0];
    const py = point.y !== undefined ? point.y : point[1];
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      const intersects = ((a.y > py) !== (b.y > py))
        && (px < (b.x - a.x) * (py - a.y) / ((b.y - a.y) || 1e-9) + a.x);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  snapshotSelection(selection) {
    const items = [];
    for (const s of selection.strokes || []) {
      items.push({ object: s, objectType: 'stroke', before: { points: this.cloneStrokePoints(s.points) } });
    }
    for (const im of selection.images || []) {
      items.push({ object: im, objectType: 'image', before: { x: im.x, y: im.y, w: im.w, h: im.h } });
    }
    return items;
  }

  cloneStrokePoints(points) {
    return (points || []).map(p => Array.isArray(p)
      ? { x: p[0], y: p[1], pressure: p[2] }
      : { ...p });
  }

  broadcastRestore(object, objectType) {
    const data = objectType === 'stroke'
      ? { id: object.id, type: 'stroke', page: object.page, tool: object.tool, color: object.color, size: object.size, points: object.points }
      : { id: object.id, type: 'image', page: object.page, src: object.src, x: object.x, y: object.y, w: object.w, h: object.h };
    this.network.send({ type: 'restoreObject', payload: { objectId: object.id, data } });
  }

  deleteLassoSelection() {
    const selection = this.storage.selection;
    if (!selection) return;
    const items = [];
    for (const s of selection.strokes || []) {
      items.push({ id: s.id, objectType: 'stroke', objectData: s });
      const idx = this.storage.strokes.indexOf(s);
      if (idx >= 0) this.storage.strokes.splice(idx, 1);
      this.network.send({ type: 'deleteObject', payload: { objectId: s.id } });
    }
    for (const im of selection.images || []) {
      items.push({ id: im.id, objectType: 'image', objectData: im });
      const idx = this.storage.images.indexOf(im);
      if (idx >= 0) this.storage.images.splice(idx, 1);
      this.network.send({ type: 'deleteObject', payload: { objectId: im.id } });
    }
    this.storage.selection = null;
    this.storage.recomputeContentBottom();
    if (items.length) this.history.push({ type: 'batch_delete', items });
    this.renderer.fullRender();
  }

  // --- Image Selector / Drag / Resize ---

  hitImage(wx, wy) {
    for (let i = this.storage.images.length - 1; i >= 0; i--) {
      const im = this.storage.images[i];
      if (im.page !== this.storage.currentPageId) continue;
      if (wx >= im.x && wx <= im.x + im.w && wy >= im.y && wy <= im.y + im.h) return im;
    }
    return null;
  }

  // Возвращает true, если палец/курсор задел изображение или его ручку
  // (и захватил его для перетаскивания / изменения размера / удаления),
  // false — если попали в пустое место (снимаем выделение, можно панорамировать).
  beginImageDrag(e) {
    const { sx, sy } = this.pointerPos(e);
    const k = this.renderer.scale;
    const wx = sx / k;
    const wy = sy / k + this.storage.cameraY;

    // Ручки текущего выделения — в экранных координатах (мир → экран через scale)
    if (this.storage.selected) {
      const s = this.storage.selected;
      const bx = s.x * k, by = (s.y - this.storage.cameraY) * k, bw = s.w * k, bh = s.h * k;

      // Кнопка удаления (правый-верхний угол), крупная зона касания
      if (Math.hypot(sx - (bx + bw), sy - by) <= 16) {
        this.deleteSelected();
        this.dragPid = null;
        this.dragMode = null;
        return true;
      }

      // Ручка изменения размера (правый-нижний угол), крупная зона касания
      if (sx >= bx + bw - 16 && sx <= bx + bw + 16 && sy >= by + bh - 16 && sy <= by + bh + 16) {
        this.dragPid = e.pointerId;
        this.dragMode = 'resize';
        this.dragStart = { x: s.x, y: s.y, w: s.w, h: s.h };
        return true;
      }
    }

    // Попадание по изображению → выбрать и начать перемещение
    const im = this.hitImage(wx, wy);
    if (im) {
      this.storage.selected = im;
      this.dragPid = e.pointerId;
      this.dragMode = 'move';
      this.dragOff = { x: wx - im.x, y: wy - im.y };
      this.dragStart = { x: im.x, y: im.y, w: im.w, h: im.h };
      this.renderer.fullRender();
      return true;
    }

    // Пустое место → снять выделение
    if (this.storage.selected) {
      this.storage.selected = null;
      this.renderer.renderOverlay();
    }
    this.dragMode = null;
    return false;
  }

  moveSelect(e) {
    const { sx, sy } = this.pointerPos(e);
    const k = this.renderer.scale;
    const wx = sx / k;
    const wy = sy / k + this.storage.cameraY;

    if (this.dragMode === 'move') {
      this.storage.selected.x = wx - this.dragOff.x;
      this.storage.selected.y = wy - this.dragOff.y;
    } else if (this.dragMode === 'resize') {
      // Пропорциональное изменение от левого-верхнего угла;
      // угол следует и за горизонтальным, и за вертикальным перемещением.
      const aspect = this.dragStart.w / this.dragStart.h;
      const dw = wx - this.storage.selected.x;
      const dh = wy - this.storage.selected.y;
      const nw = Math.max(24, Math.max(dw, dh * aspect));
      this.storage.selected.w = nw;
      this.storage.selected.h = nw / aspect;
    }

    this.renderer.renderBack();
    this.renderer.renderOverlay();
  }

  endSelect() {
    if (this.dragMode && this.storage.selected && this.dragStart) {
      const im = this.storage.selected;
      const before = this.dragStart;
      const after = { x: im.x, y: im.y, w: im.w, h: im.h };

      if (before.x !== after.x || before.y !== after.y || before.w !== after.w) {
        this.storage.recomputeContentBottom();

        // Push local history action
        this.history.push({
          type: 'move',
          id: im.id,
          before: before,
          after: after
        });

        // Broadcast moving/resizing event
        this.network.send({
          type: 'moveObject',
          payload: {
            objectId: im.id,
            x: im.x,
            y: im.y,
            w: im.w,
            h: im.h
          }
        });
      }
    }
    this.dragMode = null;
    this.dragPid = null;
    this.dragStart = null;
  }

  deleteSelected() {
    if (!this.storage.selected) return;
    const im = this.storage.selected;
    const idx = this.storage.images.indexOf(im);
    if (idx < 0) return;

    this.storage.images.splice(idx, 1);
    this.storage.selected = null;
    this.storage.recomputeContentBottom();
    this.renderer.fullRender();

    // Broadcast delete event
    this.network.send({
      type: 'deleteObject',
      payload: { objectId: im.id }
    });

    // Record action for Undo/Redo
    this.history.push({
      type: 'delete',
      id: im.id,
      objectType: 'image',
      objectData: im
    });
  }

  // --- Add Image ---

  // Перевод координат курсора (clientX/Y) в мировые координаты доски.
  clientToWorld(clientX, clientY) {
    const r = this.overlay.getBoundingClientRect();
    const k = this.renderer.scale;
    return {
      x: (clientX - r.left) / k,
      y: (clientY - r.top) / k + this.storage.cameraY
    };
  }

  // Загружает список файлов-изображений (drop / paste) и добавляет их на доску.
  // centerWorld — необязательная точка (мир), вокруг которой центрировать; при
  // нескольких файлах они слегка смещаются, чтобы не накладываться полностью.
  addImageFiles(files, centerWorld) {
    files.forEach((f, i) => {
      const reader = new FileReader();
      reader.onload = () => {
        const place = centerWorld
          ? { cx: centerWorld.x + i * 16, cy: centerWorld.y + i * 16 }
          : null;
        this.addImage(reader.result, place);
      };
      reader.readAsDataURL(f);
    });
  }

  addImage(src, place) {
    const img = new Image();
    img.onload = () => {
      const viewWorldH = this.renderer.H / this.renderer.scale;   // видимая высота (мир)
      const maxW = Math.min(BOARD_W * 0.9, img.naturalWidth);
      const sc = Math.min(maxW / img.naturalWidth, (viewWorldH * 0.72) / img.naturalHeight, 1);
      const iw = img.naturalWidth * sc;
      const ih = img.naturalHeight * sc;

      let x, y;
      if (place) {
        x = place.cx - iw / 2;                 // центрируем в точке вставки
        y = place.cy - ih / 2;
      } else {
        x = (BOARD_W - iw) / 2;                // по центру по горизонтали
        y = this.storage.cameraY + 24;         // у верхнего края видимой области
      }
      // держим картинку в пределах ширины доски и не выше видимого верха
      x = Math.max(12, Math.min(x, BOARD_W - iw - 12));
      y = Math.max(this.storage.cameraY + 12, y);
      // и в пределах высоты страницы (лист ограничен PAGE_H)
      y = Math.min(y, Math.max(12, PAGE_H - ih - 12));

      const imageId = generateUUID();
      const im = {
        id: imageId,
        page: this.storage.currentPageId,
        src,
        img,
        x: x,
        y: y,
        w: iw,
        h: ih
      };

      this.storage.images.push(im);
      this.storage.selected = im;   // сразу выбрано — видны ручки, можно двигать/масштабировать
      this.syncTools();

      this.storage.extendBottom(im);
      this.renderer.fullRender();

      // Broadcast image creation
      this.network.send({
        type: 'addImage',
        payload: {
          imageId: imageId,
          page: im.page,
          src: src,
          x: im.x,
          y: im.y,
          w: im.w,
          h: im.h
        }
      });

      // Record history
      this.history.push({
        type: 'add_image',
        id: imageId,
        image: im
      });
    };
    img.onerror = () => this.network.showToast('Не удалось загрузить изображение');
    img.src = src;
  }

  // --- Clear Board ---

  // Очистка текущей страницы (в блокноте «Очистить» относится к листу, а не
  // ко всему документу). Реализована как пакетное удаление — обратимо через undo.
  clearBoard() {
    const cur = this.storage.currentPageId;
    const strokes = this.storage.strokes.filter(s => s.page === cur);
    const images = this.storage.images.filter(im => im.page === cur);
    if (!strokes.length && !images.length) return;

    const items = [];
    for (const s of strokes) {
      items.push({ id: s.id, objectType: 'stroke', objectData: s });
      this.network.send({ type: 'deleteObject', payload: { objectId: s.id } });
    }
    for (const im of images) {
      items.push({ id: im.id, objectType: 'image', objectData: im });
      this.network.send({ type: 'deleteObject', payload: { objectId: im.id } });
    }

    this.storage.strokes = this.storage.strokes.filter(s => s.page !== cur);
    this.storage.images = this.storage.images.filter(im => im.page !== cur);
    this.storage.selected = null;
    this.storage.selection = null;
    this.storage.recomputeContentBottom();
    this.renderer.fullRender();

    this.history.push({ type: 'batch_delete', items });
  }

  // --- Страницы (блокнот) ---

  updatePageUI() {
    const total = this.storage.pages.length;
    const idx = this.storage.currentPageIndex();
    if (this.pageIndicator) this.pageIndicator.textContent = `${idx + 1}/${total}`;
    const prev = document.getElementById('prevPageBtn');
    const next = document.getElementById('nextPageBtn');
    const del = document.getElementById('delPageBtn');
    if (prev) prev.disabled = idx <= 0;
    if (next) next.disabled = idx >= total - 1;
    if (del) del.disabled = total <= 1;
    const pagebar = document.getElementById('pagebar');
    if (pagebar) pagebar.setAttribute('aria-label', `Страницы: ${idx + 1} из ${total}`);
  }

  // Сброс локального состояния при смене листа (общий для навигации/добавления/удаления).
  enterPage(pageId) {
    this.storage.currentPageId = pageId;
    this.storage.cameraY = 0;
    this.storage.selected = null;
    this.storage.selection = null;
    this.renderer.lassoPath = null;
    this.renderer.remoteCursors.clear();
    this.renderer.stopFocus();
    this.stopMomentum();
    this.network.pauseAutoFocus();
    this.network.sendCursorLeave();
    this.updatePageUI();
    this.renderer.clampCamera();
  }

  goToPage(index, dir = 0) {
    const pages = this.storage.pages;
    if (index < 0 || index >= pages.length) return;
    if (index === this.storage.currentPageIndex()) return;
    this.enterPage(pages[index]);
    this.animatePageSwitch(dir);
  }

  nextPage() { this.goToPage(this.storage.currentPageIndex() + 1, 1); }
  prevPage() { this.goToPage(this.storage.currentPageIndex() - 1, -1); }

  addPage() {
    const afterId = this.storage.currentPageId;
    const newId = generateUUID();
    this.storage.insertPageAfter(afterId, newId);
    this.network.send({ type: 'addPage', payload: { pageId: newId, afterId } });
    this.enterPage(newId);
    this.animatePageSwitch(1);
    this.network.showToast(`Добавлена страница ${this.storage.currentPageIndex() + 1} из ${this.storage.pages.length}`);
  }

  deleteCurrentPage() {
    if (this.storage.pages.length <= 1) {
      this.network.showToast('Нельзя удалить единственную страницу');
      return;
    }
    const id = this.storage.currentPageId;
    const hasContent = this.storage.strokes.some(s => s.page === id)
      || this.storage.images.some(im => im.page === id);
    if (hasContent && !window.confirm('Удалить эту страницу вместе со всем её содержимым?')) return;

    this.network.send({ type: 'deletePage', payload: { pageId: id } });
    const removed = this.storage.removePage(id);   // сам выберет соседнюю страницу
    if (!removed) return;
    this.enterPage(this.storage.currentPageId);
    this.animatePageSwitch(-1);
    this.network.showToast(`Страница удалена · осталось ${this.storage.pages.length}`);
  }

  // Смена листа: содержимое переключается мгновенно (fullRender) — холст
  // никогда не остаётся смещённым/полупрозрачным. Анимируем только индикатор
  // (пружинный «поп» через GSAP) — это заметная и безопасная обратная связь.
  animatePageSwitch(dir = 0) {
    this.renderer.fullRender();
    this.pulseIndicator();
  }

  // Счётчик «оживает» при смене листа — вырастает и пружинит обратно.
  pulseIndicator() {
    this.springPop(this.pageIndicator, 1.34, 'pulse');
  }

  // Пружинистый «поп» при нажатии на любую кнопку тулбаров — тот же живой
  // отклик, что и у счётчика страниц. Делегируем в фазе capture, чтобы
  // срабатывало даже на кнопках, гасящих всплытие клика («Настройки фона»).
  initPressFx() {
    const bars = [
      document.querySelector('.toolbar'),
      document.getElementById('pagebar'),
      document.getElementById('gridMenu')
    ].filter(Boolean);
    const onPress = (e) => {
      const btn = e.target.closest('.btn, .swatch, .size, .presence');
      if (!btn || btn.disabled) return;
      const inner = btn.querySelector('.m-icon, .dot, .pip') || btn;
      this.springPop(inner, 0.8, 'tap-pop');
    };
    for (const bar of bars) bar.addEventListener('click', onPress, true);
  }

  // Единый пружинный эффект (GSAP back.out; без GSAP — CSS-класс).
  // На время анимации гасим CSS-transition элемента, иначе он «смазывает»
  // пружину покадрово (у счётчика страниц transition нет — потому он чёткий).
  // Таймер-страховка + killTweensOf гарантируют, что иконка не «залипнет»
  // уменьшенной, даже если rAF заморожен (фоновая вкладка / reduced-motion).
  springPop(el, from, cssClass) {
    if (!el) return;
    if (window.gsap) {
      window.gsap.killTweensOf(el);
      if (el._popTimer) clearTimeout(el._popTimer);
      el.style.transition = 'none';
      window.gsap.fromTo(el,
        { scale: from },
        {
          scale: 1, duration: 0.42, ease: 'back.out(2.6)',
          onComplete: () => this.clearPop(el)
        }
      );
      el._popTimer = setTimeout(() => this.clearPop(el), 520);
    } else {
      el.classList.remove(cssClass);
      void el.offsetWidth;
      el.classList.add(cssClass);
    }
  }

  clearPop(el) {
    if (!el) return;
    if (el._popTimer) { clearTimeout(el._popTimer); el._popTimer = null; }
    if (window.gsap) window.gsap.killTweensOf(el);
    el.style.transform = '';
    el.style.transition = '';
  }

  // --- Export PNG (текущая страница) ---

  exportPNG() {
    const margin = 40;
    const cur = this.storage.currentPageId;
    const fullW = BOARD_W;                                    // единая ширина холста
    const viewWorldH = this.renderer.H / this.renderer.scale; // видимая высота (мир)
    const pageBottom = this.storage.pageContentBottom(cur);
    // Экспортируем текущую страницу: по содержимому, но не выше PAGE_H.
    const fullH = Math.min(PAGE_H, Math.max(Math.round(viewWorldH), Math.ceil(pageBottom) + margin));
    const scale = Math.min(1, MAX_EXPORT_H / fullH);
    const outW = Math.round(fullW * scale), outH = Math.round(fullH * scale);

    // bg + grid + images
    const bg = document.createElement('canvas');
    bg.width = outW;
    bg.height = outH;
    const bx = bg.getContext('2d');
    bx.scale(scale, scale);
    bx.fillStyle = '#ffffff';
    bx.fillRect(0, 0, fullW, fullH);

    this.renderer.drawGrid(bx, 0, fullW, fullH, PAGE_H);
    for (const im of this.storage.images) {
      if (im.page !== cur) continue;
      if (im.img.complete && im.img.naturalWidth) {
        bx.drawImage(im.img, im.x, im.y, im.w, im.h);
      }
    }

    // strokes on a transparent canvas
    const il = document.createElement('canvas');
    il.width = outW;
    il.height = outH;
    const ix = il.getContext('2d');
    ix.scale(scale, scale);
    for (const s of this.storage.strokes) {
      if (s.page === cur) this.renderer.drawStrokeTo(ix, s, 0);
    }

    bx.drawImage(il, 0, 0, fullW, fullH);

    const pageNo = this.storage.currentPageIndex() + 1;
    bg.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `whiteboard-${this.storage.boardId}-p${pageNo}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }
}
