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


def install_cloudflared():
    """Скачивает cloudflared при отсутствии."""

    if os.path.exists("cloudflared"):
        return

    print("Устанавливаю cloudflared...")

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

    subprocess.run(
        ["chmod", "+x", "cloudflared"],
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


def start_cloudflare(token):
    print("Запускаю Cloudflare Tunnel...")

    proc = subprocess.Popen(
        [
            "./cloudflared",
            "tunnel",
            "run",
            "--token",
            token,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    return proc


def print_logs(proc):
    """Выводит журнал cloudflared."""

    while True:
        line = proc.stdout.readline()

        if not line:
            break

        print("[cloudflared]", line.rstrip())


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "token",
        help="Cloudflare Tunnel Token",
    )

    args = parser.parse_args()

    install_requirements()

    install_cloudflared()

    errors = start_server()

    wait_until_ready(errors)

    print(f"Локальный сервер работает: http://127.0.0.1:{PORT}")

    cloudflare = start_cloudflare(args.token)

    threading.Thread(
        target=print_logs,
        args=(cloudflare,),
        daemon=True,
    ).start()

    print()
    print("=" * 60)
    print("Cloudflare Tunnel запущен.")
    print("Откройте домен, который привязан к этому Tunnel")
    print("в панели Cloudflare.")
    print("=" * 60)
    print()

    try:
        for i in range(12 * 90):
            if cloudflare.poll() is not None:
                raise RuntimeError("Cloudflare Tunnel завершился.")

            time.sleep(5)
        cloudflare.terminate()
        cloudflare.kill()

    except KeyboardInterrupt:
        print("\nОстановка...")

        cloudflare.terminate()

        try:
            cloudflare.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cloudflare.kill()


if __name__ == "__main__":
    main()