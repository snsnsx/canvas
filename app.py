"""
Лёгкий бэкенд доски для запуска в Google Colab на FastAPI.
Поддерживает WebSocket-синхронизацию в реальном времени и REST API.
"""

import os
import re
import json
import time
import hashlib
import asyncio
from typing import Dict, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

BASE = os.getcwd() # Fix: Use os.getcwd() instead of __file__ for Colab environment
INDEX = os.path.join(BASE, "index.html")
BOARDS = os.path.join(BASE, "boards")
os.makedirs(BOARDS, exist_ok=True)

# Имя доски: латиница/цифры/подчёркивание/дефис, до 64 символов.
SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
EPHEMERAL_WS_TYPES = {"cursorMove", "cursorLeave"}
DEFAULT_PAGE_ID = "page-1"   # id первой/легаси-страницы (совпадает с фронтендом)

# Ограничения защиты и обслуживания памяти.
MAX_WS_MESSAGE = 8 * 1024 * 1024   # кадр крупнее — почти наверняка мусор/атака
SAVE_MAX_DELAY = 15.0              # доска сохраняется не реже, чем раз в 15 с активности
BOARD_IDLE_TTL = 600.0             # доска без клиентов выгружается из памяти через 10 мин
SEND_TIMEOUT = 5.0                 # медленный клиент не должен держать рассылку

app = FastAPI()

# Разрешаем CORS для работы с ngrok и Colab
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Снимок доски — самый крупный ответ (мегабайты JSON), и он текстовый:
# gzip сжимает его примерно в 7 раз и снимает основную часть трафика reconnect.
app.add_middleware(GZipMiddleware, minimum_size=1024)

def _pack_point(p):
    """Точка в компактном виде для JSON: [x, y] или [x, y, pressure].

    Координаты округляются до сотых мировых пикселей. Мир доски — 1024 px в
    ширину, то есть 0.01 px лежит далеко за пределом различимого даже при DPR 3,
    зато полная запись float64 (18 значащих цифр) стоит ~50 байт на точку против
    ~16. На реальной доске это даёт троекратное сокращение снимка.
    """
    # Клиент присылает точки уже округлёнными (см. network.js::encodePoint), так
    # что обычный путь — вернуть список как есть, без арифметики на каждой точке.
    # Округление здесь остаётся только для унаследованных досок, где точки лежат
    # словарями с полной точностью.
    if not isinstance(p, dict):
        return p
    pr = p.get("pressure")
    x, y = round(p.get("x", 0.0), 2), round(p.get("y", 0.0), 2)
    return [x, y] if pr is None else [x, y, round(pr, 3)]


class BoardState:
    def __init__(self, board_id: str):
        self.board_id = board_id
        self.v = 1
        self.pages = [DEFAULT_PAGE_ID]   # упорядоченный список id страниц
        self.contentBottom = 0.0
        self.penColors = ["#1f1f42", "#dc2626", "#14992f"]
        self.hlColors = ["#fde047", "#7f46a4"]
        self.objects = {}  # UUID -> dict (stroke or image)
        self.version = 0

        # contentBottom пересчитывается лениво: операции удаления/перемещения лишь
        # помечают его устаревшим, а полный проход делается один раз перед чтением.
        # Без этого «Очистить страницу» из N объектов давал O(N^2) по точкам.
        self._bottom_dirty = False
        # Кэш сериализованного снимка: REST-ответ и запись на диск используют одни
        # и те же байты, пока доска не изменилась (version — счётчик операций).
        self._snap_bytes = None
        self._snap_version = -1
        self._snap_etag = None

    def load_from_dict(self, data: dict):
        self.v = data.get("v", 1)
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
                    "points": [_pack_point(p) for p in obj["points"]]
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
            "pages": self.pages,
            "contentBottom": self.content_bottom(),
            "penColors": self.penColors,
            "hlColors": self.hlColors,
            "strokes": strokes_list,
            "images": images_list,
            "version": self.version
        }

    # Сериализованный снимок доски с ETag. Пересобирается только при изменении
    # состояния: до этого и REST-ответ, и запись на диск переиспользуют те же
    # байты вместо повторного кодирования мегабайтов JSON на каждый запрос.
    def snapshot(self):
        if self._snap_bytes is None or self._snap_version != self.version:
            payload = json.dumps(
                self.to_dict(), ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            self._snap_bytes = payload
            self._snap_version = self.version
            self._snap_etag = '"%s"' % hashlib.blake2b(payload, digest_size=16).hexdigest()
        return self._snap_bytes, self._snap_etag

    @staticmethod
    def _point_y(p):
        return p["y"] if isinstance(p, dict) else p[1]

    @staticmethod
    def _decode_point(p):
        # Точки хранятся в том же компактном виде, в каком приходят по сети:
        # [x, y] / [x, y, pressure]. Раньше каждая точка разворачивалась в dict —
        # это лишняя аллокация на КАЖДУЮ точку и втрое более объёмный JSON.
        if isinstance(p, list):
            if len(p) > 2:
                try:
                    pressure = max(0.0, min(1.0, float(p[2])))
                except (TypeError, ValueError):
                    return [float(p[0]), float(p[1])]
                return [float(p[0]), float(p[1]), pressure]
            return [float(p[0]), float(p[1])]
        return p

    def _bump_bottom(self, y: float):
        if y > self.contentBottom:
            self.contentBottom = y

    def _bump_points(self, obj: dict, points, size: float = 0.0):
        # Рост границы только по переданным точкам — без обхода всего штриха.
        # Попутно поддерживаем кэш максимума штриха, чтобы полный пересчёт
        # нижней границы стоил O(объектов), а не O(точек).
        my = obj.get("_maxY")
        for p in points:
            y = self._point_y(p)
            if my is None or y > my:
                my = y
            if y + size > self.contentBottom:
                self.contentBottom = y + size
        if my is not None:
            obj["_maxY"] = my

    def _bump_object(self, obj: dict):
        if obj.get("type") == "stroke":
            pts = obj.get("points", [])
            if pts:
                my = max(self._point_y(p) for p in pts)
                obj["_maxY"] = my
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
                self._bump_points(obj, pts, obj.get("size", 0.0))
        elif op_type == "endStroke":
            pass
        elif op_type == "deleteObject":
            oid = payload["objectId"]
            if oid in self.objects:
                del self.objects[oid]
                self.invalidate_content_bottom()
        elif op_type == "restoreObject":
            oid = payload["objectId"]
            data = payload["data"]
            if "page" not in data:
                data["page"] = DEFAULT_PAGE_ID
            self._ensure_page(data["page"])
            if data.get("type") == "stroke" and "points" in data:
                data["points"] = [self._decode_point(p) for p in data["points"]]
            data.pop("_maxY", None)
            self.objects[oid] = data
            self._bump_object(data)
            # Объект мог переехать вверх — граница снизу могла и уменьшиться.
            self.invalidate_content_bottom()
        elif op_type == "moveObject":
            oid = payload["objectId"]
            if oid in self.objects:
                self.objects[oid]["x"] = float(payload["x"])
                self.objects[oid]["y"] = float(payload["y"])
                if "w" in payload:
                    self.objects[oid]["w"] = float(payload["w"])
                if "h" in payload:
                    self.objects[oid]["h"] = float(payload["h"])
                self.invalidate_content_bottom()
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
                self.invalidate_content_bottom()
        elif op_type == "clearBoard":
            self.objects.clear()
            self.contentBottom = 0.0
            self._bottom_dirty = False
        elif op_type == "undo":
            if "inverseOp" in payload:
                inner = payload["inverseOp"]
                self.apply_operation(inner["type"], inner["payload"])
        elif op_type == "redo":
            if "op" in payload:
                inner = payload["op"]
                self.apply_operation(inner["type"], inner["payload"])

    # Нижняя граница читается редко (снимок доски), а инвалидируется часто
    # (каждое удаление/перемещение). Поэтому операции лишь ставят флаг, а полный
    # проход выполняется максимум один раз перед чтением: очистка страницы из N
    # объектов стоит O(N·P) вместо O(N²·P) — на 5000 штрихов это разница между
    # десятками секунд блокировки цикла событий и десятками миллисекунд.
    def invalidate_content_bottom(self):
        self._bottom_dirty = True

    def content_bottom(self) -> float:
        if self._bottom_dirty:
            self.recompute_content_bottom()
        return self.contentBottom

    def recompute_content_bottom(self):
        m = 0.0
        for obj in self.objects.values():
            if obj["type"] == "stroke":
                points = obj.get("points")
                if points:
                    # Кэш максимума по точкам: точки штриха только дописываются в
                    # конец, поэтому пересчитывать весь список нужно лишь когда
                    # он вырос (_bump_points двигает кэш вместе с границей).
                    my = obj.get("_maxY")
                    if my is None:
                        my = max(self._point_y(p) for p in points)
                        obj["_maxY"] = my
                    m = max(m, my + obj.get("size", 0.0))
            elif obj["type"] == "image":
                m = max(m, obj.get("y", 0.0) + obj.get("h", 0.0))
        self.contentBottom = m
        self._bottom_dirty = False

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
                    "save_task": None,
                    "save_deadline": 0.0,
                    "idle_since": time.monotonic()
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

    async def broadcast(self, board_id: str, message: dict, exclude: WebSocket = None,
                        text: str = None):
        # Раньше здесь удерживался ОДИН глобальный лок на всё время рассылки, и
        # внутри него по очереди выполнялся await send_json на каждого клиента.
        # Следствия: (1) одно и то же сообщение кодировалось в JSON заново для
        # каждого получателя — O(C) кодирований; (2) любой медленный клиент
        # останавливал не только свою доску, а весь процесс целиком.
        #
        # Теперь: под локом делается только снимок списка сокетов, затем лок
        # отпускается; сообщение кодируется один раз; отправка идёт параллельно
        # с таймаутом, а отвалившиеся сокеты убираются одной операцией.
        board = self.boards.get(board_id)
        if board is None:
            return
        targets = [c for c in board["clients"] if c is not exclude]
        if not targets:
            return

        payload = text if text is not None else json.dumps(message, ensure_ascii=False,
                                                           separators=(",", ":"))

        async def send(client):
            try:
                await client.send_text(payload)
                return None
            except Exception:
                return client

        # Таймаут — один на всю рассылку, а не на каждого получателя: отдельный
        # wait_for создавал таймер на КАЖДОГО клиента на КАЖДОЕ сообщение
        # (при 100 клиентах и 400 сообщениях/с — 40 000 таймеров в секунду,
        # что само по себе разгоняло хвост задержек).
        try:
            results = await asyncio.wait_for(
                asyncio.gather(*(send(c) for c in targets), return_exceptions=True),
                timeout=SEND_TIMEOUT)
        except asyncio.TimeoutError:
            return
        dead = [r for r in results if r is not None and not isinstance(r, BaseException)]
        if dead:
            async with self.lock:
                board = self.boards.get(board_id)
                if board is not None:
                    for ws in dead:
                        board["clients"].discard(ws)

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
        # Дебаунс перезапускался КАЖДЫМ сообщением, а сообщения при рисовании
        # идут каждые 24 мс — поэтому активная доска не сохранялась вообще ни
        # разу, пока по ней рисуют, и всё держалось только на записи при выходе
        # последнего клиента. Добавлен потолок: не реже, чем раз в SAVE_MAX_DELAY.
        board = self.boards.get(board_id)
        if board is None:
            return

        now = time.monotonic()
        if board["save_task"] and not board["save_task"].done():
            if now < board["save_deadline"]:
                return                      # запись уже гарантирована к сроку
            board["save_task"].cancel()

        board["save_deadline"] = now + SAVE_MAX_DELAY

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
        board = self.boards.get(board_id)
        if board is None:
            return
        state = board["state"]
        path = os.path.join(BOARDS, board_id + ".json")
        # Сериализация и запись уходят в поток: раньше json.dump(indent=2) всей
        # доски выполнялся прямо в цикле событий — на доске в 300k точек это
        # 725 мс полной остановки обслуживания ВСЕХ досок процесса.
        # Снимок переиспользуется с REST-ответом, отступы убраны (файл втрое
        # меньше при том же содержимом).
        try:
            payload, _etag = state.snapshot()
            await asyncio.to_thread(_write_atomic, path, payload)
        except Exception as e:
            print(f"Failed writing board {board_id} to disk: {e}")

    async def evict_idle_boards(self):
        # Реестр досок рос неограниченно: любой GET создавал запись навсегда.
        while True:
            await asyncio.sleep(60.0)
            now = time.monotonic()
            stale = []
            async with self.lock:
                for bid, board in self.boards.items():
                    if board["clients"]:
                        board["idle_since"] = now
                    elif now - board["idle_since"] > BOARD_IDLE_TTL:
                        stale.append(bid)
            for bid in stale:
                try:
                    await self.save_board_to_disk(bid)
                except Exception:
                    pass
                async with self.lock:
                    board = self.boards.get(bid)
                    if board is not None and not board["clients"]:
                        if board["save_task"]:
                            board["save_task"].cancel()
                        del self.boards[bid]

def _write_atomic(path: str, payload: bytes):
    # Выполняется в отдельном потоке — цикл событий не блокируется.
    temp_path = path + ".tmp"
    with open(temp_path, "wb") as f:
        f.write(payload)
    os.replace(temp_path, path)


board_manager = BoardManager()


@app.on_event("startup")
async def _start_housekeeping():
    asyncio.create_task(board_manager.evict_idle_boards())

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

@app.get("/freehand.js")
async def get_freehand():
    return FileResponse(os.path.join(BASE, "freehand.js"), media_type="application/javascript", headers=JS_HEADERS)

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
async def get_board(bid: str, request: Request):
    if not SAFE_ID.match(bid):
        raise HTTPException(status_code=400, detail="Invalid board ID")
    state = await board_manager.get_board(bid)
    # Снимок кодируется один раз на изменение состояния, а не на каждый запрос,
    # и сопровождается ETag. Клиент перезапрашивает доску при КАЖДОМ открытии
    # сокета (в том числе на каждом переподключении) — с ETag неизменившаяся
    # доска стоит 304 и ноль байт тела вместо мегабайтов JSON.
    payload, etag = state.snapshot()
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    return Response(content=payload, media_type="application/json",
                    headers={"ETag": etag, "Cache-Control": "no-cache"})

# --- WebSocket Route ---

@app.websocket("/ws/{board_id}")
async def websocket_endpoint(websocket: WebSocket, board_id: str):
    if not SAFE_ID.match(board_id):
        await websocket.close(code=4000)
        return

    await board_manager.connect(board_id, websocket)
    # Состояние доски берётся ОДИН раз на соединение. Раньше get_board() вызывался
    # на каждое сообщение и каждый раз захватывал глобальный лок процесса —
    # то есть все клиенты всех досок выстраивались в очередь на каждый пакет точек.
    state = await board_manager.get_board(board_id)
    await board_manager.broadcast_presence(board_id)
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_WS_MESSAGE:
                continue
            try:
                data = json.loads(raw)
            except Exception:
                # Один битый кадр больше не рвёт соединение: раньше это стоило
                # клиенту переподключения и полной перезагрузки доски.
                continue
            if not isinstance(data, dict):
                continue

            op_type = data.get("type")
            if op_type in EPHEMERAL_WS_TYPES:
                # Эфемерное сообщение ретранслируется как есть — без повторного
                # кодирования: исходный текст уже готов к отправке.
                await board_manager.broadcast(board_id, data, exclude=websocket, text=raw)
                continue

            state.version += 1
            data["sequence_number"] = state.version

            payload = data.get("payload", {})
            if op_type:
                try:
                    state.apply_operation(op_type, payload)
                except Exception as e:
                    print(f"Bad op {op_type} on {board_id}: {e}")
                    continue

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
