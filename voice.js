// Голосовой разговор поверх доски: полносвязный меш (каждый с каждым), только
// микрофон. Сигналинг едет по тому же WebSocket, но МИМО состояния доски —
// сервер не поднимает версию, ничего не пишет на диск и разносит offer/answer
// адресно. Состав разговора ведёт сервер: этот модуль его не сочиняет, а
// применяет. Любое сообщение о составе полностью пересобирает меш (_reconcile),
// поэтому повторная доставка и переподключение безопасны по построению.

const SPEAK_ON = 0.055;        // порог «заговорил» по RMS
const SPEAK_OFF = 0.030;       // порог «замолчал» — ниже: без гистерезиса точка дрожит
const SPEAK_HANG = 400;        // пауза между словами не должна гасить индикатор
const METER_HZ = 15;
const ICE_BATCH = 50;          // коалесинг исходящих кандидатов, мс
const DIAL_TIMEOUT = 10000;    // столько ждём чужой оффер, прежде чем набрать самим
const NEGOTIATE_TIMEOUT = 12000;
const ORPHAN_GRACE = 15000;    // сосед пропал из состава аварийно — держим звук
const LONELY_TIMEOUT = 120000; // один в разговоре — гасим микрофон сами
const HOUSE_TICK = 2000;
const WELCOME_TIMEOUT = 4000;
const REJOIN_THROTTLE = 2000;
const FALLBACK_ICE = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  hasTurn: false
};

export function pluralMembers(n) {
  const t = n % 100, o = n % 10;
  if (t > 10 && t < 20) return 'участников';
  if (o === 1) return 'участник';
  if (o >= 2 && o <= 4) return 'участника';
  return 'участников';
}

export class VoiceManager {
  constructor(storage, network, renderer) {
    this.storage = storage;
    this.network = network;
    this.renderer = renderer;              // только ради cursorColor()

    // Личность в разговоре — clientId ПЛЮС метка загрузки страницы. clientId
    // лежит в sessionStorage, а браузер копирует sessionStorage в дублированную
    // вкладку и в окно, открытое из этой же страницы: две живые вкладки
    // получили бы один id, склеились бы в одну запись состава и обе ответили бы
    // на один оффер. Метка живёт только в памяти — скопировать её нельзя, а
    // переподключение сокета её не меняет, поэтому после обрыва мы возвращаемся
    // в разговор тем же участником и соседям нечего пересобирать.
    this.selfId = storage.clientId + '.' + Math.random().toString(36).slice(2, 8);

    this.inCall = false;
    this.joining = false;
    this.muted = false;
    this.stream = null;
    this.track = null;

    this.rev = -1;
    this.roster = new Map();               // voiceId -> {client, muted}
    this.peers = new Map();                // voiceId -> запись пира
    this.ice = FALLBACK_ICE;
    this.maxMembers = 6;

    this.audioCtx = null;
    this.localMeter = null;                // {src, an, buf}
    this.meterRaf = null;
    this.lastMeterAt = 0;
    this.houseTimer = null;
    this.lonelyTimer = null;
    this.welcomeTimer = null;
    this.rejoinAt = 0;
    this.narrow = null;
    this.unlockArmed = false;
    this.warnedFail = false;
    this.reloadArmedUntil = 0;

    this.barEl = null;
    this.callBtn = null;
    this.micBtn = null;
    this.levelEl = null;
    this.dotsEl = null;
    this.statusEl = null;
    this.sinks = null;
  }

  // ---------- жизненный цикл ----------

  init() {
    this.barEl = document.getElementById('voicebar');
    this.callBtn = document.getElementById('callBtn');
    this.micBtn = document.getElementById('micBtn');
    this.levelEl = document.getElementById('voiceLevel');
    this.dotsEl = document.getElementById('voiceDots');
    this.statusEl = document.getElementById('voiceStatus');
    this.sinks = document.getElementById('voiceSinks') || document.body;

    this.callBtn?.addEventListener('click', () => this.toggle());
    this.micBtn?.addEventListener('click', () => this.setMuted(!this.muted));

    // Свой слушатель клавиатуры — как в notes.js. Модификаторы гасим первыми:
    // без этого Cmd+M ушло бы в мьют вместе со сворачиванием окна. Клавиши на
    // «начать/завершить» нет намеренно: положить трубку промахом посреди фразы
    // хуже, чем один лишний клик, а случайно начатый разговор — это ещё и
    // незаметно включённый микрофон.
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Зажатая клавиша повторяется системой десятки раз в секунду, а каждый
      // мьют — это сообщение на сервер и новый состав всем на доске.
      if (e.repeat) return;
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if ((e.key || '').toLowerCase() !== 'm' || !this.inCall) return;
      e.preventDefault();
      this.setMuted(!this.muted);
    });

    // pagehide покрывает и bfcache, и iOS Safari, где beforeunload не
    // срабатывает. Это ускорение, а не гарантия: состав всё равно снимет сервер
    // при закрытии сокета — поэтому никаких синхронных запросов тут не нужно.
    const bye = () => {
      if (this.inCall) this._send('voiceLeave', {});
      this._stopLocalMedia();
    };
    window.addEventListener('pagehide', bye);
    window.addEventListener('beforeunload', bye);

    // Сколько точек помещается в ряд, зависит от ширины окна, а решается это
    // при отрисовке. Без пересчёта на смене раскладки повёрнутый телефон
    // остался бы с «широким» рядом до ближайшего изменения состава.
    this.narrow = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;
    if (this.narrow) {
      const relayout = () => this._renderDots();
      if (this.narrow.addEventListener) this.narrow.addEventListener('change', relayout);
      else if (this.narrow.addListener) this.narrow.addListener(relayout);
    }

    this._syncUI();
  }

  isInCall() { return this.inCall; }

  // Пилюля участников перезагружает страницу — во время разговора это мгновенный
  // обрыв связи для всех, кто нас слушает. Просим подтвердить вторым нажатием
  // (модальных окон в проекте нет и заводить их незачем).
  guardReload() {
    if (!this.inCall) return false;
    const now = Date.now();
    if (now < this.reloadArmedUntil) return false;
    this.reloadArmedUntil = now + 3000;
    this._toast('Перезагрузка прервёт разговор · нажмите ещё раз');
    return true;
  }

  supportState() {
    if (!window.RTCPeerConnection) return 'unsupported';
    // В незащищённом контексте navigator.mediaDevices вообще undefined: без этой
    // проверки чтение .getUserMedia бросит TypeError, а браузер не покажет ни
    // одного диалога — кнопка выглядела бы просто сломанной.
    if (!window.isSecureContext) return 'insecure';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'unsupported';
    return 'ok';
  }

  // ---------- вход и выход ----------

  async toggle() {
    if (this.inCall) this.leave('manual');
    else await this.join();
  }

  async join() {
    if (this.inCall || this.joining) return;
    const st = this.supportState();
    if (st === 'insecure') return this._toast('Разговор доступен только по https');
    if (st === 'unsupported') return this._toast('Браузер не поддерживает разговор');
    if (this.roster.size >= this.maxMembers) {
      return this._toast(`В разговоре уже ${this.maxMembers} ${pluralMembers(this.maxMembers)}`);
    }

    this.joining = true;
    this._syncUI();
    // AudioContext создаём внутри жеста и ДО первого await: политика автозапуска
    // считает клик потраченным, как только обработчик чего-нибудь дождался.
    this._ctx();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,    // в меше без него два ноутбука в одной
          noiseSuppression: true,    // комнате дают свист мгновенно
          autoGainControl: true,
          channelCount: { ideal: 1 } // не exact: часть устройств отдаёт только стерео
        },
        video: false
      });
    } catch (e) {
      this.joining = false;
      this._syncUI();
      return this._toast(this._gumMessage(e));
    }

    this.track = this.stream.getAudioTracks()[0] || null;
    if (this.track) {
      // Наушники выдернули, устройство отобрала другая программа.
      this.track.addEventListener('ended', () => {
        this._toast('Микрофон отключён · разговор завершён');
        this.leave('device');
      });
    }
    this.inCall = true;
    this.muted = false;
    this.warnedFail = false;
    this._meterLocal();
    this._startMeter();
    this._startHouse();

    // Представляемся серверу; конфигурация ICE придёт в voiceWelcome, и только
    // после неё уходит voiceJoin — иначе первые пиры создались бы без TURN.
    this._send('voiceHello', {});
    this.welcomeTimer = setTimeout(() => {
      this.welcomeTimer = null;
      if (!this.joining) return;
      this.joining = false;
      this.ice = FALLBACK_ICE;
      this._sendJoin();
      this._syncUI();
    }, WELCOME_TIMEOUT);
    this._syncUI();
  }

  leave(reason) {
    if (!this.inCall && !this.joining) return;
    this.inCall = false;
    this.joining = false;
    if (this.welcomeTimer) { clearTimeout(this.welcomeTimer); this.welcomeTimer = null; }
    this._send('voiceLeave', {});
    for (const id of [...this.peers.keys()]) this._dropPeer(id);
    this._stopLocalMedia();
    this._stopMeter();
    this._stopHouse();
    this.roster.delete(this.selfId);
    if (reason !== 'device' && reason !== 'full') {
      this._toast(reason === 'lonely'
        ? 'Разговор завершён · никого не осталось'
        : 'Разговор завершён');
    }
    this._syncUI();
  }

  setMuted(v) {
    if (!this.inCall || !!v === this.muted) return;
    this.muted = !!v;
    // enabled = false отдаёт тишину ВСЕМ потребителям трека (в том числе
    // анализатору, поэтому собственное кольцо гаснет само), не трогает соединение
    // и не требует пересогласования. track.stop() освободил бы устройство, но
    // тогда включение обратно стоило бы нового getUserMedia и пересогласования
    // каждой пары — а размьючиваются обычно уже посреди фразы.
    for (const t of (this.stream ? this.stream.getAudioTracks() : [])) t.enabled = !this.muted;
    // Соседям сообщаем через состав: тишина и выключенный микрофон обязаны
    // выглядеть по-разному, а состав переживает и потерю одного сообщения.
    this._send('voiceMute', { payload: { muted: this.muted } });
    this._syncUI();
  }

  // ---------- сокет ----------

  onSocketOpen() {
    // Сокет открылся заново — возможно, и сервер перезапустился. Его счётчик
    // состава тогда начинается с нуля, а наш только растёт: сравнение
    // «rev <= this.rev» навсегда отбрасывало бы свежие сообщения, и разговор
    // замирал бы до перезагрузки страницы. Счётчик сравним только внутри одной
    // жизни соединения, поэтому на каждом открытии сбрасываем его.
    this.rev = -1;
    if (!this.inCall) return;
    // Соединения НЕ рвём: медиа по ICE переживает обрыв сигналинга, а network.js
    // переподключается каждые три секунды.
    this._send('voiceHello', {});
    // А вот переговоры, застигнутые обрывом, мертвы: sendVoice тогда возвращал
    // false и молча выбрасывал offer/answer/кандидаты. Живые пары не трогаем,
    // недоговорившиеся пересоберём с чистого листа.
    for (const [id, p] of [...this.peers]) {
      if (p.pc && p.pc.connectionState === 'connected') continue;
      this._dropPeer(id);
    }
  }

  // ---------- входящие ----------

  handleMessage(msg) {
    switch (msg.type) {
      case 'voiceWelcome': return this._onWelcome(msg);
      case 'voiceRoster': return this._onRoster(msg);
      case 'voiceSignal': return this._onSignal(msg.from, msg.payload || {});
      case 'voiceFull': {
        const limit = msg.limit || this.maxMembers;
        this.maxMembers = limit;
        this.leave('full');
        this._toast(`В разговоре уже ${limit} ${pluralMembers(limit)}`);
        return;
      }
    }
  }

  _onWelcome(msg) {
    if (this.welcomeTimer) { clearTimeout(this.welcomeTimer); this.welcomeTimer = null; }
    this.maxMembers = msg.maxMembers || this.maxMembers;
    this.ice = (msg.ice && Array.isArray(msg.ice.iceServers) && msg.ice.iceServers.length)
      ? msg.ice : FALLBACK_ICE;
    // Приветствие адресное и приходит прямо в ответ на наш voiceHello, то есть
    // заведомо свежее всего, что мы видели: принимаем его как истину, а не
    // сравниваем версии.
    if (typeof msg.rev === 'number') this.rev = msg.rev;
    this.roster = this._toRoster(msg.members);
    if (this.joining) {
      this.joining = false;
      this._sendJoin();
    }
    this._reconcile();
  }

  _onRoster(msg) {
    const now = Date.now();
    // Пометку «сосед пропал аварийно» ставим ДО проверки версии. Она
    // идемпотентна, а потерять её нельзя: сообщения приходят не строго по
    // порядку (личный снимок состава уходит уже после того, как сокет попал в
    // общую рассылку), и отброшенное по версии сообщение унесло бы с собой
    // льготное время — соседа снесли бы мгновенно вместе с работающим звуком.
    for (const id of msg.lost || []) {
      const p = this.peers.get(id);
      // У соседа умер сокет, но соединение по ICE ещё живо: рвать звук из-за
      // трёхсекундного обрыва сигналинга нельзя — ждём его возвращения.
      if (p) { p.orphanUntil = now + ORPHAN_GRACE; p.state = 'away'; }
    }
    // rev монотонен внутри жизни соединения: устаревший снимок игнорируем.
    if (typeof msg.rev === 'number') {
      if (msg.rev <= this.rev) return;
      this.rev = msg.rev;
    }
    // А вот снос по left необратим, поэтому только после проверки версии.
    for (const id of msg.left || []) this._dropPeer(id);

    const prev = this.roster;
    const next = this._toRoster(msg.members);
    this.roster = next;

    if (this.inCall && next.has(this.selfId)) {
      // Тех, у кого просто оборвался сигналинг, в «пришёл/ушёл» не считаем:
      // человек никуда не делся, его слышно, и через три секунды он вернётся.
      // Иначе один блип выглядел бы как «Участник вышел» и сразу «Участник
      // присоединился» — два ложных сообщения на ровном месте.
      const blip = (id) => { const p = this.peers.get(id); return !!(p && p.orphanUntil && now < p.orphanUntil); };
      let joined = 0, gone = 0;
      for (const id of next.keys()) if (id !== this.selfId && !prev.has(id) && !blip(id)) joined++;
      for (const id of prev.keys()) if (id !== this.selfId && !next.has(id) && !blip(id)) gone++;
      const n = this._memberCount();
      if (joined) this._toast(`Участник присоединился · всего ${n}`);
      else if (gone) this._toast(`Участник вышел · всего ${n}`);
    } else if (!this.inCall && !prev.size && next.size) {
      this._toast(`Идёт разговор · ${next.size} ${pluralMembers(next.size)}`);
    }
    this._reconcile();
  }

  // Участники разговора глазами интерфейса: состав плюс те, у кого сигналинг
  // оборвался, но звук ещё идёт. Сервер о вторых уже не знает, а слышно их
  // по-прежнему — и в счётчике они обязаны оставаться.
  _visibleIds() {
    const now = Date.now();
    const ids = [...this.roster.keys()].filter(id => id !== this.selfId);
    for (const [id, p] of this.peers) {
      if (id === this.selfId || this.roster.has(id)) continue;
      if (p.orphanUntil && now < p.orphanUntil) ids.push(id);
    }
    return ids;
  }

  _memberCount() {
    return this._visibleIds().length + (this.inCall ? 1 : 0);
  }

  _toRoster(members) {
    const m = new Map();
    for (const x of members || []) {
      if (x && x.id) m.set(x.id, { client: x.client || x.id, muted: !!x.muted });
    }
    return m;
  }

  // Единственная точка правды на клиенте: полная сверка меша с составом.
  // Идемпотентна — её можно звать и на снимок, и на дельту, и повторно.
  _reconcile() {
    const now = Date.now();
    const mine = this.roster.has(this.selfId);

    if (this.inCall && !this.joining && !mine && now > this.rejoinAt) {
      // Нас нет в составе — значит voiceJoin потерялся на обрыве. Заявляемся
      // снова: сервер идемпотентен, лишний join безвреден. Троттлинг нужен,
      // чтобы чужие входы не порождали пачку наших повторов.
      this.rejoinAt = now + REJOIN_THROTTLE;
      this._sendJoin();
    }
    if (this.inCall && mine) {
      for (const [id, meta] of this.roster) {
        if (id === this.selfId) continue;
        const p = this._ensurePeer(id, meta);
        if (!p) continue;
        p.orphanUntil = 0;
        p.muted = meta.muted;
        p.base = meta.client;
        // Вернулся в состав, а соединение всё это время было живым: гасить
        // точку больше не за что. Без этого после каждого обрыва сигналинга
        // сосед навсегда оставался бы бледным при работающем звуке —
        // connectionState не менялся, значит и события состояния не будет.
        if (p.state === 'away' && p.pc && p.pc.connectionState === 'connected') p.state = 'live';
      }
    }
    for (const [id, p] of [...this.peers]) {
      // Условие тут именно inCall, а НЕ «нас нет в составе». После обрыва сокета
      // сервер снимает нас с учёта, и до ответа на повторный voiceJoin мы в
      // составе отсутствуем — но соединения в это время живы и звук идёт. Снос
      // по «нас нет» рвал бы работающий звук на каждом переподключении, то есть
      // ровно в том случае, ради которого весь этот механизм и сделан.
      if (!this.inCall) { this._dropPeer(id); continue; }
      if (this.roster.has(id)) continue;
      if (p.orphanUntil && now < p.orphanUntil) continue;
      this._dropPeer(id);
    }
    this._syncUI();
  }

  // ---------- RTCPeerConnection ----------

  _ensurePeer(id, meta) {
    if (!id || id === this.selfId || !this.stream) return null;
    const known = this.peers.get(id);
    if (known) return known;

    // Вежливость выводится из сравнения идентификаторов: обе стороны получают
    // ОДИН и тот же ответ, не обменявшись ни одним сообщением. Первый оффер
    // делает только невежливая (бо́льшая) сторона — столкновений на входе не
    // бывает вовсе, а полный перфектный алгоритм ниже остаётся ради ICE-рестарта,
    // где инициатором может оказаться кто угодно.
    const polite = this.selfId < id;
    const pc = new RTCPeerConnection({
      iceServers: this.ice.iceServers || [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0        // в меше пиров много, пре-гатеринг впустую
    });

    const p = {
      id, base: (meta && meta.client) || id.split('.')[0], pc, polite,
      mayOffer: !polite, makingOffer: false, ignoreOffer: false,
      srdAnswerPending: false, gotRemote: false,
      pendingIce: [], iceOut: [], iceTimer: 0, chain: Promise.resolve(),
      audio: null, src: null, an: null, buf: null,
      speaking: false, quietAt: 0, muted: !!(meta && meta.muted),
      dot: null, state: 'wait', restarts: 0, failTimer: 0,
      // Пара, ещё не получившая описания: сторож перенаберёт её сам, что бы ни
      // потерялось по дороге — очередь исходящих для этого не нужна.
      dialDeadline: Date.now() + DIAL_TIMEOUT,
      orphanUntil: Date.now() + ORPHAN_GRACE,  // оффер может обогнать состав
      reported: false
    };
    this.peers.set(id, p);

    for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);

    pc.onnegotiationneeded = () => {
      if (!p.mayOffer) return;       // вежливая сторона первый оффер не делает
      p.chain = p.chain.then(() => this._negotiate(p)).catch(e => console.warn('voice: nego', e));
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        p.iceOut.push(e.candidate.toJSON());
        // Кандидаты сыплются пачкой за первые ~200 мс, а конверт весит больше
        // самого кандидата — копим 50 мс и шлём одним сообщением. Тот же приём,
        // что и с буфером точек в network.js.
        if (!p.iceTimer) p.iceTimer = setTimeout(() => this._flushIce(p, false), ICE_BATCH);
      } else {
        this._flushIce(p, true);     // гатеринг закончился — досылаем хвост
      }
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      this._attachAudio(p, stream);   // ЭЛЕМЕНТ ПЕРВЫМ: в Chrome анализатор на
      this._meterPeer(p, stream);     // «голом» удалённом потоке читает тишину
    };
    pc.onconnectionstatechange = () => this._onPeerState(p);
    this._renderDots();
    return p;
  }

  async _negotiate(p, opts) {
    if (!p.pc || !this.peers.has(p.id)) return;
    const restart = !!(opts && opts.iceRestart);
    // createOffer допустим только в stable/have-local-offer. Если пара прямо
    // сейчас договаривается, рестарт не нужен: текущий обмен либо закончится
    // сам, либо его подберёт сторож по dialDeadline.
    if (restart && p.pc.signalingState !== 'stable') {
      // Сторож уже обнулил срок, и просто выйти отсюда значит замолчать
      // навсегда: пара, застрявшая в have-local-offer, никогда бы не
      // перенабралась. Взводим срок заново и ждём следующего круга.
      p.dialDeadline = Date.now() + 4000;
      return;
    }
    p.dialDeadline = Date.now() + NEGOTIATE_TIMEOUT;
    try {
      p.makingOffer = true;
      if (restart) {
        await p.pc.setLocalDescription(await p.pc.createOffer({ iceRestart: true }));
      } else {
        // setLocalDescription() без аргумента сам выбирает offer/answer и умеет
        // неявный откат: Chrome 80+, Firefox 75+, Safari 15+.
        await p.pc.setLocalDescription();
      }
      const ok = this._signal(p.id, { kind: 'sdp', sdp: p.pc.localDescription.toJSON() });
      if (!ok) p.dialDeadline = Date.now() + 4000;   // сокет лежит — скоро повторим
    } catch (e) {
      console.warn('voice: offer', p.id, e);
      p.dialDeadline = Date.now() + 5000;
    } finally {
      p.makingOffer = false;
    }
  }

  _onSignal(from, payload) {
    if (!from || !this.inCall) return;
    const p = this.peers.get(from) || this._ensurePeer(from, this.roster.get(from));
    if (!p) return;
    // Обработка сериализуется на пира: два входящих сообщения могут переплестись
    // на await, и кандидат обогнал бы setRemoteDescription.
    p.chain = p.chain.then(() => this._apply(p, payload)).catch(e => console.warn('voice: signal', e));
  }

  async _apply(p, payload) {
    if (!p.pc || !this.peers.has(p.id)) return;
    if (payload.kind === 'ice') {
      for (const c of payload.cands || []) {
        // addIceCandidate до setRemoteDescription бросает InvalidStateError,
        // поэтому ранние кандидаты копятся до описания.
        if (!p.pc.remoteDescription) { p.pendingIce.push(c); continue; }
        try { await p.pc.addIceCandidate(c); }
        catch (e) { if (!p.ignoreOffer) console.warn('voice: ice', e); }
      }
      return;
    }
    if (payload.kind !== 'sdp' || !payload.sdp) return;

    const desc = payload.sdp;
    const readyForOffer = !p.makingOffer &&
      (p.pc.signalingState === 'stable' || p.srdAnswerPending);
    const collision = desc.type === 'offer' && !readyForOffer;
    p.ignoreOffer = !p.polite && collision;
    if (p.ignoreOffer) return;             // невежливый держится своего предложения

    p.srdAnswerPending = desc.type === 'answer';
    await p.pc.setRemoteDescription(desc);  // у вежливого откат неявный
    p.srdAnswerPending = false;
    p.gotRemote = true;
    p.mayOffer = true;                      // дальше инициировать может любая сторона
    for (const c of p.pendingIce.splice(0)) {
      try { await p.pc.addIceCandidate(c); } catch (_) {}
    }
    if (desc.type === 'offer') {
      await p.pc.setLocalDescription();
      this._signal(p.id, { kind: 'sdp', sdp: p.pc.localDescription.toJSON() });
    }
    p.dialDeadline = Date.now() + NEGOTIATE_TIMEOUT;
  }

  _flushIce(p, end) {
    if (p.iceTimer) { clearTimeout(p.iceTimer); p.iceTimer = 0; }
    if (!p.iceOut.length) return;
    this._signal(p.id, { kind: 'ice', cands: p.iceOut.splice(0), end: !!end });
  }

  _onPeerState(p) {
    if (this.peers.get(p.id) !== p) return;   // запись уже снята — не воскрешаем
    const st = p.pc ? p.pc.connectionState : 'closed';
    if (st === 'connected') {
      p.state = 'live'; p.restarts = 0; p.dialDeadline = 0; p.reported = false;
      if (p.failTimer) { clearTimeout(p.failTimer); p.failTimer = 0; }
    } else if (st === 'disconnected') {
      // «disconnected» часто самолечится за пару секунд (смена Wi-Fi,
      // ре-роутинг). Дёргать ICE сразу — значит рвать то, что и так вернётся.
      p.state = 'away';
      if (!p.failTimer) p.failTimer = setTimeout(() => this._restartIce(p), 4000);
    } else if (st === 'failed') {
      p.state = 'away';
      this._restartIce(p);
    } else if (st === 'closed') {
      this._dropPeer(p.id);
      return;
    } else {
      p.state = 'wait';
    }
    this._renderDots();
  }

  _restartIce(p) {
    if (p.failTimer) { clearTimeout(p.failTimer); p.failTimer = 0; }
    if (this.peers.get(p.id) !== p || !p.pc || p.pc.connectionState === 'connected') return;
    if (p.restarts >= 2) return this._failPeer(p);
    p.restarts += 1;
    // Рестарт ведёт та же сторона, что делала первый звонок: 'failed' прилетает
    // обоим, и симметричный рестарт дал бы гарантированное столкновение на каждом
    // восстановлении. Вежливая берётся сама, только если невежливая молчит
    // дольше шести секунд.
    const delay = p.polite ? 6000 : 0;
    setTimeout(() => {
      if (this.peers.get(p.id) !== p || !p.pc) return;
      if (p.pc.connectionState === 'connected') return;
      p.chain = p.chain.then(() => this._negotiate(p, { iceRestart: true }))
        .catch(e => console.warn('voice: restart', e));
    }, delay);
  }

  _failPeer(p) {
    p.state = 'lost';
    p.dialDeadline = 0;
    this._renderDots();
    if (p.reported || this.warnedFail) return;
    p.reported = true;
    this.warnedFail = true;
    // Одна пара из меша может не собраться, когда все остальные работают: за
    // симметричным NAT нужен ретранслятор, и честнее сказать об этом, чем звать
    // повторить попытку, которая обречена.
    this._toast(this.ice.hasTurn
      ? 'Не удалось соединиться с участником'
      : 'Не удалось соединиться с участником · нужен TURN-сервер');
  }

  _dropPeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    if (p.iceTimer) clearTimeout(p.iceTimer);
    if (p.failTimer) clearTimeout(p.failTimer);
    if (p.pc) {
      // Обработчики снимаем ДО close(): у закрытого соединения ещё может
      // выстрелить отложенный connectionstatechange и воскресить запись, которую
      // мы только что удалили.
      p.pc.onnegotiationneeded = null;
      p.pc.onicecandidate = null;
      p.pc.ontrack = null;
      p.pc.onconnectionstatechange = null;
      try { p.pc.close(); } catch (_) {}
    }
    p.pc = null;
    this._unmeter(p);
    if (p.audio) {
      p.audio.pause();
      p.audio.srcObject = null;     // без этого Chrome держит поток и декодер
      p.audio.remove();
      p.audio = null;
    }
    p.dot = null;
    this._renderDots();
  }

  // ---------- воспроизведение ----------

  _attachAudio(p, stream) {
    if (!p.audio) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;        // iOS иначе уводит звук в системный плеер
      el.setAttribute('data-peer', p.id);
      // Элемент обязан лежать в документе и не быть display:none — иначе часть
      // движков просто перестаёт его играть. Ссылку держим в записи пира, чтобы
      // сборщик мусора не превратил приём в тишину без единой ошибки.
      this.sinks.appendChild(el);
      p.audio = el;
    }
    p.audio.srcObject = stream;
    const pr = p.audio.play();
    if (pr && pr.catch) pr.catch(() => this._armUnlock());
  }

  _armUnlock() {
    if (this.unlockArmed) return;
    this.unlockArmed = true;
    this._toast('Звук включится после касания доски');
    const go = () => {
      this.unlockArmed = false;
      document.removeEventListener('pointerdown', go, true);
      if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      for (const p of this.peers.values()) if (p.audio) p.audio.play().catch(() => {});
    };
    // capture на document, но БЕЗ preventDefault: обработчики холста должны
    // отработать следом как обычно — рисование не ломаем.
    document.addEventListener('pointerdown', go, true);
  }

  _stopLocalMedia() {
    if (this.localMeter) {
      try { this.localMeter.src.disconnect(); } catch (_) {}
      this.localMeter = null;
    }
    for (const t of (this.stream ? this.stream.getAudioTracks() : [])) t.stop();
    this.stream = null;
    this.track = null;
    this.muted = false;
  }

  // ---------- индикатор речи ----------

  _ctx() {
    if (!this.audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try { this.audioCtx = new Ctor(); } catch (_) { return null; }
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }

  _makeMeter(stream) {
    const ctx = this._ctx();
    if (!ctx) return null;
    try {
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.5;
      // К ctx.destination НЕ подключаем: свой микрофон ушёл бы в динамики
      // (свист), а удалённый поток играл бы дважды — он уже звучит через
      // <audio>. Анализатор — тупиковая ветвь графа, и это правильно.
      src.connect(an);
      return { src, an, buf: new Uint8Array(an.fftSize) };
    } catch (e) {
      console.warn('voice: meter', e);
      return null;
    }
  }

  _meterLocal() { this.localMeter = this.stream ? this._makeMeter(this.stream) : null; }

  _meterPeer(p, stream) {
    const m = this._makeMeter(stream);
    if (!m) return;
    p.src = m.src; p.an = m.an; p.buf = m.buf;
  }

  _unmeter(p) {
    if (p.src) { try { p.src.disconnect(); } catch (_) {} }
    p.src = null; p.an = null; p.buf = null; p.speaking = false;
  }

  _rms(an, buf) {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  _startMeter() {
    if (this.meterRaf) return;
    const loop = (now) => {
      this.meterRaf = requestAnimationFrame(loop);
      if (now - this.lastMeterAt < 1000 / METER_HZ) return;
      this.lastMeterAt = now;
      if (this.localMeter && this.micBtn) {
        const lv = this.muted ? 0 : this._rms(this.localMeter.an, this.localMeter.buf);
        this.micBtn.style.setProperty('--lvl', (Math.min(1, lv * 6) * 5).toFixed(2) + 'px');
      }
      // Громкость разговора — самый громкий из собеседников. Не сумма: от суммы
      // индикатор упирался бы в потолок втроём при обычной речи, и «громко» уже
      // ничем не отличалось бы от «нормально». Свой голос сюда не входит — его
      // показывает кольцо вокруг микрофона, и путать «меня слышно» с «мне
      // слышно» нельзя.
      let loudest = 0;
      for (const p of this.peers.values()) {
        if (!p.an) continue;
        const lv = p.muted ? 0 : this._rms(p.an, p.buf);
        if (lv > loudest) loudest = lv;
        if (!p.dot) continue;
        if (lv > SPEAK_ON) { p.speaking = true; p.quietAt = 0; }
        else if (lv < SPEAK_OFF) {
          if (!p.quietAt) p.quietAt = now;
          else if (now - p.quietAt > SPEAK_HANG) p.speaking = false;
        }
        p.dot.classList.toggle('speaking', p.speaking);
        p.dot.style.setProperty('--lvl',
          (p.speaking ? 2 + Math.min(1, lv * 6) * 4 : 0).toFixed(2) + 'px');
      }
      if (this.levelEl) {
        this.levelEl.style.setProperty('--lvl', Math.min(1, loudest * 6).toFixed(3));
      }
    };
    // rAF, а не setInterval: в фоновой вкладке кадры замирают сами, и разговор
    // перестаёт греть батарею ровно тогда, когда индикатор всё равно не виден.
    this.meterRaf = requestAnimationFrame(loop);
  }

  _stopMeter() {
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.meterRaf = null;
    if (this.micBtn) this.micBtn.style.removeProperty('--lvl');
    if (this.levelEl) this.levelEl.style.removeProperty('--lvl');
  }

  // ---------- сторож ----------

  _startHouse() {
    if (this.houseTimer) return;
    this.houseTimer = setInterval(() => this._house(), HOUSE_TICK);
  }

  _stopHouse() {
    if (this.houseTimer) clearInterval(this.houseTimer);
    this.houseTimer = null;
    if (this.lonelyTimer) clearTimeout(this.lonelyTimer);
    this.lonelyTimer = null;
  }

  _house() {
    if (!this.inCall) return;
    const now = Date.now();
    let expired = false;
    for (const [id, p] of [...this.peers]) {
      if (p.orphanUntil && now > p.orphanUntil && !this.roster.has(id)) {
        this._dropPeer(id);
        expired = true;
        continue;
      }
      // Сторож пересогласования: он же покрывает любой потерянный кадр
      // сигналинга — очередь исходящих для этого не нужна и вредна.
      if (p.dialDeadline && now > p.dialDeadline &&
          (!p.pc || p.pc.connectionState !== 'connected')) {
        p.dialDeadline = 0;
        p.mayOffer = true;
        p.chain = p.chain.then(() => this._negotiate(p, { iceRestart: p.gotRemote }))
          .catch(e => console.warn('voice: redial', e));
      }
    }
    if (expired) this._syncUI();
    this._checkLonely();
  }

  _checkLonely() {
    const alone = this.inCall && this.roster.size <= 1;
    if (!alone) {
      if (this.lonelyTimer) clearTimeout(this.lonelyTimer);
      this.lonelyTimer = null;
      return;
    }
    if (this.lonelyTimer) return;
    // Брошенная вкладка с горячим микрофоном — единственная приватная проблема
    // этой возможности. Через две минуты в одиночестве гасим сами.
    this.lonelyTimer = setTimeout(() => {
      this.lonelyTimer = null;
      this.leave('lonely');
    }, LONELY_TIMEOUT);
  }

  // ---------- интерфейс ----------

  _syncUI() {
    const st = this.supportState();
    const active = this.roster.size > 0;
    if (this.callBtn) {
      this.callBtn.classList.toggle('on', this.inCall);
      this.callBtn.classList.toggle('live', active && !this.inCall);
      this.callBtn.classList.toggle('pending', this.joining);
      this.callBtn.disabled = this.joining;
      this.callBtn.setAttribute('aria-pressed', this.inCall ? 'true' : 'false');
      // Кнопку НЕ отключаем в незащищённом контексте: у отключённой нет ни
      // подсказки на касании, ни объяснения — вместо этого клик отвечает тостом,
      // что именно не так.
      const label = this.inCall ? 'Завершить разговор'
        : active ? 'Присоединиться к разговору'
          : 'Начать разговор';
      this.callBtn.setAttribute('aria-label', label);
      this.callBtn.title = st === 'insecure' ? 'Разговор доступен только по https' : label;
    }
    // Микрофон и уровень громкости стоят в панели всегда, даже когда разговора
    // нет: место под них занято с самого начала, и звонок ничего не сдвигает
    // под уже занесённым пальцем. Вне разговора они гаснут — «есть, но пока
    // нечем управлять» честнее, чем кнопка, появляющаяся из ниоткуда.
    if (this.micBtn) {
      this.micBtn.disabled = !this.inCall;
      this.micBtn.classList.toggle('muted', this.inCall && this.muted);
      this.micBtn.classList.toggle('on', this.inCall && !this.muted);
      this.micBtn.setAttribute('aria-pressed', this.inCall && this.muted ? 'true' : 'false');
      const label = this.inCall
        ? (this.muted ? 'Включить микрофон' : 'Выключить микрофон')
        : 'Микрофон — доступен во время разговора';
      this.micBtn.setAttribute('aria-label', label);
      this.micBtn.title = this.inCall ? `${label} (M)` : label;
      if (!this.inCall) this.micBtn.style.removeProperty('--lvl');
    }
    if (this.levelEl) {
      this.levelEl.classList.toggle('on', this.inCall);
      if (!this.inCall) this.levelEl.style.removeProperty('--lvl');
    }
    if (this.statusEl) {
      const n = this._memberCount() || this.roster.size;
      this.statusEl.textContent = active ? `В разговоре ${n} ${pluralMembers(n)}` : '';
    }
    this._renderDots();
    this._checkLonely();
  }

  _peerColor(base) {
    // Цвет голоса = цвет курсора того же человека: cursorColor даёт
    // hsl(H, 72%, 43%) — из того же тона собираем полупрозрачный ореол, чтобы не
    // заводить вторую палитру. Кто рисует бирюзовым, тот и светится бирюзовым.
    const solid = this.renderer.cursorColor(base);
    const m = /hsl\((\d+)/.exec(solid);
    return { solid, soft: `hsla(${m ? m[1] : 160}, 72%, 43%, 0.30)` };
  }

  _renderDots() {
    if (!this.dotsEl) return;
    // Свой голос — это кольцо вокруг микрофона; в ряду точек только остальные.
    const ids = this._visibleIds();
    this.dotsEl.hidden = ids.length === 0;
    // Панели нужно знать, чем начинается её группа: у точки нет собственного
    // «воздуха», и отступ до корпуса считается иначе, чем у кнопки.
    this.barEl?.classList.toggle('has-dots', ids.length > 0);
    this.dotsEl.textContent = '';
    // Ряд пересобирается целиком, поэтому старые ссылки на узлы недействительны:
    // индикатор речи пишет прямо в p.dot и без сброса красил бы отцепленные узлы.
    for (const p of this.peers.values()) p.dot = null;

    // На узком экране в тулбаре дорога каждая точка. Предел живёт ТОЛЬКО здесь:
    // когда его дублировали правилом nth-child в CSS, лишние точки исчезали
    // молча — счётчик «+N» считал по своему пределу и не появлялся вовсе.
    const LIMIT = (this.narrow ? this.narrow.matches
      : window.matchMedia && window.matchMedia('(max-width: 760px)').matches) ? 3 : 5;
    for (const id of ids.slice(0, LIMIT)) {
      const p = this.peers.get(id);
      const meta = this.roster.get(id) || { client: (p && p.base) || id, muted: !!(p && p.muted) };
      const dot = document.createElement('span');
      dot.className = 'voice-dot';
      const c = this._peerColor(meta.client || id);
      dot.style.setProperty('--peer', c.solid);
      dot.style.setProperty('--peer-soft', c.soft);
      if (meta.muted) dot.classList.add('muted');
      if (p && p.state === 'lost') dot.classList.add('lost');
      else if (!p || p.state === 'wait' || p.state === 'away') dot.classList.add('away');
      this.dotsEl.appendChild(dot);
      if (p) p.dot = dot;
    }
    if (ids.length > LIMIT) {
      const more = document.createElement('span');
      more.className = 'voice-more';
      more.textContent = `+${ids.length - LIMIT}`;
      this.dotsEl.appendChild(more);
    }
  }

  // ---------- отправка ----------

  _send(type, extra) { return this.network.sendVoice({ type, from: this.selfId, ...extra }); }
  _sendJoin() { return this._send('voiceJoin', { payload: { muted: this.muted } }); }
  _signal(to, payload) { return this._send('voiceSignal', { to, payload }); }
  _toast(msg) { this.network.showToast(msg); }

  _gumMessage(e) {
    switch (e && e.name) {
      case 'NotAllowedError':
      case 'SecurityError':        return 'Доступ к микрофону запрещён';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
      case 'OverconstrainedError': return 'Микрофон не найден';
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':           return 'Микрофон занят другим приложением';
      default:                     return 'Не удалось включить микрофон';
    }
  }
}
