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
    this.hbar    = document.getElementById('hbar');
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
    return Math.max(0, this.storage.contentRight + this.W);
  }

  clampCamera() {
    this.storage.cameraX = Math.max(0, Math.min(this.storage.cameraX, this.maxCamera()));
  }

  getCSS(v) {
    if (!(v in this.cssCache)) {
      this.cssCache[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    }
    return this.cssCache[v];
  }

  drawGrid(ctx, camX, w, h) {
    if (this.storage.gridType === 'none') return;
    ctx.save();
    if (this.storage.gridType === 'lines') {
      ctx.strokeStyle = this.getCSS('--grid-strong');
      ctx.lineWidth = 1;
      for (let y = CELL; y < h; y += CELL) {
        const yy = Math.round(y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    const startX = Math.floor(camX / CELL) * CELL;
    if (this.storage.gridType === 'dots') {
      ctx.fillStyle = this.getCSS('--grid-strong');
      for (let x = startX; x <= camX + w; x += CELL) {
        for (let y = 0; y <= h; y += CELL) {
          ctx.beginPath();
          ctx.arc(x - camX, y, 1.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else { // grid
      ctx.strokeStyle = this.getCSS('--grid');
      ctx.lineWidth = 1;
      for (let x = startX; x <= camX + w; x += CELL) {
        const xx = Math.round(x - camX) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xx, 0);
        ctx.lineTo(xx, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += CELL) {
        const yy = Math.round(y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawStrokeTo(ctx, s, camX) {
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
      ctx.arc(getX(pts[0]) - camX, getY(pts[0]), Math.max(0.6, s.size / 2), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(getX(pts[0]) - camX, getY(pts[0]));
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i+1];
        ctx.quadraticCurveTo(
          getX(a) - camX,
          getY(a),
          (getX(a) + getX(b)) / 2 - camX,
          (getY(a) + getY(b)) / 2
        );
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(getX(last) - camX, getY(last));
      ctx.stroke();
    }
    ctx.restore();
  }

  renderBack() {
    this.backCtx.clearRect(0, 0, this.W, this.H);
    this.drawGrid(this.backCtx, this.storage.cameraX, this.W, this.H);
    for (const im of this.storage.images) {
      if (!im.img.complete || !im.img.naturalWidth) continue;
      if (im.x + im.w < this.storage.cameraX || im.x > this.storage.cameraX + this.W) continue; // culling
      this.backCtx.drawImage(im.img, im.x - this.storage.cameraX, im.y, im.w, im.h);
    }
  }

  strokeVisible(s) {
    return s.maxX >= this.storage.cameraX - 4 && s.minX <= this.storage.cameraX + this.W + 4;
  }

  rebuildInkCache() {
    this.cacheCtx.clearRect(0, 0, this.W, this.H);
    for (const s of this.storage.strokes) {
      if (this.strokeVisible(s)) this.drawStrokeTo(this.cacheCtx, s, this.storage.cameraX);
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
    if (active) this.drawStrokeTo(this.inkCtx, active, this.storage.cameraX);
  }

  renderOverlay() {
    this.ovCtx.clearRect(0, 0, this.W, this.H);
    if (this.storage.tool === 'select' && this.storage.selected) {
      const selected = this.storage.selected;
      const x = selected.x - this.storage.cameraX, y = selected.y, w = selected.w, h = selected.h;
      this.ovCtx.save();
      this.ovCtx.strokeStyle = this.getCSS('--accent');
      this.ovCtx.lineWidth = 1.5;
      this.ovCtx.setLineDash([5, 4]);
      this.ovCtx.strokeRect(x, y, w, h);
      this.ovCtx.setLineDash([]);

      // resize handle (right-bottom)
      this.ovCtx.fillStyle = '#fff';
      this.ovCtx.strokeStyle = this.getCSS('--accent');
      this.ovCtx.lineWidth = 1.5;
      this.roundRect(this.ovCtx, x + w - 9, y + h - 9, 18, 18, 4);
      this.ovCtx.fill();
      this.ovCtx.stroke();

      // delete button (right-top)
      this.ovCtx.beginPath();
      this.ovCtx.arc(x + w, y, 11, 0, Math.PI * 2);
      this.ovCtx.fillStyle = this.getCSS('--ui-strong');
      this.ovCtx.fill();
      this.ovCtx.strokeStyle = '#fff';
      this.ovCtx.lineWidth = 1.6;
      this.ovCtx.lineCap = 'round';
      this.ovCtx.beginPath();
      this.ovCtx.moveTo(x + w - 4, y - 4);
      this.ovCtx.lineTo(x + w + 4, y + 4);
      this.ovCtx.moveTo(x + w + 4, y - 4);
      this.ovCtx.lineTo(x + w - 4, y + 4);
      this.ovCtx.stroke();
      this.ovCtx.restore();
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
    const total = this.maxCamera() + this.W;
    const barW = this.hbar.clientWidth || (this.W - 16);
    const tw = Math.max(28, barW * (this.W / total));
    const maxLeft = barW - tw;
    const left = total <= this.W ? 0 : (this.storage.cameraX / this.maxCamera()) * maxLeft;
    this.thumb.style.width = tw + 'px';
    this.thumb.style.left = Math.max(0, Math.min(maxLeft, left)) + 'px';
  }
}
