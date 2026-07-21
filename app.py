"""
Лёгкий бэкенд доски для запуска в Google Colab на FastAPI.
Поддерживает WebSocket-синхронизацию в реальном времени и REST API.
"""

import os
import re
import json
import asyncio
from typing import Dict, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

BASE = os.getcwd() # Fix: Use os.getcwd() instead of __file__ for Colab environment
INDEX = os.path.join(BASE, "index.html")
BOARDS = os.path.join(BASE, "boards")
os.makedirs(BOARDS, exist_ok=True)

# Имя доски: латиница/цифры/подчёркивание/дефис, до 64 символов.
SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
EPHEMERAL_WS_TYPES = {"cursorMove", "cursorLeave"}
DEFAULT_PAGE_ID = "page-1"   # id первой/легаси-страницы (совпадает с фронтендом)

app = FastAPI()

# Разрешаем CORS для работы с ngrok и Colab
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class BoardState:
    def __init__(self, board_id: str):
        self.board_id = board_id
        self.v = 1
        self.grid = "none"
        self.pages = [DEFAULT_PAGE_ID]   # упорядоченный список id страниц
        self.contentBottom = 0.0
        self.penColors = ["#1f1f42", "#dc2626", "#14992f"]
        self.hlColors = ["#fde047", "#7f46a4"]
        self.objects = {}  # UUID -> dict (stroke or image)
        self.version = 0

    def load_from_dict(self, data: dict):
        self.v = data.get("v", 1)
        self.grid = data.get("grid", "grid")
        self.contentBottom = float(data.get("contentBottom", 0.0))
        self.penColors = data.get("penColors", ["#1f1f42", "#dc2626", "#14992f"])
        self.hlColors = data.get("hlColors", ["#fde047", "#7f46a4"])
        self.version = int(data.get("version", self.version))

        # Список страниц. Легаси-доски (без pages) сводятся к одной странице.
        pages = [p for p in data.get("pages", []) if isinstance(p, str) and p]
        self.pages = pages if pages else [DEFAULT_PAGE_ID]

        self.objects = {}

        # Load legacy strokes
        strokes = data.get("strokes", [])
        for s in strokes:
            sid = s.get("id") or s.get("strokeId")
            if not sid:
                import uuid
                sid = str(uuid.uuid4())
            self.objects[sid] = {
                "id": sid,
                "type": "stroke",
                "page": s.get("page", DEFAULT_PAGE_ID),
                "tool": s.get("tool", "pen"),
                "color": s.get("color", "#000000"),
                "size": float(s.get("size", 2)),
                "points": [self._decode_point(p) for p in s.get("points", [])]
            }
            self._ensure_page(self.objects[sid]["page"])

        # Load legacy images
        images = data.get("images", [])
        for im in images:
            iid = im.get("id") or im.get("imageId")
            if not iid:
                import uuid
                iid = str(uuid.uuid4())
            self.objects[iid] = {
                "id": iid,
                "type": "image",
                "page": im.get("page", DEFAULT_PAGE_ID),
                "src": im.get("src", ""),
                "x": float(im.get("x", 0)),
                "y": float(im.get("y", 0)),
                "w": float(im.get("w", 100)),
                "h": float(im.get("h", 100))
            }
            self._ensure_page(self.objects[iid]["page"])

        # Пересчёт по фактическим объектам: чинит старые доски и вертикальную границу.
        self.recompute_content_bottom()

    def to_dict(self) -> dict:
        strokes_list = []
        images_list = []
        for obj in self.objects.values():
            if obj["type"] == "stroke":
                strokes_list.append({
                    "id": obj["id"],
                    "page": obj.get("page", DEFAULT_PAGE_ID),
                    "tool": obj["tool"],
                    "color": obj["color"],
                    "size": obj["size"],
                    "points": obj["points"]
                })
            elif obj["type"] == "image":
                images_list.append({
                    "id": obj["id"],
                    "page": obj.get("page", DEFAULT_PAGE_ID),
                    "src": obj["src"],
                    "x": obj["x"],
                    "y": obj["y"],
                    "w": obj["w"],
                    "h": obj["h"]
                })
        return {
            "v": self.v,
            "grid": self.grid,
            "pages": self.pages,
            "contentBottom": self.contentBottom,
            "penColors": self.penColors,
            "hlColors": self.hlColors,
            "strokes": strokes_list,
            "images": images_list,
            "version": self.version
        }

    @staticmethod
    def _point_y(p):
        return p["y"] if isinstance(p, dict) else p[1]

    @staticmethod
    def _decode_point(p):
        if isinstance(p, list):
            point = {"x": float(p[0]), "y": float(p[1])}
            if len(p) > 2:
                try:
                    pressure = float(p[2])
                except (TypeError, ValueError):
                    pressure = None
                if pressure is not None:
                    point["pressure"] = max(0.0, min(1.0, pressure))
            return point
        return p

    def _bump_bottom(self, y: float):
        if y > self.contentBottom:
            self.contentBottom = y

    def _bump_points(self, points, size: float = 0.0):
        # Рост границы только по переданным точкам — без обхода всего штриха.
        for p in points:
            y = self._point_y(p)
            if y + size > self.contentBottom:
                self.contentBottom = y + size

    def _bump_object(self, obj: dict):
        if obj.get("type") == "stroke":
            pts = obj.get("points", [])
            if pts:
                my = max(self._point_y(p) for p in pts)
                self._bump_bottom(my + obj.get("size", 0.0))
        elif obj.get("type") == "image":
            self._bump_bottom(obj.get("y", 0.0) + obj.get("h", 0.0))

    def _ensure_page(self, page_id: str):
        # Страница объекта могла прийти раньше сообщения addPage — добавим её.
        if page_id and page_id not in self.pages:
            self.pages.append(page_id)

    def apply_operation(self, op_type: str, payload: dict):
        # contentBottom обновляется по месту: операции роста только двигают границу
        # вниз, а полный пересчёт нужен лишь там, где содержимое может уменьшиться.
        if op_type == "beginStroke":
            sid = payload["strokeId"]
            obj = {
                "id": sid,
                "type": "stroke",
                "page": payload.get("page", DEFAULT_PAGE_ID),
                "tool": payload["tool"],
                "color": payload["color"],
                "size": float(payload["size"]),
                "points": [self._decode_point(p) for p in payload.get("points", [])]
            }
            self._ensure_page(obj["page"])
            self.objects[sid] = obj
            self._bump_object(obj)
        elif op_type == "appendPoints":
            sid = payload["strokeId"]
            obj = self.objects.get(sid)
            if obj is not None and obj.get("type") == "stroke":
                pts = [self._decode_point(p) for p in payload.get("points", [])]
                obj["points"].extend(pts)
                self._bump_points(pts, obj.get("size", 0.0))
        elif op_type == "endStroke":
            pass
        elif op_type == "deleteObject":
            oid = payload["objectId"]
            if oid in self.objects:
                del self.objects[oid]
                self.recompute_content_bottom()
        elif op_type == "restoreObject":
            oid = payload["objectId"]
            data = payload["data"]
            if "page" not in data:
                data["page"] = DEFAULT_PAGE_ID
            self._ensure_page(data["page"])
            self.objects[oid] = data
            self._bump_object(data)
        elif op_type == "moveObject":
            oid = payload["objectId"]
            if oid in self.objects:
                self.objects[oid]["x"] = float(payload["x"])
                self.objects[oid]["y"] = float(payload["y"])
                if "w" in payload:
                    self.objects[oid]["w"] = float(payload["w"])
                if "h" in payload:
                    self.objects[oid]["h"] = float(payload["h"])
                self.recompute_content_bottom()
        elif op_type == "addImage":
            iid = payload["imageId"]
            obj = {
                "id": iid,
                "type": "image",
                "page": payload.get("page", DEFAULT_PAGE_ID),
                "src": payload["src"],
                "x": float(payload["x"]),
                "y": float(payload["y"]),
                "w": float(payload["w"]),
                "h": float(payload["h"])
            }
            self._ensure_page(obj["page"])
            self.objects[iid] = obj
            self._bump_object(obj)
        elif op_type == "addPage":
            page_id = payload.get("pageId")
            after_id = payload.get("afterId")
            if page_id and page_id not in self.pages:
                if after_id in self.pages:
                    self.pages.insert(self.pages.index(after_id) + 1, page_id)
                else:
                    self.pages.append(page_id)
        elif op_type == "deletePage":
            page_id = payload.get("pageId")
            if page_id in self.pages and len(self.pages) > 1:
                self.pages.remove(page_id)
                self.objects = {
                    oid: obj for oid, obj in self.objects.items()
                    if obj.get("page", DEFAULT_PAGE_ID) != page_id
                }
                self.recompute_content_bottom()
        elif op_type == "changeGrid":
            self.grid = payload["grid"]
        elif op_type == "clearBoard":
            self.objects.clear()
            self.contentBottom = 0.0
        elif op_type == "undo":
            if "inverseOp" in payload:
                inner = payload["inverseOp"]
                self.apply_operation(inner["type"], inner["payload"])
        elif op_type == "redo":
            if "op" in payload:
                inner = payload["op"]
                self.apply_operation(inner["type"], inner["payload"])

    def recompute_content_bottom(self):
        m = 0.0
        for obj in self.objects.values():
            if obj["type"] == "stroke":
                points = obj.get("points", [])
                if points:
                    my = max(self._point_y(p) for p in points)
                    m = max(m, my + obj.get("size", 0.0))
            elif obj["type"] == "image":
                m = max(m, obj.get("y", 0.0) + obj.get("h", 0.0))
        self.contentBottom = m

class BoardManager:
    def __init__(self):
        self.boards: Dict[str, dict] = {}  # board_id -> { "clients": set, "state": BoardState, "save_task": Task }
        self.lock = asyncio.Lock()

    async def get_board(self, board_id: str) -> BoardState:
        async with self.lock:
            if board_id not in self.boards:
                state = BoardState(board_id)
                path = os.path.join(BOARDS, board_id + ".json")
                if os.path.exists(path):
                    try:
                        with open(path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                            state.load_from_dict(data)
                    except Exception as e:
                        print(f"Error loading board {board_id}: {e}")
                self.boards[board_id] = {
                    "clients": set(),
                    "state": state,
                    "save_task": None
                }
            return self.boards[board_id]["state"]

    async def connect(self, board_id: str, websocket: WebSocket):
        await websocket.accept()
        await self.get_board(board_id)
        async with self.lock:
            self.boards[board_id]["clients"].add(websocket)

    async def disconnect(self, board_id: str, websocket: WebSocket):
        async with self.lock:
            if board_id in self.boards:
                self.boards[board_id]["clients"].discard(websocket)
                # If no clients left, flush saving immediately
                if not self.boards[board_id]["clients"]:
                    if self.boards[board_id]["save_task"]:
                        self.boards[board_id]["save_task"].cancel()
                        self.boards[board_id]["save_task"] = None
                    await self.save_board_to_disk(board_id)

    async def broadcast(self, board_id: str, message: dict, exclude: WebSocket = None):
        async with self.lock:
            if board_id in self.boards:
                dead_sockets = set()
                for client in self.boards[board_id]["clients"]:
                    if client != exclude:
                        try:
                            await client.send_json(message)
                        except Exception:
                            dead_sockets.add(client)
                for ws in dead_sockets:
                    self.boards[board_id]["clients"].discard(ws)

    async def presence_count(self, board_id: str) -> int:
        # Число подключённых сокетов доски (прокси числа участников онлайн).
        async with self.lock:
            if board_id in self.boards:
                return len(self.boards[board_id]["clients"])
            return 0

    async def broadcast_presence(self, board_id: str):
        # Рассылаем актуальный счётчик участников всем клиентам доски
        # (включая отправителя — ему тоже нужно показать число).
        count = await self.presence_count(board_id)
        await self.broadcast(board_id, {"type": "presence", "count": count})

    async def schedule_save(self, board_id: str):
        async with self.lock:
            if board_id not in self.boards:
                return
            board = self.boards[board_id]
            if board["save_task"]:
                board["save_task"].cancel()

            async def debounced_save():
                try:
                    await asyncio.sleep(3.0)  # 3s debounce
                    await self.save_board_to_disk(board_id)
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"Error in save debounce for {board_id}: {e}")

            board["save_task"] = asyncio.create_task(debounced_save())

    async def save_board_to_disk(self, board_id: str):
        if board_id in self.boards:
            state = self.boards[board_id]["state"]
            path = os.path.join(BOARDS, board_id + ".json")
            try:
                # Write atomically using a temporary file name to avoid corruption
                temp_path = path + ".tmp"
                with open(temp_path, "w", encoding="utf-8") as f:
                    json.dump(state.to_dict(), f, ensure_ascii=False, indent=2)
                os.replace(temp_path, path)
            except Exception as e:
                print(f"Failed writing board {board_id} to disk: {e}")

board_manager = BoardManager()

# --- HTTP Static / Main Routes ---

# index.html и модули приложения отдаём с no-cache: браузер каждый раз проверяет
# ETag/mtime и подхватывает свежую версию после правок (без ручного сброса кэша).
# Без этого заголовка HTML попадает в эвристический кэш браузера и на одном origin
# (например, 127.0.0.1) может залипнуть старая разметка, тогда как на другом
# (localhost) уже свежая — из-за чего «новые» элементы там перестают работать.
NO_CACHE = {"Cache-Control": "no-cache"}
JS_HEADERS = NO_CACHE

@app.get("/")
async def index():
    return FileResponse(INDEX, headers=NO_CACHE)

@app.get("/storage.js")
async def get_storage():
    return FileResponse(os.path.join(BASE, "storage.js"), media_type="application/javascript", headers=JS_HEADERS)

@app.get("/history.js")
async def get_history():
    return FileResponse(os.path.join(BASE, "history.js"), media_type="application/javascript", headers=JS_HEADERS)

@app.get("/canvas.js")
async def get_canvas():
    return FileResponse(os.path.join(BASE, "canvas.js"), media_type="application/javascript", headers=JS_HEADERS)

@app.get("/network.js")
async def get_network():
    return FileResponse(os.path.join(BASE, "network.js"), media_type="application/javascript", headers=JS_HEADERS)

@app.get("/tools.js")
async def get_tools():
    return FileResponse(os.path.join(BASE, "tools.js"), media_type="application/javascript", headers=JS_HEADERS)

@app.get("/gsap.min.js")
async def get_gsap():
    return FileResponse(os.path.join(BASE, "gsap.min.js"), media_type="application/javascript")

# --- Иконки (favicon) ---
# Отдаём только разрешённые файлы из корня проекта.
ICONS = {
    "favicon.svg": "image/svg+xml",
    "favicon.ico": "image/x-icon",
    "favicon-16.png": "image/png",
    "favicon-32.png": "image/png",
    "favicon-48.png": "image/png",
    "apple-touch-icon.png": "image/png",
}

@app.get("/{icon}")
async def get_icon(icon: str):
    media = ICONS.get(icon)
    if media is None:
        raise HTTPException(status_code=404, detail="Not found")
    path = os.path.join(BASE, icon)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, media_type=media)

# --- REST APIs ---

@app.get("/api/board/{bid}")
async def get_board(bid: str):
    if not SAFE_ID.match(bid):
        raise HTTPException(status_code=400, detail="Invalid board ID")
    state = await board_manager.get_board(bid)
    return JSONResponse(content=state.to_dict())

# --- WebSocket Route ---

@app.websocket("/ws/{board_id}")
async def websocket_endpoint(websocket: WebSocket, board_id: str):
    if not SAFE_ID.match(board_id):
        await websocket.close(code=4000)
        return

    await board_manager.connect(board_id, websocket)
    await board_manager.broadcast_presence(board_id)
    try:
        while True:
            data = await websocket.receive_json()

            op_type = data.get("type")
            if op_type in EPHEMERAL_WS_TYPES:
                await board_manager.broadcast(board_id, data, exclude=websocket)
                continue

            state = await board_manager.get_board(board_id)
            state.version += 1
            data["sequence_number"] = state.version

            payload = data.get("payload", {})
            if op_type:
                state.apply_operation(op_type, payload)

            await board_manager.broadcast(board_id, data, exclude=websocket)
            await board_manager.schedule_save(board_id)
    except WebSocketDisconnect:
        await board_manager.disconnect(board_id, websocket)
        await board_manager.broadcast_presence(board_id)
    except Exception as e:
        print(f"WS Exception on {board_id}: {e}")
        await board_manager.disconnect(board_id, websocket)
        await board_manager.broadcast_presence(board_id)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
