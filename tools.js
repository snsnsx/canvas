import {
  BOARD_W,
  PAGE_H,
  DEFAULT_PEN,
  DEFAULT_HL,
  SIZE_PRESETS,
  MAX_EXPORT_H,
  generateUUID
} from './storage.js';

// --- Жест «дотянуть до следующего листа» ---
//
// Всё меряется в экранных px: и колесо, и палец дают экранные дельты, а порог
// усилия должен ощущаться одинаково на любом масштабе холста.
const PULL_MAX   = 88;    // предел растяжения резинки (дальше усилие уходит «в вату»)
const PULL_ARM   = 48;    // с этого растяжения жест начинает заряжаться
const PULL_HOLD  = 520;   // мс удержания усилия до перехода
const PULL_IDLE  = 150;   // мс без нового усилия — резинку отпустили
const PULL_VIS   = 0.55;  // какую долю растяжения проезжает сам лист
const PULL_ENTRY = 92;    // с какого смещения «влетает» новый лист
const PULL_COOL  = 450;   // пауза после перехода: одно усилие — один лист
const PULL_K     = 210;   // жёсткость пружины возврата
const PULL_C     = 21;    // затухание пружины (чуть меньше критического — лёгкий отскок)
const WHEEL_GAP  = 120;   // пауза, разделяющая два прокрута колесом
const RING_LEN   = 2 * Math.PI * 9.4;   // длина кольца индикатора (r=9.4 в разметке)
const GRAB_HIT   = 17;    // радиус зоны нажатия по «хвату» изображения (сама ручка — r=12)

// --- Быстрая панель ---
//
// Панель встаёт только в узлы сетки. Шаг задан в экранных px, а число узлов
// считается от свободного места, поэтому на любом окне позиции лежат примерно
// на одном физическом расстоянии друг от друга. Ближе QB_MAGNET доли шага к
// узлу панель к нему подтягивается, дальше — идёт за пальцем свободно.
const QB_STEP    = 72;              // желаемое расстояние между узлами (экранные px)
const QB_MAGNET  = 0.42;            // радиус притяжения к узлу, в долях шага
const QB_KEY     = 'wb:quickbar';   // положение и свёрнутость (localStorage)

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

    // Жест продолжения: усилие, которое не влезло в лист, тянет «резинку».
    this.pull = {
      dir: 0,            // +1 — тянем за нижний край, -1 — за верхний
      raw: 0,            // накопленное усилие (экранные px, до демпфирования)
      stretch: 0,        // фактическое растяжение резинки
      charge: 0,         // 0…1 — насколько удержано усилие
      offset: 0,         // текущее смещение листа (экранные px, со знаком)
      vel: 0,            // скорость пружины возврата
      releasing: false,  // фаза возврата/влёта — пользователь уже не тянет
      entering: false,   // влёт нового листа: индикатор в этой фазе не нужен
      lastPushAt: 0,
      lastTickAt: 0,
      cooldownUntil: 0,
      raf: null
    };
    this._wheelAt = 0;        // время последнего события колеса
    this._wheelMag = 0;       // его дельта — по ней узнаём новый рывок
    this._wheelFromEdge = false;

    this.pullHint = document.getElementById('pageHint');
    this.pullRing = document.getElementById('pageHintRing');
    this.pullLabel = document.getElementById('pageHintLabel');
    this.pullEdge = document.getElementById('pageEdge');

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
    this.initQuickbar();

    // Attach canvas events
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('pointercancel', (e) => this.onUp(e));
    this.overlay.addEventListener('pointerleave', () => {
      this.hideEraserCursor();
      this.clearImageHover();
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
      const dir = d > 0 ? 1 : -1;
      // Рывок, который сам довёл камеру до края листа, резинку не тянет —
      // тянет только следующий, то есть повторная попытка прокрутить дальше.
      const armed = this.wheelBurstFromEdge(d, this.atPageEdge(dir));

      const desired = this.storage.cameraY + d / this.renderer.scale;
      this.storage.cameraY = desired;
      this.renderer.clampCamera();
      const leftover = (desired - this.storage.cameraY) * this.renderer.scale;

      if (leftover) {
        if (armed) this.pullPush(Math.abs(leftover), leftover > 0 ? 1 : -1, false);
      } else {
        this.releasePull();   // прокрутили обратно внутрь листа — резинка не нужна
      }
      this.renderer.scheduleCameraRender();
    }, { passive: false });

    // Buttons
    // Ластик есть и в toolbar, и в быстрой панели: обе кнопки помечены
    // data-act и делают одно и то же.
    document.querySelectorAll('[data-act="eraser"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.storage.tool = 'eraser';
        this.syncTools();
      });
    });
    document.getElementById('lassoBtn').addEventListener('click', () => {
      this.storage.tool = 'lasso';
      this.storage.selected = null;
      this.syncTools();
    });

    document.getElementById('undoBtn').addEventListener('click', () => this.history.undo());
    document.getElementById('redoBtn').addEventListener('click', () => this.history.redo());
    document.getElementById('clearBtn').addEventListener('click', () => this.clearBoard());
    document.getElementById('imgBtn').addEventListener('click', () => this.fileInput.click());
    document.getElementById('exportBtn').addEventListener('click', () => this.exportPDF());

    // Панель страниц (блокнот)
    document.getElementById('prevPageBtn')?.addEventListener('click', () => this.prevPage());
    document.getElementById('nextPageBtn')?.addEventListener('click', () => this.nextPageOrAdd());
    document.getElementById('delPageBtn')?.addEventListener('click', () => this.deleteCurrentPage());
    // Обновление индикатора при изменениях страниц от удалённых клиентов / загрузки.
    // Удалённое удаление листа могло переставить камеру на соседний — вписываем
    // её в текущий размер окна.
    window.addEventListener('pagesChanged', () => {
      this.renderer.clampCamera();
      this.updatePageUI();
    });
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

  // Цвета живут в одном месте, а показывают их несколько панелей (toolbar и
  // быстрая палитра), поэтому свотчи собираются сразу во все контейнеры с
  // соответствующим data-swatches — и остаются одинаковыми во всех.
  buildSwatches() {
    const sets = [
      { kind: 'pen', sel: '[data-swatches="pen"]', colors: this.storage.penColors, label: 'Ручка' },
      { kind: 'highlighter', sel: '[data-swatches="hl"]', colors: this.storage.hlColors, label: 'Маркер' }
    ];
    for (const set of sets) {
      document.querySelectorAll(set.sel).forEach(wrap => {
        wrap.innerHTML = '';
        set.colors.forEach((c, i) => wrap.appendChild(this.makeSwatch(set, c, i)));
      });
    }
  }

  makeSwatch({ kind, label }, color, i) {
    const b = document.createElement('button');
    b.className = kind === 'pen' ? 'swatch' : 'swatch hl';
    b.type = 'button';
    // Номер цвета хранится на самой кнопке: свотчей теперь несколько наборов,
    // и порядок в общем списке уже не совпадает с индексом цвета.
    b.dataset.i = i;
    b.title = `${label} — цвет ${i + 1} (удержание — сменить)`;
    b.setAttribute('aria-label', `${label}, цвет ${i + 1}`);
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<span class="dot" style="background:${color}"></span>`;
    b.addEventListener('click', () => {
      this.storage.tool = kind;
      if (kind === 'pen') this.storage.penIdx = i;
      else this.storage.hlIdx = i;
      this.syncTools();
    });
    this.attachLongPress(b, () => this.pickColor(kind, i));
    return b;
  }

  buildSizes() {
    const wrap = document.getElementById('sizes');
    if (!wrap) return;
    wrap.innerHTML = '';
    [
      { presetIndex: 1, title: 'Средняя толщина', ariaLabel: 'Средняя толщина инструмента' },
      { presetIndex: 2, title: 'Большая толщина', ariaLabel: 'Большая толщина инструмента' }
    ].forEach(({ presetIndex, title, ariaLabel }) => {
      const b = document.createElement('button');
      b.className = 'size';
      b.dataset.i = presetIndex;
      b.title = title;
      b.setAttribute('aria-label', ariaLabel);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<span class="pip" aria-hidden="true">${presetIndex}</span>`;
      b.addEventListener('click', () => {
        const t = (this.storage.tool === 'select' || this.storage.tool === 'lasso') ? 'pen' : this.storage.tool;
        if (this.storage.tool === 'select' || this.storage.tool === 'lasso') {
          this.storage.tool = 'pen';
        }
        this.storage.sizeIdx[t] = presetIndex;
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
    document.querySelectorAll('[data-swatches="pen"] .swatch').forEach(b => {
      const selected = this.storage.tool === 'pen' && Number(b.dataset.i) === this.storage.penIdx;
      b.classList.toggle('sel', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    document.querySelectorAll('[data-swatches="hl"] .swatch').forEach(b => {
      const selected = this.storage.tool === 'highlighter' && Number(b.dataset.i) === this.storage.hlIdx;
      b.classList.toggle('sel', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });

    document.querySelectorAll('[data-act="eraser"]').forEach(btn => {
      const selected = this.storage.tool === 'eraser';
      btn.classList.toggle('on', selected);
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });

    const lassoBtn = document.getElementById('lassoBtn');
    if (lassoBtn) {
      const selected = this.storage.tool === 'lasso';
      lassoBtn.classList.toggle('on', selected);
      lassoBtn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }

    const st = (this.storage.tool === 'select' || this.storage.tool === 'lasso') ? 'pen' : this.storage.tool;
    document.querySelectorAll('#sizes .size').forEach(b => {
      const selected = Number(b.dataset.i) === this.storage.sizeIdx[st];
      b.classList.toggle('sel', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    if (this.storage.tool !== 'eraser') this.hideEraserCursor();
    this.stage.classList.toggle('lasso', this.storage.tool === 'lasso');
    // Выделение изображения больше не привязано к инструменту «выделение»:
    // им можно управлять в любом инструменте, поэтому здесь его не сбрасываем.
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

  // --- Быстрая панель ---
  //
  // Плавающая палитра 3×2 поверх листа: ластик и два маркера, под ними три
  // пера. Кнопки те же, что в toolbar (их собирает buildSwatches по
  // data-swatches, подсвечивает syncTools), а своего здесь — только корпус:
  // перетаскивание за ползунок с посадкой в узлы сетки и сворачивание.

  initQuickbar() {
    this.qbar = document.getElementById('quickbar');
    this.qgrip = document.getElementById('quickGrip');
    this.qhint = document.getElementById('quickGridHint');
    this.qfold = document.getElementById('quickFoldBtn');
    if (!this.qbar || !this.qgrip) return;

    this.qdrag = null;
    this.qpos = this.loadQuickPos();
    this.qbar.classList.toggle('folded', this.qpos.folded);
    this.syncQuickFold();
    this.placeQuick();
    // Координаты есть — панель можно показывать: до этого она ждала в углу
    // прозрачной, иначе на каждой загрузке был бы прыжок с места.
    this.qbar.classList.add('ready');

    this.qgrip.addEventListener('pointerdown', (e) => this.quickDown(e));
    this.qgrip.addEventListener('pointermove', (e) => this.quickMove(e));
    this.qgrip.addEventListener('pointerup', (e) => this.quickUp(e));
    this.qgrip.addEventListener('pointercancel', (e) => this.quickUp(e));
    this.qfold?.addEventListener('click', () => this.toggleQuickbar());

    // Панель держится за долю поля, а не за пиксели, поэтому её пересаживают
    // при каждой смене раскладки. Одного resize мало: поле меняется и когда
    // окно не трогали — первая раскладка страницы, свёрнутый корпус, выросший
    // toolbar. Наблюдатель ловит всё это по фактическим размерам; сама посадка
    // меняет только координаты, так что круга «переставили → пересчитали» нет.
    window.addEventListener('resize', () => this.placeQuick());
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => this.placeQuick());
      ro.observe(document.documentElement);
      ro.observe(this.qbar);
    }
  }

  // Поле, по которому ходит панель: по бокам — кромки листа (их держат панель
  // страниц слева и toolbar справа), сверху — под toolbar, снизу — нижнее поле
  // окна. Меряем по самим панелям, а не повторяем расчёты CSS: поле тогда само
  // подстраивается под их размер, а быстрая палитра не наезжает на них сверху.
  quickField() {
    const w = this.qbar.offsetWidth;
    const h = this.qbar.offsetHeight;
    const tb = document.querySelector('.toolbar')?.getBoundingClientRect();
    const pb = document.getElementById('pagebar')?.getBoundingClientRect();
    const x0 = pb ? pb.left : 8;
    const y0 = (tb ? tb.bottom : 44) + 6;
    const availW = Math.max(0, (tb ? tb.right : window.innerWidth - 8) - w - x0);
    const availH = Math.max(0, window.innerHeight - 10 - h - y0);
    // Узлов тем больше, чем больше места, но не меньше двух на ось: даже на
    // крошечном окне у панели остаётся выбор между краями.
    const cols = Math.max(2, Math.round(availW / QB_STEP) + 1);
    const rows = Math.max(2, Math.round(availH / QB_STEP) + 1);
    return {
      x0, y0, w, h, cols, rows, availW, availH,
      stepX: availW / (cols - 1),
      stepY: availH / (rows - 1)
    };
  }

  // Ближайший узел по одной оси. Возвращает и сам узел (at), и «магнитную»
  // координату (pull) — свободную позицию, подтянутую к узлу тем сильнее, чем
  // она ближе. На границе притяжения тяга ровно нулевая, поэтому панель под
  // пальцем не дёргается, а именно прилипает и отлипает.
  quickSnap(v, origin, step, count) {
    if (!(step > 0)) return { i: 0, at: origin, pull: origin };
    const i = Math.min(count - 1, Math.max(0, Math.round((v - origin) / step)));
    const at = origin + i * step;
    let k = Math.max(0, 1 - (Math.abs(v - at) / step) / QB_MAGNET);
    k = k * k * (3 - 2 * k);
    return { i, at, pull: v + (at - v) * k };
  }

  // Ставим панель в узел, ближайший к сохранённой доле поля. Хранятся именно
  // доли, а не пиксели: после смены размера окна панель остаётся там же по
  // смыслу и снова садится ровно в узел.
  placeQuick() {
    if (!this.qbar || this.qdrag) return;
    const f = this.quickField();
    const sx = this.quickSnap(f.x0 + this.qpos.fx * f.availW, f.x0, f.stepX, f.cols);
    const sy = this.quickSnap(f.y0 + this.qpos.fy * f.availH, f.y0, f.stepY, f.rows);
    this.qbar.style.left = `${Math.round(sx.at)}px`;
    this.qbar.style.top = `${Math.round(sy.at)}px`;
  }

  quickDown(e) {
    if (e.button > 0 || e.target.closest('.quick-fold')) return;
    e.preventDefault();
    const box = this.qbar.getBoundingClientRect();
    this.qdrag = {
      pid: e.pointerId,
      dx: e.clientX - box.left,
      dy: e.clientY - box.top,
      fx: this.qpos.fx,
      fy: this.qpos.fy
    };
    try { this.qgrip.setPointerCapture(e.pointerId); } catch (_) {}
    // Пока панель несут, координаты меняются без transition: иначе корпус
    // отстаёт от пальца и магнит перестаёт читаться как щелчок по узлу.
    this.qbar.classList.remove('settling');
    this.qbar.classList.add('dragging');
    this.showQuickGrid(this.quickField());
  }

  quickMove(e) {
    const d = this.qdrag;
    if (!d || d.pid !== e.pointerId) return;
    const f = this.quickField();
    const gx = Math.min(f.x0 + f.availW, Math.max(f.x0, e.clientX - d.dx));
    const gy = Math.min(f.y0 + f.availH, Math.max(f.y0, e.clientY - d.dy));
    const sx = this.quickSnap(gx, f.x0, f.stepX, f.cols);
    const sy = this.quickSnap(gy, f.y0, f.stepY, f.rows);
    this.qbar.style.left = `${Math.round(sx.pull)}px`;
    this.qbar.style.top = `${Math.round(sy.pull)}px`;
    d.fx = f.availW ? (sx.at - f.x0) / f.availW : 0;
    d.fy = f.availH ? (sy.at - f.y0) / f.availH : 0;
  }

  quickUp(e) {
    const d = this.qdrag;
    if (!d || d.pid !== e.pointerId) return;
    this.qdrag = null;
    try { this.qgrip.releasePointerCapture(e.pointerId); } catch (_) {}
    this.qbar.classList.remove('dragging');
    this.qbar.classList.add('settling');
    this.hideQuickGrid();
    this.qpos.fx = d.fx;
    this.qpos.fy = d.fy;
    this.placeQuick();     // отпустили между узлами — панель доезжает сама
    this.saveQuickPos();
  }

  // Поле посадочных мест. Точка стоит в центре тайла размером в шаг сетки,
  // а сам тайл сдвинут на половину шага, поэтому точки попадают ровно туда,
  // где окажется центр панели, — включая крайние узлы.
  showQuickGrid(f) {
    const el = this.qhint;
    if (!el || !(f.stepX > 0) || !(f.stepY > 0)) return;
    el.style.left = `${f.x0 + f.w / 2 - f.stepX / 2}px`;
    el.style.top = `${f.y0 + f.h / 2 - f.stepY / 2}px`;
    el.style.width = `${f.availW + f.stepX}px`;
    el.style.height = `${f.availH + f.stepY}px`;
    el.style.backgroundSize = `${f.stepX}px ${f.stepY}px`;
    el.classList.add('show');
  }

  hideQuickGrid() {
    this.qhint?.classList.remove('show');
  }

  toggleQuickbar() {
    if (!this.qbar) return;
    this.qpos.folded = !this.qpos.folded;
    this.qbar.classList.toggle('folded', this.qpos.folded);
    this.syncQuickFold();
    // Габарит панели изменился, а с ним и поле её хода: пересаживаем корпус
    // в узел заново, иначе свёрнутая пилюля осталась бы стоять по углу
    // развёрнутой панели.
    this.qbar.classList.add('settling');
    this.placeQuick();
    this.saveQuickPos();
  }

  syncQuickFold() {
    if (!this.qfold) return;
    const open = !this.qpos.folded;
    this.qfold.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.qfold.setAttribute('aria-label', open ? 'Свернуть быструю панель' : 'Развернуть быструю панель');
    this.qfold.title = open ? 'Свернуть панель (Q)' : 'Развернуть панель (Q)';
  }

  // Положение панели — настройка рабочего места, а не содержимое доски,
  // поэтому живёт в localStorage отдельно от неё и не уходит соседям.
  loadQuickPos() {
    const def = { fx: 0, fy: 0.62, folded: false };
    try {
      const o = JSON.parse(localStorage.getItem(QB_KEY) || 'null');
      if (!o || typeof o !== 'object') return def;
      return {
        fx: Number.isFinite(o.fx) ? Math.min(1, Math.max(0, o.fx)) : def.fx,
        fy: Number.isFinite(o.fy) ? Math.min(1, Math.max(0, o.fy)) : def.fy,
        folded: !!o.folded
      };
    } catch (_) {
      return def;
    }
  }

  saveQuickPos() {
    try {
      localStorage.setItem(QB_KEY, JSON.stringify(this.qpos));
    } catch (_) {}
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

    if (e.key === 'Escape' && (this.storage.selected || this.storage.selection)) {
      this.storage.selected = null;
      this.storage.selection = null;
      this.renderer.renderOverlay();
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'p': this.storage.tool = 'pen'; this.syncTools(); break;
      case 'h': this.storage.tool = 'highlighter'; this.syncTools(); break;
      case 'e': this.storage.tool = 'eraser'; this.syncTools(); break;
      case 'q': this.toggleQuickbar(); break;
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
        this.renderer.scheduleCameraRender();
        break;
      case 'arrowdown':
        this.network.pauseAutoFocus();
        this.renderer.stopFocus();
        this.storage.cameraY += 80 / this.renderer.scale;
        this.renderer.clampCamera();
        this.renderer.scheduleCameraRender();
        break;
      case 'home':
        this.network.pauseAutoFocus();
        this.renderer.stopFocus();
        this.storage.cameraY = 0;
        this.renderer.clampCamera();
        this.renderer.scheduleCameraRender();
        break;
      case 'end':
        this.network.pauseAutoFocus();
        this.renderer.stopFocus();
        this.storage.cameraY = this.renderer.maxCamera();
        this.renderer.clampCamera();
        this.renderer.scheduleCameraRender();
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
      if (this.beginImageGrab(e)) return;   // «хват» подсвеченной картинки
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
    this.updateImageHover(e);
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

      // Штрих больше не активный: в кэш он должен попасть уже завершённым —
      // с концевой шапкой и без «шлейфа» на хвосте.
      this.activeStroke = null;
      this.renderer.activeStroke = null;
      this.renderer.commitStrokeToCache(s);
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
  }

  movePan(e) {
    this.network.pauseAutoFocus(1200);
    const now = performance.now();
    const k = this.renderer.scale;
    const desired = this.panStartCam - (e.clientY - this.panStartY) / k;
    this.storage.cameraY = desired;
    this.renderer.clampCamera();

    // Палец держит растяжение сам: усилие здесь абсолютное (насколько увели
    // палец за край листа), поэтому оно не копится, а просто следует за рукой.
    const leftover = (desired - this.storage.cameraY) * k;
    if (leftover) this.pullPush(Math.abs(leftover), leftover > 0 ? 1 : -1, true);
    else this.releasePull();

    const dt = Math.max(1, now - this.panLastT);
    this.panVel = -((e.clientY - this.panLastY) / dt) / k; // мировых px/ms
    this.panLastY = e.clientY;
    this.panLastT = now;

    this.renderer.scheduleCameraRender();
  }

  endPan() {
    this.panPid = null;
    this.releasePull();
    if (Math.abs(this.panVel) > 0.02) this.startMomentum();
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

      this.renderer.cameraRender();

      if (Math.abs(this.panVel) > 0.02) {
        this.momRAF = requestAnimationFrame(step);
      } else {
        this.momRAF = null;
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

  // --- Жест продолжения: дотянуть лист до следующей страницы ---
  //
  // Камера упирается в конец листа (clampCamera), и остаток усилия деть некуда.
  // Этот остаток растягивает «резинку»: лист отъезжает, у края всплывает
  // индикатор, кольцо заполняется — но только пока усилие держат. Обычная
  // прокрутка до конца страницы кольцо не заряжает: рывок, который сам довёл
  // камеру до края, в счёт не идёт (wheelBurstFromEdge), а инерция броска — тем
  // более, она гасится о край ещё в startMomentum.

  atPageEdge(dir) {
    const cam = this.storage.cameraY;
    return dir > 0 ? cam >= this.renderer.maxCamera() - 0.5 : cam <= 0.5;
  }

  // Колесо и трекпад не «отпускаются», как палец: события идут слитным потоком.
  // Считаем прокрут одним рывком, пока паузы между событиями меньше WHEEL_GAP
  // и дельта не растёт: инерция трекпада только затухает, поэтому рост дельты
  // означает, что человек толкнул заново.
  wheelBurstFromEdge(delta, atEdge) {
    const now = performance.now();
    const mag = Math.abs(delta);
    if (now - this._wheelAt > WHEEL_GAP || mag > this._wheelMag * 1.6 + 2) {
      this._wheelFromEdge = atEdge;
    }
    this._wheelAt = now;
    this._wheelMag = mag;
    return this._wheelFromEdge;
  }

  // Куда ведёт жест: на соседний лист, а в конце блокнота — на новый.
  pullTarget(dir) {
    if (!dir) return null;
    const idx = this.storage.currentPageIndex();
    if (dir > 0) {
      return idx < this.storage.pages.length - 1
        ? { index: idx + 1, label: `Страница ${idx + 2}` }
        : { index: -1, label: 'Новая страница' };
    }
    return idx > 0 ? { index: idx - 1, label: `Страница ${idx}` } : null;
  }

  // excess — усилие мимо края листа (экранные px). absolute: палец держит
  // растяжение сам (усилие позиционно), колесо же его накапливает.
  pullPush(excess, dir, absolute) {
    const p = this.pull;
    if (!(excess > 0.5) || p.entering) return;
    if (performance.now() < p.cooldownUntil) return;
    if (!this.pullTarget(dir)) return;            // выше первого листа тянуть некуда

    if (p.dir !== dir) { p.dir = dir; p.raw = 0; p.charge = 0; }
    p.raw = absolute ? excess : p.raw + excess;
    // Демпфирование как у резинки: чем сильнее растянута, тем меньше отдаёт
    // каждый следующий px усилия — дальше PULL_MAX лист не уедет.
    p.stretch = PULL_MAX * (1 - Math.exp(-p.raw / PULL_MAX));
    p.offset = -dir * p.stretch * PULL_VIS;
    p.releasing = false;
    p.lastPushAt = performance.now();
    this.pullLoop();
    this.renderPull();
  }

  // Усилие сняли — пружина возвращает лист на место.
  releasePull() {
    const p = this.pull;
    if (!p.dir || p.releasing) return;
    p.releasing = true;
    p.vel = 0;
    p.raw = 0;
    p.stretch = 0;
    this.pullLoop();
  }

  resetPull() {
    const p = this.pull;
    if (p.raf) { cancelAnimationFrame(p.raf); p.raf = null; }
    p.dir = 0; p.raw = 0; p.stretch = 0; p.charge = 0;
    p.offset = 0; p.vel = 0; p.releasing = false; p.entering = false;
    this.renderPull();
  }

  // Один цикл на весь жест: и натяжение, и возврат, и влёт нового листа.
  pullLoop() {
    const p = this.pull;
    if (p.raf || p.inTick) return;
    p.lastTickAt = performance.now();
    const step = () => {
      p.raf = null;
      p.inTick = true;
      const alive = this.pullStep();
      p.inTick = false;
      if (alive) p.raf = requestAnimationFrame(step);
    };
    p.raf = requestAnimationFrame(step);
  }

  pullStep() {
    const p = this.pull;
    const now = performance.now();
    const dt = Math.min(64, Math.max(1, now - p.lastTickAt));
    p.lastTickAt = now;

    // Палец, лежащий на экране, держит растяжение сам и новых событий не шлёт —
    // по таймеру бездействия отпускаем резинку только у колеса.
    if (!p.releasing && this.panPid === null && now - p.lastPushAt > PULL_IDLE) this.releasePull();

    if (p.releasing) {
      // Пружина: лист садится на место с лёгким перелётом, как отпущенная бумага.
      const t = dt / 1000;
      p.vel += (-PULL_K * p.offset - PULL_C * p.vel) * t;
      p.offset += p.vel * t;
      p.charge = Math.max(0, p.charge - dt / 160);
      if (Math.abs(p.offset) < 0.4 && Math.abs(p.vel) < 6) {
        this.resetPull();
        return false;
      }
    } else {
      // Заряд копится, только пока резинка растянута до порога усилия.
      p.charge = p.stretch >= PULL_ARM
        ? Math.min(1, p.charge + dt / PULL_HOLD)
        : Math.max(0, p.charge - dt / (PULL_HOLD * 0.6));
      if (p.charge >= 1) this.commitPull();
    }

    this.renderPull();
    return true;
  }

  // Усилие удержали — переходим. Тот же цикл доигрывает влёт нового листа.
  commitPull() {
    const p = this.pull;
    const dir = p.dir;
    const target = this.pullTarget(dir);

    p.dir = 0; p.raw = 0; p.stretch = 0; p.charge = 0;
    p.releasing = true;
    p.vel = 0;
    p.cooldownUntil = performance.now() + PULL_COOL;

    // Жест сделал своё дело: палец, который ещё лежит на экране, больше не
    // панорамирует — иначе он утянул бы камеру нового листа в старые координаты.
    if (this.panPid !== null) { this.panVel = 0; this.endPan(); }

    if (!target) return;
    if (target.index < 0) this.addPage();
    else this.goToPage(target.index, dir);

    // Новый лист влетает с той стороны, куда шло движение, и садится на место
    // той же пружиной, что возвращает резинку.
    p.offset = dir * PULL_ENTRY;
    p.vel = 0;
    p.releasing = true;
    p.entering = true;
  }

  renderPull() {
    const p = this.pull;
    const active = Math.abs(p.offset) > 0.05;
    const mag = Math.min(1, Math.abs(p.offset) / (PULL_ARM * PULL_VIS));

    this.stage.style.setProperty('--pull', p.offset.toFixed(2) + 'px');
    this.stage.classList.toggle('pulling', active);

    // Край листа: снизу — граница страницы, сверху — её начало. Позиция даётся
    // без учёта смещения: --pull уезжает вместе с холстом по тому же правилу.
    if (this.pullEdge) {
      const show = active && p.dir !== 0;
      if (show) {
        const k = this.renderer.scale;
        const edgeY = p.dir > 0
          ? (PAGE_H - this.storage.cameraY) * k
          : -this.storage.cameraY * k;
        this.pullEdge.style.top = edgeY.toFixed(1) + 'px';
        this.pullEdge.style.opacity = (mag * 0.9).toFixed(3);
      } else if (this.pullEdge.style.opacity !== '') {
        this.pullEdge.style.opacity = '';
      }
    }

    const hint = this.pullHint;
    if (!hint) return;
    if (!p.entering && p.dir !== 0 && mag > 0.02) {
      const target = this.pullTarget(p.dir);
      hint.classList.toggle('top', p.dir < 0);
      hint.classList.toggle('create', !!target && target.index < 0);
      if (target && target.label !== this._pullLabel) {
        this._pullLabel = target.label;
        if (this.pullLabel) this.pullLabel.textContent = target.label;
      }
      hint.style.opacity = Math.min(1, mag * 1.25).toFixed(3);
      hint.style.transform = `translate(-50%, ${((p.dir > 0 ? 1 : -1) * (1 - mag) * 16).toFixed(1)}px)`;
      if (this.pullRing) this.pullRing.style.strokeDashoffset = (RING_LEN * (1 - p.charge)).toFixed(2);
    } else if (hint.style.opacity !== '') {
      hint.style.opacity = '';
      hint.style.transform = '';
    }
  }

  // --- Eraser Cursor (кольцо, показывающее размер и положение ластика) ---

  updateEraserCursor(e) {
    const show = this.storage.tool === 'eraser'
      && (e.pointerType === 'mouse' || e.pointerType === 'pen');
    if (!show) { this.hideEraserCursor(); return; }
    if (!this.eraserCursor) return;

    // Кольцо лежит в координатах stage, а холст во время жеста продолжения
    // смещён — считаем от самого stage, иначе ринг уедет от курсора.
    const r = this.stage.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
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
      this.renderer.scheduleCameraRender();
    });
    this.thumb.addEventListener('pointerup', e => {
      if (e.pointerId === id) {
        id = null;
      }
    });
  }

  // --- Lasso selection (strokes + images) ---

  beginLasso(e) {
    const world = this.pointerWorld(e);
    const screen = this.pointerPos(e);
    const bounds = this.renderer.selectionBounds(this.storage.selection);

    if (bounds) {
      const k = this.renderer.scale;
      const deleteX = (bounds.x + bounds.w) * k + 14;
      const deleteY = (bounds.y - this.storage.cameraY) * k - 14;
      if (Math.hypot(screen.sx - deleteX, screen.sy - deleteY) <= 17) {
        this.deleteLassoSelection();
        return;
      }
      if (world.x >= bounds.x && world.x <= bounds.x + bounds.w && world.y >= bounds.y && world.y <= bounds.y + bounds.h) {
        this.lassoPid = e.pointerId;
        this.lassoMode = 'move';
        this.lassoStart = world;
        this.lassoOriginal = this.snapshotSelection(this.storage.selection);
        return;
      }
    }

    // Лассо ничего не рисует, поэтому здесь картинку берут прямо за тело —
    // обводить её контуром не нужно. Заодно работают её ручки: размер и
    // удаление. Промах по картинке снимает выделение и начинает обводку.
    if (this.storage.selected || this.hitImage(world.x, world.y)) {
      this.storage.selection = null;
      this.clearImageHover();
      if (this.beginImageDrag(e)) return;
    }

    this.storage.selection = null;
    this.lassoPid = e.pointerId;
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
        // Полный перебор «каждая точка каждого штриха × каждое ребро лассо» —
        // O(S·P·L). Замер на 5000 штрихов × 60 точек и контуре из 300 вершин:
        // 433 мс полной остановки интерфейса. Предфильтр по габаритам лассо
        // отсекает подавляющее большинство ещё до дорогой проверки: сначала по
        // готовому bbox штриха (minY/maxY уже поддерживаются), затем по точке.
        // Результат выделения при этом побитово тот же — прямоугольник лассо
        // содержит сам контур, поэтому ни одна точка внутри не может быть
        // отброшена. Замер после правки: 2.1 мс, то же выделение (206×).
        let lminX = Infinity, lminY = Infinity, lmaxX = -Infinity, lmaxY = -Infinity;
        for (const p of path) {
          if (p.x < lminX) lminX = p.x;
          if (p.x > lmaxX) lmaxX = p.x;
          if (p.y < lminY) lminY = p.y;
          if (p.y > lmaxY) lmaxY = p.y;
        }

        const strokes = this.storage.strokes.filter(s => {
          if (s.page !== cur) return false;
          if (s.maxY < lminY || s.minY > lmaxY) return false;     // штрих вне полосы лассо
          const pts = s.points || [];
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (p.x < lminX || p.x > lmaxX || p.y < lminY || p.y > lmaxY) continue;
            if (this.pointInPolygon(p, path)) return true;
          }
          return false;
        });
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
    this.clearImageHover();
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

  // --- Наведение курсора на изображение ---
  //
  // Мышь на десктопе одновременно и рисует, и управляет объектами, поэтому
  // нажатие по телу картинки оставлено рисованию: поверх изображения нужно
  // писать. Управлять картинкой даёт «хват» — ручка в левом-верхнем углу,
  // которая всплывает при наведении. В режиме лассо инструмент ничего не рисует,
  // и там картинку можно брать за любое место (см. beginLasso).

  updateImageHover(e) {
    if (!this.isDrawingPointer(e)) return;
    const busy = this.drawPid !== null || this.dragPid !== null
      || this.panPid !== null || this.lassoPid !== null;
    if (busy || (e.buttons && e.buttons !== 0)) { this.clearImageHover(); return; }

    const { sx, sy } = this.pointerPos(e);
    const k = this.renderer.scale;
    const im = this.hitImage(sx / k, sy / k + this.storage.cameraY);
    let hovered = (im && im !== this.storage.selected) ? im : null;

    // Ручка сидит на самом углу, то есть половиной висит за границей картинки.
    // Пока курсор на ней, подсветку не снимаем — иначе ручка исчезала бы прямо
    // под курсором, который на неё нацелился.
    if (!hovered) {
      const prev = this.renderer.hoverImage;
      if (prev && prev !== this.storage.selected && this.onGrabHandle(prev, sx, sy)) hovered = prev;
    }

    if (hovered !== this.renderer.hoverImage) {
      this.renderer.hoverImage = hovered;
      this.renderer.renderOverlay();
    }

    // Курсор «взять»: в лассо — над всей картинкой, в рисующих инструментах —
    // только над самой ручкой, чтобы не обещать хват там, где будет линия.
    const grabbable = !!hovered
      && (this.storage.tool === 'lasso' || this.onGrabHandle(hovered, sx, sy));
    this.stage.classList.toggle('grab', grabbable);
  }

  // Экранная точка (sx, sy) лежит на «хвате» картинки?
  onGrabHandle(im, sx, sy) {
    const g = this.renderer.imageGrabHandle(im);
    return !!g && Math.hypot(sx - g.x, sy - g.y) <= GRAB_HIT;
  }

  clearImageHover() {
    this.stage.classList.remove('grab');
    if (this.renderer.hoverImage) {
      this.renderer.hoverImage = null;
      this.renderer.renderOverlay();
    }
  }

  // Нажатие по «хвату» подсвеченной картинки: выделяем её и сразу тащим.
  beginImageGrab(e) {
    const im = this.renderer.hoverImage;
    if (!im || im.page !== this.storage.currentPageId) return false;
    if (this.storage.imageById(im.id) !== im) return false;   // картинку уже убрали
    const { sx, sy } = this.pointerPos(e);
    if (!this.onGrabHandle(im, sx, sy)) return false;

    const k = this.renderer.scale;
    this.storage.selected = im;
    this.storage.selection = null;
    this.clearImageHover();
    this.dragPid = e.pointerId;
    this.dragMode = 'move';
    this.dragOff = { x: sx / k - im.x, y: sy / k + this.storage.cameraY - im.y };
    this.dragStart = { x: im.x, y: im.y, w: im.w, h: im.h };
    this.stage.classList.add('grabbing');
    this.renderer.fullRender();
    return true;
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
      this.stage.classList.add('grabbing');
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
    this.stage.classList.remove('grabbing');
  }

  deleteSelected() {
    if (!this.storage.selected) return;
    const im = this.storage.selected;
    const idx = this.storage.images.indexOf(im);
    if (idx < 0) return;

    this.storage.images.splice(idx, 1);
    this.storage.selected = null;
    this.clearImageHover();
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
    const notes = this.storage.notes.filter(n => n.page === cur);
    if (!strokes.length && !images.length && !notes.length) return false;

    const items = [];
    for (const s of strokes) {
      items.push({ id: s.id, objectType: 'stroke', objectData: s });
      this.network.send({ type: 'deleteObject', payload: { objectId: s.id } });
    }
    for (const im of images) {
      items.push({ id: im.id, objectType: 'image', objectData: im });
      this.network.send({ type: 'deleteObject', payload: { objectId: im.id } });
    }
    // Плавающие окна — тоже содержимое листа: «Очистить страницу» убирает и их
    // (обратимо через undo, как и всё остальное в этом пакете).
    for (const n of notes) {
      items.push({ id: n.id, objectType: 'note', objectData: n });
      this.network.send({ type: 'deleteObject', payload: { objectId: n.id } });
    }

    this.storage.strokes = this.storage.strokes.filter(s => s.page !== cur);
    this.storage.images = this.storage.images.filter(im => im.page !== cur);
    this.storage.notes = this.storage.notes.filter(n => n.page !== cur);
    this.storage.selected = null;
    this.storage.selection = null;
    this.clearImageHover();
    this.storage.recomputeContentBottom();
    this.renderer.fullRender();
    if (notes.length) window.dispatchEvent(new CustomEvent('notesChanged'));

    this.history.push({ type: 'batch_delete', items });
    return true;
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
    // На последнем листе стрелка «вперёд» не гаснет, а заводит новый: об этом
    // говорит верхний индекс «+» (отдельной кнопки добавления в блокноте нет).
    if (next) {
      const atEnd = idx >= total - 1;
      next.disabled = false;
      next.classList.toggle('can-add', atEnd);
      const label = atEnd ? 'Добавить страницу' : 'Следующая страница';
      // Подсказку про «]» показываем только в роли навигации: горячая клавиша
      // остаётся листалкой и страниц не создаёт.
      next.title = atEnd ? label : `${label} (])`;
      next.setAttribute('aria-label', label);
    }
    // Корзина активна всегда: на единственном листе она его очищает.
    if (del) {
      const label = total <= 1 ? 'Очистить страницу' : 'Удалить страницу';
      del.title = label;
      del.setAttribute('aria-label', label);
    }
    const pagebar = document.getElementById('pagebar');
    if (pagebar) pagebar.setAttribute('aria-label', `Страницы: ${idx + 1} из ${total}`);
  }

  // Сброс локального состояния при смене листа (общий для навигации/добавления/удаления).
  //
  // Позиция просмотра запоминается для каждого листа: возврат приводит туда же,
  // где пользователь остановился, а не в начало страницы. remember: false — для
  // удаления, где currentPageId уже переставлен на соседний лист и запоминать
  // положение камеры (оно от удалённого листа) нельзя. follow: true — переход
  // не наш, а вслед за пишущим участником (см. followRemotePage).
  enterPage(pageId, opts = {}) {
    if (opts.remember !== false && this.storage.currentPageId !== pageId) {
      this.storage.rememberScroll(this.storage.currentPageId, this.storage.cameraY);
    }
    this.resetPull();
    this.storage.currentPageId = pageId;
    this.storage.cameraY = this.storage.recallScroll(pageId);
    this.storage.selected = null;
    this.storage.selection = null;
    this.renderer.lassoPath = null;
    this.clearImageHover();
    this.renderer.remoteCursors.clear();
    this.renderer.stopFocus();
    this.stopMomentum();
    if (opts.follow) {
      // Перешли за участником — автопрокрутка нужна сразу, чтобы подвести
      // камеру к его штриху на новом листе.
      this.network.resumeAutoFocus();
    } else {
      // Перелистнули сами: и автопрокрутка, и автопереход молчат — участник
      // ушёл на этот лист намеренно, и чужое перо не тащит его обратно.
      this.network.pauseAutoFocus();
      this.network.pausePageFollow();
    }
    this.network.sendCursorLeave();
    this.updatePageUI();
    this.renderer.clampCamera();
    // Плавающие окна принадлежат листу: на новом листе показываются его окна.
    window.dispatchEvent(new CustomEvent('pageChanged'));
  }

  // Автопереход на лист, где начал писать другой участник. Решение о переходе
  // принимает network.followRemotePage (он же держит паузы и кулдаун) — здесь
  // только сама смена листа и подводка камеры к чужому штриху.
  followRemotePage(pageId, point) {
    if (!pageId || pageId === this.storage.currentPageId) return;
    this.storage.ensurePage(pageId);
    const idx = this.storage.pageIndex(pageId);
    if (idx < 0) return;

    const dir = idx > this.storage.currentPageIndex() ? 1 : -1;
    this.enterPage(pageId, { follow: true });
    this.animatePageSwitch(dir);
    if (point) this.renderer.focusWorldPoint(point);
    this.network.showToast(`Участник пишет на странице ${idx + 1}`);
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

  // Стрелка «вперёд» в блокноте: на последнем листе она заводит следующий —
  // ровно то же, что делает жест «потянуть за край листа» (см. commitPull).
  nextPageOrAdd() {
    if (this.storage.currentPageIndex() >= this.storage.pages.length - 1) this.addPage();
    else this.nextPage();
  }

  addPage() {
    const afterId = this.storage.currentPageId;
    const newId = generateUUID();
    this.storage.insertPageAfter(afterId, newId);
    this.network.send({ type: 'addPage', payload: { pageId: newId, afterId } });
    this.enterPage(newId);
    this.animatePageSwitch(1);
    this.network.showToast(`Добавлена страница ${this.storage.currentPageIndex() + 1}`);
  }

  // Удаление без переспроса: корзина срабатывает сразу. Единственный лист в
  // блокноте не удаляется — он очищается (и это обратимо через undo).
  deleteCurrentPage() {
    if (this.storage.pages.length <= 1) {
      const cleared = this.clearBoard();
      this.network.showToast(cleared ? 'Страница очищена' : 'Страница уже пуста');
      return;
    }

    const id = this.storage.currentPageId;
    this.network.send({ type: 'deletePage', payload: { pageId: id } });
    const removed = this.storage.removePage(id);   // сам выберет соседнюю страницу
    if (!removed) return;
    this.enterPage(this.storage.currentPageId, { remember: false });
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
      document.getElementById('quickbar')
    ].filter(Boolean);
    const onPress = (e) => {
      const btn = e.target.closest('.btn, .swatch, .size, .presence');
      if (!btn || btn.disabled) return;
      // У кнопок разговора две иконки в одной ячейке, и скрыта та, что не по
      // состоянию: берём первую ВИДИМУЮ, иначе пружина досталась бы display:none
      // и нажатие выглядело бы мёртвым. getClientRects() у скрытой пуст.
      let inner = btn;
      for (const el of btn.querySelectorAll('.m-icon, .dot, .pip')) {
        if (el.getClientRects().length) { inner = el; break; }
      }
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

  // --- Экспорт всех страниц в один PDF ---

  exportPDF() {
    try {
      const pages = this.storage.pages;
      if (!pages || !pages.length) return;

      const imgs = [];
      for (const pageId of pages) {
        const { canvas, w, h } = this.renderPageCanvas(pageId);
        const jpeg = this.dataURLToBytes(canvas.toDataURL('image/jpeg', 0.92));
        imgs.push({ jpeg, w, h });
      }

      const bytes = this.buildPDF(imgs);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `whiteboard-${this.storage.boardId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      this.network.showToast('Не удалось создать PDF');
    }
  }

  // Рендер одной страницы на offscreen-canvas: белый фон + изображения, поверх —
  // штрихи на прозрачном слое (чтобы ластик стирал только чернила, как в живом виде).
  renderPageCanvas(pageId) {
    const margin = 40;
    const fullW = BOARD_W;                                      // единая ширина холста
    const minH = Math.round(BOARD_W * 1.414);                  // ~A4 для пустых/коротких страниц
    const pageBottom = this.storage.pageContentBottom(pageId);
    // По содержимому страницы, но не ниже минимума и не выше PAGE_H.
    const fullH = Math.min(PAGE_H, Math.max(minH, Math.ceil(pageBottom) + margin));
    const scale = Math.min(1, MAX_EXPORT_H / fullH);
    const outW = Math.round(fullW * scale), outH = Math.round(fullH * scale);

    const bg = document.createElement('canvas');
    bg.width = outW;
    bg.height = outH;
    const bx = bg.getContext('2d');
    bx.scale(scale, scale);
    bx.fillStyle = '#ffffff';
    bx.fillRect(0, 0, fullW, fullH);
    for (const im of this.storage.images) {
      if (im.page !== pageId) continue;
      if (im.img.complete && im.img.naturalWidth) {
        bx.drawImage(im.img, im.x, im.y, im.w, im.h);
      }
    }

    // штрихи на прозрачном слое, затем композитинг поверх фона
    const il = document.createElement('canvas');
    il.width = outW;
    il.height = outH;
    const ix = il.getContext('2d');
    ix.scale(scale, scale);
    for (const s of this.storage.strokes) {
      if (s.page === pageId) this.renderer.drawStrokeTo(ix, s, 0);
    }
    bx.drawImage(il, 0, 0, fullW, fullH);

    return { canvas: bg, w: outW, h: outH };
  }

  dataURLToBytes(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Минимальный PDF-писатель без внешних зависимостей: каждая страница холста —
  // отдельная страница PDF с JPEG-изображением (DCTDecode) во всю страницу.
  // 1 px = 1 pt. Смещения объектов считаем в байтах (JPEG — бинарный поток).
  buildPDF(imgs) {
    const enc = new TextEncoder();
    const chunks = [];
    let length = 0;
    const offsets = [];
    const push = (data) => {
      const b = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(b);
      length += b.length;
    };
    const startObj = (num) => { offsets[num] = length; };

    const n = imgs.length;
    const objCount = 2 + n * 3;                                 // catalog + pages + (page,content,image)×N

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // бинарный маркер

    startObj(1);
    push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    let kids = '';
    for (let i = 0; i < n; i++) kids += `${3 + i * 3} 0 R `;
    startObj(2);
    push(`2 0 obj\n<< /Type /Pages /Kids [ ${kids.trim()} ] /Count ${n} >>\nendobj\n`);

    for (let i = 0; i < n; i++) {
      const pageObj = 3 + i * 3, contentObj = pageObj + 1, imgObj = pageObj + 2;
      const { jpeg, w, h } = imgs[i];

      startObj(pageObj);
      push(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] `
        + `/Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);

      const stream = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
      startObj(contentObj);
      push(`${contentObj} 0 obj\n<< /Length ${enc.encode(stream).length} >>\nstream\n`);
      push(stream);
      push('endstream\nendobj\n');

      startObj(imgObj);
      push(`${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} `
        + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      push(jpeg);
      push('\nendstream\nendobj\n');
    }

    const xrefAt = length;
    let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
    for (let num = 1; num <= objCount; num++) {
      xref += String(offsets[num]).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let p = 0;
    for (const b of chunks) { out.set(b, p); p += b.length; }
    return out;
  }
}
