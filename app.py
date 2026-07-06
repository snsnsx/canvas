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

# Сообщения сигналинга WebRTC: ретранслируем как есть, состояние доски не трогаем.
SIGNAL_TYPES = {"rtc-join", "rtc-hello", "rtc-offer", "rtc-answer", "rtc-ice", "rtc-leave"}

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
        self.grid = "grid"
        self.contentBottom = 0.0
        self.penColors = ["#1f1f42", "#dc2626", "#14992f"]
        self.hlColors = ["#fde047", "#86efac"]
        self.objects = {}  # UUID -> dict (stroke or image)
        self.version = 0

    def load_from_dict(self, data: dict):
        self.v = data.get("v", 1)
        self.grid = data.get("grid", "grid")
        self.contentBottom = float(data.get("contentBottom", 0.0))
        self.penColors = data.get("penColors", ["#1f1f42", "#dc2626", "#14992f"])
        self.hlColors = data.get("hlColors", ["#fde047", "#86efac"])
        self.version = int(data.get("version", self.version))

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
                "tool": s.get("tool", "pen"),
                "color": s.get("color", "#000000"),
                "size": float(s.get("size", 2)),
                "points": [{"x": float(p[0]), "y": float(p[1])} if isinstance(p, list) else p for p in s.get("points", [])]
            }

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
                "src": im.get("src", ""),
                "x": float(im.get("x", 0)),
                "y": float(im.get("y", 0)),
                "w": float(im.get("w", 100)),
                "h": float(im.get("h", 100))
            }

        # Пересчёт по фактическим объектам: чинит старые доски и вертикальную границу.
        self.recompute_content_bottom()

    def to_dict(self) -> dict:
        strokes_list = []
        images_list = []
        for obj in self.objects.values():
            if obj["type"] == "stroke":
                strokes_list.append({
                    "id": obj["id"],
                    "tool": obj["tool"],
                    "color": obj["color"],
                    "size": obj["size"],
                    "points": obj["points"]
                })
            elif obj["type"] == "image":
                images_list.append({
                    "id": obj["id"],
                    "src": obj["src"],
                    "x": obj["x"],
                    "y": obj["y"],
                    "w": obj["w"],
                    "h": obj["h"]
                })
        return {
            "v": self.v,
            "grid": self.grid,
            "contentBottom": self.contentBottom,
            "penColors": self.penColors,
            "hlColors": self.hlColors,
            "strokes": strokes_list,
            "images": images_list,
            "version": self.version
        }

    def apply_operation(self, op_type: str, payload: dict):
        if op_type == "beginStroke":
            sid = payload["strokeId"]
            self.objects[sid] = {
                "id": sid,
                "type": "stroke",
                "tool": payload["tool"],
                "color": payload["color"],
                "size": float(payload["size"]),
                "points": [{"x": float(p[0]), "y": float(p[1])} for p in payload.get("points", [])]
            }
        elif op_type == "appendPoints":
            sid = payload["strokeId"]
            if sid in self.objects:
                pts = [{"x": float(p[0]), "y": float(p[1])} for p in payload.get("points", [])]
                self.objects[sid]["points"].extend(pts)
        elif op_type == "endStroke":
            pass
        elif op_type == "deleteObject":
            oid = payload["objectId"]
            if oid in self.objects:
                del self.objects[oid]
        elif op_type == "restoreObject":
            oid = payload["objectId"]
            data = payload["data"]
            self.objects[oid] = data
        elif op_type == "moveObject":
            oid = payload["objectId"]
            if oid in self.objects:
                self.objects[oid]["x"] = float(payload["x"])
                self.objects[oid]["y"] = float(payload["y"])
                if "w" in payload:
                    self.objects[oid]["w"] = float(payload["w"])
                if "h" in payload:
                    self.objects[oid]["h"] = float(payload["h"])
        elif op_type == "addImage":
            iid = payload["imageId"]
            self.objects[iid] = {
                "id": iid,
                "type": "image",
                "src": payload["src"],
                "x": float(payload["x"]),
                "y": float(payload["y"]),
                "w": float(payload["w"]),
                "h": float(payload["h"])
            }
        elif op_type == "changeGrid":
            self.grid = payload["grid"]
        elif op_type == "clearBoard":
            self.objects.clear()
            self.contentBottom = 0
        elif op_type == "undo":
            if "inverseOp" in payload:
                inner = payload["inverseOp"]
                self.apply_operation(inner["type"], inner["payload"])
        elif op_type == "redo":
            if "op" in payload:
                inner = payload["op"]
                self.apply_operation(inner["type"], inner["payload"])

        self.recompute_content_bottom()

    def recompute_content_bottom(self):
        m = 0.0
        for obj in self.objects.values():
            if obj["type"] == "stroke":
                points = obj.get("points", [])
                if points:
                    my = max(p["y"] if isinstance(p, dict) else p[1] for p in points)
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

@app.get("/")
async def index():
    return FileResponse(INDEX)

@app.get("/storage.js")
async def get_storage():
    return FileResponse(os.path.join(BASE, "storage.js"), media_type="application/javascript")

@app.get("/history.js")
async def get_history():
    return FileResponse(os.path.join(BASE, "history.js"), media_type="application/javascript")

@app.get("/canvas.js")
async def get_canvas():
    return FileResponse(os.path.join(BASE, "canvas.js"), media_type="application/javascript")

@app.get("/network.js")
async def get_network():
    return FileResponse(os.path.join(BASE, "network.js"), media_type="application/javascript")

@app.get("/tools.js")
async def get_tools():
    return FileResponse(os.path.join(BASE, "tools.js"), media_type="application/javascript")

@app.get("/voice.js")
async def get_voice():
    return FileResponse(os.path.join(BASE, "voice.js"), media_type="application/javascript")

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
    try:
        while True:
            data = await websocket.receive_json()

            op_type = data.get("type")

            # --- Голосовой звонок (WebRTC): чистый сигналинг, без записи в состояние ---
            if op_type in SIGNAL_TYPES:
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
    except Exception as e:
        print(f"WS Exception on {board_id}: {e}")
        await board_manager.disconnect(board_id, websocket)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
