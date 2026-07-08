import argparse
import os
import subprocess
import sys
import threading
import time
import urllib.request

PORT = 8000

def install_requirements():
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"],
        check=True,
    )

    try:
        import pyngrok  # noqa
    except ImportError:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "pyngrok"],
            check=True,
        )


def start_server():
    if os.getcwd() not in sys.path:
        sys.path.insert(0, os.getcwd())

    errors = {}

    def run():
        try:
            import uvicorn

            uvicorn.run(
                "app:app",
                host="0.0.0.0",
                port=PORT,
                log_level="warning",
            )
        except Exception as e:
            errors["err"] = e
            import traceback

            traceback.print_exc()

    threading.Thread(target=run, daemon=True).start()

    return errors


def wait_until_ready(errors, timeout=40):
    start = time.time()

    while time.time() - start < timeout:

        if errors.get("err"):
            raise RuntimeError(errors["err"])

        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{PORT}/",
                timeout=2,
            ) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.5)

    raise RuntimeError("FastAPI не запустился.")


def start_ngrok(token):
    from pyngrok import ngrok, exception

    ngrok.set_auth_token(token)

    os.makedirs("boards", exist_ok=True)

    try:
        for tunnel in ngrok.get_tunnels():
            ngrok.disconnect(tunnel.public_url)
    except Exception:
        pass

    ngrok.kill()

    addr = f"127.0.0.1:{PORT}"

    for i in range(5):
        time.sleep(3 if i == 0 else 5)

        try:
            return ngrok.connect(addr, "http").public_url

        except exception.PyngrokNgrokHTTPError as e:
            if (
                "ERR_NGROK_334" in str(e)
                or "already online" in str(e)
            ):
                print("Ожидаю освобождения предыдущего туннеля...")
                ngrok.kill()
                continue
            raise

    raise RuntimeError("Не удалось открыть туннель ngrok.")


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "token",
        help="ngrok authtoken",
    )

    args = parser.parse_args()

    install_requirements()

    errors = start_server()

    wait_until_ready(errors)

    print(f"Локальный сервер работает: http://127.0.0.1:{PORT}")

    public_url = start_ngrok(args.token)

    print("\n========================================")
    print("Доска доступна по адресу:")
    print(public_url)
    print()
    print("Комната:")
    print(public_url + "#room1")
    print("========================================\n")

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\nОстановка...")
        from pyngrok import ngrok

        ngrok.kill()


if __name__ == "__main__":
    main()
