import {
  generateUUID,
  normalizeNote,
  isTypingTarget,
  MAX_NOTE_LEN,
  NOTE_DEFAULT_W,
  NOTE_DEFAULT_H
} from './storage.js';

// --- Плавающие окна ---
//
// Окно с текстом, приклеенное к экрану: холст под ним прокручивается, а окно
// остаётся на месте. Координаты хранятся долями видимой области (см.
// normalizeNote в storage.js), поэтому у всех участников окно оказывается в
// одной и той же части экрана независимо от размера окна браузера.
//
// Окно — DOM-элемент, а не объект холста: текст должен выделяться, копироваться
// и набираться с системной клавиатурой, а перерисовка доски его не касается.

const MIN_W = 168;          // экранные px: уже окно текст не держит
const MIN_H = 104;
const GUTTER = 8;           // отступ от краёв рабочей области
const BAR_GUTTER = 20;      // справа — место под полосу прокрутки листа
const TEXT_FLUSH = 220;     // мс паузы в наборе — и текст уходит соседям
const GEOM_FLUSH = 70;      // мс: шаг рассылки при перетаскивании (~14 пакетов/с)
const TYPING_HOLD = 1200;   // мс: столько после своей клавиши чужой текст не затирает набранное

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(v, Math.max(lo, hi)));
}

export class NotesManager {
  constructor(storage, network, history) {
    this.storage = storage;
    this.network = network;
    this.history = history;

    this.layer = document.getElementById('notes');
    this.tpl = document.getElementById('noteTpl');

    this.els = new Map();          // id → корневой элемент окна
    this.textTimers = new Map();   // id → таймер отложенной отправки текста
    this.typedAt = new Map();      // id → время последнего нажатия клавиши
    this.drag = null;              // активное перетаскивание/изменение размера
    this.zTop = 1;                 // порядок окон: тронутое поднимается наверх

    this.init();
  }

  init() {
    document.getElementById('noteBtn')?.addEventListener('click', () => this.createNote());

    // Изменения приходят тремя путями: сеть (notesChanged), смена листа
    // (pageChanged) и перезагрузка снимка доски (pagesChanged из deserialize).
    window.addEventListener('notesChanged', () => this.sync());
    window.addEventListener('pageChanged', () => this.sync());
    window.addEventListener('pagesChanged', () => this.sync());

    // Размер экрана поменялся — доли те же, а пиксели другие.
    window.addEventListener('resize', () => this.layoutAll());
    window.addEventListener('orientationchange', () => setTimeout(() => this.layoutAll(), 220));

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key.toLowerCase() !== 'n') return;
      e.preventDefault();
      this.createNote();
    });

    // Незакрытый набор не должен пропасть при закрытии вкладки.
    window.addEventListener('pagehide', () => this.flushAllText());

    this.sync();
  }

  // --- Создание и удаление ---

  createNote() {
    const page = this.storage.currentPageId;
    // Каждое следующее окно на листе смещается по диагонали: подряд созданные
    // окна не ложатся друг на друга и их видно все сразу.
    const step = (this.storage.notes.filter(n => n.page === page).length % 5) * 0.035;
    const note = normalizeNote({
      id: generateUUID(),
      page,
      x: 0.06 + step,
      y: 0.08 + step,
      w: NOTE_DEFAULT_W,
      h: NOTE_DEFAULT_H,
      text: ''
    });

    this.storage.notes.push(note);
    this.network.send({ type: 'addNote', payload: { noteId: note.id, ...note } });
    this.history?.push({ type: 'add_note', id: note.id, note });
    this.sync();

    const el = this.els.get(note.id);
    const ta = el && el.querySelector('.note-text');
    if (ta) ta.focus();
  }

  deleteNote(id) {
    const note = this.storage.removeNote(id);
    if (!note) return;
    this.clearTimers(id);
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
      }
      this.applyNote(el, note);
    }

    for (const [id, el] of this.els) {
      if (live.has(id)) continue;
      el.remove();
      this.els.delete(id);
      this.clearTimers(id);
    }
  }

  applyNote(el, note) {
    this.layout(el, note);

    const ta = el.querySelector('.note-text');
    if (!ta || ta.value === note.text) return;

    // Пока человек печатает, чужой снимок текста его не перебивает: набранное
    // всё равно уйдёт следующим пакетом и станет общим. Два одновременных
    // автора одного окна разрешаются по принципу «последний записавший прав».
    if (document.activeElement === ta && Date.now() - (this.typedAt.get(note.id) || 0) < TYPING_HOLD) return;

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = note.text;
    if (document.activeElement === ta) {
      const max = ta.value.length;
      ta.setSelectionRange(Math.min(start, max), Math.min(end, max));
    }
  }

  layoutAll() {
    for (const [id, el] of this.els) {
      const note = this.storage.noteById(id);
      if (note) this.layout(el, note);
    }
  }

  // Доли → пиксели. Окно не выходит за края рабочей области и не уползает под
  // полосу прокрутки, при этом на узком экране не сжимается до нечитаемого.
  layout(el, note) {
    const r = this.layer.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const w = clamp(note.w * r.width, MIN_W, r.width - GUTTER - BAR_GUTTER);
    const h = clamp(note.h * r.height, MIN_H, r.height - GUTTER * 2);
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
    el.style.left = Math.round(clamp(note.x * r.width, GUTTER, r.width - w - BAR_GUTTER)) + 'px';
    el.style.top = Math.round(clamp(note.y * r.height, GUTTER, r.height - h - GUTTER)) + 'px';
  }

  // --- Разметка одного окна ---

  buildElement(id) {
    const el = this.tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = id;

    const bar = el.querySelector('.note-bar');
    const grip = el.querySelector('.note-resize');
    const close = el.querySelector('.note-close');
    const ta = el.querySelector('.note-text');

    // Порядок окон задаём z-index, а не перестановкой в DOM: перенос узла во
    // время жеста снял бы захват указателя, и перетаскивание оборвалось бы.
    el.addEventListener('pointerdown', () => this.raise(el), true);

    bar?.addEventListener('pointerdown', (e) => this.beginDrag(e, el, 'move'));
    grip?.addEventListener('pointerdown', (e) => this.beginDrag(e, el, 'resize'));
    el.addEventListener('pointermove', (e) => this.moveDrag(e, el));
    el.addEventListener('pointerup', (e) => this.endDrag(e, el));
    el.addEventListener('pointercancel', (e) => this.endDrag(e, el));

    close?.addEventListener('click', () => this.deleteNote(id));

    if (ta) {
      ta.addEventListener('input', () => this.onInput(id, ta));
      ta.addEventListener('blur', () => this.flushText(id));
      // Клавиши внутри поля — дело поля: наверх (к горячим клавишам доски и к
      // перехвату колеса на stage) они не идут.
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') ta.blur();
        e.stopPropagation();
      });
      ta.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
      // Ни рисование, ни панорамирование: касание внутри поля — это текст.
      ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    return el;
  }

  // --- Перетаскивание и изменение размера ---

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

  raise(el) {
    el.style.zIndex = String(++this.zTop);
  }

  moveDrag(e, el) {
    const d = this.drag;
    if (!d || d.pid !== e.pointerId || d.id !== el.dataset.id) return;
    const note = this.storage.noteById(d.id);
    if (!note) return;

    const r = this.layer.getBoundingClientRect();
    if (!r.width || !r.height) return;

    if (d.mode === 'move') {
      const left = clamp(e.clientX - r.left - d.dx, GUTTER, r.width - d.w - BAR_GUTTER);
      const top = clamp(e.clientY - r.top - d.dy, GUTTER, r.height - d.h - GUTTER);
      note.x = left / r.width;
      note.y = top / r.height;
    } else {
      const w = clamp(e.clientX - r.left - d.left, MIN_W, r.width - d.left - BAR_GUTTER);
      const h = clamp(e.clientY - r.top - d.top, MIN_H, r.height - d.top - GUTTER);
      note.w = w / r.width;
      note.h = h / r.height;
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
  // «вживую», но не по кадру на каждый pointermove.
  pushGeometry(note, force = false) {
    const now = Date.now();
    if (!force && this.drag && now - this.drag.sentAt < GEOM_FLUSH) return;
    if (this.drag) this.drag.sentAt = now;
    this.network.send({
      type: 'updateNote',
      payload: { noteId: note.id, x: note.x, y: note.y, w: note.w, h: note.h }
    });
  }

  // --- Текст ---

  onInput(id, ta) {
    const note = this.storage.noteById(id);
    if (!note) return;
    if (ta.value.length > MAX_NOTE_LEN) ta.value = ta.value.slice(0, MAX_NOTE_LEN);
    note.text = ta.value;
    this.typedAt.set(id, Date.now());

    // Один отложенный пакет на серию нажатий: беглый набор не превращается в
    // сообщение на каждую букву.
    if (this.textTimers.has(id)) return;
    this.textTimers.set(id, setTimeout(() => {
      this.textTimers.delete(id);
      this.flushText(id);
    }, TEXT_FLUSH));
  }

  flushText(id) {
    const timer = this.textTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.textTimers.delete(id);
    }
    const note = this.storage.noteById(id);
    if (!note) return;
    this.network.send({ type: 'noteText', payload: { noteId: id, text: note.text } });
  }

  flushAllText() {
    for (const id of Array.from(this.textTimers.keys())) this.flushText(id);
  }

  clearTimers(id) {
    const timer = this.textTimers.get(id);
    if (timer) clearTimeout(timer);
    this.textTimers.delete(id);
    this.typedAt.delete(id);
  }
}
