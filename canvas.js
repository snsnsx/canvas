import { CELL, HL_ALPHA } from './storage.js';

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
    this.cssCache = {};

    this.init();
  }

  init() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
    window.addEventListener('imageLoaded', () => this.fullRender());
  }

  setupCanvas(c, ctx) {
    c.width  = Math.round(this.W * this.DPR);
    c.height = Math.round(this.H * this.DPR);
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.W = Math.max(1, Math.floor(r.width));
    this.H = Math.max(1, Math.floor(r.height));
    this.DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

    this.setupCanvas(this.back, this.backCtx);
    this.setupCanvas(this.ink, this.inkCtx);
    this.setupCanvas(this.overlay, this.ovCtx);

    this.inkCache.width  = Math.round(this.W * this.DPR);
    this.inkCache.height = Math.round(this.H * this.DPR);
    this.cacheCtx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);

    this.clampCamera();
    this.fullRender();
  }

  maxCamera() {
    return Math.max(0, this.storage.contentBottom + this.H);
  }

  clampCamera() {
    this.storage.cameraY = Math.max(0, Math.min(this.storage.cameraY, this.maxCamera()));
  }

  getCSS(v) {
    if (!(v in this.cssCache)) {
      this.cssCache[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    }
    return this.cssCache[v];
  }

  drawGrid(ctx, camY, w, h) {
    if (this.storage.gridType === 'none') return;
    ctx.save();

    const startY = Math.floor(camY / CELL) * CELL;

    if (this.storage.gridType === 'lines') {
      // линейка — горизонтальные линии, прокручиваются по Y
      ctx.strokeStyle = this.getCSS('--grid-strong');
      ctx.lineWidth = 1;
      for (let y = startY; y <= camY + h; y += CELL) {
        const yy = Math.round(y - camY) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    if (this.storage.gridType === 'dots') {
      ctx.fillStyle = this.getCSS('--grid-strong');
      for (let y = startY; y <= camY + h; y += CELL) {
        for (let x = 0; x <= w; x += CELL) {
          ctx.beginPath();
          ctx.arc(x, y - camY, 1.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else { // grid
      ctx.strokeStyle = this.getCSS('--grid');
      ctx.lineWidth = 1;
      // вертикальные линии — фиксированы по X
      for (let x = 0; x <= w; x += CELL) {
        const xx = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xx, 0);
        ctx.lineTo(xx, h);
        ctx.stroke();
      }
      // горизонтальные линии — прокручиваются по Y
      for (let y = startY; y <= camY + h; y += CELL) {
        const yy = Math.round(y - camY) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }
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
    ctx.lineWidth = s.size;

    // Support point object structures {x, y} or [x, y]
    const getX = p => (p.x !== undefined ? p.x : p[0]);
    const getY = p => (p.y !== undefined ? p.y : p[1]);

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(getX(pts[0]), getY(pts[0]) - camY, Math.max(0.6, s.size / 2), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(getX(pts[0]), getY(pts[0]) - camY);
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i+1];
        ctx.quadraticCurveTo(
          getX(a),
          getY(a) - camY,
          (getX(a) + getX(b)) / 2,
          (getY(a) + getY(b)) / 2 - camY
        );
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(getX(last), getY(last) - camY);
      ctx.stroke();
    }
    ctx.restore();
  }

  renderBack() {
    this.backCtx.clearRect(0, 0, this.W, this.H);
    this.drawGrid(this.backCtx, this.storage.cameraY, this.W, this.H);
    for (const im of this.storage.images) {
      if (!im.img.complete || !im.img.naturalWidth) continue;
      if (im.y + im.h < this.storage.cameraY || im.y > this.storage.cameraY + this.H) continue; // culling
      this.backCtx.drawImage(im.img, im.x, im.y - this.storage.cameraY, im.w, im.h);
    }
  }

  strokeVisible(s) {
    return s.maxY >= this.storage.cameraY - 4 && s.minY <= this.storage.cameraY + this.H + 4;
  }

  rebuildInkCache() {
    this.cacheCtx.clearRect(0, 0, this.W, this.H);
    for (const s of this.storage.strokes) {
      if (this.strokeVisible(s)) this.drawStrokeTo(this.cacheCtx, s, this.storage.cameraY);
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
    const sel = this.storage.selected;
    if (sel) {
      const ctx = this.ovCtx;
      const x = sel.x;
      const y = sel.y - this.storage.cameraY;
      const w = sel.w, h = sel.h;
      const accent = this.getCSS('--accent');

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
      const DR = 12; // радиус → 24px
      ctx.beginPath();
      ctx.arc(x + w, y, DR, 0, Math.PI * 2);
      ctx.fillStyle = this.getCSS('--ui-strong');
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + w - 4.5, y - 4.5);
      ctx.lineTo(x + w + 4.5, y + 4.5);
      ctx.moveTo(x + w + 4.5, y - 4.5);
      ctx.lineTo(x + w - 4.5, y + 4.5);
      ctx.stroke();

      ctx.restore();
    }
    this.updateScrollbar();
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
    this.renderBack();
    this.renderOverlay();
  }

  updateScrollbar() {
    const total = this.maxCamera() + this.H;
    const barH = this.vbar.clientHeight || (this.H - 16);
    const th = Math.max(28, barH * (this.H / total));
    const maxTop = barH - th;
    const top = total <= this.H ? 0 : (this.storage.cameraY / this.maxCamera()) * maxTop;
    this.thumb.style.height = th + 'px';
    this.thumb.style.top = Math.max(0, Math.min(maxTop, top)) + 'px';
  }
}
