import os, shutil, subprocess, time
subprocess.run(
    "curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg | sudo tee /usr/share/keyrings/cloudflare-public-v2.gpg >/dev/null",
    shell=True,
    check=True,
)
subprocess.run(
    "echo 'deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list",
    shell=True,
    check=True,
)

subprocess.run(
    ["apt-get", "update"],
    check=True,
)

subprocess.run(
    ["apt-get", "install", "-y", "cloudflared"],
    check=True,
)

subprocess.Popen(
    ["python3", "app.py"],
)

time.sleep(5)
from google.colab import userdata
token = userdata.get("CLOUDFLARED")
subprocess.Popen(
    ["cloudflared", "tunnel", "run", "--token", token]
)
for i in range(90):
  print(f"Прошло {i}/90 минут")
  i = i + 1
  time.sleep(60)
