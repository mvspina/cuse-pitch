# Deploy verification – copy-paste commands

## 1) Fly logs – startup line and bind

Confirm the startup line includes `bound=0.0.0.0:3000` and a build stamp:

```bash
fly logs -a syracuse-pitch
```

Look for one line containing:
- `bound=0.0.0.0:3000`
- `build=2025-...` (ISO timestamp)

To filter to recent app output only:

```bash
fly logs -a syracuse-pitch 2>&1 | head -80
```

---

## 2) Fly SSH – node, /data, sessions, stats size (BusyBox-safe)

Run in one shot (single `sh -c` with semicolons):

```bash
fly ssh console -a syracuse-pitch -C "sh -c 'node -v; echo ---; ls -al /data; echo ---; if [ -d /data/sessions ]; then echo /data/sessions exists; else echo /data/sessions missing; fi; echo ---; if [ -f /data/stats.json ]; then ls -l /data/stats.json; wc -c /data/stats.json; else echo /data/stats.json missing; fi'"
```

You should see:
- Node version (e.g. `v20.x.x`)
- Listing of `/data` (e.g. `stats.json`, `sessions/`)
- Whether `/data/sessions` exists
- Size of `/data/stats.json` if present (from `ls -l` and `wc -c`)

---

## 3) Health check – public URL returns 200

```bash
curl -s -o /dev/null -w "%{http_code}" https://syracuse-pitch.fly.dev/healthz
```

Expected output: `200`

With response body:

```bash
curl -s -w "\nHTTP code: %{http_code}\n" https://syracuse-pitch.fly.dev/healthz
```

Expected: JSON body (e.g. `{"ok":true,...}`) and `HTTP code: 200`.
