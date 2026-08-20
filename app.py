"""
Лёгкий бэкенд доски для запуска в Google Colab на FastAPI.
Поддерживает WebSocket-синхронизацию в реальном времени и REST API.
"""

import os
import re
import json
import time
import hashlib
import hmac
import base64
import asyncio
from typing import Dict, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

BASE = os.getcwd() # Fix: Use os.getcwd() instead of __file__ for Colab environment
INDEX = os.path.join(BASE, "index.html")
SOURCE = os.path.join(BASE, "source")
BOARDS = os.path.join(BASE, "boards")
os.makedirs(BOARDS, exist_ok=True)

# Имя доски: латиница/цифры/подчёркивание/дефис, до 64 символов.
SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
EPHEMERAL_WS_TYPES = {"cursorMove", "cursorLeave"}
# Сигналинг разговора. Отдельный набор, а не расширение эфемерного: тот путь
# рассылает кадр всем подряд, а offer/answer/ICE адресные — и по объёму (SDP
# в единицы килобайт на пару), и по приватности: в ICE-кандидатах лежат
# локальные и внешние адреса, и знать их тем, кто в разговоре не участвует,
# незачем.
#
# Класть их на общий путь нельзя тем более: там state.version растёт на КАЖДОМ
# сообщении, версия — ключ кэша snapshot() и ETag, а schedule_save после этого
# переписывает весь JSON доски. При этом apply_operation промолчала бы: в её
# цепочке if/elif нет ветки else — поломка была бы полностью невидимой.
VOICE_WS_TYPES = {"voiceHello", "voiceJoin", "voiceLeave", "voiceMute", "voiceSignal"}
# Обратное направление: эти типы сочиняет только сервер. Пришедшие от клиента,
# они попадали бы на общий путь — подняли бы версию доски, вызвали перезапись
# всего JSON на диск и, главное, были бы ретранслированы остальным как
# настоящие: одного кадра voiceFull хватило бы, чтобы у всех оборвался
# разговор, а voiceRoster с огромным rev навсегда заклинил бы состав.
VOICE_OUT_TYPES = {"voiceWelcome", "voiceRoster", "voiceFull"}
DEFAULT_PAGE_ID = "page-1"   # id первой/легаси-страницы (совпадает с фронтендом)

# Ограничения защиты и обслуживания памяти.
MAX_WS_MESSAGE = 8 * 1024 * 1024   # кадр крупнее — почти наверняка мусор/атака
BOARD_W = 1024.0                   # ширина доски в мировых px (совпадает с фронтендом)
NOTE_MIN_W = 130.0                 # минимальный размер плавающего окна (мировые px)
NOTE_MIN_H = 90.0
PAGE_MAX_H = 8000.0                # предел размера окна по высоте (высота листа)
SAVE_MAX_DELAY = 15.0              # доска сохраняется не реже, чем раз в 15 с активности
BOARD_IDLE_TTL = 600.0             # доска без клиентов выгружается из памяти через 10 мин
SEND_TIMEOUT = 5.0                 # медленный клиент не должен держать рассылку

# Разговор идёт полносвязным мешем: у каждого участника N-1 соединений и N-1
# кодировщиков Opus. На шестерых это 15 соединений на доску и примерно 200
# кбит/с отдачи с каждого — дальше начинает захлёбываться мобильный процессор,
# поэтому предел проверяется на сервере: проверка на клиенте проиграла бы гонку
# одновременным входам.
VOICE_MAX_MEMBERS = 6
VOICE_REJOIN_GRACE = 20.0          # столько место ждёт вернувшегося после обрыва
MAX_SIGNAL_MESSAGE = 64 * 1024     # SDP — единицы килобайт; крупнее не пропускаем

# ICE-серверы. STUN хватает в одной сети и за обычным NAT; за симметричным NAT
# и корпоративным файрволом нужен TURN, поэтому его адрес и секрет берутся из
# окружения и в репозиторий не попадают.
VOICE_STUN = [u.strip() for u in os.environ.get(
    "VOICE_STUN_URLS",
    "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302").split(",") if u.strip()]
VOICE_TURN = [u.strip() for u in os.environ.get("VOICE_TURN_URLS", "").split(",") if u.strip()]
VOICE_TURN_SECRET = os.environ.get("VOICE_TURN_SECRET", "")   # coturn use-auth-secret
VOICE_TURN_USER = os.environ.get("VOICE_TURN_USER", "")
VOICE_TURN_PASS = os.environ.get("VOICE_TURN_PASS", "")
VOICE_TURN_TTL = int(os.environ.get("VOICE_TURN_TTL", "3600"))


def voice_ice_config(voice_id: str) -> dict:
    """Конфигурация ICE для одного участника.

    Учётки TURN временные (схема coturn use-auth-secret): логин — «срок:кто»,
    пароль — HMAC от логина. Секрет не покидает сервер, а утёкшая пара протухает
    через VOICE_TURN_TTL.
    """
    servers = []
    if VOICE_STUN:
        servers.append({"urls": VOICE_STUN})
    if VOICE_TURN:
        if VOICE_TURN_SECRET:
            username = f"{int(time.time()) + VOICE_TURN_TTL}:{voice_id}"
            cred = base64.b64encode(hmac.new(VOICE_TURN_SECRET.encode(),
                                             username.encode(), hashlib.sha1).digest()).decode()
        else:
            username, cred = VOICE_TURN_USER, VOICE_TURN_PASS
        servers.append({"urls": VOICE_TURN, "username": username, "credential": cred})
    return {"iceServers": servers, "hasTurn": bool(VOICE_TURN)}

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


def _num(v, default: float, lo: float, hi: float) -> float:
    """Число в заданных границах; мусор и NaN заменяются значением по умолчанию."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:                      # NaN
        return default
    return max(lo, min(hi, f))


def _note_geometry(src: dict, base: dict = None) -> dict:
    """Геометрия плавающего окна.

    Окно приклеено к экрану, а не к листу, поэтому единицы у него смешанные:
    x, w, h — мировые px (доска всегда 1024 в ширину, значит доля экрана по
    горизонтали у всех одна), а y — доля видимой ВЫСОТЫ: высота окна браузера у
    всех разная, и только доля ставит окно в одну и ту же часть экрана.
    """
    base = base or {}
    w = _num(src.get("w", base.get("w")), NOTE_MIN_W * 2, NOTE_MIN_W, BOARD_W)
    return {
        "x": _num(src.get("x", base.get("x")), 60.0, 0.0, BOARD_W - w),
        "y": _num(src.get("y", base.get("y")), 0.1, 0.0, 1.0),
        "w": w,
        "h": _num(src.get("h", base.get("h")), NOTE_MIN_H * 2, NOTE_MIN_H, PAGE_MAX_H)
    }


def _note_stroke(s: dict) -> dict:
    """Штрих внутри окна: тот же формат, что и на листе, в координатах окна."""
    return {
        "id": s.get("id") or s.get("strokeId") or "",
        "tool": s.get("tool", "pen"),
        "color": s.get("color", "#000000"),
        "size": _num(s.get("size"), 3.5, 0.5, 120.0),
        "points": [BoardState._decode_point(p) for p in s.get("points", [])]
    }


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

        # Плавающие окна. На высоту содержимого листа не влияют: они приклеены к
        # экрану, а их штрихи лежат во внутренних координатах окна.
        for n in data.get("notes", []):
            nid = n.get("id")
            if not nid:
                import uuid
                nid = str(uuid.uuid4())
            obj = {
                "id": nid,
                "type": "note",
                "page": n.get("page", DEFAULT_PAGE_ID),
                "strokes": [_note_stroke(s) for s in n.get("strokes", [])]
            }
            obj.update(_note_geometry(n))
            self.objects[nid] = obj
            self._ensure_page(obj["page"])

        # Пересчёт по фактическим объектам: чинит старые доски и вертикальную границу.
        self.recompute_content_bottom()

    def to_dict(self) -> dict:
        strokes_list = []
        images_list = []
        notes_list = []
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
            elif obj["type"] == "note":
                notes_list.append({
                    "id": obj["id"],
                    "page": obj.get("page", DEFAULT_PAGE_ID),
                    "x": obj.get("x", 60.0),
                    "y": obj.get("y", 0.1),
                    "w": obj.get("w", NOTE_MIN_W * 2),
                    "h": obj.get("h", NOTE_MIN_H * 2),
                    "strokes": [{
                        "id": s["id"],
                        "tool": s["tool"],
                        "color": s["color"],
                        "size": s["size"],
                        "points": [_pack_point(p) for p in s["points"]]
                    } for s in obj.get("strokes", [])]
                })
        return {
            "v": self.v,
            "pages": self.pages,
            "contentBottom": self.content_bottom(),
            "penColors": self.penColors,
            "hlColors": self.hlColors,
            "strokes": strokes_list,
            "images": images_list,
            "notes": notes_list,
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
            elif data.get("type") == "note":
                # Возврат окна после undo: приводим к тем же границам, что и при
                # создании — снимок доски не должен принять NaN или окно во весь
                # экран только потому, что объект пришёл «на восстановление».
                data.update(_note_geometry(data))
                data["strokes"] = [_note_stroke(s) for s in data.get("strokes", [])]
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
        elif op_type == "addNote":
            # Плавающее окно. Границу содержимого листа оно не двигает: окно
            # приклеено к экрану, а его штрихи — во внутренних координатах.
            nid = payload.get("noteId")
            if nid:
                obj = {
                    "id": nid,
                    "type": "note",
                    "page": payload.get("page", DEFAULT_PAGE_ID),
                    "strokes": []
                }
                obj.update(_note_geometry(payload))
                self._ensure_page(obj["page"])
                self.objects[nid] = obj
        elif op_type == "updateNote":
            obj = self.objects.get(payload.get("noteId"))
            if obj is not None and obj.get("type") == "note":
                obj.update(_note_geometry(payload, obj))
        elif op_type == "noteStroke":
            obj = self.objects.get(payload.get("noteId"))
            sid = payload.get("strokeId")
            if obj is not None and obj.get("type") == "note" and sid:
                strokes = obj.setdefault("strokes", [])
                # Повтор того же id приходит при redo — заменяем, а не двоим.
                strokes[:] = [s for s in strokes if s["id"] != sid]
                strokes.append(_note_stroke({**payload, "id": sid}))
        elif op_type == "noteStrokePoints":
            obj = self.objects.get(payload.get("noteId"))
            if obj is not None and obj.get("type") == "note":
                for s in obj.get("strokes", []):
                    if s["id"] == payload.get("strokeId"):
                        s["points"].extend(self._decode_point(p) for p in payload.get("points", []))
                        break
        elif op_type == "noteStrokeDelete":
            obj = self.objects.get(payload.get("noteId"))
            if obj is not None and obj.get("type") == "note":
                sid = payload.get("strokeId")
                obj["strokes"] = [s for s in obj.get("strokes", []) if s["id"] != sid]
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
        # Ссылки на фоновые задачи досылки состава разговора: без них сборщик
        # мусора может собрать задачу до того, как она выполнится.
        self._tasks: Set[asyncio.Task] = set()

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
                    # voiceId -> WebSocket: адресная доставка сигналинга.
                    # Заполняется по voiceHello, то есть только для тех, кто
                    # действительно вошёл в разговор.
                    "peers": {},
                    # voiceId -> {"client": str, "muted": bool}: состав разговора.
                    "call": {},
                    # voiceId -> до какого момента место придержано за тем, у
                    # кого аварийно оборвался сокет (см. voice_join).
                    "reserved": {},
                    "call_rev": 0,
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
                board = self.boards[board_id]
                board["clients"].discard(websocket)
                # Привязку voiceId снимаем на всякий случай: состав разговора к
                # этому моменту уже разослан voice_detach().
                vid = getattr(websocket.state, "voice_id", None)
                if vid and board["peers"].get(vid) is websocket:
                    del board["peers"][vid]
                # If no clients left, flush saving immediately
                if not board["clients"]:
                    board["peers"].clear()
                    board["call"].clear()
                    board["reserved"].clear()
                    if board["save_task"]:
                        board["save_task"].cancel()
                        board["save_task"] = None
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
            roster = None
            async with self.lock:
                board = self.boards.get(board_id)
                if board is not None:
                    lost = []
                    for ws in dead:
                        board["clients"].discard(ws)
                        # Сокет умер мимо disconnect() — снимаем и голосовую
                        # запись, иначе участник навсегда зависнет в составе, а
                        # адресная доставка будет уходить в никуда.
                        vid = getattr(ws.state, "voice_id", None)
                        if vid and self._voice_forget_locked(board, vid, ws):
                            lost.append(vid)
                    if lost:
                        board["call_rev"] += 1
                        roster = self.voice_roster(board_id, lost=lost)
            if roster is not None:
                # Звать broadcast изнутри broadcast нельзя — лок не
                # реентерабельный; досылаем отдельной задачей.
                task = asyncio.create_task(self.broadcast(board_id, roster))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)

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

    # --- Голосовой разговор ------------------------------------------------
    # Состав разговора ведёт сервер: клиент его не сочиняет, а применяет. Любое
    # сообщение о составе — это полный список, поэтому повторная доставка и
    # переподключение безопасны.
    #
    # Сообщения о составе НИКОГДА не содержат поля "client": клиент отбрасывает
    # сообщения со своим clientId (network.js), и вошедший не увидел бы
    # собственный состав, то есть не набрал бы никого. Ровно по этой причине так
    # же устроен presence выше.
    #
    # asyncio.Lock не реентерабельный, а broadcast() берёт его сам при неудачной
    # отправке. Поэтому каждый помощник ниже собирает сообщение ПОД локом и
    # возвращает его, а рассылает уже вызывающий — после освобождения.

    def voice_roster(self, board_id: str, left=None, lost=None):
        """Сообщение о составе разговора. Без await — лок не нужен."""
        board = self.boards.get(board_id)
        if board is None:
            return None
        members = [{"id": vid, "client": rec["client"], "muted": bool(rec["muted"])}
                   for vid, rec in sorted(board["call"].items())]
        msg = {"type": "voiceRoster", "rev": board["call_rev"], "members": members}
        if left:
            msg["left"] = list(left)
        if lost:
            msg["lost"] = list(lost)
        return msg

    def _voice_forget_locked(self, board: dict, voice_id: str, websocket=None) -> bool:
        """Снимает участника с учёта. Только под self.lock.
        Возвращает True, если он был в составе разговора.

        Сверка по идентичности сокета обязательна: переподключившийся клиент уже
        занял тот же voiceId новым сокетом, и запоздалый disconnect старого не
        должен снести привязку нового — иначе человек станет недостижим навсегда.
        """
        bound = board["peers"].get(voice_id)
        if websocket is not None and bound is not None and bound is not websocket:
            return False
        board["peers"].pop(voice_id, None)
        return board["call"].pop(voice_id, None) is not None

    async def voice_register(self, board_id: str, voice_id: str, websocket: WebSocket) -> bool:
        async with self.lock:
            board = self.boards.get(board_id)
            if board is None:
                return False
            old = getattr(websocket.state, "voice_id", None)
            if old and old != voice_id and board["peers"].get(old) is websocket:
                board["peers"].pop(old, None)
                board["call"].pop(old, None)
            board["peers"][voice_id] = websocket      # перезапись безусловна
            websocket.state.voice_id = voice_id
            return True

    async def voice_detach(self, board_id: str, websocket: WebSocket, clean: bool):
        """Отвязывает голосовую личность умершего сокета.
        Возвращает сообщение о составе (рассылать ВНЕ лока) либо None."""
        async with self.lock:
            board = self.boards.get(board_id)
            if board is None:
                return None
            vid = getattr(websocket.state, "voice_id", None)
            if not vid:
                return None
            in_call = self._voice_forget_locked(board, vid, websocket)
            websocket.state.voice_id = None
            if not in_call:
                return None
            if clean:
                board["reserved"].pop(vid, None)
            else:
                # Обрыв сети, а не выход: место придерживаем на то же время, что
                # соседи держат звук. Без этого при полном разговоре чужой вход
                # успевал занять освободившийся слот, и вернувшийся через три
                # секунды участник получал «мест нет» — вылет посреди разговора.
                board["reserved"][vid] = time.monotonic() + VOICE_REJOIN_GRACE
            board["call_rev"] += 1
            return self.voice_roster(board_id,
                                     left=[vid] if clean else None,
                                     lost=None if clean else [vid])

    async def voice_send(self, board_id: str, voice_id: str, message: dict) -> bool:
        """Адресная доставка одному участнику разговора."""
        board = self.boards.get(board_id)
        if board is None:
            return False
        ws = board["peers"].get(voice_id)     # без await — читать без лока безопасно
        if ws is None:
            return False
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        try:
            await asyncio.wait_for(ws.send_text(payload), timeout=SEND_TIMEOUT)
            return True
        except asyncio.TimeoutError:
            # Не уложился в таймаут — это ЕЩЁ НЕ мёртвый сокет, а медленный.
            # Выписывать его из clients здесь нельзя: он перестал бы получать и
            # синхронизацию доски тоже, то есть человек молча остался бы с
            # застывшим листом. Настоящий обрыв заметит его собственный цикл
            # receive_text и уйдёт штатным путём через disconnect().
            return False
        except Exception:
            roster = None
            async with self.lock:
                board = self.boards.get(board_id)
                if board is not None:
                    board["clients"].discard(ws)
                    if self._voice_forget_locked(board, voice_id, ws):
                        board["call_rev"] += 1
                        roster = self.voice_roster(board_id, lost=[voice_id])
            if roster is not None:
                await self.broadcast(board_id, roster)
            return False

    async def voice_send_snapshot(self, board_id: str, websocket: WebSocket):
        """Свежему сокету — текущий состав разговора. Без этого кнопка вызова не
        загорится у того, кто открыл доску уже во время разговора."""
        msg = self.voice_roster(board_id)
        if msg is None or not msg["members"]:
            return
        try:
            await asyncio.wait_for(
                websocket.send_text(json.dumps(msg, ensure_ascii=False, separators=(",", ":"))),
                timeout=SEND_TIMEOUT)
        except Exception:
            pass

    async def voice_join(self, board_id: str, voice_id: str, client_id: str, muted: bool):
        """Возвращает (сообщение_всем, сообщение_лично)."""
        async with self.lock:
            board = self.boards.get(board_id)
            if board is None:
                return None, None
            call = board["call"]
            reserved = board["reserved"]
            now = time.monotonic()
            for stale in [k for k, exp in reserved.items() if exp <= now]:
                reserved.pop(stale, None)
            rec = call.get(voice_id)
            if rec is None:
                held = reserved.pop(voice_id, None) is not None
                # Придержанные места считаются занятыми: иначе слот оборвавшегося
                # успевал занять посторонний, а вернувшийся входил сверх предела —
                # и в меше оказывалось семеро вместо шести.
                taken = len(call) + sum(1 for k in reserved if k not in call)
                if not held and taken >= VOICE_MAX_MEMBERS:
                    return None, {"type": "voiceFull", "limit": VOICE_MAX_MEMBERS}
                rec = {"client": client_id, "muted": False}
                call[voice_id] = rec
            rec["client"] = client_id
            rec["muted"] = bool(muted)
            board["call_rev"] += 1
            return self.voice_roster(board_id), None

    async def voice_leave(self, board_id: str, voice_id: str):
        async with self.lock:
            board = self.boards.get(board_id)
            if board is None or board["call"].pop(voice_id, None) is None:
                return None
            board["reserved"].pop(voice_id, None)   # ушёл сам — место не держим
            board["call_rev"] += 1
            return self.voice_roster(board_id, left=[voice_id])

    async def voice_mute(self, board_id: str, voice_id: str, muted: bool):
        async with self.lock:
            board = self.boards.get(board_id)
            rec = board["call"].get(voice_id) if board else None
            if rec is None:
                return None                     # мьют сам по себе в разговор не вводит
            rec["muted"] = bool(muted)
            board["call_rev"] += 1
            return self.voice_roster(board_id)

    async def handle_voice(self, board_id: str, websocket: WebSocket, data: dict):
        op = data.get("type")
        vid = data.get("from")
        if not isinstance(vid, str) or not (1 <= len(vid) <= 96):
            return
        cid = data.get("client")
        cid = cid[:64] if isinstance(cid, str) else ""

        if op == "voiceHello":
            if not await self.voice_register(board_id, vid, websocket):
                return
            snap = self.voice_roster(board_id) or {}
            await self.voice_send(board_id, vid, {
                "type": "voiceWelcome",
                "rev": snap.get("rev", 0),
                "members": snap.get("members", []),
                "maxMembers": VOICE_MAX_MEMBERS,
                "ice": voice_ice_config(vid),
            })
            return

        # Дальше — только представившиеся: адресная доставка держится на привязке
        # voiceId к сокету, а её ставит voiceHello.
        board = self.boards.get(board_id)
        if board is None or board["peers"].get(vid) is not websocket:
            return

        if op == "voiceSignal":
            to = data.get("to")
            if not isinstance(to, str) or not to or to == vid:
                return
            # Обе стороны обязаны быть В РАЗГОВОРЕ, а не просто представиться.
            # Иначе любой, кто открыл доску, берёт из состава чужой voiceId,
            # шлёт туда оффер — и получает в ответ живой микрофон, не показавшись
            # никому в списке участников.
            call = board["call"]
            if vid not in call or to not in call:
                return
            # Кадр пересобирается, а не ретранслируется как есть: поле "client"
            # убирается (иначе фильтр своих сообщений на клиенте съел бы сигнал
            # между двумя вкладками с одинаковым clientId), а "from" ставит
            # сервер — представиться чужим нельзя.
            await self.voice_send(board_id, to, {
                "type": "voiceSignal", "from": vid, "payload": data.get("payload") or {}})
            return

        payload = data.get("payload") or {}
        direct = None
        if op == "voiceJoin":
            roster, direct = await self.voice_join(board_id, vid, cid, bool(payload.get("muted")))
        elif op == "voiceLeave":
            roster = await self.voice_leave(board_id, vid)
        else:                                   # voiceMute
            roster = await self.voice_mute(board_id, vid, bool(payload.get("muted")))
        if direct is not None:
            await self.voice_send(board_id, vid, direct)
        if roster is not None:
            await self.broadcast(board_id, roster)

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

# SVG-иконки интерфейса лежат отдельными файлами в source/ и подставляются в
# разметку на месте меток <!--icon:имя--> при отдаче страницы. Именно инлайн, а не
# <img>/<use>: иконки красятся правилами самой страницы (.m-edge, .hint-arrow,
# var(--ui-strong)), а кольцо подсказки tools.js достаёт через getElementById —
# во внешнем документе ни то, ни другое не работает.
# Собранная страница кэшируется по mtime исходников, поэтому правка любого .svg
# подхватывается со следующим запросом и без перезапуска сервера.
ICON_MARK = re.compile(rb"<!--icon:([a-z0-9-]+)-->")

_index_cache = {"stamp": None, "html": b""}


def _index_stamp():
    """Отпечаток исходников страницы: mtime index.html и всех иконок."""
    stamp = [os.path.getmtime(INDEX)]
    try:
        for name in sorted(os.listdir(SOURCE)):
            if name.endswith(".svg"):
                stamp.append((name, os.path.getmtime(os.path.join(SOURCE, name))))
    except OSError:
        pass
    return tuple(stamp)


def _render_index() -> bytes:
    with open(INDEX, "rb") as fh:
        html = fh.read()

    def inline(match):
        # Имя ограничено регуляркой [a-z0-9-]+, выйти из source/ через метку нельзя.
        path = os.path.join(SOURCE, match.group(1).decode("ascii") + ".svg")
        try:
            with open(path, "rb") as fh:
                return fh.read().strip()
        except OSError:
            # Пропавшая иконка не должна ронять страницу: оставляем метку — она
            # видна в DOM и сразу называет недостающий файл.
            return match.group(0)

    return ICON_MARK.sub(inline, html)


def _index_html() -> bytes:
    stamp = _index_stamp()
    if _index_cache["stamp"] != stamp:
        _index_cache["html"] = _render_index()
        _index_cache["stamp"] = stamp
    return _index_cache["html"]


@app.get("/")
async def index():
    return HTMLResponse(_index_html(), headers=NO_CACHE)

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

@app.get("/notes.js")
async def get_notes():
    return FileResponse(os.path.join(BASE, "notes.js"), media_type="application/javascript", headers=JS_HEADERS)

# Строго выше маршрута "/{icon}": тот перехватывает ЛЮБОЙ односегментный путь,
# а Starlette берёт первое совпадение по порядку регистрации. Ниже этот маршрут
# был бы мёртвым — доска открывалась бы как обычно, а разговор просто молча
# отсутствовал.
@app.get("/voice.js")
async def get_voice():
    return FileResponse(os.path.join(BASE, "voice.js"), media_type="application/javascript", headers=JS_HEADERS)

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
    # Свежему клиенту сразу сообщаем, идёт ли на доске разговор.
    await board_manager.voice_send_snapshot(board_id, websocket)
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
            if op_type in VOICE_OUT_TYPES:
                continue                    # так представляться может только сервер
            if op_type in VOICE_WS_TYPES:
                # ДО инкремента версии: сигналинг — не операция доски. Кадр в
                # десятки килобайт — это уже не SDP, а попытка прокачать через
                # доску файл мимо состояния и сохранений.
                if len(raw) <= MAX_SIGNAL_MESSAGE:
                    await board_manager.handle_voice(board_id, websocket, data)
                continue
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
    except WebSocketDisconnect as exc:
        # 1000/1001 — вкладку закрыли или перезагрузили: участник ушёл сам, и
        # соседи рвут соединение сразу. Всё прочее (1006) — обрыв сети: медиа
        # идёт по ICE мимо сигналинга и в это время не прерывается, поэтому
        # соседи держат соединение живым ещё пятнадцать секунд (voice.js).
        clean = getattr(exc, "code", 1006) in (1000, 1001)
        roster = await board_manager.voice_detach(board_id, websocket, clean)
        await board_manager.disconnect(board_id, websocket)
        await board_manager.broadcast_presence(board_id)
        if roster is not None:
            await board_manager.broadcast(board_id, roster)
    except Exception as e:
        print(f"WS Exception on {board_id}: {e}")
        roster = await board_manager.voice_detach(board_id, websocket, False)
        await board_manager.disconnect(board_id, websocket)
        await board_manager.broadcast_presence(board_id)
        if roster is not None:
            await board_manager.broadcast(board_id, roster)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
