PORT = 8000
NGROK_TOKEN = "3Fab4qxy9M2Y6ROQDMKS92T2sZd_s7aq8Tx6gzdGU8AcpN4E"

import os, sys, time, threading, subprocess, urllib.request
os.makedirs('boards', exist_ok=True)

# --- Зависимости ---
try:
    import fastapi, uvicorn, websockets  # noqa
except ImportError:
    print('Установка зависимостей...')
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q',
                    'fastapi', 'uvicorn', 'websockets'])
    import fastapi, uvicorn, websockets  # noqa
try:
    from pyngrok import ngrok, exception
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'pyngrok'])
    from pyngrok import ngrok, exception

assert NGROK_TOKEN.strip(), \
    'Вставьте ваш ngrok-токен в NGROK_TOKEN. Получить: https://dashboard.ngrok.com/get-started/your-authtoken'
ngrok.set_auth_token(NGROK_TOKEN.strip())

# --- FastAPI поднимаем один раз в фоне; ошибки старта перехватываем ---
_server_error = {}
if not globals().get('_WB_STARTED'):
    for _p in ('/content', '.'):
        if _p not in sys.path:
            sys.path.append(_p)

    def run_uvicorn():
        try:
            uvicorn.run("app:app", host="0.0.0.0", port=PORT, log_level="warning")
        except Exception as e:               # импорт app.py упал и т.п.
            _server_error['err'] = e
            import traceback; traceback.print_exc()

    threading.Thread(target=run_uvicorn, daemon=True).start()
    globals()['_WB_STARTED'] = True

# --- Активная проверка готовности сервера вместо "слепого" sleep ---
# Стучимся именно по 127.0.0.1 (IPv4) — тот же адрес мы дадим ngrok.
def wait_until_ready(url="http://127.0.0.1:%d/" % PORT, timeout=40):
    start = time.time()
    while time.time() - start < timeout:
        if _server_error.get('err'):
            raise RuntimeError("FastAPI не запустился: %r" % _server_error['err'])
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False

if not wait_until_ready():
    raise RuntimeError(
        "Сервер FastAPI не ответил на http://127.0.0.1:%d за 40 c.\n"
        "→ Убедитесь, что ячейка с app.py (%writefile app.py) выполнена выше, "
        "затем Среда выполнения → Перезапустить сессию." % PORT)
print("✅ Локальный сервер отвечает на http://127.0.0.1:%d" % PORT)

# --- ngrok: закрыть старые туннели и открыть новый ---
# ВАЖНО: передаём адрес "127.0.0.1:PORT" (IPv4), а НЕ число PORT.
# Иначе агент ngrok резолвит localhost -> ::1 (IPv6), где сервер не слушает,
# и возвращает ERR_NGROK_8012 (dial tcp [::1]:PORT: connection refused).
def open_tunnel(addr="127.0.0.1:%d" % PORT, tries=5):
    try:
        for t in ngrok.get_tunnels():
            ngrok.disconnect(t.public_url)
    except Exception:
        pass
    ngrok.kill()
    for i in range(tries):
        time.sleep(3 if i == 0 else 5)
        try:
            return ngrok.connect(addr, 'http').public_url
        except exception.PyngrokNgrokHTTPError as e:
            if 'ERR_NGROK_334' in str(e) or 'already online' in str(e):
                print(f'  прежний туннель ещё закрывается, попытка {i + 1}…')
                ngrok.kill()
                continue
            raise
    raise RuntimeError(
        'ngrok: прежний туннель не освободился.\n'
        '→ Среда выполнения → Перезапустить сессию, либо остановите старый туннель '
        'на https://dashboard.ngrok.com/endpoints (на бесплатном плане доступен один туннель).')

public_url = open_tunnel()
print('\n✅ Доска запущена. Ссылка для совместной работы:')
print('   ', public_url)
print('    Отдельная комната/доска — добавьте хэш в конец ссылки, например:', public_url + '#room1')
print('\nПри первом открытии нажмите на странице ngrok кнопку «Visit Site».')
