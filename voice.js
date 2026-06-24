// voice.js — Голосовые звонки в реальном времени (WebRTC mesh) поверх уже
// существующего WebSocket. Сервер ретранслирует сообщения типа rtc-* всем
// участникам доски; адресность обеспечивается полем "to" (clientId получателя).
//
// Архитектура: полная сетка (mesh). Каждая пара участников держит прямое
// RTCPeerConnection, звук идёт P2P. WebSocket нужен только для сигналинга
// (обмен SDP и ICE-кандидатами). Это масштабируется на ~4–6 человек на доску;
// для больших комнат нужен SFU-сервер (здесь намеренно не используется).

// --- ICE-серверы ---------------------------------------------------------
// STUN помогает узнать «внешний» адрес за NAT. Публичных STUN от Google
// хватает для большинства домашних сетей. Для «жёстких» (симметричных) NAT и
// корпоративных файрволов нужен TURN-релей — раскомментируйте и подставьте свои
// данные (например, бесплатный аккаунт на metered.ca или собственный coturn):
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // { urls: 'turn:turn.example.com:3478', username: 'USER', credential: 'PASS' },
];

const RTC_CONFIG = { iceServers: ICE_SERVERS };

// Порог громкости (RMS, 0..1) для индикатора «говорит».
const SPEAK_THRESHOLD = 0.045;

export class VoiceManager {
  constructor(storage, network) {
    this.storage = storage;
    this.network = network;
    this.myId = storage.clientId;

    this.inCall = false;
    this.muted = false;
    this.localStream = null;
    this.localSpeaking = false;

    // peerId -> { pc, audioEl, candidates:[], analyser, buf, speaking }
    this.peers = new Map();

    // WebAudio (индикатор речи)
    this.audioCtx = null;
    this._localAnalyser = null;
    this._localBuf = null;
    this._meterRAF = null;

    // DOM
    this.callBtn = null;
    this.muteBtn = null;
    this.panel = null;
    this.rosterEl = null;
    this.sink = null;

    // Слушаем входящие сообщения и переподключения сокета
    this.network.onMessage((msg) => this.handleSignal(msg));
    this.network.onOpen(() => this.onSocketOpen());
  }

  // ======================= UI =======================
  initUI() {
    this.callBtn  = document.getElementById('callBtn');
    this.muteBtn  = document.getElementById('muteBtn');
    this.panel    = document.getElementById('voicePanel');
    this.rosterEl = document.getElementById('voiceRoster');
    this.sink     = document.getElementById('audioSink');

    if (this.callBtn) this.callBtn.addEventListener('click', () => this.toggleCall());
    if (this.muteBtn) this.muteBtn.addEventListener('click', () => this.toggleMute());

    // Best-effort выход из звонка при закрытии вкладки
    window.addEventListener('pagehide', () => {
      if (this.inCall) this.signal('rtc-leave', null, {});
    });

    this.updateUI();
  }

  toggleCall() {
    if (this.inCall) this.leaveCall();
    else this.joinCall();
  }

  async joinCall() {
    if (this.inCall) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.network.showToast('Микрофон недоступен (нужен HTTPS)');
      return;
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (e) {
      console.error('getUserMedia failed:', e);
      this.network.showToast('Нет доступа к микрофону');
      return;
    }

    this.inCall = true;
    this.muted = false;

    // AudioContext создаём из обработчика клика — этого требует autoplay-политика
    this.ensureAudioCtx();
    this.attachLocalMeter();
    this.startMeterLoop();
    this.updateUI();

    // Объявляем о входе: действующие участники откликнутся rtc-hello
    this.signal('rtc-join', null, {});
    this.network.showToast('Вы в звонке');
  }

  leaveCall() {
    if (!this.inCall) return;

    this.signal('rtc-leave', null, {});
    for (const pid of Array.from(this.peers.keys())) this.removePeer(pid);

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this._localAnalyser = null;
    this.localSpeaking = false;
    this.inCall = false;
    this.muted = false;
    this.stopMeterLoop();
    this.updateUI();
    this.network.showToast('Звонок завершён');
  }

  toggleMute() {
    if (!this.inCall || !this.localStream) return;
    this.muted = !this.muted;
    this.localStream.getAudioTracks().forEach(t => (t.enabled = !this.muted));
    this.updateUI();
  }

  // ==================== Сигналинг ====================
  signal(type, to, payload) {
    // network.send добавит client=this.myId. to — адресат (или null для broadcast).
    this.network.send({ type, to: to || null, payload: payload || {} });
  }

  onSocketOpen() {
    // При переподключении сокета пересобираем соединения заново
    if (!this.inCall) return;
    for (const pid of Array.from(this.peers.keys())) this.removePeer(pid);
    this.signal('rtc-join', null, {});
  }

  handleSignal(msg) {
    const type = msg.type;
    if (!type || type.indexOf('rtc-') !== 0) return;

    const from = msg.client;            // отправитель
    if (from === this.myId) return;     // собственные сообщения игнорируем
    if (msg.to && msg.to !== this.myId) return;  // адресные — только своему получателю

    const payload = msg.payload || {};

    switch (type) {
      case 'rtc-join':
        // Новый участник вошёл. Если я тоже в звонке — здороваюсь и соединяюсь.
        if (!this.inCall) return;
        this.signal('rtc-hello', from, {});
        this.ensurePeer(from, true);
        break;

      case 'rtc-hello':
        // Ответ действующего участника на мой вход
        if (!this.inCall) return;
        this.ensurePeer(from, true);
        break;

      case 'rtc-offer':
        if (!this.inCall) return;
        this.handleOffer(from, payload.sdp);
        break;

      case 'rtc-answer':
        this.handleAnswer(from, payload.sdp);
        break;

      case 'rtc-ice':
        this.handleIce(from, payload.candidate);
        break;

      case 'rtc-leave':
        this.removePeer(from);
        this.updateUI();
        break;
    }
  }

  // ===================== WebRTC =====================
  // Детерминированный выбор инициатора устраняет «glare» (одновременные офферы):
  // оффер всегда делает участник с БОЛЬШИМ clientId, второй ждёт.
  isInitiator(peerId) {
    return this.myId > peerId;
  }

  ensurePeer(peerId, initiateIfNeeded) {
    let p = this.peers.get(peerId);
    if (p) return p;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    p = { pc, audioEl: null, candidates: [], analyser: null, buf: null, speaking: false };
    this.peers.set(peerId, p);

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signal('rtc-ice', peerId, { candidate: ev.candidate });
    };

    pc.ontrack = (ev) => {
      this.attachRemoteAudio(peerId, ev.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') {
        this.removePeer(peerId);
      } else if (st === 'disconnected') {
        // Даём соединению шанс восстановиться, иначе чистим
        setTimeout(() => {
          const cur = this.peers.get(peerId);
          if (cur && cur.pc.connectionState === 'disconnected') this.removePeer(peerId);
          this.updateUI();
        }, 6000);
      }
      this.updateUI();
    };

    if (initiateIfNeeded && this.isInitiator(peerId)) this.makeOffer(peerId);

    this.updateUI();
    return p;
  }

  async makeOffer(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    try {
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      this.signal('rtc-offer', peerId, { sdp: p.pc.localDescription });
    } catch (e) {
      console.error('makeOffer error:', e);
    }
  }

  async handleOffer(peerId, sdp) {
    // Я — неинициатор (оффер приходит только от пира с большим id)
    const p = this.ensurePeer(peerId, false);
    try {
      await p.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await this.flushCandidates(peerId);
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      this.signal('rtc-answer', peerId, { sdp: p.pc.localDescription });
    } catch (e) {
      console.error('handleOffer error:', e);
    }
  }

  async handleAnswer(peerId, sdp) {
    const p = this.peers.get(peerId);
    if (!p) return;
    try {
      await p.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await this.flushCandidates(peerId);
    } catch (e) {
      console.error('handleAnswer error:', e);
    }
  }

  async handleIce(peerId, candidate) {
    const p = this.peers.get(peerId);
    if (!p || !candidate) return;
    try {
      if (p.pc.remoteDescription && p.pc.remoteDescription.type) {
        await p.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        p.candidates.push(candidate); // буфер до установки remoteDescription
      }
    } catch (e) {
      console.error('addIceCandidate error:', e);
    }
  }

  async flushCandidates(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    while (p.candidates.length) {
      const c = p.candidates.shift();
      try { await p.pc.addIceCandidate(new RTCIceCandidate(c)); }
      catch (e) { console.error('flush ice error:', e); }
    }
  }

  removePeer(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    try {
      p.pc.ontrack = null;
      p.pc.onicecandidate = null;
      p.pc.onconnectionstatechange = null;
      p.pc.close();
    } catch (_) {}
    if (p.audioEl) {
      try { p.audioEl.srcObject = null; p.audioEl.remove(); } catch (_) {}
    }
    this.peers.delete(peerId);
  }

  attachRemoteAudio(peerId, stream) {
    const p = this.peers.get(peerId);
    if (!p || !stream) return;

    let el = p.audioEl;
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      el.dataset.peer = peerId;
      this.sink.appendChild(el);
      p.audioEl = el;
    }
    el.srcObject = stream;
    el.play().catch(() => {}); // autoplay уже разрешён жестом «войти в звонок»

    this.attachMeter(p, stream);
    this.updateUI();
  }

  // =============== Индикатор речи (WebAudio) ===============
  ensureAudioCtx() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
  }

  _makeAnalyser(stream) {
    // Источник -> анализатор. К destination НЕ подключаем: звук воспроизводит
    // <audio>, а анализатор только измеряет уровень (иначе было бы эхо).
    const src = this.audioCtx.createMediaStreamSource(stream);
    const an = this.audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    return an;
  }

  attachMeter(p, stream) {
    try {
      this.ensureAudioCtx();
      p.analyser = this._makeAnalyser(stream);
      p.buf = new Uint8Array(p.analyser.fftSize);
    } catch (_) { /* индикатор необязателен */ }
  }

  attachLocalMeter() {
    try {
      this.ensureAudioCtx();
      this._localAnalyser = this._makeAnalyser(this.localStream);
      this._localBuf = new Uint8Array(this._localAnalyser.fftSize);
    } catch (_) {}
  }

  _rms(analyser, buf) {
    if (!analyser || !buf) return 0;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  startMeterLoop() {
    if (this._meterRAF) return;
    const tick = () => {
      let changed = false;

      const lr = this.muted ? 0 : this._rms(this._localAnalyser, this._localBuf);
      const ls = lr > SPEAK_THRESHOLD;
      if (ls !== this.localSpeaking) { this.localSpeaking = ls; changed = true; }

      for (const [, p] of this.peers) {
        const sp = this._rms(p.analyser, p.buf) > SPEAK_THRESHOLD;
        if (sp !== p.speaking) { p.speaking = sp; changed = true; }
      }

      if (changed) this.renderRoster();
      this._meterRAF = requestAnimationFrame(tick);
    };
    this._meterRAF = requestAnimationFrame(tick);
  }

  stopMeterLoop() {
    if (this._meterRAF) { cancelAnimationFrame(this._meterRAF); this._meterRAF = null; }
  }

  // ==================== Рендер UI ====================
  updateUI() {
    if (this.callBtn) {
      this.callBtn.classList.toggle('active', this.inCall);
      this.callBtn.setAttribute('data-count', String(1 + this.peers.size));
    }
    if (this.muteBtn) {
      this.muteBtn.classList.toggle('hidden', !this.inCall);
      this.muteBtn.classList.toggle('muted', this.muted);
      this.muteBtn.title = this.muted ? 'Включить микрофон' : 'Выключить микрофон';
    }
    if (this.panel) this.panel.classList.toggle('hidden', !this.inCall);
    this.renderRoster();
  }

  _short(id) { return (id || '').slice(0, 4); }

  _color(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 65% 52%)`;
  }

  renderRoster() {
    if (!this.rosterEl) return;
    if (!this.inCall) { this.rosterEl.innerHTML = ''; return; }

    const rows = [];
    rows.push(this._row('Вы', this.myId, this.localSpeaking, this.muted, true));

    for (const [pid, p] of this.peers) {
      const st = p.pc.connectionState;
      const connected = (st === 'connected' || st === 'completed');
      rows.push(this._row('Участник', pid, p.speaking, false, connected));
    }
    this.rosterEl.innerHTML = rows.join('');
  }

  _row(label, id, speaking, muted, connected) {
    const col = this._color(id);
    const dotCls = speaking ? 'speaking' : '';
    const pendCls = connected ? '' : 'pending';
    const mutedMark = muted ? '<span class="vp-mute">🔇</span>' : '';
    return (
      `<div class="vp-item ${pendCls}">` +
        `<span class="vp-dot ${dotCls}" style="--c:${col}"></span>` +
        `<span class="vp-name">${label} <em>${this._short(id)}</em></span>` +
        mutedMark +
      `</div>`
    );
  }
}
