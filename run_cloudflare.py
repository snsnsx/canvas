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


def install_cloudflared():
    if os.path.exists("cloudflared"):
        return

    print("Скачиваю cloudflared...")

    subprocess.run(
        [
            "wget",
            "-q",
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
            "-O",
            "cloudflared",
        ],
        check=True,
    )

    subprocess.run(["chmod", "+x", "cloudflared"], check=True)


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


def start_cloudflare():
    if not os.path.exists("config.yml"):
        raise FileNotFoundError(
            "Не найден config.yml."
        )

    print("Запускаю Cloudflare Tunnel...")

    proc = subprocess.Popen(
        [
            "./cloudflared",
            "tunnel",
            "--config",
            "config.yml",
            "run",
        ]
    )

    return proc


def main():
    install_requirements()

    install_cloudflared()

    errors = start_server()

    wait_until_ready(errors)

    print(f"Локальный сервер работает: http://127.0.0.1:{PORT}")

    cloudflare = start_cloudflare()

    print("\n========================================")
    print("Cloudflare Tunnel запущен.")
    print("Откройте ваш Public Hostname, настроенный")
    print("в панели Cloudflare.")
    print("========================================\n")

    try:
        while True:
            time.sleep(3600)

    except KeyboardInterrupt:
        print("\nОстановка...")

        cloudflare.terminate()
        cloudflare.wait()


if __name__ == "__main__":
    main()