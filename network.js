export class NetworkManager {
  constructor(storage, onMessageReceived) {
    this.storage = storage;
    this.onMessageReceived = onMessageReceived; // callback to trigger rerender

    this.socket = null;
    this.reconnectTimer = null;

    // Buffering variables for outgoing strokes
    this.bufferInterval = null;
    this.bufferedPoints = [];
    this.currentStrokeId = null;

    // Toast element for network status
    this.toastEl = document.getElementById('toast');

    // Внешние слушатели (например, голосовая связь) на входящие сообщения
    // и на (пере)открытие сокета.
    this.messageListeners = [];
    this.openListeners = [];
  }

  showToast(msg) {
    if (!this.toastEl) return;
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2000);
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
      this.openListeners.forEach(fn => { try { fn(); } catch (e) { console.error('open listener:', e); } });
    };

    this.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.client === this.storage.clientId) {
          // Ignore own messages as they are applied locally immediately
          return;
        }
        this.handleRemoteMessage(msg);
        this.messageListeners.forEach(fn => { try { fn(msg); } catch (e) { console.error('msg listener:', e); } });
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

  // Подписки для внешних модулей (например, голосовой связи)
  onMessage(fn) { if (typeof fn === 'function') this.messageListeners.push(fn); }
  onOpen(fn) { if (typeof fn === 'function') this.openListeners.push(fn); }

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
      // Local backup if server offline
      this.storage.dirty = true;
      try {
        localStorage.setItem(this.storage.LS_KEY, this.storage.serialize());
      } catch(_) {}
    }
  }

  // --- Buffering outgoing points (30-60 FPS) ---

  startStroke(strokeId, tool, color, size, startPoint) {
    this.currentStrokeId = strokeId;
    this.bufferedPoints = [[startPoint.x, startPoint.y]];

    // Broadcast immediately the beginStroke event
    this.send({
      type: 'beginStroke',
      payload: {
        strokeId: strokeId,
        tool: tool,
        color: color,
        size: size,
        points: [[startPoint.x, startPoint.y]]
      }
    });

    // Start interval to send points (every 24ms, ~40fps)
    this.bufferInterval = setInterval(() => {
      this.flushBufferedPoints();
    }, 24);
  }

  bufferPoint(point) {
    this.bufferedPoints.push([point.x, point.y]);
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

    // Save state in local storage too
    try {
      localStorage.setItem(this.storage.LS_KEY, this.storage.serialize());
    } catch(_) {}
  }

  // --- Handling Remote Operations ---

  handleRemoteMessage(msg) {
    // Сигналинг WebRTC обрабатывается голосовым модулем и на доску не влияет.
    if (msg.type && msg.type.indexOf('rtc-') === 0) return;
    switch (msg.type) {
      case 'beginStroke': {
        const payload = msg.payload;
        const pts = (payload.points || []).map(p => ({ x: p[0], y: p[1] }));
        const stroke = {
          id: payload.strokeId,
          tool: payload.tool,
          color: payload.color,
          size: payload.size,
          points: pts
        };
        this.storage.computeBBox(stroke);
        this.storage.strokes.push(stroke);
        break;
      }
      case 'appendPoints': {
        const payload = msg.payload;
        const stroke = this.storage.strokes.find(s => s.id === payload.strokeId);
        if (stroke) {
          const newPts = payload.points.map(p => ({ x: p[0], y: p[1] }));
          stroke.points.push(...newPts);
          this.storage.computeBBox(stroke);
          this.storage.extendRight(stroke);
        }
        break;
      }
      case 'endStroke': {
        // Stroke complete. Bounding boxes already handled.
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
        this.storage.recomputeContentRight();
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
            tool: data.tool,
            color: data.color,
            size: data.size,
            points: data.points
          };
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
            src: data.src,
            x: data.x,
            y: data.y,
            w: data.w,
            h: data.h,
            img: new Image()
          };
          img.img.onload = () => this.onMessageReceived();
          img.img.src = data.src;
          if (idx >= 0) {
            this.storage.images[idx] = img;
          } else {
            this.storage.images.push(img);
          }
        }
        this.storage.recomputeContentRight();
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
          this.storage.recomputeContentRight();
        }
        break;
      }
      case 'addImage': {
        const payload = msg.payload;
        const img = {
          id: payload.imageId,
          src: payload.src,
          x: payload.x,
          y: payload.y,
          w: payload.w,
          h: payload.h,
          img: new Image()
        };
        img.img.onload = () => this.onMessageReceived();
        img.img.src = payload.src;
        this.storage.images.push(img);
        this.storage.extendRight(img);
        break;
      }
      case 'changeGrid': {
        this.storage.gridType = msg.payload.grid;
        break;
      }
      case 'clearBoard': {
        this.storage.strokes = [];
        this.storage.images = [];
        this.storage.selected = null;
        this.storage.contentRight = 0;
        this.storage.cameraX = 0;
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
    }

    // Trigger canvas repaint
    this.onMessageReceived();
  }
}