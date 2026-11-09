# Hosting the demo UI on a VPS

How to run the API Test Agent UI on a shared Linux server (the SprintSynergy VPS) so clients and
testers can use it from a browser, without exposing the server's own network or a personal Claude
login. Every step has the exact command and what you should see.

What hosted mode changes is listed in `CLAUDE.md`, section "Hosted mode". In short: login required,
Claude through an API key, local and private addresses refused, production hosts read-only, 5 runs
per hour per login, one run at a time with a queue, each login sees only its own runs.

## Cost

Hosted mode uses `ANTHROPIC_API_KEY`, so every run is billed to that key's Console workspace (the
local demo uses the free Claude Code login instead). A local-shop run is about 10 calls and roughly
60k input and 10k output tokens. Set a monthly spend limit on the workspace in the Console before
sharing the link, and keep `HOSTED_RUNS_PER_HOUR` low.

## Before you start

- The VPS already runs OpenVPN Access Server. It uses ports 443, 943 and 1194. The UI binds to
  127.0.0.1:3000 and Nginx proxies it, so nothing clashes unless Nginx itself needs 443. If OpenVPN
  Access Server owns 443, run Nginx on 8443 and use `https://<host>:8443` in the steps below, or move
  the Access Server web UI to another port first.
- You need a domain or subdomain pointing at the VPS (for example `agent.sprintsynergy.com`) for HTTPS.
- Node 20 or newer, git, and `zip` installed (`node -v`, `zip -v`).

## 1. Install

```
sudo adduser --system --group --home /opt/api-test-agent agent
sudo -u agent git clone https://github.com/sprintsynergyio/api-test-agent /opt/api-test-agent/app
cd /opt/api-test-agent/app
sudo -u agent npm ci
sudo -u agent npx playwright install --with-deps chromium
```

Expected: `added N packages`, then Playwright downloads its browser (API tests do not open a browser,
but the Playwright runner still checks for one).

## 2. Make the password hashes

```
cd /opt/api-test-agent/app
npm run -s ui:hash -- 'a-long-password-for-demo'
```

Expected: one line starting with `$2a$10$`. Repeat for every login you want. Keep the passwords; the
server stores only the hashes.

## 3. Write .env

```
sudo -u agent nano /opt/api-test-agent/app/.env
```

Contents (replace the values):

```
HOSTED=1
UI_PORT=3000
UI_USERS=demo:$2a$10$...,client1:$2a$10$...
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-5
MAX_CLAUDE_CALLS=30
HOSTED_RUNS_PER_HOUR=5
HOSTED_QUEUE=5
HOSTED_RUN_TTL_HOURS=24
```

Do not set `HOST`: the UI must stay on 127.0.0.1 behind Nginx. Do not put any API auth value in
`.env` on the server; demo users enter it in the UI per run.

```
sudo chmod 600 /opt/api-test-agent/app/.env
```

## 4. Check it starts

```
cd /opt/api-test-agent/app && sudo -u agent npm run ui
```

Expected: `API Test Agent UI running on http://localhost:3000 (hosted mode: login required, 2 user(s), 5 runs/hour, queue 5, local hosts refused)`.
If instead you see `HOSTED=1 requires UI_USERS` or `HOSTED=1 requires ANTHROPIC_API_KEY`, fix `.env`.
Stop it with Ctrl+C.

## 5. systemd unit

```
sudo nano /etc/systemd/system/api-test-agent.service
```

```
[Unit]
Description=API Test Agent UI (hosted)
After=network.target

[Service]
Type=simple
User=agent
Group=agent
WorkingDirectory=/opt/api-test-agent/app
ExecStart=/usr/bin/npm run ui
Restart=on-failure
RestartSec=5
# .env is read by the app itself (dotenv). Nothing else needed here.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now api-test-agent
sudo systemctl status api-test-agent --no-pager
```

Expected: `Active: active (running)` and the "hosted mode" line in the log
(`journalctl -u api-test-agent -n 20 --no-pager`).

## 6. Nginx with HTTPS

```
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/api-test-agent
```

```
server {
    server_name agent.sprintsynergy.com;
    listen 80;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        # The live log is server-sent events: no buffering, long timeout.
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

```
sudo ln -s /etc/nginx/sites-available/api-test-agent /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d agent.sprintsynergy.com
```

Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`, then certbot reports
`Successfully deployed certificate`. If port 443 belongs to OpenVPN Access Server, run certbot with
`--https-port 8443` and add `listen 8443 ssl;` instead.

The `X-Forwarded-Proto https` header makes the session cookie `Secure`.

## 7. Verify the guard from the hosted UI

1. Open `https://agent.sprintsynergy.com`, sign in with a user from `UI_USERS`.
   Expected: the Sign in card disappears, the header shows `demo (hosted, 5 runs/hour)`.
2. Saved API, pick `local-shop.json`, Run.
   Expected: `REFUSED: localhost is a local or private address; the hosted agent only tests public non-production hosts.` and no run starts.
3. Custom API, paste a JSON with `"baseUrl": "http://10.8.0.1"` (the VPN network), Run.
   Expected: the same refusal naming `10.8.0.1`.
4. Saved API, `demo-small.json` (Restful Booker, a production host), tick "I understand this is a
   production host", Run. Expected: `safety: production host, read-only mode`, only GET endpoints run,
   the rest `SKIPPED read-only mode`. There is no "Allow write requests" checkbox in hosted mode.
5. Run a 6th time within an hour. Expected: `Limit reached: 5 runs per hour per login.`
6. On the server: `ls /opt/api-test-agent/app/runs/` shows one folder per run; folders older than
   24 hours disappear.
7. `sudo -u agent grep -r "sk-ant" /opt/api-test-agent/app/runs/ /opt/api-test-agent/app/out/ 2>/dev/null`
   Expected: no output. The key never reaches a run folder.

## Updating

```
cd /opt/api-test-agent/app
sudo -u agent git pull
sudo -u agent npm ci
sudo systemctl restart api-test-agent
```

## What hosted mode does not do yet

- Runs execute one at a time (the agent writes to fixed folders); other logins wait in the queue.
- Sessions are in memory: a restart signs everyone out.
- No per-user usage report; `journalctl -u api-test-agent` logs who started which run.
