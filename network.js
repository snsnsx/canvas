const EPHEMERAL_TYPES = new Set(['cursorMove', 'cursorLeave']);

export class NetworkManager {
  constructor(storage, onMessageReceived, onRemoteFocus) {
    this.storage = storage;
    this.onMessageReceived = onMessageReceived; // callback to trigger rerender
    this.onRemoteFocus = onRemoteFocus;
    this.onRemoteCursor = null;

    this.socket = null;
    this.reconnectTimer = null;

    // Buffering variables for outgoing strokes
    this.bufferInterval = null;
    this.bufferedPoints = [];
    this.currentStrokeId = null;

    // Toast element for network status
    this.toastEl = document.getElementById('toast');

    // Счётчик участников онлайн (обновляется сообщениями presence от сервера)
    this.presenceEl = document.getElementById('userCount');

    // Дебаунс резервной записи в localStorage (см. _scheduleLocalSave)
    this._saveTimer = null;

    this.activeClientId = null;
    this.activeStrokeId = null;
    this.focusPausedUntil = 0;
    this.remoteWritingClients = new Set();
    this.remoteStrokeLastPoint = new Map();
    this.remoteCursorTimers = new Map();
    this.remoteCursorResumeAt = new Map();
    this.lastCursorSentAt = 0;
    this.lastCursorPoint = null;
  }

  showToast(msg) {
    if (!this.toastEl) return;
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2000);
  }

  updatePresence(count) {
    const n = Math.max(0, count | 0);
    if (this.presenceEl) this.presenceEl.textContent = String(n);
  }

  pauseAutoFocus(ms = 3500) {
    this.focusPausedUntil = Math.max(this.focusPausedUntil, Date.now() + ms);
  }

  focusRemotePoint(point, clientId, strokeId) {
    if (!this.onRemoteFocus || !point) return;
    if (Date.now() < this.focusPausedUntil) return;

    this.activeClientId = clientId || null;
    this.activeStrokeId = strokeId || null;
    this.onRemoteFocus(point);
  }

  async init() {
    // 1. First load the initial board state via REST
    await this.loadInitialState();

    // 2. Open the WebSocket connection
    this.connectWebSocket();
  }

  async loadInitialState() {
    let ok = false;
    try {
      const r = await fetch(`api/board/${encodeURIComponent(this.storage.boardId)}`);
      if (r.ok) {
        const text = await r.text();
        if (text && text.trim() && text.trim() !== '{}') {
          ok = this.storage.deserialize(text);
        }
      }
    } catch (e) {
      console.warn("Failed to load state from server, falling back to local storage:", e);
    }

    if (!ok) {
      const ls = localStorage.getItem(this.storage.LS_KEY);
      if (ls) {
        this.storage.deserialize(ls);
      }
    }

    this.onMessageReceived();
  }

  connectWebSocket() {
    if (this.socket) {
      try { this.socket.close(); } catch(_) {}
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/${encodeURIComponent(this.storage.boardId)}`;

    console.log("Connecting to WS:", wsUrl);
    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      console.log("WebSocket connected.");
      this.showToast("Соединение установлено");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // On reconnect, catch up state to ensure we are 100% in sync
      this.loadInitialState();
    };

    this.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.client === this.storage.clientId) {
          // Ignore own messages as they are applied locally immediately
          return;
        }
        this.handleRemoteMessage(msg);
      } catch (err) {
        console.error("Error processing incoming WS message:", err);
      }
    };

    this.socket.onclose = (event) => {
      console.warn("WebSocket closed. Reconnecting in 3s...", event.reason);
      this.showToast("Соединение разорвано. Переподключение...");
      this.scheduleReconnect();
    };

    this.socket.onerror = (err) => {
      console.error("WebSocket error:", err);
      this.socket.close();
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 3000);
  }

  send(msg) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const envelope = {
        board: this.storage.boardId,
        client: this.storage.clientId,
        timestamp: Date.now(),
        ...msg
      };
      this.socket.send(JSON.stringify(envelope));
    } else {
      // Local backup if server offline (сериализация отложена и коалесится)
      this.storage.dirty = true;
      this._scheduleLocalSave();
    }
  }

  sendEphemeral(msg) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      board: this.storage.boardId,
      client: this.storage.clientId,
      timestamp: Date.now(),
      ...msg
    }));
  }

  sendCursor(point) {
    if (this.currentStrokeId || !point) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

    const now = Date.now();
    const last = this.lastCursorPoint;
    if (last && now - this.lastCursorSentAt < 60) {
      const moved = Math.hypot(point.x - last.x, point.y - last.y);
      if (moved < 4) return;
    }

    this.lastCursorSentAt = now;
    this.lastCursorPoint = { x: point.x, y: point.y };
    this.sendEphemeral({
      type: 'cursorMove',
      payload: { x: point.x, y: point.y, page: this.storage.currentPageId }
    });
  }

  sendCursorLeave() {
    this.lastCursorPoint = null;
    this.sendEphemeral({ type: 'cursorLeave', payload: {} });
  }

  setRemoteCursor(clientId, point) {
    if (this.onRemoteCursor) this.onRemoteCursor(clientId, point);
  }

  clearRemoteCursorDelay(clientId) {
    const timer = this.remoteCursorTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.remoteCursorTimers.delete(clientId);
    this.remoteCursorResumeAt.delete(clientId);
  }

  scheduleRemoteCursor(clientId, point, delay = 450) {
    if (!clientId || !point) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

    const showAt = Date.now() + delay;
    this.remoteCursorResumeAt.set(clientId, showAt);
    this.remoteStrokeLastPoint.set(clientId, point);

    const oldTimer = this.remoteCursorTimers.get(clientId);
    if (oldTimer) clearTimeout(oldTimer);

    const timer = setTimeout(() => {
      this.remoteCursorTimers.delete(clientId);
      this.remoteCursorResumeAt.delete(clientId);
      if (!this.remoteWritingClients.has(clientId)) {
        this.setRemoteCursor(clientId, this.remoteStrokeLastPoint.get(clientId) || point);
      }
    }, delay);
    this.remoteCursorTimers.set(clientId, timer);
  }

  // Резервное сохранение в localStorage с дебаунсом: убирает синхронную
  // сериализацию всей доски на каждый исходящий пакет (например, точки штриха).
  _scheduleLocalSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        localStorage.setItem(this.storage.LS_KEY, this.storage.serialize());
      } catch (_) {}
    }, 400);
  }

  // --- Buffering outgoing points (30-60 FPS) ---

  startStroke(strokeId, tool, color, size, startPoint, page) {
    this.currentStrokeId = strokeId;
    this.bufferedPoints = [this.encodePoint(startPoint)];
    this.lastCursorPoint = null;

    // Broadcast immediately the beginStroke event
    this.send({
      type: 'beginStroke',
      payload: {
        strokeId: strokeId,
        page: page,
        tool: tool,
        color: color,
        size: size,
        points: [this.encodePoint(startPoint)]
      }
    });

    // Start interval to send points (every 24ms, ~40fps)
    this.bufferInterval = setInterval(() => {
      this.flushBufferedPoints();
    }, 24);
  }

  bufferPoint(point) {
    this.bufferedPoints.push(this.encodePoint(point));
  }

  encodePoint(point) {
    const pressure = point.pressure ?? point.p;
    if (Number.isFinite(pressure)) return [point.x, point.y, pressure];
    return [point.x, point.y];
  }

  decodePoint(point) {
    if (Array.isArray(point)) {
      const decoded = { x: point[0], y: point[1] };
      if (Number.isFinite(point[2])) decoded.pressure = point[2];
      return decoded;
    }
    return point;
  }

  flushBufferedPoints() {
    if (this.bufferedPoints.length > 0 && this.currentStrokeId) {
      this.send({
        type: 'appendPoints',
        payload: {
          strokeId: this.currentStrokeId,
          points: this.bufferedPoints
        }
      });
      this.bufferedPoints = [];
    }
  }

  endStroke() {
    if (this.bufferInterval) {
      clearInterval(this.bufferInterval);
      this.bufferInterval = null;
    }
    this.flushBufferedPoints();
    if (this.currentStrokeId) {
      this.send({
        type: 'endStroke',
        payload: {
          strokeId: this.currentStrokeId
        }
      });
    }
    this.currentStrokeId = null;

    // Резервная копия доски в localStorage (отложенно, вне горячего пути)
    this._scheduleLocalSave();
  }

  // --- Handling Remote Operations ---

  handleRemoteMessage(msg) {
    if (EPHEMERAL_TYPES.has(msg.type)) {
      if (msg.type === 'cursorMove' && !this.remoteWritingClients.has(msg.client)) {
        const payload = msg.payload || {};
        // Курсор с другой страницы не показываем на текущей.
        if (payload.page && payload.page !== this.storage.currentPageId) {
          this.clearRemoteCursorDelay(msg.client);
          this.setRemoteCursor(msg.client, null);
          return;
        }
        const point = {
          x: Number(payload.x),
          y: Number(payload.y)
        };
        const resumeAt = this.remoteCursorResumeAt.get(msg.client) || 0;
        if (Date.now() < resumeAt) {
          this.scheduleRemoteCursor(msg.client, point, resumeAt - Date.now());
        } else {
          this.setRemoteCursor(msg.client, point);
        }
      } else if (msg.type === 'cursorLeave') {
        this.clearRemoteCursorDelay(msg.client);
        this.setRemoteCursor(msg.client, null);
      }
      return;
    }

    switch (msg.type) {
      case 'beginStroke': {
        const payload = msg.payload;
        const pts = (payload.points || []).map(p => this.decodePoint(p));
        this.clearRemoteCursorDelay(msg.client);
        this.remoteWritingClients.add(msg.client);
        this.setRemoteCursor(msg.client, null);
        const stroke = {
          id: payload.strokeId,
          page: payload.page || this.storage.currentPageId,
          tool: payload.tool,
          color: payload.color,
          size: payload.size,
          points: pts
        };
        this.storage.ensurePage(stroke.page);
        this.storage.computeBBox(stroke);
        this.storage.strokes.push(stroke);
        this.storage.extendBottom(stroke);
        const lastPt = pts[pts.length - 1];
        if (lastPt) this.remoteStrokeLastPoint.set(msg.client, lastPt);
        // Автопрокрутка к чужому штриху — только если он на нашей странице.
        if (stroke.page === this.storage.currentPageId) {
          this.focusRemotePoint(lastPt, msg.client, payload.strokeId);
        }
        break;
      }
      case 'appendPoints': {
        const payload = msg.payload;
        const stroke = this.storage.strokes.find(s => s.id === payload.strokeId);
        if (stroke) {
          const newPts = payload.points.map(p => this.decodePoint(p));
          this.clearRemoteCursorDelay(msg.client);
          this.remoteWritingClients.add(msg.client);
          this.setRemoteCursor(msg.client, null);
          stroke.points.push(...newPts);
          // Обновляем bbox и границу только по новым точкам, а не по всему штриху.
          this.storage.extendBBox(stroke, newPts);
          this.storage.extendBottomPoints(newPts);
          const lastPt = newPts[newPts.length - 1];
          if (lastPt) this.remoteStrokeLastPoint.set(msg.client, lastPt);
          if (stroke.page === this.storage.currentPageId) {
            this.focusRemotePoint(lastPt, msg.client, payload.strokeId);
          }
        }
        break;
      }
      case 'endStroke': {
        // Stroke complete. Bounding boxes already handled.
        const payload = msg.payload;
        if (payload && payload.strokeId === this.activeStrokeId) {
          this.activeClientId = null;
          this.activeStrokeId = null;
        }
        this.remoteWritingClients.delete(msg.client);
        this.scheduleRemoteCursor(msg.client, this.remoteStrokeLastPoint.get(msg.client) || null);
        break;
      }
      case 'deleteObject': {
        const id = msg.payload.objectId;
        const sIdx = this.storage.strokes.findIndex(s => s.id === id);
        if (sIdx >= 0) {
          this.storage.strokes.splice(sIdx, 1);
        } else {
          const iIdx = this.storage.images.findIndex(im => im.id === id);
          if (iIdx >= 0) {
            this.storage.images.splice(iIdx, 1);
          }
        }
        this.storage.selection = null;
        this.storage.recomputeContentBottom();
        break;
      }
      case 'restoreObject': {
        const id = msg.payload.objectId;
        const data = msg.payload.data;
        if (data.type === 'stroke') {
          // Ensure we don't have duplicates
          const idx = this.storage.strokes.findIndex(s => s.id === id);
          const strokeObj = {
            id: id,
            page: data.page || this.storage.currentPageId,
            tool: data.tool,
            color: data.color,
            size: data.size,
            points: data.points
          };
          this.storage.ensurePage(strokeObj.page);
          this.storage.computeBBox(strokeObj);
          if (idx >= 0) {
            this.storage.strokes[idx] = strokeObj;
          } else {
            this.storage.strokes.push(strokeObj);
          }
        } else if (data.type === 'image') {
          const idx = this.storage.images.findIndex(im => im.id === id);
          const img = {
            id: id,
            page: data.page || this.storage.currentPageId,
            src: data.src,
            x: data.x,
            y: data.y,
            w: data.w,
            h: data.h,
            img: new Image()
          };
          this.storage.ensurePage(img.page);
          img.img.onload = () => this.onMessageReceived();
          img.img.src = data.src;
          if (idx >= 0) {
            this.storage.images[idx] = img;
          } else {
            this.storage.images.push(img);
          }
        }
        this.storage.selection = null;
        this.storage.recomputeContentBottom();
        break;
      }
      case 'moveObject': {
        const payload = msg.payload;
        const img = this.storage.images.find(im => im.id === payload.objectId);
        if (img) {
          img.x = payload.x;
          img.y = payload.y;
          if (payload.w) img.w = payload.w;
          if (payload.h) img.h = payload.h;
          this.storage.recomputeContentBottom();
        }
        break;
      }
      case 'addImage': {
        const payload = msg.payload;
        const img = {
          id: payload.imageId,
          page: payload.page || this.storage.currentPageId,
          src: payload.src,
          x: payload.x,
          y: payload.y,
          w: payload.w,
          h: payload.h,
          img: new Image()
        };
        this.storage.ensurePage(img.page);
        img.img.onload = () => this.onMessageReceived();
        img.img.src = payload.src;
        this.storage.images.push(img);
        this.storage.extendBottom(img);
        break;
      }
      case 'changeGrid': {
        this.storage.gridType = msg.payload.grid;
        window.dispatchEvent(new CustomEvent('gridChanged'));
        break;
      }
      case 'addPage': {
        this.storage.insertPageAfter(msg.payload.afterId, msg.payload.pageId);
        window.dispatchEvent(new CustomEvent('pagesChanged'));
        break;
      }
      case 'deletePage': {
        const removed = this.storage.removePage(msg.payload.pageId);
        if (removed) {
          this.storage.selection = null;
          this.storage.selected = null;
          window.dispatchEvent(new CustomEvent('pagesChanged'));
        }
        break;
      }
      case 'clearBoard': {
        this.storage.strokes = [];
        this.storage.images = [];
        this.storage.selected = null;
        this.storage.selection = null;
        this.storage.contentBottom = 0;
        this.storage.cameraY = 0;
        break;
      }
      case 'undo': {
        if (msg.payload && msg.payload.inverseOp) {
          this.handleRemoteMessage(msg.payload.inverseOp);
        }
        break;
      }
      case 'redo': {
        if (msg.payload && msg.payload.op) {
          this.handleRemoteMessage(msg.payload.op);
        }
        break;
      }
      case 'presence': {
        // Только обновляем счётчик участников — перерисовка холста не нужна.
        this.updatePresence(msg.count);
        return;
      }
    }

    // Trigger canvas repaint
    this.onMessageReceived();
  }
}
