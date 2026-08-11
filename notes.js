import {
  BOARD_W,
  SIZE_PRESETS,
  NOTE_DEFAULT_W,
  NOTE_DEFAULT_H,
  NOTE_MIN_W,
  NOTE_MIN_H,
  generateUUID,
  normalizeNote
} from './storage.js';

// --- Плавающие окна ---
//
// Окно — маленький холст поверх листа: в нём пишут теми же инструментами
// (перо, маркер, ластик, те же цвета и толщины), что и на основной доске.
// Отличие одно: окно приклеено к экрану, а не к бумаге, поэтому прокрутка
// уводит лист, а окно остаётся на месте — и у всех участников в одной и той же
// части экрана (единицы координат — см. normalizeNote в storage.js).
//
// Штрихи окна лежат в его собственных координатах (0…w, 0…h мировых px) и
// рисуются той же процедурой, что и штрихи листа: одинаковый нажим, одинаковый
// характер линии, ластик тем же destination-out.

const GUTTER = 8;           // отступ от краёв рабочей области (экранные px)
const BAR_GUTTER = 20;      // справа — место под полосу прокрутки листа
const POINT_FLUSH = 24;     // мс: шаг рассылки точек (~40 пакетов/с, как на листе)
const GEOM_FLUSH = 70;      // мс: шаг рассылки при перетаскивании окна

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(v, Math.max(lo, hi)));
}

export class NotesManager {
  constructor(storage, renderer, network, history, tools) {
    this.storage = storage;
    this.renderer = renderer;
    this.network = network;
    this.history = history;
    this.tools = tools;

    this.layer = document.getElementById('notes');
    this.tpl = document.getElementById('noteTpl');

    this.els = new Map();      // id → корневой элемент окна
    this.drag = null;          // перетаскивание / изменение размера окна
    this.draw = null;          // штрих, который сейчас ведут в окне
    this.zTop = 1;             // порядок окон: тронутое поднимается наверх

    this.init();
  }

  init() {
    document.getElementById('noteBtn')?.addEventListener('click', () => this.createNote());

    // Изменения приходят тремя путями: сеть (notesChanged), смена листа
    // (pageChanged) и перезагрузка снимка доски (pagesChanged из deserialize).
    window.addEventListener('notesChanged', () => this.sync());
    window.addEventListener('pageChanged', () => this.sync());
    window.addEventListener('pagesChanged', () => this.sync());

    // Размер экрана поменялся — мировые размеры те же, а пиксели другие.
    window.addEventListener('resize', () => this.layoutAll());
    window.addEventListener('orientationchange', () => setTimeout(() => this.layoutAll(), 220));

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key.toLowerCase() !== 'n') return;
      e.preventDefault();
      this.createNote();
    });

    this.sync();
  }

  // --- Создание и удаление ---

  createNote() {
    const page = this.storage.currentPageId;
    // Каждое следующее окно на листе смещается по диагонали: подряд созданные
    // окна не ложатся друг на друга и их видно все сразу.
    const step = this.storage.notes.filter(n => n.page === page).length % 5;
    const note = normalizeNote({
      id: generateUUID(),
      page,
      x: 60 + step * 34,
      y: 0.08 + step * 0.035,
      w: NOTE_DEFAULT_W,
      h: NOTE_DEFAULT_H
    });

    this.storage.notes.push(note);
    this.network.send({
      type: 'addNote',
      payload: { noteId: note.id, page: note.page, x: note.x, y: note.y, w: note.w, h: note.h }
    });
    this.history?.push({ type: 'add_note', id: note.id, note });
    this.sync();
    const el = this.els.get(note.id);
    if (el) this.raise(el);
  }

  deleteNote(id) {
    const note = this.storage.removeNote(id);
    if (!note) return;
    this.network.send({ type: 'deleteObject', payload: { objectId: id } });
    this.history?.push({ type: 'delete', id, objectType: 'note', objectData: note });
    this.sync();
  }

  // --- Синхронизация DOM со снимком доски ---

  sync() {
    if (!this.layer || !this.tpl) return;
    const page = this.storage.currentPageId;
    const live = new Set();

    for (const note of this.storage.notes) {
      if (note.page !== page) continue;              // окна принадлежат листу, как штрихи
      live.add(note.id);
      let el = this.els.get(note.id);
      if (!el) {
        el = this.buildElement(note.id);
        this.layer.appendChild(el);
        this.els.set(note.id, el);
        this.raise(el);
      }
      this.layout(el, note);
    }

    for (const [id, el] of this.els) {
      if (live.has(id)) continue;
      // Окно могли удалить (или увести на другой лист) прямо под рукой: жест
      // по исчезнувшему элементу уже не завершится сам, а незакрытый штрих
      // навсегда заблокировал бы рисование в остальных окнах.
      if (this.draw && this.draw.id === id) {
        clearInterval(this.draw.timer);
        this.draw = null;
      }
      if (this.drag && this.drag.id === id) this.drag = null;
      el.remove();
      this.els.delete(id);
    }
  }

  layoutAll() {
    for (const [id, el] of this.els) {
      const note = this.storage.noteById(id);
      if (note) this.layout(el, note);
    }
  }

  // Мировые размеры → пиксели. Тот же масштаб, что у холста листа: линия в окне
  // выглядит ровно так же, как та же линия на бумаге.
  //
  // Размер задаётся только холсту, а корпус окна обтекает его сам (абсолютно
  // позиционированный блок сжимается по содержимому) — рамка и шапка в мировые
  // размеры не входят и на всех экранах остаются одинаковой толщины.
  layout(el, note) {
    const r = this.layer.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const k = this.renderer.scale;
    const canvas = el.querySelector('.note-canvas');
    if (canvas) {
      canvas.style.width = Math.round(note.w * k) + 'px';
      canvas.style.height = Math.round(note.h * k) + 'px';
    }

    const box = el.getBoundingClientRect();
    el.style.left = Math.round(clamp(note.x * k, GUTTER, r.width - box.width - BAR_GUTTER)) + 'px';
    el.style.top = Math.round(clamp(note.y * r.height, GUTTER, r.height - box.height - GUTTER)) + 'px';
    this.scheduleRender();
  }

  // --- Рисование содержимого окна ---
  //
  // Перерисовка коалесится в один кадр: точки идут потоком и от своей руки, и от
  // соседей, а холст окна маленький — незачем растеризовать его по нескольку раз
  // за animation frame.
  scheduleRender() {
    if (this._paintRAF) return;
    this._paintRAF = requestAnimationFrame(() => {
      this._paintRAF = null;
      for (const [id, node] of this.els) {
        const note = this.storage.noteById(id);
        if (note) this.paint(node, note);
      }
    });
  }

  paint(el, note) {
    const canvas = el.querySelector('.note-canvas');
    if (!canvas) return;
    const k = this.renderer.scale;
    const dpr = this.renderer.DPR;
    const pw = Math.max(1, Math.round(note.w * k * dpr));
    const ph = Math.max(1, Math.round(note.h * k * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
    // Тем же кодом, что и лист: контур пера, альфа маркера, ластик
    // destination-out. Фон окна — под холстом, поэтому стирание открывает его.
    for (const s of note.strokes) this.renderer.drawStrokeTo(ctx, s, 0);
    const live = this.draw && this.draw.id === note.id ? this.draw.stroke : null;
    if (live) this.renderer.drawStrokeTo(ctx, live, 0);
  }

  // --- Разметка одного окна ---

  buildElement(id) {
    const el = this.tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = id;

    const bar = el.querySelector('.note-bar');
    const grip = el.querySelector('.note-resize');
    const close = el.querySelector('.note-close');
    const canvas = el.querySelector('.note-canvas');

    // Порядок окон задаём z-index, а не перестановкой в DOM: перенос узла во
    // время жеста снял бы захват указателя, и перетаскивание оборвалось бы.
    el.addEventListener('pointerdown', () => this.raise(el), true);

    bar?.addEventListener('pointerdown', (e) => this.beginDrag(e, el, 'move'));
    grip?.addEventListener('pointerdown', (e) => this.beginDrag(e, el, 'resize'));
    el.addEventListener('pointermove', (e) => this.moveDrag(e, el));
    el.addEventListener('pointerup', (e) => this.endDrag(e, el));
    el.addEventListener('pointercancel', (e) => this.endDrag(e, el));

    close?.addEventListener('click', () => this.deleteNote(id));

    if (canvas) {
      canvas.addEventListener('pointerdown', (e) => this.beginStroke(e, el));
      canvas.addEventListener('pointermove', (e) => this.extendStroke(e, el));
      canvas.addEventListener('pointerup', (e) => this.endStroke(e));
      canvas.addEventListener('pointercancel', (e) => this.endStroke(e));
      canvas.addEventListener('pointerleave', () => this.tools?.hideEraserCursor());
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    return el;
  }

  raise(el) {
    el.style.zIndex = String(++this.zTop);
  }

  // --- Штрих внутри окна ---
  //
  // Инструмент, цвет и толщина берутся из общего состояния доски: чем пишут на
  // листе, тем пишут и в окне. Лассо и выделение в окне смысла не имеют —
  // в этих режимах окно к рисованию не приглашает.

  strokeTool() {
    const tool = this.storage.tool;
    return (tool === 'pen' || tool === 'highlighter' || tool === 'eraser') ? tool : null;
  }

  notePoint(e, el, note) {
    const r = el.querySelector('.note-canvas').getBoundingClientRect();
    const k = this.renderer.scale;
    return {
      x: clamp((e.clientX - r.left) / k, 0, note.w),
      y: clamp((e.clientY - r.top) / k, 0, note.h),
      pressure: this.tools ? this.tools.pointerPressure(e) : undefined
    };
  }

  beginStroke(e, el) {
    if (e.button > 0 || this.drag || this.draw) return;      // один штрих за раз
    // Отсечение ладони — как на листе: пока в руке перо, касания не рисуют.
    if (e.pointerType === 'touch' && this.tools?.penActive) return;
    const note = this.storage.noteById(el.dataset.id);
    const tool = this.strokeTool();
    if (!note || !tool) return;

    e.preventDefault();
    e.stopPropagation();
    // Своё письмо не должно уводить лист: соседи могут писать на других
    // страницах, а мы заняты окном.
    this.network.pauseAutoFocus();
    // Признак «в руке перо» общий с листом: лежащая на планшете ладонь не
    // должна рисовать ни там, ни здесь.
    if (e.pointerType === 'pen' && this.tools) this.tools.penActive = true;

    const color = tool === 'pen'
      ? this.storage.penColors[this.storage.penIdx]
      : tool === 'highlighter'
        ? this.storage.hlColors[this.storage.hlIdx]
        : '#000000';
    const stroke = {
      id: generateUUID(),
      tool,
      color,
      size: SIZE_PRESETS[tool][this.storage.sizeIdx[tool]],
      points: [this.notePoint(e, el, note)]
    };

    this.draw = { id: note.id, pid: e.pointerId, el, stroke, buffer: [], timer: null };
    e.target.setPointerCapture(e.pointerId);

    this.network.send({
      type: 'noteStroke',
      payload: {
        noteId: note.id,
        strokeId: stroke.id,
        tool: stroke.tool,
        color: stroke.color,
        size: stroke.size,
        points: [this.network.encodePoint(stroke.points[0])]
      }
    });
    // Точки уходят пачками, как на листе: соседи видят линию «вживую», но не
    // получают пакет на каждое движение указателя.
    this.draw.timer = setInterval(() => this.flushPoints(), POINT_FLUSH);
    this.scheduleRender();
  }

  extendStroke(e, el) {
    this.tools?.updateEraserCursor(e);
    const d = this.draw;
    if (!d || d.pid !== e.pointerId || d.el !== el) return;
    const note = this.storage.noteById(d.id);
    if (!note) return;

    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) {
      const pt = this.notePoint(ev, el, note);
      d.stroke.points.push(pt);
      d.buffer.push(this.network.encodePoint(pt));
    }
    this.scheduleRender();
  }

  endStroke(e) {
    if (e && e.pointerType === 'pen' && this.tools) this.tools.penActive = false;
    const d = this.draw;
    if (!d || (e && d.pid !== e.pointerId)) return;
    clearInterval(d.timer);
    this.flushPoints();
    this.draw = null;

    const note = this.storage.noteById(d.id);
    if (note && d.stroke.points.length) {
      note.strokes.push(d.stroke);
      this.history?.push({ type: 'note_draw', noteId: note.id, id: d.stroke.id, stroke: d.stroke });
    }
    this.scheduleRender();
  }

  flushPoints() {
    const d = this.draw;
    if (!d || !d.buffer.length) return;
    this.network.send({
      type: 'noteStrokePoints',
      payload: { noteId: d.id, strokeId: d.stroke.id, points: d.buffer }
    });
    d.buffer = [];
  }

  // --- Перетаскивание и изменение размера окна ---

  beginDrag(e, el, mode) {
    if (e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();

    const r = this.layer.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    this.drag = {
      id: el.dataset.id,
      mode,
      pid: e.pointerId,
      dx: e.clientX - box.left,
      dy: e.clientY - box.top,
      left: box.left - r.left,
      top: box.top - r.top,
      w: box.width,
      h: box.height,
      sentAt: 0
    };
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  }

  moveDrag(e, el) {
    const d = this.drag;
    if (!d || d.pid !== e.pointerId || d.id !== el.dataset.id) return;
    const note = this.storage.noteById(d.id);
    if (!note) return;

    const r = this.layer.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const k = this.renderer.scale;

    if (d.mode === 'move') {
      const left = clamp(e.clientX - r.left - d.dx, GUTTER, r.width - d.w - BAR_GUTTER);
      const top = clamp(e.clientY - r.top - d.dy, GUTTER, r.height - d.h - GUTTER);
      note.x = clamp(left / k, 0, BOARD_W - note.w);
      note.y = top / r.height;
    } else {
      // Размер тянут за уголок холста; нарисованное при этом не растягивается —
      // окно просто показывает больше или меньше поля, как лист бумаги.
      const cr = el.querySelector('.note-canvas').getBoundingClientRect();
      const maxH = (r.height - (cr.top - r.top) - GUTTER) / k;
      note.w = clamp((e.clientX - cr.left) / k, NOTE_MIN_W, BOARD_W - note.x);
      note.h = clamp((e.clientY - cr.top) / k, NOTE_MIN_H, Math.max(NOTE_MIN_H, maxH));
    }

    this.layout(el, note);
    this.pushGeometry(note);
  }

  endDrag(e, el) {
    const d = this.drag;
    if (!d || d.pid !== e.pointerId) return;
    this.drag = null;
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}

    const note = this.storage.noteById(d.id);
    if (note) this.pushGeometry(note, true);
  }

  // Геометрия уходит потоком, как точки штриха: соседи видят движение окна
  // «вживую», но не по пакету на каждое движение указателя.
  pushGeometry(note, force = false) {
    const now = Date.now();
    if (!force && this.drag && now - this.drag.sentAt < GEOM_FLUSH) return;
    if (this.drag) this.drag.sentAt = now;
    this.network.send({
      type: 'updateNote',
      payload: { noteId: note.id, x: note.x, y: note.y, w: note.w, h: note.h }
    });
  }
}
