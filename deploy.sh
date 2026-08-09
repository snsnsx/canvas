#!/usr/bin/env bash
#
# canvas-deploy — установка и обновление доски github.com/snsnsx/canvas на Ubuntu VPS.
#
# Что делает:
#   1. Ищет каталог ./canvas в текущей директории.
#   2. Если он есть — приводит файлы проекта в точное соответствие с репозиторием.
#   3. Если его нет — разворачивает проект из репозитория.
#   4. Ставит и запускает systemd-демона: автозапуск после перезагрузки VPS,
#      автоматический перезапуск при падении. Если демон уже работает —
#      только обновление файлов (и перезапуск, если код действительно изменился).
#   5. Настраивает nginx и HTTPS (Let's Encrypt) для домена из аргумента.
#      Если всё уже настроено — только обновление файлов.
#   6. Скрипт идемпотентен: его можно запускать повторно сколько угодно раз.
#
# Использование:
#   sudo ./deploy.sh example.com [опции]
#   sudo ./deploy.sh                 # повторный запуск: домен берётся из /etc/canvas-deploy.conf
#
# Опции:
#   --email ADDR     e-mail для Let's Encrypt (напоминания об истечении сертификата)
#   --port N         локальный порт приложения (по умолчанию 8000)
#   --user NAME      системный пользователь для демона (по умолчанию — владелец каталога)
#   --repo URL       адрес репозитория (по умолчанию https://github.com/snsnsx/canvas.git)
#   --branch NAME    ветка (по умолчанию — ветка по умолчанию в репозитории)
#   --www            выпустить сертификат ещё и на www.<домен> (нужна DNS-запись)
#   --staging        тестовый сертификат Let's Encrypt — для отладки без расхода лимитов
#   --no-tls         только HTTP, без выпуска сертификата
#   --skip-update    не трогать код, только демон и nginx
#   -h, --help       эта справка
#
# Коды возврата: 0 — успех; 1 — ошибка; 3 — приложение работает, но HTTPS не поднялся.
#
set -Eeuo pipefail
umask 022

# ---------------------------------------------------------------- константы --

REPO_DEFAULT="https://github.com/snsnsx/canvas.git"
PORT_DEFAULT=8000
DIR_NAME="canvas"
SERVICE="canvas"
UNIT_PATH="/etc/systemd/system/${SERVICE}.service"
STATE_FILE="/etc/canvas-deploy.conf"
BACKUP_DIR="/var/backups/canvas"
ACME_WEBROOT="/var/www/certbot"
MAP_CONF="/etc/nginx/conf.d/canvas-ws-upgrade.conf"
KEEP_BACKUPS=10

# ------------------------------------------------------------------- вывод ---

if [[ -t 1 ]]; then
    C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
    C_BLU=$'\033[34m'; C_DIM=$'\033[2m';  C_OFF=$'\033[0m'
else
    C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_DIM=""; C_OFF=""
fi

log()  { printf '%s[..]%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s[!!]%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
step() { printf '\n%s==>%s %s%s%s\n' "$C_BLU" "$C_OFF" "$C_DIM" "$*" "$C_OFF"; }
die()  { printf '%s[XX]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

usage() { sed -n '2,/^set -Eeuo/p' "$0" | sed 's/^# \{0,1\}//; $d'; }

WORKTMP=""
cleanup() { [[ -n $WORKTMP && -d $WORKTMP ]] && rm -rf "$WORKTMP"; return 0; }
trap cleanup EXIT
trap 'rc=$?; printf "\n%s[XX]%s сбой на строке %s: %s (код %s)\n" "$C_RED" "$C_OFF" "$LINENO" "$BASH_COMMAND" "$rc" >&2; exit "$rc"' ERR

WORKTMP=$(mktemp -d)
mktmp() { mktemp -p "$WORKTMP"; }

# Повтор команды: retry <попыток> <пауза_сек> -- команда ...
retry() {
    local tries=$1 delay=$2 n=1; shift 3
    until "$@"; do
        if (( n >= tries )); then return 1; fi
        warn "попытка $n/$tries не удалась, повтор через ${delay}с: $1"
        sleep "$delay"; n=$(( n + 1 ))
    done
    return 0
}

# Заменяет файл, только если содержимое отличается. 0 — заменён, 1 — не изменился.
install_if_changed() {
    local src=$1 dst=$2 mode=${3:-0644}
    if [[ -f $dst ]] && cmp -s "$src" "$dst"; then return 1; fi
    install -D -m "$mode" "$src" "$dst"
    return 0
}

# version_ge A B — истина, если версия A не ниже B.
version_ge() { [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1) == "$2" ]]; }

# Имена процессов, слушающих порт (пусто, если порт свободен).
port_users() {
    ss -lntp 2>/dev/null \
        | awk -v p=":$1" '{ n = split($4, a, ":"); if (":" a[n] == p) print }' \
        | grep -oE '"[^"]+"' | tr -d '"' | sort -u | tr '\n' ' '
}

# ---------------------------------------------------------- разбор аргументов -

ORIG_ARGS=("$@")
DOMAIN=""; EMAIL=""; PORT=""; SVC_USER=""; REPO=""; BRANCH=""
WITH_WWW=0; STAGING=0; NO_TLS=0; SKIP_UPDATE=0

while (( $# )); do
    case "$1" in
        -h|--help)     usage; exit 0 ;;
        --email)       [[ ${2-} ]] || die "--email требует значение";  EMAIL=$2;    shift 2 ;;
        --port)        [[ ${2-} ]] || die "--port требует значение";   PORT=$2;     shift 2 ;;
        --user)        [[ ${2-} ]] || die "--user требует значение";   SVC_USER=$2; shift 2 ;;
        --repo)        [[ ${2-} ]] || die "--repo требует значение";   REPO=$2;     shift 2 ;;
        --branch)      [[ ${2-} ]] || die "--branch требует значение"; BRANCH=$2;   shift 2 ;;
        --www)         WITH_WWW=1;    shift ;;
        --staging)     STAGING=1;     shift ;;
        --no-tls)      NO_TLS=1;      shift ;;
        --skip-update) SKIP_UPDATE=1; shift ;;
        -*)            die "неизвестная опция: $1 (см. --help)" ;;
        *)             [[ -z $DOMAIN ]] || die "лишний аргумент: $1"; DOMAIN=$1; shift ;;
    esac
done

# Явно заданные аргументы проверяем до эскалации, чтобы не спрашивать пароль зря.
DOMAIN_RE='^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
if [[ -n $PORT ]]; then
    [[ $PORT =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || die "некорректный порт: $PORT"
fi
[[ -n $DOMAIN && ! $DOMAIN =~ $DOMAIN_RE ]] && die "некорректный домен: $DOMAIN"

# -------------------------------------------------------------- права, путь --

SELF=$(readlink -f "$0")
if (( ${EUID:-$(id -u)} != 0 )); then
    command -v sudo >/dev/null 2>&1 || die "нужны права root: запустите скрипт от root"
    log "нужны права root — перезапуск через sudo"
    exec sudo -- bash "$SELF" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi

BASE_DIR=$(pwd -P)
[[ $BASE_DIR == / ]] && die "не запускайте скрипт из корня файловой системы — перейдите в рабочий каталог"
APP_DIR="$BASE_DIR/$DIR_NAME"

# ------------------------------------------- состояние прошлого развёртывания -

PREV_DOMAIN=""
if [[ -f $STATE_FILE ]]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE" || warn "не удалось прочитать $STATE_FILE — игнорирую"
    PREV_DOMAIN=${CANVAS_DOMAIN-}
    [[ -z $DOMAIN   && -n ${CANVAS_DOMAIN-}  ]] && DOMAIN=$CANVAS_DOMAIN
    [[ -z $PORT     && -n ${CANVAS_PORT-}    ]] && PORT=$CANVAS_PORT
    [[ -z $EMAIL    && -n ${CANVAS_EMAIL-}   ]] && EMAIL=$CANVAS_EMAIL
    [[ -z $REPO     && -n ${CANVAS_REPO-}    ]] && REPO=$CANVAS_REPO
    [[ -z $BRANCH   && -n ${CANVAS_BRANCH-}  ]] && BRANCH=$CANVAS_BRANCH
    [[ -z $SVC_USER && -n ${CANVAS_USER-}    ]] && SVC_USER=$CANVAS_USER
fi

REPO=${REPO:-$REPO_DEFAULT}
PORT=${PORT:-$PORT_DEFAULT}
[[ $PORT =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || die "некорректный порт: $PORT"

if [[ -z $DOMAIN ]]; then
    (( NO_TLS )) || { usage; die "не указан домен. Пример: sudo $0 board.example.com"; }
    SERVER_NAMES="_"; SITE_ID="default"
else
    [[ $DOMAIN =~ $DOMAIN_RE ]] || die "некорректный домен: $DOMAIN (в том числе из $STATE_FILE)"
    DOMAIN=${DOMAIN,,}
    SERVER_NAMES="$DOMAIN"
    (( WITH_WWW )) && SERVER_NAMES="$DOMAIN www.$DOMAIN"
    SITE_ID="$DOMAIN"
fi

printf '\n%s== canvas-deploy ==%s\n' "$C_BLU" "$C_OFF"
printf '   каталог  : %s\n' "$APP_DIR"
printf '   репозит. : %s%s\n' "$REPO" "${BRANCH:+ (ветка $BRANCH)}"
printf '   домен    : %s\n' "${DOMAIN:-<не задан, только HTTP>}"
printf '   порт     : %s\n' "$PORT"

# =============================================================== 0. проверки ==

step "Проверка окружения"

if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    if [[ ${ID-} != ubuntu && ${ID_LIKE-} != *debian* ]]; then
        warn "система «${PRETTY_NAME-неизвестна}»: скрипт рассчитан на Ubuntu/Debian, продолжаю на свой риск"
    else
        ok "система: ${PRETTY_NAME-Ubuntu}"
    fi
else
    warn "нет /etc/os-release — не могу определить систему"
fi

command -v systemctl >/dev/null 2>&1 || die "systemd не найден — установить демона невозможно"

# Скрипт создаёт ./canvas, поэтому запускать его нужно из родительского каталога.
if [[ -f $BASE_DIR/app.py && -d $BASE_DIR/.git && ! -d $APP_DIR ]]; then
    die "похоже, скрипт запущен внутри самого проекта ($BASE_DIR).
     Перейдите в родительский каталог:  cd .. && sudo ./$DIR_NAME/$(basename "$SELF") <домен>"
fi

if command -v ss >/dev/null 2>&1; then
    holders=$(port_users 80 || true)
    if [[ -n ${holders// /} && $holders != *nginx* ]]; then
        die "порт 80 занят процессом: ${holders}— освободите его (например: systemctl stop apache2) и повторите"
    fi
    holders=$(port_users "$PORT" || true)
    if [[ -n ${holders// /} ]] && ! systemctl is-active --quiet "$SERVICE"; then
        die "порт $PORT занят посторонним процессом: ${holders}— укажите другой через --port"
    fi
    ok "порты 80 и $PORT свободны либо заняты нашими сервисами"
fi

# ================================================================= 1. пакеты ==

step "Пакеты системы"

APT_UPDATED=0
apt_get() {
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a UCF_FORCE_CONFOLD=1 \
        apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold -yq "$@"
}
apt_update_once() {
    (( APT_UPDATED )) && return 0
    log "apt-get update"
    retry 3 15 -- apt_get update \
        || die "apt-get update не выполнен: нет сети или репозитории недоступны"
    APT_UPDATED=1
    return 0
}
ensure_pkgs() {
    local missing=() p
    for p in "$@"; do
        dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "ok installed" || missing+=("$p")
    done
    if (( ! ${#missing[@]} )); then ok "уже установлено: $*"; return 0; fi
    apt_update_once
    log "установка: ${missing[*]}"
    retry 3 15 -- apt_get install --no-install-recommends "${missing[@]}" \
        || die "не удалось установить пакеты: ${missing[*]}"
    ok "установлено: ${missing[*]}"
    return 0
}

ensure_pkgs ca-certificates curl git iproute2 nginx python3 python3-venv python3-pip
(( NO_TLS )) || ensure_pkgs certbot

# =========================================================== 2. пользователь ==

step "Пользователь для демона"

if [[ -z $SVC_USER ]]; then
    SVC_USER=${SUDO_USER:-}
    [[ -z $SVC_USER ]] && SVC_USER=$(stat -c '%U' "$BASE_DIR" 2>/dev/null || echo root)
fi
id "$SVC_USER" >/dev/null 2>&1 || { warn "пользователя «$SVC_USER» нет — использую root"; SVC_USER=root; }
SVC_GROUP=$(id -gn "$SVC_USER")
ok "демон будет работать от $SVC_USER:$SVC_GROUP"

# ============================================================ 3. код проекта ==

step "Файлы проекта"

git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" \
    || git config --global --add safe.directory "$APP_DIR"

backup_boards() {
    [[ -d $APP_DIR/boards ]] || return 0
    mkdir -p "$BACKUP_DIR"
    local stamp old=()
    stamp=$(date +%Y%m%d-%H%M%S)
    if tar czf "$BACKUP_DIR/boards-$stamp.tar.gz" -C "$APP_DIR" boards 2>/dev/null; then
        ok "резервная копия досок: $BACKUP_DIR/boards-$stamp.tar.gz"
        mapfile -t old < <(ls -1t "$BACKUP_DIR"/boards-*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)))
        if (( ${#old[@]} )); then rm -f "${old[@]}"; fi
    else
        warn "не удалось сделать резервную копию каталога boards"
    fi
    return 0
}

is_our_repo() {
    local top
    top=$(git -C "$APP_DIR" rev-parse --show-toplevel 2>/dev/null) || return 1
    [[ $(readlink -f "$top") == "$(readlink -f "$APP_DIR")" ]]
}

detect_branch() {
    local ref
    ref=$(git -C "$APP_DIR" ls-remote --symref origin HEAD 2>/dev/null \
          | awk '/^ref:/ { sub("refs/heads/", "", $2); print $2; exit }') || true
    printf '%s' "${ref:-main}"
}

clone_repo() {
    rm -rf "$APP_DIR"
    git clone ${BRANCH:+--branch "$BRANCH"} "$REPO" "$APP_DIR"
}

OLD_HEAD=""; NEW_HEAD=""; CODE_CHANGED=0; SAVED_BOARDS=""

if (( SKIP_UPDATE )); then
    [[ -d $APP_DIR ]] || die "указан --skip-update, но каталога $APP_DIR не существует"
    warn "обновление кода пропущено (--skip-update)"
elif [[ -e $APP_DIR && ! -d $APP_DIR ]]; then
    die "$APP_DIR существует, но это не каталог"
elif [[ -d $APP_DIR ]] && is_our_repo; then
    # --- каталог есть: приводим к состоянию репозитория ----------------------
    ok "каталог $DIR_NAME найден — обновляю до состояния репозитория"
    OLD_HEAD=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "")
    cur_remote=$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || echo "")
    if [[ -z $cur_remote ]]; then
        git -C "$APP_DIR" remote add origin "$REPO"
    elif [[ $cur_remote != "$REPO" ]]; then
        warn "origin указывал на $cur_remote — переключаю на $REPO"
        git -C "$APP_DIR" remote set-url origin "$REPO"
    fi
    backup_boards
    retry 3 10 -- git -C "$APP_DIR" fetch --prune --tags origin \
        || die "не удалось получить изменения из $REPO"
    [[ -n $BRANCH ]] || BRANCH=$(detect_branch)
    git -C "$APP_DIR" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null \
        || die "ветки «$BRANCH» нет в репозитории"
    # -f отбрасывает локальные правки: файлы должны точно соответствовать репозиторию.
    git -C "$APP_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH" >/dev/null 2>&1 \
        || die "не удалось переключиться на ветку $BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$BRANCH" >/dev/null
    # Доски и venv не трогаем: они в .gitignore, но -e делает это явным.
    git -C "$APP_DIR" clean -fd -e boards -e .venv >/dev/null
    NEW_HEAD=$(git -C "$APP_DIR" rev-parse HEAD)
else
    # --- каталога нет (или там что-то постороннее): разворачиваем заново -----
    if [[ -d $APP_DIR && -n $(ls -A "$APP_DIR" 2>/dev/null) ]]; then
        backup_boards
        stamp=$(date +%Y%m%d-%H%M%S)
        warn "$APP_DIR не является клоном репозитория — переношу в ${APP_DIR}.bak-$stamp"
        mv "$APP_DIR" "${APP_DIR}.bak-$stamp"
        SAVED_BOARDS="${APP_DIR}.bak-$stamp/boards"
    fi
    log "клонирование $REPO"
    retry 3 10 -- clone_repo \
        || die "не удалось клонировать $REPO (проверьте сеть и доступность GitHub)"
    [[ -n $BRANCH ]] || BRANCH=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)
    NEW_HEAD=$(git -C "$APP_DIR" rev-parse HEAD)
    if [[ -n $SAVED_BOARDS && -d $SAVED_BOARDS ]]; then
        mkdir -p "$APP_DIR/boards"
        cp -an "$SAVED_BOARDS/." "$APP_DIR/boards/" 2>/dev/null || true
        ok "прежние доски перенесены в новый каталог"
    fi
    CODE_CHANGED=1
fi

[[ -f $APP_DIR/app.py ]]           || die "в $APP_DIR нет app.py — содержимое репозитория выглядит неверным"
[[ -f $APP_DIR/requirements.txt ]] || die "в $APP_DIR нет requirements.txt"

if [[ -n $OLD_HEAD && -n $NEW_HEAD && $OLD_HEAD != "$NEW_HEAD" ]]; then
    CODE_CHANGED=1
    ok "код обновлён: ${OLD_HEAD:0:7} → ${NEW_HEAD:0:7} (ветка $BRANCH)"
elif [[ -n $NEW_HEAD && -z $OLD_HEAD ]]; then
    ok "код развёрнут: ${NEW_HEAD:0:7} (ветка $BRANCH)"
elif (( ! SKIP_UPDATE )); then
    ok "код уже актуален: ${NEW_HEAD:0:7}"
fi

mkdir -p "$APP_DIR/boards"

# ======================================================= 4. venv и зависимости

step "Виртуальное окружение Python"

VENV="$APP_DIR/.venv"
PY="$VENV/bin/python"

if [[ ! -x $PY ]] || ! "$PY" -c 'import sys' >/dev/null 2>&1; then
    if [[ -d $VENV ]]; then warn "окружение повреждено — пересоздаю"; rm -rf "$VENV"; fi
    log "создание $VENV"
    python3 -m venv "$VENV" || die "не удалось создать venv (нужен пакет python3-venv)"
fi

export PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1
pip_install() { "$PY" -m pip install --no-input --timeout 30 --retries 3 "$@" >/dev/null; }

REQ_HASH=$(sha256sum "$APP_DIR/requirements.txt" | cut -d' ' -f1)
STAMP_FILE="$VENV/.requirements.sha256"
DEPS_CHANGED=0

if [[ ! -f $STAMP_FILE ]] || [[ $(cat "$STAMP_FILE") != "$REQ_HASH" ]] \
   || ! "$PY" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
    log "установка зависимостей (fastapi, uvicorn[standard], websockets)"
    pip_install --upgrade pip wheel setuptools || warn "обновить pip не удалось — продолжаю"
    if ! retry 2 10 -- pip_install -r "$APP_DIR/requirements.txt"; then
        warn "установка не прошла — доставляю компиляторы и пробую ещё раз"
        ensure_pkgs build-essential python3-dev
        pip_install -r "$APP_DIR/requirements.txt" \
            || die "не удалось установить зависимости из requirements.txt"
    fi
    "$PY" -c 'import fastapi, uvicorn' || die "fastapi/uvicorn не импортируются после установки"
    printf '%s\n' "$REQ_HASH" > "$STAMP_FILE"
    DEPS_CHANGED=1
    ok "зависимости установлены"
else
    ok "зависимости актуальны"
fi

[[ -x $VENV/bin/uvicorn ]] || die "в окружении нет uvicorn"

# Демону нужен доступ на запись в boards/ — выставляем владельца всего каталога.
chown -R "$SVC_USER:$SVC_GROUP" "$APP_DIR"
if [[ $SVC_USER != root ]] && ! runuser -u "$SVC_USER" -- test -r "$APP_DIR/app.py" 2>/dev/null; then
    warn "$SVC_USER не может читать $APP_DIR (закрыт вышестоящий каталог) — демон будет работать от root"
    SVC_USER=root; SVC_GROUP=root
    chown -R root:root "$APP_DIR"
fi

# ============================================================== 5. systemd ====

step "Демон systemd (${SERVICE}.service)"

unit=$(mktmp)
cat > "$unit" <<UNIT
# Файл создан canvas-deploy. Ручные правки будут перезаписаны при следующем запуске.
[Unit]
Description=Canvas board (FastAPI/uvicorn)
Documentation=$REPO
After=network-online.target
Wants=network-online.target
# Демон поднимается всегда, сколько бы раз ни падал.
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_GROUP
# app.py строит пути от os.getcwd(), поэтому рабочий каталог обязателен.
WorkingDirectory=$APP_DIR
Environment=PYTHONUNBUFFERED=1
ExecStart=$VENV/bin/uvicorn app:app --host 127.0.0.1 --port $PORT --proxy-headers --forwarded-allow-ips=127.0.0.1
KillSignal=SIGINT
TimeoutStopSec=20
Restart=always
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=$APP_DIR
SyslogIdentifier=$SERVICE

[Install]
WantedBy=multi-user.target
UNIT

UNIT_CHANGED=0
if install_if_changed "$unit" "$UNIT_PATH" 0644; then
    UNIT_CHANGED=1
    systemctl daemon-reload
    ok "unit-файл записан: $UNIT_PATH"
else
    ok "unit-файл без изменений"
fi

if ! systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
    systemctl enable "$SERVICE" >/dev/null 2>&1 || die "не удалось включить автозапуск $SERVICE"
    ok "автозапуск после перезагрузки включён"
else
    ok "автозапуск после перезагрузки уже включён"
fi

if ! systemctl is-active --quiet "$SERVICE"; then
    log "запуск демона"
    systemctl start "$SERVICE" || true
elif (( CODE_CHANGED || DEPS_CHANGED || UNIT_CHANGED )); then
    log "демон уже работает — перезапускаю с новой версией"
    systemctl restart "$SERVICE" || true
else
    ok "демон уже работает, изменений нет — перезапуск не требуется"
fi

app_ready() { curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$PORT/"; }
for _ in $(seq 1 30); do
    app_ready && break
    if ! systemctl is-active --quiet "$SERVICE"; then
        printf '\n%s--- журнал %s ---%s\n' "$C_DIM" "$SERVICE" "$C_OFF" >&2
        journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
        die "демон не запустился (журнал выше). Подробнее: systemctl status $SERVICE"
    fi
    sleep 1
done
if app_ready; then
    ok "приложение отвечает на http://127.0.0.1:$PORT/"
else
    journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
    die "приложение не отвечает на 127.0.0.1:$PORT"
fi

# ================================================================ 6. nginx ====

step "nginx"

systemctl is-enabled --quiet nginx 2>/dev/null || systemctl enable nginx >/dev/null 2>&1 || true
systemctl is-active --quiet nginx || systemctl start nginx || die "nginx не запускается"

# Куда класть конфиг сайта — смотрим, какие include есть в nginx.conf.
INC_SITES=0; INC_CONFD=0
grep -qE '^[[:space:]]*include[[:space:]]+/etc/nginx/sites-enabled/' /etc/nginx/nginx.conf 2>/dev/null && INC_SITES=1
grep -qE '^[[:space:]]*include[[:space:]]+/etc/nginx/conf\.d/'       /etc/nginx/nginx.conf 2>/dev/null && INC_CONFD=1

if (( INC_SITES )); then
    SITE_CONF="/etc/nginx/sites-available/canvas-${SITE_ID}.conf"
    SITE_LINK="/etc/nginx/sites-enabled/canvas-${SITE_ID}.conf"
elif (( INC_CONFD )); then
    SITE_CONF="/etc/nginx/conf.d/canvas-${SITE_ID}.conf"
    SITE_LINK="$SITE_CONF"
else
    die "nginx.conf не подключает ни sites-enabled, ни conf.d — добавьте include вручную и повторите"
fi

mkdir -p "$ACME_WEBROOT/.well-known/acme-challenge"
chown -R www-data:www-data "$ACME_WEBROOT" 2>/dev/null || true

# map для WebSocket-апгрейда. Имя переменной своё, чтобы не столкнуться
# с $connection_upgrade, который мог быть объявлен в чужих конфигах.
# Если conf.d не подключён, map уедет прямо в конфиг сайта (см. render_site).
MAP_BLOCK='map $http_upgrade $canvas_connection_upgrade {
    default upgrade;
    '"''"'      close;
}'
MAP_INLINE=1
if (( INC_CONFD )); then
    MAP_INLINE=0
    mapf=$(mktmp)
    printf '# Файл создан canvas-deploy.\n%s\n' "$MAP_BLOCK" > "$mapf"
    if install_if_changed "$mapf" "$MAP_CONF" 0644; then ok "добавлен $MAP_CONF"; fi
fi

# IPv6 добавляем, только если он есть в ядре — иначе nginx не стартует.
# Все подстановки однострочные: так конфиг собирается без диалектов sed.
if [[ -f /proc/net/if_inet6 ]]; then
    L80V6='listen [::]:80;'
    HAS_V6=1
else
    L80V6='# IPv6 в системе отключён'
    HAS_V6=0
fi

NGINX_VER=$(nginx -v 2>&1 | sed -n 's|.*/\([0-9.]*\).*|\1|p')
if [[ -n $NGINX_VER ]] && version_ge "$NGINX_VER" 1.25.1; then
    L443='listen 443 ssl;'
    L443V6='listen [::]:443 ssl;'
    HTTP2='http2 on;'
else
    # До 1.25.1 http2 включается только в самой директиве listen.
    L443='listen 443 ssl http2;'
    L443V6='listen [::]:443 ssl http2;'
    HTTP2='# http2 включён в директиве listen'
fi
(( HAS_V6 )) || L443V6='# IPv6 в системе отключён'

# Общий блок проксирования: WebSocket + длинные соединения без буферизации.
PROXY_BLOCK='    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $canvas_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
        proxy_buffering off;
        proxy_request_buffering off;
    }'

render_site() {   # $1 = http | tls
    {
        printf '# Файл создан canvas-deploy (%s). Ручные правки будут перезаписаны.\n\n' "$1"
        (( MAP_INLINE )) && printf '%s\n\n' "$MAP_BLOCK"
        if [[ $1 == http ]]; then
            cat <<SITE
server {
    listen 80;
    __L80V6__
    server_name __NAMES__;

    access_log /var/log/nginx/canvas.access.log;
    error_log  /var/log/nginx/canvas.error.log;
    client_max_body_size 64m;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type "text/plain";
        access_log off;
    }

$PROXY_BLOCK
}
SITE
        else
            cat <<SITE
server {
    listen 80;
    __L80V6__
    server_name __NAMES__;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type "text/plain";
        access_log off;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    __L443__
    __L443V6__
    __HTTP2__
    server_name __NAMES__;

    ssl_certificate         /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key     /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/$DOMAIN/chain.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:CanvasSSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "same-origin" always;

    access_log /var/log/nginx/canvas.access.log;
    error_log  /var/log/nginx/canvas.error.log;
    client_max_body_size 64m;

$PROXY_BLOCK
}
SITE
        fi
    } | sed -e "s|__L80V6__|$L80V6|" -e "s|__L443__|$L443|" \
            -e "s|__L443V6__|$L443V6|" -e "s|__HTTP2__|$HTTP2|" \
            -e "s|__NAMES__|$SERVER_NAMES|g" -e "s|__PORT__|$PORT|g"
}

apply_site() {   # $1 = http | tls; ставит конфиг с проверкой и откатом
    local mode=$1 new backup=""
    new=$(mktmp)
    render_site "$mode" > "$new"
    if [[ -f $SITE_CONF ]] && cmp -s "$new" "$SITE_CONF" && [[ -e $SITE_LINK ]]; then
        ok "конфиг nginx ($mode) без изменений"
        return 0
    fi
    if [[ -f $SITE_CONF ]]; then backup=$(mktmp); cp -a "$SITE_CONF" "$backup"; fi
    install -D -m 0644 "$new" "$SITE_CONF"
    [[ $SITE_LINK != "$SITE_CONF" ]] && ln -sfn "$SITE_CONF" "$SITE_LINK"
    if ! nginx -t >/dev/null 2>&1; then
        printf '%s' "$C_RED"; nginx -t 2>&1 | sed 's/^/    /' >&2; printf '%s' "$C_OFF"
        if [[ -n $backup ]]; then
            cp -a "$backup" "$SITE_CONF"
            warn "конфиг откачен к предыдущей версии"
        else
            rm -f "$SITE_CONF"
            [[ $SITE_LINK != "$SITE_CONF" ]] && rm -f "$SITE_LINK"
        fi
        die "nginx отверг конфигурацию (вывод выше)"
    fi
    systemctl reload nginx || systemctl restart nginx || die "nginx не перезагружается"
    ok "конфиг nginx ($mode) применён: $SITE_CONF"
    return 0
}

# Домен из прошлого запуска больше не обслуживаем.
if [[ -n $PREV_DOMAIN && -n $DOMAIN && $PREV_DOMAIN != "$DOMAIN" ]]; then
    old_link="/etc/nginx/sites-enabled/canvas-${PREV_DOMAIN}.conf"
    if [[ -L $old_link ]]; then
        rm -f "$old_link"
        warn "прежний сайт $PREV_DOMAIN отключён (конфиг сохранён в sites-available)"
    fi
fi

# Режим «без домена» — забираем себе весь HTTP, иначе выиграет дефолтный сайт nginx.
if [[ -z $DOMAIN && -L /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
    warn "отключён дефолтный сайт nginx (режим без домена)"
fi

CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
HAVE_CERT=0
[[ -n $DOMAIN && -s $CERT_DIR/fullchain.pem && -s $CERT_DIR/privkey.pem ]] && HAVE_CERT=1

if (( NO_TLS )); then
    apply_site http
elif (( HAVE_CERT )); then
    ok "сертификат для $DOMAIN уже есть"
    apply_site tls
else
    apply_site http    # временный HTTP-конфиг, чтобы прошла проверка ACME
fi

# Порты в ufw открываем, только если он уже включён (сам ufw не включаем — можно потерять SSH).
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    for rule in 80/tcp 443/tcp; do
        ufw status | grep -q "^$rule" || { ufw allow "$rule" >/dev/null 2>&1 && ok "ufw: открыт $rule"; }
    done
fi

# ================================================================ 7. HTTPS ====

TLS_OK=0
if (( NO_TLS )); then
    warn "выпуск сертификата пропущен (--no-tls)"
elif (( HAVE_CERT )); then
    TLS_OK=1
    if certbot certificates 2>/dev/null | grep -A3 "Certificate Name: $DOMAIN" | grep -q "INVALID"; then
        warn "сертификат $DOMAIN просрочен — пробую обновить"
        certbot renew --cert-name "$DOMAIN" --non-interactive --quiet || warn "обновление не удалось"
        systemctl reload nginx || true
    fi
    ok "HTTPS уже настроен — выполнено только обновление файлов"
else
    step "Сертификат Let's Encrypt для $DOMAIN"

    # Проверка DNS до запроса: так сразу видна причина возможной неудачи.
    myip=$(curl -fsS -m 8 https://api.ipify.org 2>/dev/null || curl -fsS -m 8 https://ifconfig.me 2>/dev/null || echo "")
    dnsip=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 { print $1 }' || echo "")
    if [[ -z $dnsip ]]; then
        warn "DNS-запись для $DOMAIN не разрешается — проверка Let's Encrypt, скорее всего, не пройдёт"
    elif [[ -n $myip && $myip != "$dnsip" ]]; then
        warn "DNS: $DOMAIN → $dnsip, а внешний IP сервера — $myip. Если это не CDN/прокси, проверка не пройдёт."
    else
        ok "DNS: $DOMAIN → $dnsip"
    fi

    # Хук: перезагрузить nginx после любого продления сертификата.
    hook=$(mktmp)
    cat > "$hook" <<'HOOK'
#!/bin/sh
# Создано canvas-deploy: подхватываем обновлённый сертификат.
systemctl reload nginx 2>/dev/null || true
HOOK
    install -D -m 0755 "$hook" /etc/letsencrypt/renewal-hooks/deploy/00-reload-nginx.sh

    cb=(certbot certonly --webroot -w "$ACME_WEBROOT" -d "$DOMAIN"
        --non-interactive --agree-tos --keep-until-expiring
        --deploy-hook "systemctl reload nginx")
    (( WITH_WWW )) && cb+=(-d "www.$DOMAIN")
    (( STAGING ))  && cb+=(--staging)
    if [[ -n $EMAIL ]]; then cb+=(--email "$EMAIL"); else cb+=(--register-unsafely-without-email); fi

    if "${cb[@]}"; then
        ok "сертификат получен"
        apply_site tls
        TLS_OK=1
    else
        warn "certbot не смог выпустить сертификат — сайт остаётся на HTTP"
        warn "частые причины: A-запись домена не указывает на этот сервер; порт 80 закрыт файрволом"
        warn "или провайдером; исчерпан недельный лимит Let's Encrypt на домен"
        warn "после исправления повторите: sudo $SELF $DOMAIN${EMAIL:+ --email $EMAIL}"
    fi

    if systemctl enable --now certbot.timer >/dev/null 2>&1; then
        ok "автопродление сертификата включено (certbot.timer)"
    else
        warn "не удалось включить certbot.timer — проверьте автопродление вручную"
    fi
fi

# ========================================================== 8. проверка боем ==

step "Итоговая проверка"

systemctl is-active  --quiet "$SERVICE" && ok "демон $SERVICE: active"  || die "демон $SERVICE не активен"
systemctl is-enabled --quiet "$SERVICE" && ok "автозапуск: enabled"     || warn "автозапуск не включён"
systemctl is-active  --quiet nginx      && ok "nginx: active"           || warn "nginx не активен"

host_hdr=${DOMAIN:-localhost}

# HTTP через nginx — по петле, с нужным Host: работает даже без DNS.
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $host_hdr" "http://127.0.0.1/" || echo 000)
case "$code" in
    200)     ok "HTTP через nginx: 200" ;;
    301|302) ok "HTTP через nginx: $code — редирект на HTTPS" ;;
    *)       warn "HTTP через nginx вернул $code" ;;
esac

# Аргументы для проверок поверх TLS: резолвим домен в петлю, чтобы не зависеть от DNS.
tls_args=(); (( STAGING )) && tls_args+=(-k)
if (( TLS_OK )); then
    tls_args+=(--resolve "$DOMAIN:443:127.0.0.1")
    code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "${tls_args[@]}" "https://$DOMAIN/" || echo 000)
    if [[ $code == 200 ]]; then
        ok "HTTPS: 200 (проверено локально через --resolve)"
    else
        warn "HTTPS вернул $code — проверьте вручную: curl -v https://$DOMAIN/"
    fi
fi

# Рукопожатие WebSocket: именно по нему идёт синхронизация досок.
wskey=$(head -c 16 /dev/urandom | base64)
ws_hdr=(-H "Connection: Upgrade" -H "Upgrade: websocket"
        -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $wskey")
if (( TLS_OK )); then
    wsout=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "${tls_args[@]}" "${ws_hdr[@]}" \
            "https://$DOMAIN/ws/default" 2>/dev/null) || true
else
    wsout=$(curl -s -o /dev/null -m 8 -w '%{http_code}' -H "Host: $host_hdr" "${ws_hdr[@]}" \
            "http://127.0.0.1/ws/default" 2>/dev/null) || true
fi
if [[ ${wsout: -3} == 101 ]]; then
    ok "WebSocket через nginx: 101 Switching Protocols"
else
    warn "WebSocket-проверка вернула «${wsout:-нет ответа}» вместо 101 — совместное редактирование может не работать"
fi

# ------------------------------------------------------- сохранение состояния

st=$(mktmp)
cat > "$st" <<STATE
# Состояние последнего запуска canvas-deploy.
# Используется при повторном запуске без аргументов: sudo $SELF
CANVAS_DOMAIN='$DOMAIN'
CANVAS_PORT='$PORT'
CANVAS_APP_DIR='$APP_DIR'
CANVAS_USER='$SVC_USER'
CANVAS_REPO='$REPO'
CANVAS_BRANCH='${BRANCH:-}'
CANVAS_EMAIL='$EMAIL'
STATE
install_if_changed "$st" "$STATE_FILE" 0600 >/dev/null || true

# ==================================================================== итог ====

scheme="http"; (( TLS_OK )) && scheme="https"
url="$scheme://${DOMAIN:-<IP-сервера>}/"

printf '\n%s================================================%s\n' "$C_GRN" "$C_OFF"
printf '%s  Готово: %s%s\n' "$C_GRN" "$url" "$C_OFF"
printf '%s================================================%s\n' "$C_GRN" "$C_OFF"
cat <<INFO

  Каталог проекта : $APP_DIR
  Доски (данные)  : $APP_DIR/boards   — при обновлении не затираются
  Копии досок     : $BACKUP_DIR
  Демон           : $SERVICE (от $SVC_USER, слушает 127.0.0.1:$PORT)
  Конфиг nginx    : $SITE_CONF

  Полезные команды:
    systemctl status $SERVICE       # состояние демона
    journalctl -u $SERVICE -f       # логи в реальном времени
    systemctl restart $SERVICE      # перезапуск
    sudo $SELF                    # повторное обновление (домен подставится сам)

INFO

if (( ! TLS_OK && ! NO_TLS )); then
    warn "HTTPS не поднят — приложение доступно только по HTTP"
    exit 3
fi
exit 0
