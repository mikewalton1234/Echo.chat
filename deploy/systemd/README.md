# EchoChat systemd deployment

This folder contains a ready-to-edit `echochat.service` and an env template.

## Recommended layout

- Project: `/opt/echochat/Echo-Chat-main`
- Venv: `/opt/echochat/.venv`
- Env file: `/etc/echochat/echochat.env`
- User: `echochat`

## Install steps (Arch)

### 1) Create a dedicated user

```bash
sudo useradd -r -s /usr/bin/nologin -d /opt/echochat echochat
```

### 2) Put EchoChat under /opt

```bash
sudo mkdir -p /opt/echochat
sudo chown -R echochat:echochat /opt/echochat
```

Copy your repo contents to `/opt/echochat/` and ensure:

- `/opt/echochat/Echo-Chat-main` exists

### 3) Create venv + install deps

```bash
cd /opt/echochat/Echo-Chat-main
python -m venv /opt/echochat/.venv
source /opt/echochat/.venv/bin/activate
pip install -U pip
pip install -r requirements.txt
```

### 4) Install Redis (optional but recommended)

```bash
sudo pacman -S redis
sudo systemctl enable --now redis
```

### 5) Install env file

```bash
sudo mkdir -p /etc/echochat
sudo cp deploy/systemd/echochat.env.example /etc/echochat/echochat.env
sudo chmod 600 /etc/echochat/echochat.env
sudo chown root:root /etc/echochat/echochat.env
```

Edit `/etc/echochat/echochat.env` and set real values.

### 6) Install a unit file

You have two options:

1) **Single-process dev-ish** (`python main.py`) — simplest.
2) **Production** (`gunicorn + eventlet + multi-worker`) — recommended.

#### Option A: python main.py

```bash
sudo cp deploy/systemd/echochat.service /etc/systemd/system/echochat.service
sudo systemctl daemon-reload
sudo systemctl enable --now echochat
```

#### Option B: gunicorn + eventlet (websockets) + multi-worker

This requires Redis if you use more than 1 worker.

```bash
sudo cp deploy/systemd/echochat-gunicorn.service /etc/systemd/system/echochat-gunicorn.service
sudo cp deploy/systemd/echochat-janitor.service /etc/systemd/system/echochat-janitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now echochat-gunicorn
sudo systemctl enable --now echochat-janitor
```

## Logs

```bash
journalctl -u echochat -f
journalctl -u echochat-gunicorn -f
journalctl -u echochat-janitor -f
```

## Common tweaks

- If you installed EchoChat somewhere else, update `WorkingDirectory=` and
  `ExecStart=`.
- If you do NOT want config persistence at all, keep `ECHOCHAT_PERSIST_SECRETS=0`
  and remove `ReadWritePaths=.../server_config.json`.
