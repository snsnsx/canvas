export const CELL = 32;                       // шаг сетки (мировые px)
export const HL_ALPHA = 0.32;                 // прозрачность маркера
export const DEFAULT_PEN = ['#1f1f42','#dc2626','#14992f'];   // 3 быстрых цвета ручки
export const DEFAULT_HL  = ['#fde047','#86efac'];             // 2 цвета маркера
export const SIZE_PRESETS = {                 // пресеты толщины по инструментам
  pen:[2,3.5,6], highlighter:[14,22,30], eraser:[16,28,46]
};
export const SIZE_DEFAULT = { pen:1, highlighter:1, eraser:1 };  // индексы пресета (S/M/L)
export const MAX_EXPORT_W = 12000;            // ограничение ширины экспорта

export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export class BoardStorage {
  constructor() {
    this.boardId = (decodeURIComponent((location.hash||'').replace(/^#/,''))
                     .replace(/[^A-Za-z0-9_\-]/g,'').slice(0,64)) || 'default';
    this.LS_KEY = 'wb:' + this.boardId;
    this.clientId = this.getOrCreateClientId();

    this.penColors = DEFAULT_PEN.slice();
    this.hlColors  = DEFAULT_HL.slice();
    this.tool = 'pen';                      // pen | highlighter | eraser | select
    this.penIdx = 0;
    this.hlIdx = 0;            // выбранный быстрый цвет
    this.sizeIdx = Object.assign({}, SIZE_DEFAULT);
    this.gridType = 'grid';                 // none | grid | dots | lines

    this.strokes = [];                      // [{id, tool, color, size, points:[{x,y}], minX, maxX}]
    this.images  = [];                      // [{id, src, img, x, y, w, h}]
    this.contentRight = 0;                  // правая граница содержимого (мир)
    this.cameraX = 0;                       // смещение «камеры» вправо (мир)
    this.selected = null;                   // выбранное изображение (select)
    this.dirty = false;
  }

  getOrCreateClientId() {
    let id = sessionStorage.getItem('wb_client_id');
    if (!id) {
      id = generateUUID();
      sessionStorage.setItem('wb_client_id', id);
    }
    return id;
  }

  serialize() {
    return JSON.stringify({
      v: 1,
      grid: this.gridType,
      contentRight: this.contentRight,
      penColors: this.penColors,
      hlColors: this.hlColors,
      strokes: this.strokes.map(s => ({
        id: s.id || generateUUID(),
        tool: s.tool,
        color: s.color,
        size: s.size,
        points: s.points
      })),
      images: this.images.map(im => ({
        id: im.id || generateUUID(),
        x: im.x,
        y: im.y,
        w: im.w,
        h: im.h,
        src: im.src
      }))
    });
  }

  deserialize(text) {
    let o;
    try {
      o = typeof text === 'string' ? JSON.parse(text) : text;
    } catch(_) {
      return false;
    }
    if (!o || typeof o !== 'object') return false;

    if (Array.isArray(o.penColors) && o.penColors.length) this.penColors = o.penColors.slice(0,3);
    if (Array.isArray(o.hlColors) && o.hlColors.length) this.hlColors = o.hlColors.slice(0,2);
    if (o.grid) this.gridType = o.grid;

    this.strokes = (o.strokes || []).map(s => {
      const st = {
        id: s.id || generateUUID(),
        tool: s.tool,
        color: s.color,
        size: s.size,
        points: s.points || []
      };
      this.computeBBox(st);
      return st;
    });

    this.images = (o.images || []).map(d => {
      const im = {
        id: d.id || generateUUID(),
        src: d.src,
        x: d.x,
        y: d.y,
        w: d.w,
        h: d.h,
        img: new Image()
      };
      im.img.onload = () => {
        if (window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('imageLoaded'));
        }
      };
      im.img.src = d.src;
      return im;
    });

    this.selected = null;
    this.recomputeContentRight();
    return true;
  }

  extendRight(s) {
    if (s.points) {
      for (const p of s.points) {
        if (p.x > this.contentRight) this.contentRight = p.x;
      }
    } else if (s.x !== undefined && s.w !== undefined) {
      if (s.x + s.w > this.contentRight) this.contentRight = s.x + s.w;
    }
  }

  recomputeContentRight() {
    let m = 0;
    for (const s of this.strokes) {
      if (s.maxX > m) m = s.maxX;
    }
    for (const im of this.images) {
      if (im.x + im.w > m) m = im.x + im.w;
    }
    this.contentRight = m;
  }

  computeBBox(s) {
    let mnX = Infinity, mxX = -Infinity;
    for (const p of s.points) {
      if (p.x < mnX) mnX = p.x;
      if (p.x > mxX) mxX = p.x;
    }
    s.minX = mnX === Infinity ? 0 : mnX - s.size;
    s.maxX = mxX === -Infinity ? 0 : mxX + s.size;
  }
}
