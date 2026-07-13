import { CELL, HL_ALPHA, BOARD_W } from './storage.js';

export class CanvasRenderer {
  constructor(storage) {
    this.storage = storage;

    this.stage   = document.getElementById('stage');
    this.back    = document.getElementById('back');
    this.ink     = document.getElementById('ink');
    this.overlay = document.getElementById('overlay');
    this.backCtx = this.back.getContext('2d');
    this.inkCtx  = this.ink.getContext('2d', { desynchronized: true });
    this.ovCtx   = this.overlay.getContext('2d');
    this.vbar    = document.getElementById('vbar');
    this.thumb   = document.getElementById('thumb');

    // offscreen-кэш зафиксированных штрихов (для текущей камеры)
    this.inkCache = document.createElement('canvas');
    this.cacheCtx = this.inkCache.getContext('2d');

    this.DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.W = 0;
    this.H = 0;
    // Мир доски всегда 1024 в ширину; экран масштабируется, чтобы вместить его.
    // scale — коэффициент мир→экран (CSS px), одинаковая логика у всех клиентов.
    this.scale = 1;
    this.worldW = BOARD_W;
    this.worldH = 0;            // видимая высота в мировых координатах (H / scale)
    this.cssCache = {};

    this.activeStroke = null;   // штрих в процессе рисования (доносится поверх кэша)
    this.lassoPath = null;      // активный контур лассо в мировых координатах
    this.remoteCursors = new Map();
    this._raf = null;           // id запланированного кадра рендера
    this._focusRAF = null;
    this._focusTargetY = null;
    this._cursorCleanupTimer = null;
    this._cursorRAF = null;

    this.init();
  }

  init() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
    window.addEventListener('imageLoaded', () => this.scheduleRender());
  }

  // Коалесинг рендера: несколько источников за кадр (удалённые точки,
  // панорамирование, догрузка картинок) схлопываются в один fullRender на animation frame.
  scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.fullRender();
    });
  }

  // Холсты содержимого (сетка/штрихи/картинки) рисуются в мировых координатах:
  // трансформация включает мировой масштаб, поэтому 1024-мировая ширина
  // всегда занимает всю ширину экрана — одинаково у всех участников.
  setupScaledCanvas(c, ctx) {
    c.width  = Math.round(this.W * this.DPR);
    c.height = Math.round(this.H * this.DPR);
    ctx.setTransform(this.DPR * this.scale, 0, 0, this.DPR * this.scale, 0, 0);
  }

  // Оверлей (рамка/ручки выделения) рисуется в экранных координатах, чтобы
  // размеры ручек и зоны касания оставались одинаковыми на любом устройстве.
  setupScreenCanvas(c, ctx) {
    c.width  = Math.round(this.W * this.DPR);
    c.height = Math.round(this.H * this.DPR);
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.W = Math.max(1, Math.floor(r.width));
    this.H = Math.max(1, Math.floor(r.height));
    this.DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

    // Единая мировая ширина (1024) вписывается по ширине экрана.
    this.scale = this.W / BOARD_W;
    this.worldW = BOARD_W;
    this.worldH = this.H / this.scale;

    this.setupScaledCanvas(this.back, this.backCtx);
    this.setupScaledCanvas(this.ink, this.inkCtx);
    this.setupScreenCanvas(this.overlay, this.ovCtx);

    this.inkCache.width  = Math.round(this.W * this.DPR);
    this.inkCache.height = Math.round(this.H * this.DPR);
    this.cacheCtx.setTransform(this.DPR * this.scale, 0, 0, this.DPR * this.scale, 0, 0);

    this.clampCamera();
    this.fullRender();
  }

  maxCamera() {
    return Math.max(0, this.storage.contentBottom + this.worldH);
  }

  clampCamera() {
    this.storage.cameraY = Math.max(0, Math.min(this.storage.cameraY, this.maxCamera()));
  }

  focusWorldPoint(pt) {
    if (!pt || !Number.isFinite(pt.y)) return;

    const comfortableTop = this.storage.cameraY + this.worldH * 0.28;
    const comfortableBottom = this.storage.cameraY + this.worldH * 0.72;
    if (pt.y >= comfortableTop && pt.y <= comfortableBottom) return;

    this._focusTargetY = pt.y - this.worldH * 0.5;
    this._focusTargetY = Math.max(0, Math.min(this._focusTargetY, this.maxCamera()));
    if (!this._focusRAF) this._focusStep();
  }

  stopFocus() {
    if (this._focusRAF) {
      cancelAnimationFrame(this._focusRAF);
      this._focusRAF = null;
    }
    this._focusTargetY = null;
  }

  _focusStep() {
    this._focusRAF = requestAnimationFrame(() => {
      this._focusRAF = null;
      if (this._focusTargetY === null) return;

      const delta = this._focusTargetY - this.storage.cameraY;
      if (Math.abs(delta) < 1) {
        this.storage.cameraY = this._focusTargetY;
        this._focusTargetY = null;
      } else {
        this.storage.cameraY += delta * 0.22;
        this._focusStep();
      }
      this.clampCamera();
      this.scheduleRender();
    });
  }

  getCSS(v) {
    if (!(v in this.cssCache)) {
      this.cssCache[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    }
    return this.cssCache[v];
  }

  cursorColor(clientId) {
    let hash = 0;
    for (let i = 0; i < clientId.length; i++) {
      hash = ((hash << 5) - hash + clientId.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 72%, 43%)`;
  }

  setRemoteCursor(clientId, point) {
    if (!clientId) return;
    if (!point) {
      this.remoteCursors.delete(clientId);
      this.renderOverlay();
      return;
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const existing = this.remoteCursors.get(clientId);
    if (existing) {
      existing.targetX = point.x;
      existing.targetY = point.y;
      existing.updatedAt = Date.now();
    } else {
      this.remoteCursors.set(clientId, {
        x: point.x,
        y: point.y,
        targetX: point.x,
        targetY: point.y,
        color: this.cursorColor(clientId),
        updatedAt: Date.now()
      });
    }
    this.scheduleCursorCleanup();
    this.scheduleCursorMotion();
    this.renderOverlay();
  }

  scheduleCursorMotion() {
    if (this._cursorRAF) return;
    this._cursorRAF = requestAnimationFrame(() => {
      this._cursorRAF = null;
      let moving = false;

      for (const cursor of this.remoteCursors.values()) {
        const dx = cursor.targetX - cursor.x;
        const dy = cursor.targetY - cursor.y;
        if (Math.hypot(dx, dy) < 0.15) {
          cursor.x = cursor.targetX;
          cursor.y = cursor.targetY;
        } else {
          cursor.x += dx * 0.34;
          cursor.y += dy * 0.34;
          moving = true;
        }
      }

      this.renderOverlay();
      if (moving) this.scheduleCursorMotion();
    });
  }

  scheduleCursorCleanup() {
    if (this._cursorCleanupTimer) return;
    this._cursorCleanupTimer = setTimeout(() => {
      this._cursorCleanupTimer = null;
      this.renderOverlay();
      if (this.remoteCursors.size) this.scheduleCursorCleanup();
    }, 6100);
  }

  drawRemoteCursors(ctx) {
    const now = Date.now();
    const staleAfter = 6000;
    const k = this.scale;

    for (const [clientId, cursor] of this.remoteCursors) {
      if (now - cursor.updatedAt > staleAfter) {
        this.remoteCursors.delete(clientId);
        continue;
      }

      const x = cursor.x * k;
      const y = (cursor.y - this.storage.cameraY) * k;
      if (x < -24 || x > this.W + 24 || y < -24 || y > this.H + 24) continue;

      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = cursor.color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 18);
      ctx.lineTo(5, 14);
      ctx.lineTo(9, 23);
      ctx.lineTo(13, 21);
      ctx.lineTo(9, 13);
      ctx.lineTo(17, 13);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();

      ctx.restore();
    }
  }

  drawGrid(ctx, camY, w, h) {
    if (this.storage.gridType === 'none') return;
    ctx.save();

    const startY = Math.floor(camY / CELL) * CELL;

    if (this.storage.gridType === 'lines') {
      // линейка — горизонтальные линии, прокручиваются по Y (единый путь)
      ctx.strokeStyle = this.getCSS('--grid-strong');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = startY; y <= camY + h; y += CELL) {
        const yy = Math.round(y - camY) + 0.5;
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (this.storage.gridType === 'dots') {
      // все точки — один путь и один fill вместо fill на каждую точку
      ctx.fillStyle = this.getCSS('--grid-strong');
      ctx.beginPath();
      for (let y = startY; y <= camY + h; y += CELL) {
        const yy = y - camY;
        for (let x = 0; x <= w; x += CELL) {
          ctx.moveTo(x + 1.15, yy);
          ctx.arc(x, yy, 1.15, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    } else { // grid — вертикали и горизонтали одним путём, один stroke
      ctx.strokeStyle = this.getCSS('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x += CELL) {
        const xx = Math.round(x) + 0.5;
        ctx.moveTo(xx, 0);
        ctx.lineTo(xx, h);
      }
      for (let y = startY; y <= camY + h; y += CELL) {
        const yy = Math.round(y - camY) + 0.5;
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawStrokeTo(ctx, s, camY) {
    const pts = s.points;
    if (!pts.length) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (s.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      if (s.tool === 'highlighter') ctx.globalAlpha = HL_ALPHA;
    }

    const points = this.normalizeStrokePoints(pts, camY);

    if (s.tool === 'pen' || s.tool === 'highlighter') {
      this.drawTldrawInk(ctx, points, s.size, s.tool);
      ctx.restore();
      return;
    }

    ctx.lineWidth = s.size;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, Math.max(0.6, s.size / 2), 0, Math.PI * 2);
      ctx.fill();
    } else {
      this.drawSmoothPolyline(ctx, points);
      ctx.stroke();
    }
    ctx.restore();
  }

  normalizeStrokePoints(pts, camY) {
    return pts.map(p => {
      const pressure = p.p ?? p.pressure ?? p[2];
      return {
        x: p.x !== undefined ? p.x : p[0],
        y: (p.y !== undefined ? p.y : p[1]) - camY,
        pressure: Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : undefined
      };
    });
  }

  drawSmoothPolyline(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  drawTldrawInk(ctx, rawPts, size, tool = 'pen') {
    const pts = this.prepareInkPoints(rawPts);
    if (!pts.length) return;

    const highlighter = tool === 'highlighter';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, Math.max(0.9, size * 0.5), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const left = [];
    const right = [];
    const lastIndex = pts.length - 1;
    const distances = [0];
    let total = 0;

    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      distances[i] = total;
    }

    const baseRadius = size * 0.5;
    const taperDistance = highlighter
      ? Math.max(size * 0.9, 14)
      : Math.max(size * 2.25, 12);
    const minTaper = highlighter ? 0.58 : 0.18;

    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(lastIndex, i + 1)];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;

      const travel = i === 0 ? 0 : Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      const pressure = pts[i].pressure ?? Math.max(0.35, 0.72 - Math.min(0.45, travel / 42));
      const pressureWidth = highlighter
        ? 0.96 + pressure * 0.08
        : 0.62 + pressure * 0.58;
      const startTaper = Math.min(1, distances[i] / taperDistance);
      const endTaper = Math.min(1, (total - distances[i]) / taperDistance);
      const taperEase = 1 - Math.pow(1 - Math.min(startTaper, endTaper), 3);
      const taper = minTaper + (1 - minTaper) * taperEase;
      const radius = Math.max(0.75, baseRadius * pressureWidth * taper);

      const nx = -dy * radius;
      const ny = dx * radius;
      left.push({ x: pts[i].x + nx, y: pts[i].y + ny });
      right.push({ x: pts[i].x - nx, y: pts[i].y - ny });
    }

    const outline = left.concat(right.reverse());
    ctx.beginPath();
    ctx.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    ctx.closePath();
    ctx.fill();
  }

  prepareInkPoints(rawPts) {
    const compact = [];
    for (const p of rawPts) {
      const last = compact[compact.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 0.7) {
        compact.push(p);
      }
    }
    if (compact.length < 3) return compact;

    const smooth = [compact[0]];
    for (let i = 1; i < compact.length - 1; i++) {
      const a = compact[i - 1];
      const b = compact[i];
      const c = compact[i + 1];
      smooth.push({
        x: a.x * 0.18 + b.x * 0.64 + c.x * 0.18,
        y: a.y * 0.18 + b.y * 0.64 + c.y * 0.18,
        pressure: this.mixPressure(a, b, c)
      });
    }
    smooth.push(compact[compact.length - 1]);
    return smooth;
  }

  mixPressure(a, b, c) {
    const vals = [a.pressure, b.pressure, c.pressure].filter(Number.isFinite);
    if (!vals.length) return undefined;
    return vals.reduce((sum, value) => sum + value, 0) / vals.length;
  }

  renderBack() {
    const ctx = this.backCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.back.width, this.back.height);
    ctx.restore();

    this.drawGrid(ctx, this.storage.cameraY, this.worldW, this.worldH);
    for (const im of this.storage.images) {
      if (!im.img.complete || !im.img.naturalWidth) continue;
      if (im.y + im.h < this.storage.cameraY || im.y > this.storage.cameraY + this.worldH) continue; // culling
      ctx.drawImage(im.img, im.x, im.y - this.storage.cameraY, im.w, im.h);
    }
  }

  strokeVisible(s) {
    return s.maxY >= this.storage.cameraY - 4 && s.minY <= this.storage.cameraY + this.worldH + 4;
  }

  rebuildInkCache() {
    const ctx = this.cacheCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.inkCache.width, this.inkCache.height);
    ctx.restore();
    for (const s of this.storage.strokes) {
      if (this.strokeVisible(s)) this.drawStrokeTo(ctx, s, this.storage.cameraY);
    }
  }

  blitInk() {
    this.inkCtx.save();
    this.inkCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.inkCtx.clearRect(0, 0, this.ink.width, this.ink.height);
    this.inkCtx.drawImage(this.inkCache, 0, 0);
    this.inkCtx.restore();
  }

  renderActive(active) {
    this.blitInk();
    if (active) this.drawStrokeTo(this.inkCtx, active, this.storage.cameraY);
  }

  renderOverlay() {
    this.ovCtx.clearRect(0, 0, this.W, this.H);
    const ctx = this.ovCtx;
    const accent = this.getCSS('--accent');

    if (this.lassoPath && this.lassoPath.length) {
      const k = this.scale;
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.fillStyle = 'rgba(16, 163, 127, 0.08)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      this.lassoPath.forEach((p, i) => {
        const x = p.x * k;
        const y = (p.y - this.storage.cameraY) * k;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      if (this.lassoPath.length > 2) ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    const groupBounds = this.selectionBounds(this.storage.selection);
    if (groupBounds) {
      const k = this.scale;
      const x = groupBounds.x * k;
      const y = (groupBounds.y - this.storage.cameraY) * k;
      const w = groupBounds.w * k;
      const h = groupBounds.h * k;
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.fillStyle = 'rgba(16, 163, 127, 0.055)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      this.drawDeleteHandle(ctx, x + w + 14, y - 14, accent);
      ctx.restore();
    }

    const sel = this.storage.selected;
    if (sel) {
      const k = this.scale;
      // мир → экран: рамка масштабируется, а ручки ниже — фиксированного размера
      const x = sel.x * k;
      const y = (sel.y - this.storage.cameraY) * k;
      const w = sel.w * k, h = sel.h * k;
      ctx.save();

      // рамка выделения
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      // — ручка изменения размера (правый-нижний угол), крупная —
      const HR = 11; // половина стороны → 22px, зона касания шире
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      this.roundRect(ctx, x + w - HR, y + h - HR, HR * 2, HR * 2, 5);
      ctx.fill();
      ctx.stroke();
      // диагональные насечки
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + w - 4, y + h + 4);
      ctx.lineTo(x + w + 4, y + h - 4);
      ctx.moveTo(x + w,     y + h + 4);
      ctx.lineTo(x + w + 4, y + h);
      ctx.stroke();

      // — кнопка удаления (правый-верхний угол), крупная —
      this.drawDeleteHandle(ctx, x + w, y, accent);

      ctx.restore();
    }
    this.drawRemoteCursors(this.ovCtx);
    this.updateScrollbar();
  }

  selectionBounds(selection) {
    if (!selection) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of selection.strokes || []) {
      for (const p of s.points || []) {
        const x = p.x !== undefined ? p.x : p[0];
        const y = p.y !== undefined ? p.y : p[1];
        minX = Math.min(minX, x - s.size / 2);
        minY = Math.min(minY, y - s.size / 2);
        maxX = Math.max(maxX, x + s.size / 2);
        maxY = Math.max(maxY, y + s.size / 2);
      }
    }
    for (const im of selection.images || []) {
      minX = Math.min(minX, im.x); minY = Math.min(minY, im.y);
      maxX = Math.max(maxX, im.x + im.w); maxY = Math.max(maxY, im.y + im.h);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }

  drawDeleteHandle(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fillStyle = this.getCSS('--ui-strong');
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 4.5, y - 4.5); ctx.lineTo(x + 4.5, y + 4.5);
    ctx.moveTo(x + 4.5, y - 4.5); ctx.lineTo(x - 4.5, y + 4.5);
    ctx.stroke();
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  fullRender() {
    this.rebuildInkCache();
    this.blitInk();
    if (this.activeStroke) this.drawStrokeTo(this.inkCtx, this.activeStroke, this.storage.cameraY);
    this.renderBack();
    this.renderOverlay();
  }

  updateScrollbar() {
    const view = this.worldH;                 // видимая высота (мир)
    const total = this.maxCamera() + view;    // полная прокручиваемая высота (мир)
    const barH = this.vbar.clientHeight || (this.H - 16);
    const th = Math.max(28, barH * (view / total));
    const maxTop = barH - th;
    const top = total <= view ? 0 : (this.storage.cameraY / this.maxCamera()) * maxTop;
    this.thumb.style.height = th + 'px';
    this.thumb.style.top = Math.max(0, Math.min(maxTop, top)) + 'px';
  }
}
