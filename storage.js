export const BOARD_W = 1024;                  // единая ширина холста (мировые px) для всех участников
export const PAGE_H = 8000;                   // максимальная высота одной страницы (мировые px)
export const DEFAULT_PAGE_ID = 'page-1';      // id первой/легаси-страницы (одинаков у всех клиентов)
export const HL_ALPHA = 0.32;                 // прозрачность маркера
export const DEFAULT_PEN = ['#1d1d1d','#e03131','#2f9e44'];   // 3 быстрых цвета ручки
export const DEFAULT_HL  = ['#fde047','#7f46a4'];             // 2 цвета маркера
export const SIZE_PRESETS = {                 // пресеты толщины по инструментам
  pen:[2,3.5,6], highlighter:[14,22,30], eraser:[16,28,46]
};
export const SIZE_DEFAULT = { pen:1, highlighter:1, eraser:1 };  // индексы пресета (S/M/L)
export const MAX_EXPORT_H = 12000;            // ограничение высоты экспорта

// --- Плавающие окна ---
//
// Окно — маленький холст поверх листа, на котором пишут теми же инструментами.
// Штрихи и картинки листа живут в мировых координатах и уезжают вместе с
// камерой; окно — наоборот, приклеено к ЭКРАНУ, поэтому прокрутка его не
// двигает.
//
// Единицы измерения выбраны так, чтобы «одна и та же часть экрана» значила одно
// и то же и на телефоне, и на мониторе:
//   x, w, h — мировые px (доска всегда 1024 в ширину, см. BOARD_W). Ширина окна
//             и толщина линий в нём масштабируются ровно как содержимое листа,
//             поэтому у всех участников окно занимает одинаковую долю экрана и
//             выглядит одинаково.
//   y       — доля видимой высоты (0…1): высота экрана у всех разная, и только
//             доля даёт одно и то же место по вертикали.
// Штрихи внутри окна — в его собственных координатах (0…w, 0…h), тот же масштаб.
export const NOTE_DEFAULT_W = 300;
export const NOTE_DEFAULT_H = 210;
export const NOTE_MIN_W = 130;
export const NOTE_MIN_H = 90;

// Доля видимой области: всё, что не число или вне 0…1, приводится к границе.
export function clampUnit(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function noteSide(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Штрих внутри окна: тот же формат, что и на листе, минус страница и bbox —
// окно маленькое, отсечения по видимости в нём не нужно.
export function normalizeNoteStroke(raw) {
  const src = raw || {};
  return {
    id: src.id || generateUUID(),
    tool: src.tool === 'highlighter' || src.tool === 'eraser' ? src.tool : 'pen',
    color: typeof src.color === 'string' ? src.color.slice(0, 32) : '#1d1d1d',
    size: Number.isFinite(Number(src.size)) ? Math.max(0.5, Math.min(120, Number(src.size))) : 3.5,
    points: decodePoints(src.points)
  };
}

// Единая нормализация окна: и для снимка доски, и для сообщений по сети. Чужой
// клиент (или старый снимок) не должен уметь прислать окно с NaN-координатой.
export function normalizeNote(raw, fallbackPage = DEFAULT_PAGE_ID) {
  const src = raw || {};
  const w = noteSide(src.w, NOTE_DEFAULT_W, NOTE_MIN_W, BOARD_W);
  return {
    id: src.id || generateUUID(),
    page: src.page || fallbackPage,
    x: Math.max(0, Math.min(BOARD_W - w, Number(src.x) || 0)),
    y: clampUnit(src.y, 0.1),
    w,
    h: noteSide(src.h, NOTE_DEFAULT_H, NOTE_MIN_H, PAGE_H),
    strokes: (src.strokes || []).map(normalizeNoteStroke)
  };
}

// Точки приходят с сервера и по сети в компактном виде [x, y] / [x, y, pressure]
// (втрое меньше байт, чем {"x":…,"y":…}). Внутри клиента точка — объект: так её
// читают рендер, лассо и история. Разворачиваем один раз при загрузке снимка.
export function decodePoints(points) {
  if (!points || !points.length) return [];
  if (!Array.isArray(points[0])) return points;
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    out[i] = Number.isFinite(p[2])
      ? { x: p[0], y: p[1], pressure: p[2] }
      : { x: p[0], y: p[1] };
  }
  return out;
}

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

    // Блокнот: упорядоченный список страниц. У каждого объекта есть поле page
    // (id страницы). Одновременно отображается только currentPageId.
    this.pages = [DEFAULT_PAGE_ID];         // порядок страниц (общий для всех клиентов)
    this.currentPageId = DEFAULT_PAGE_ID;   // текущая видимая страница (локально у каждого)
    // Позиция просмотра каждого листа. Как и currentPageId — величина локальная
    // (у каждого участника свой взгляд на доску), поэтому в serialize не идёт.
    this.pageScroll = new Map();            // pageId → cameraY

    this.strokes = [];                      // [{id, page, tool, color, size, points:[{x,y}], minY, maxY}]
    this.images  = [];                      // [{id, page, src, img, x, y, w, h}]
    // Плавающие окна: координаты — доли экрана, а не мира (см. normalizeNote).
    // Живут в DOM поверх холста, поэтому в рендер канвы не попадают.
    this.notes   = [];                      // [{id, page, x, y, w, h, text}]
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
      })),
      notes: this.notes.map(n => normalizeNote(n))
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
        points: decodePoints(s.points)
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

    this.notes = (o.notes || []).map(d => {
      const note = normalizeNote(d);
      this.ensurePage(note.page);
      return note;
    });

    this.selected = null;
    this.selection = null;
    this.recomputeContentBottom();
    if (window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('pagesChanged'));
      window.dispatchEvent(new CustomEvent('notesChanged'));
    }
    return true;
  }

  noteById(id) {
    return this.notes.find(n => n.id === id);
  }

  removeNote(id) {
    const at = this.notes.findIndex(n => n.id === id);
    return at < 0 ? null : this.notes.splice(at, 1)[0];
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
    const notes = this.notes.filter(n => n.page === id);
    this.strokes = this.strokes.filter(s => s.page !== id);
    this.images = this.images.filter(im => im.page !== id);
    this.notes = this.notes.filter(n => n.page !== id);
    this.pages.splice(at, 1);
    this.pageScroll.delete(id);
    if (this.currentPageId === id) {
      this.currentPageId = this.pages[Math.min(at, this.pages.length - 1)];
      // Лист мог быть удалён и удалённым клиентом — камера должна встать туда,
      // где мы остановились на соседнем листе, а не остаться в чужой позиции.
      this.cameraY = this.recallScroll(this.currentPageId);
    }
    this.recomputeContentBottom();
    return { index: at, strokes, images, notes };
  }

  // --- Позиция просмотра по листам ---
  //
  // Блокнот листают туда-обратно: возврат на лист должен приводить в то место,
  // где пользователь остановился, а не в начало страницы.

  rememberScroll(pageId, y) {
    if (!pageId || !Number.isFinite(y)) return;
    this.pageScroll.set(pageId, Math.max(0, y));
  }

  recallScroll(pageId) {
    const y = this.pageScroll.get(pageId);
    return Number.isFinite(y) ? y : 0;
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

  // --- Индекс по id ---
  //
  // Поиск объекта по id стоял на самом горячем сетевом пути: appendPoints от
  // каждого пишущего соседа (≈40 пакетов/с) делал линейный скан всего массива
  // штрихов. Замер: 0.0395 мс на скан по 10 000 штрихов против 0.0001 мс через
  // Map — в 395 раз дороже, и стоимость растёт с числом и штрихов, и соседей.
  //
  // Индекс — кэш, а не второй источник истины: он перестраивается, как только
  // длина массива изменилась (push/splice/filter) или его пометили вручную
  // (замена элемента по месту при restoreObject). Пропустить инвалидацию
  // невозможно: любое добавление или удаление меняет длину.
  invalidateIndex() {
    this._idxDirty = true;
  }

  _index() {
    if (this._idx === undefined) { this._idx = new Map(); this._idxLen = -1; this._idxDirty = true; }
    if (this._idxDirty || this._idxLen !== this.strokes.length + this.images.length) {
      this._idx.clear();
      for (const s of this.strokes) this._idx.set(s.id, s);
      for (const im of this.images) this._idx.set(im.id, im);
      this._idxLen = this.strokes.length + this.images.length;
      this._idxDirty = false;
    }
    return this._idx;
  }

  strokeById(id) {
    const o = this._index().get(id);
    return o && o.points !== undefined ? o : undefined;
  }

  imageById(id) {
    const o = this._index().get(id);
    return o && o.points === undefined ? o : undefined;
  }

  objectById(id) {
    return this._index().get(id);
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
