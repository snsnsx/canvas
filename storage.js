export const BOARD_W = 1024;                  // единая ширина холста (мировые px) для всех участников
export const PAGE_H = 8000;                   // максимальная высота одной страницы (мировые px)
export const DEFAULT_PAGE_ID = 'page-1';      // id первой/легаси-страницы (одинаков у всех клиентов)
export const CELL = 32;                       // шаг сетки (мировые px)
export const HL_ALPHA = 0.32;                 // прозрачность маркера
export const DEFAULT_PEN = ['#1d1d1d','#e03131','#2f9e44'];   // 3 быстрых цвета ручки
export const DEFAULT_HL  = ['#fde047','#7f46a4'];             // 2 цвета маркера
export const SIZE_PRESETS = {                 // пресеты толщины по инструментам
  pen:[2,3.5,6], highlighter:[14,22,30], eraser:[16,28,46]
};
export const SIZE_DEFAULT = { pen:1, highlighter:1, eraser:1 };  // индексы пресета (S/M/L)
export const MAX_EXPORT_H = 12000;            // ограничение высоты экспорта

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
    this.tool = 'pen';                      // pen | highlighter | eraser | lasso | select
    this.penIdx = 0;
    this.hlIdx = 0;            // выбранный быстрый цвет
    this.sizeIdx = Object.assign({}, SIZE_DEFAULT);
    this.gridType = 'none';                 // none | grid | dots | lines

    // Блокнот: упорядоченный список страниц. У каждого объекта есть поле page
    // (id страницы). Одновременно отображается только currentPageId.
    this.pages = [DEFAULT_PAGE_ID];         // порядок страниц (общий для всех клиентов)
    this.currentPageId = DEFAULT_PAGE_ID;   // текущая видимая страница (локально у каждого)

    this.strokes = [];                      // [{id, page, tool, color, size, points:[{x,y}], minY, maxY}]
    this.images  = [];                      // [{id, page, src, img, x, y, w, h}]
    this.contentBottom = 0;                 // нижняя граница содержимого (мир)
    this.cameraY = 0;                       // смещение «камеры» вниз (мир)
    this.selected = null;                   // выбранное изображение
    this.selection = null;                  // групповое выделение лассо: {strokes, images}
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
      pages: this.pages.slice(),
      contentBottom: this.contentBottom,
      penColors: this.penColors,
      hlColors: this.hlColors,
      strokes: this.strokes.map(s => ({
        id: s.id || generateUUID(),
        page: s.page || DEFAULT_PAGE_ID,
        tool: s.tool,
        color: s.color,
        size: s.size,
        points: s.points
      })),
      images: this.images.map(im => ({
        id: im.id || generateUUID(),
        page: im.page || DEFAULT_PAGE_ID,
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

    // Список страниц. Легаси-доски (без pages) сводятся к одной странице page-1.
    const pages = (Array.isArray(o.pages) ? o.pages : [])
      .filter(id => typeof id === 'string' && id)
      .slice(0, 500);
    this.pages = pages.length ? pages.slice() : [DEFAULT_PAGE_ID];
    // Сохраняем текущую страницу при переподключении; если её больше нет — на первую.
    if (!this.pages.includes(this.currentPageId)) this.currentPageId = this.pages[0];

    this.strokes = (o.strokes || []).map(s => {
      const st = {
        id: s.id || generateUUID(),
        page: s.page || DEFAULT_PAGE_ID,
        tool: s.tool,
        color: s.color,
        size: s.size,
        points: s.points || []
      };
      this.ensurePage(st.page);
      this.computeBBox(st);
      return st;
    });

    this.images = (o.images || []).map(d => {
      const im = {
        id: d.id || generateUUID(),
        page: d.page || DEFAULT_PAGE_ID,
        src: d.src,
        x: d.x,
        y: d.y,
        w: d.w,
        h: d.h,
        img: new Image()
      };
      this.ensurePage(im.page);
      im.img.onload = () => {
        if (window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('imageLoaded'));
        }
      };
      im.img.src = d.src;
      return im;
    });

    this.selected = null;
    this.selection = null;
    this.recomputeContentBottom();
    if (window.dispatchEvent) window.dispatchEvent(new CustomEvent('pagesChanged'));
    return true;
  }

  // --- Страницы (блокнот) ---

  pageIndex(id) {
    return this.pages.indexOf(id);
  }

  currentPageIndex() {
    const i = this.pages.indexOf(this.currentPageId);
    return i < 0 ? 0 : i;
  }

  // Гарантирует, что страница присутствует в списке (для объектов, пришедших
  // от удалённого клиента раньше, чем сообщение addPage).
  ensurePage(id) {
    if (id && !this.pages.includes(id)) this.pages.push(id);
  }

  // Вставляет новую страницу после afterId (или в конец). Идемпотентно.
  insertPageAfter(afterId, newId) {
    if (!newId || this.pages.includes(newId)) return;
    const at = this.pages.indexOf(afterId);
    if (at < 0) this.pages.push(newId);
    else this.pages.splice(at + 1, 0, newId);
  }

  // Удаляет страницу и все её объекты. Возвращает удалённые объекты (для истории).
  removePage(id) {
    const at = this.pages.indexOf(id);
    if (at < 0 || this.pages.length <= 1) return null;
    const strokes = this.strokes.filter(s => s.page === id);
    const images = this.images.filter(im => im.page === id);
    this.strokes = this.strokes.filter(s => s.page !== id);
    this.images = this.images.filter(im => im.page !== id);
    this.pages.splice(at, 1);
    if (this.currentPageId === id) {
      this.currentPageId = this.pages[Math.min(at, this.pages.length - 1)];
    }
    this.recomputeContentBottom();
    return { index: at, strokes, images };
  }

  // Нижняя граница содержимого конкретной страницы (для экспорта).
  pageContentBottom(id) {
    let m = 0;
    for (const s of this.strokes) {
      if (s.page === id && s.maxY > m) m = s.maxY;
    }
    for (const im of this.images) {
      if (im.page === id && im.y + im.h > m) m = im.y + im.h;
    }
    return m;
  }

  extendBottom(s) {
    if (s.points) {
      for (const p of s.points) {
        if (p.y > this.contentBottom) this.contentBottom = p.y;
      }
    } else if (s.y !== undefined && s.h !== undefined) {
      if (s.y + s.h > this.contentBottom) this.contentBottom = s.y + s.h;
    }
  }

  // Инкрементальное расширение bbox штриха только по новым точкам —
  // без повторного обхода всех точек (важно для «живого» удалённого штриха).
  extendBBox(s, pts) {
    if (s.minY === undefined || s.maxY === undefined) { this.computeBBox(s); return; }
    for (const p of pts) {
      const lo = p.y - s.size, hi = p.y + s.size;
      if (lo < s.minY) s.minY = lo;
      if (hi > s.maxY) s.maxY = hi;
    }
  }

  // Рост нижней границы содержимого только по переданным точкам.
  extendBottomPoints(pts) {
    for (const p of pts) {
      if (p.y > this.contentBottom) this.contentBottom = p.y;
    }
  }

  recomputeContentBottom() {
    let m = 0;
    for (const s of this.strokes) {
      if (s.maxY > m) m = s.maxY;
    }
    for (const im of this.images) {
      if (im.y + im.h > m) m = im.y + im.h;
    }
    this.contentBottom = m;
  }

  computeBBox(s) {
    let mnY = Infinity, mxY = -Infinity;
    for (const p of s.points) {
      if (p.y < mnY) mnY = p.y;
      if (p.y > mxY) mxY = p.y;
    }
    s.minY = mnY === Infinity ? 0 : mnY - s.size;
    s.maxY = mxY === -Infinity ? 0 : mxY + s.size;
  }
}
