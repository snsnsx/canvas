import {
  CELL,
  DEFAULT_PEN,
  DEFAULT_HL,
  SIZE_PRESETS,
  MAX_EXPORT_W,
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
    this.panStartX = 0;
    this.panStartCam = 0;
    this.panLastX = 0;
    this.panLastT = 0;
    this.panVel = 0;
    this.momRAF = null;

    this.dragPid = null;
    this.dragMode = null;
    this.dragOff = { x: 0, y: 0 };
    this.dragStart = null;

    this.sbTimer = null;

    this.fileInput = document.getElementById('fileInput');
    this.overlay = document.getElementById('overlay');
    this.hbar = document.getElementById('hbar');
    this.thumb = document.getElementById('thumb');

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
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());

    // Wheel/trackpad panning
    this.renderer.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.stopMomentum();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.storage.cameraX += d;
      this.renderer.clampCamera();
      this.renderer.fullRender();
      this.showScrollbar();
      this.hideScrollbarLater();
    }, { passive: false });

    // Buttons
    document.getElementById('eraserBtn').addEventListener('click', () => {
      this.storage.tool = 'eraser';
      this.syncTools();
    });
    document.getElementById('selectBtn').addEventListener('click', () => {
      this.storage.tool = 'select';
      this.syncTools();
    });
    document.querySelectorAll('#gridSeg .btn').forEach(b => {
      b.addEventListener('click', () => {
        this.storage.gridType = b.dataset.grid;
        this.syncTools();
        this.renderer.renderBack();

        // Broadcast grid change
        this.network.send({
          type: 'changeGrid',
          payload: { grid: this.storage.gridType }
        });
      });
    });

    document.getElementById('undoBtn').addEventListener('click', () => this.history.undo());
    document.getElementById('redoBtn').addEventListener('click', () => this.history.redo());
    document.getElementById('clearBtn').addEventListener('click', () => this.clearBoard());
    document.getElementById('imgBtn').addEventListener('click', () => this.fileInput.click());
    document.getElementById('exportBtn').addEventListener('click', () => this.exportPNG());

    // Image Upload
    this.fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => this.addImage(reader.result);
      reader.readAsDataURL(f);
      this.fileInput.value = '';
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
      b.innerHTML = `<span class="pip" style="width:${px}px;height:${px}px"></span>`;
      b.addEventListener('click', () => {
        const t = (this.storage.tool === 'select') ? 'pen' : this.storage.tool;
        if (this.storage.tool === 'select') {
          this.storage.tool = 'pen';
        }
        this.storage.sizeIdx[t] = i;
        this.syncTools();
      });
      wrap.appendChild(b);
    });
  }

  syncTools() {
    document.querySelectorAll('#penColors .swatch').forEach((b, i) => {
      b.classList.toggle('sel', this.storage.tool === 'pen' && i === this.storage.penIdx);
    });
    document.querySelectorAll('#hlColors .swatch').forEach((b, i) => {
      b.classList.toggle('sel', this.storage.tool === 'highlighter' && i === this.storage.hlIdx);
    });

    const eraserBtn = document.getElementById('eraserBtn');
    const selectBtn = document.getElementById('selectBtn');
    if (eraserBtn) eraserBtn.classList.toggle('on', this.storage.tool === 'eraser');
    if (selectBtn) selectBtn.classList.toggle('on', this.storage.tool === 'select');

    const st = (this.storage.tool === 'select') ? 'pen' : this.storage.tool;
    document.querySelectorAll('#sizes .size').forEach((b, i) => {
      b.classList.toggle('sel', i === this.storage.sizeIdx[st]);
    });
    document.querySelectorAll('#gridSeg .btn').forEach(b => {
      b.classList.toggle('on', b.dataset.grid === this.storage.gridType);
    });

    if (this.storage.tool !== 'select' && this.storage.selected) {
      this.storage.selected = null;
      this.renderer.renderOverlay();
    }
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
      if (this.storage.tool === 'select' && this.storage.selected) {
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
      case 'v': this.storage.tool = 'select'; this.syncTools(); break;
      case 'arrowleft':
        this.storage.cameraX -= 80;
        this.renderer.clampCamera();
        this.renderer.fullRender();
        this.showScrollbar();
        this.hideScrollbarLater();
        break;
      case 'arrowright':
        this.storage.cameraX += 80;
        this.renderer.clampCamera();
        this.renderer.fullRender();
        this.showScrollbar();
        this.hideScrollbarLater();
        break;
      case 'home':
        this.storage.cameraX = 0;
        this.renderer.clampCamera();
        this.renderer.fullRender();
        break;
      case 'end':
        this.storage.cameraX = this.renderer.maxCamera();
        this.renderer.clampCamera();
        this.renderer.fullRender();
        break;
    }
  }

  // --- Pointer Handlers (Input Routing) ---

  pointerPos(e) {
    const r = this.overlay.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  isDrawingPointer(e) {
    return e.pointerType === 'pen' || e.pointerType === 'mouse';
  }

  onDown(e) {
    if (e.pointerType === 'pen') this.penActive = true;

    if (this.storage.tool === 'select' && this.isDrawingPointer(e)) {
      this.overlay.setPointerCapture(e.pointerId);
      this.startSelect(e);
      return;
    }

    if (this.isDrawingPointer(e)) {
      this.overlay.setPointerCapture(e.pointerId);
      this.startStroke(e);
      return;
    }

    if (e.pointerType === 'touch') {
      if (this.penActive) return; // Palm rejection
      if (this.drawPid !== null) return; // Already drawing
      this.overlay.setPointerCapture(e.pointerId);
      this.startPan(e);
      return;
    }
  }

  onMove(e) {
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
  }

  onUp(e) {
    if (e.pointerType === 'pen') this.penActive = false;
    if (e.pointerId === this.drawPid) this.endStroke();
    if (e.pointerId === this.panPid) this.endPan();
    if (e.pointerId === this.dragPid) this.endSelect();
  }

  // --- Active Stroke Handlers ---

  startStroke(e) {
    this.drawPid = e.pointerId;
    const { sx, sy } = this.pointerPos(e);
    const col = this.storage.tool === 'pen'
      ? this.storage.penColors[this.storage.penIdx]
      : this.storage.tool === 'highlighter'
        ? this.storage.hlColors[this.storage.hlIdx]
        : '#000000';
    const sz = SIZE_PRESETS[this.storage.tool][this.storage.sizeIdx[this.storage.tool]];

    const strokeId = generateUUID();
    this.activeStroke = {
      id: strokeId,
      tool: this.storage.tool,
      color: col,
      size: sz,
      points: [{ x: sx + this.storage.cameraX, y: sy }]
    };

    // Buffer and stream points
    this.network.startStroke(strokeId, this.storage.tool, col, sz, { x: sx + this.storage.cameraX, y: sy });
    this.renderer.renderActive(this.activeStroke);
  }

  extendStroke(e) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const r = this.overlay.getBoundingClientRect();
    for (const ev of evs) {
      const pt = { x: (ev.clientX - r.left) + this.storage.cameraX, y: ev.clientY - r.top };
      this.activeStroke.points.push(pt);
      this.network.bufferPoint(pt);
    }
    this.renderer.renderActive(this.activeStroke);
  }

  endStroke() {
    if (this.activeStroke) {
      this.storage.computeBBox(this.activeStroke);
      const s = this.activeStroke;
      this.storage.strokes.push(s);

      this.network.endStroke(); // Flushes points and closes stroke

      this.renderer.drawStrokeTo(this.renderer.cacheCtx, s, this.storage.cameraX);
      this.renderer.blitInk();
      this.storage.extendRight(s);

      // Save to local undo/redo history
      this.history.push({
        type: 'draw',
        id: s.id,
        stroke: s
      });
    }
    this.activeStroke = null;
    this.drawPid = null;
  }

  // --- Finger Panning with Inertia ---

  startPan(e) {
    this.stopMomentum();
    this.panPid = e.pointerId;
    this.panStartX = e.clientX;
    this.panStartCam = this.storage.cameraX;
    this.panLastX = e.clientX;
    this.panLastT = performance.now();
    this.panVel = 0;
    this.showScrollbar();
  }

  movePan(e) {
    const now = performance.now();
    this.storage.cameraX = this.panStartCam - (e.clientX - this.panStartX);
    this.renderer.clampCamera();

    const dt = Math.max(1, now - this.panLastT);
    this.panVel = -((e.clientX - this.panLastX) / dt); // px/ms
    this.panLastX = e.clientX;
    this.panLastT = now;

    this.renderer.fullRender();
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

      this.storage.cameraX += this.panVel * dt;
      this.panVel *= Math.pow(0.94, dt / 16);

      const before = this.storage.cameraX;
      this.renderer.clampCamera();
      if (before !== this.storage.cameraX) this.panVel = 0;

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

  // --- Scrollbar Handling ---

  showScrollbar() {
    this.hbar.classList.add('show');
    if (this.sbTimer) {
      clearTimeout(this.sbTimer);
      this.sbTimer = null;
    }
  }

  hideScrollbarLater() {
    if (this.sbTimer) clearTimeout(this.sbTimer);
    this.sbTimer = setTimeout(() => this.hbar.classList.remove('show'), 900);
  }

  initScrollbarDrag() {
    let id = null, grab = 0;
    this.thumb.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      this.stopMomentum();

      id = e.pointerId;
      grab = e.clientX - this.thumb.getBoundingClientRect().left;
      this.thumb.setPointerCapture(id);
      this.showScrollbar();
    });
    this.thumb.addEventListener('pointermove', e => {
      if (e.pointerId !== id) return;
      const barRect = this.hbar.getBoundingClientRect();
      const tw = this.thumb.offsetWidth;
      const maxLeft = barRect.width - tw;
      let left = Math.max(0, Math.min(maxLeft, e.clientX - barRect.left - grab));

      this.storage.cameraX = this.renderer.maxCamera() * (left / (maxLeft || 1));
      this.renderer.clampCamera();
      this.renderer.fullRender();
    });
    this.thumb.addEventListener('pointerup', e => {
      if (e.pointerId === id) {
        id = null;
        this.hideScrollbarLater();
      }
    });
  }

  // --- Image Selector / Drag / Resize ---

  hitImage(wx, wy) {
    for (let i = this.storage.images.length - 1; i >= 0; i--) {
      const im = this.storage.images[i];
      if (wx >= im.x && wx <= im.x + im.w && wy >= im.y && wy <= im.y + im.h) return im;
    }
    return null;
  }

  startSelect(e) {
    this.dragPid = e.pointerId;
    const { sx, sy } = this.pointerPos(e);
    const wx = sx + this.storage.cameraX;
    const wy = sy;

    if (this.storage.selected) {
      const selected = this.storage.selected;
      const x = selected.x - this.storage.cameraX, y = selected.y, w = selected.w, h = selected.h;

      // Delete button check
      if (Math.hypot(sx - (x + w), sy - y) <= 13) {
        this.deleteSelected();
        this.dragPid = null;
        return;
      }

      // Resize handle check
      if (sx >= x + w - 12 && sx <= x + w + 8 && sy >= y + h - 12 && sy <= y + h + 8) {
        this.dragMode = 'resize';
        this.dragStart = { x: selected.x, y: selected.y, w: selected.w, h: selected.h };
        return;
      }
    }

    const im = this.hitImage(wx, wy);
    if (im) {
      this.storage.selected = im;
      this.dragMode = 'move';
      this.dragOff = { x: wx - im.x, y: wy - im.y };
      this.dragStart = { x: im.x, y: im.y, w: im.w, h: im.h };
      this.renderer.fullRender();
    } else {
      if (this.storage.selected) {
        this.storage.selected = null;
        this.renderer.renderOverlay();
      }
      this.dragMode = null;
      this.dragPid = null;
    }
  }

  moveSelect(e) {
    const { sx, sy } = this.pointerPos(e);
    const wx = sx + this.storage.cameraX;
    const wy = sy;

    if (this.dragMode === 'move') {
      this.storage.selected.x = wx - this.dragOff.x;
      this.storage.selected.y = wy - this.dragOff.y;
    } else if (this.dragMode === 'resize') {
      const aspect = this.dragStart.w / this.dragStart.h;
      let nw = Math.max(24, wx - this.storage.selected.x);
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
        this.storage.recomputeContentRight();

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
    this.storage.recomputeContentRight();
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

  addImage(src) {
    const img = new Image();
    img.onload = () => {
      const maxW = Math.min(this.renderer.W * 0.8, img.naturalWidth);
      const sc = Math.min(maxW / img.naturalWidth, (this.renderer.H * 0.72) / img.naturalHeight, 1);

      const imageId = generateUUID();
      const im = {
        id: imageId,
        src,
        img,
        x: this.storage.cameraX + 24,
        y: 24,
        w: img.naturalWidth * sc,
        h: img.naturalHeight * sc
      };

      this.storage.images.push(im);
      this.storage.selected = im;
      this.storage.tool = 'select';
      this.syncTools();

      if (im.x + im.w > this.storage.contentRight) {
        this.storage.contentRight = im.x + im.w;
      }
      this.renderer.fullRender();

      // Broadcast image creation
      this.network.send({
        type: 'addImage',
        payload: {
          imageId: imageId,
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

  clearBoard() {
    if (!this.storage.strokes.length && !this.storage.images.length) return;

    // Save previous state to history
    const prevStrokes = this.storage.strokes.slice();
    const prevImages = this.storage.images.slice();

    this.storage.strokes = [];
    this.storage.images = [];
    this.storage.selected = null;
    this.storage.contentRight = 0;
    this.storage.cameraX = 0;
    this.renderer.fullRender();

    // Broadcast clear event
    this.network.send({
      type: 'clearBoard',
      payload: {}
    });

    this.history.push({
      type: 'clear',
      strokes: prevStrokes,
      images: prevImages
    });
  }

  // --- Export PNG ---

  exportPNG() {
    const margin = 40;
    const fullW = Math.max(this.renderer.W, Math.ceil(this.storage.contentRight) + margin);
    const scale = Math.min(1, MAX_EXPORT_W / fullW);
    const outW = Math.round(fullW * scale), outH = Math.round(this.renderer.H * scale);

    // bg + grid + images
    const bg = document.createElement('canvas');
    bg.width = outW;
    bg.height = outH;
    const bx = bg.getContext('2d');
    bx.scale(scale, scale);
    bx.fillStyle = '#ffffff';
    bx.fillRect(0, 0, fullW, this.renderer.H);

    this.renderer.drawGrid(bx, 0, fullW, this.renderer.H);
    for (const im of this.storage.images) {
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
      this.renderer.drawStrokeTo(ix, s, 0);
    }

    bx.drawImage(il, 0, 0, fullW, this.renderer.H);

    bg.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `whiteboard-${this.storage.boardId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }
}