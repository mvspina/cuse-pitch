# Fly “app is not listening on the expected address” – root cause and fix

## Root cause (in this repo)

1. **Stale build artifact**  
   The **source** (`server/src/index.ts`) was already updated to bind to `0.0.0.0` and to log `Server listening on http://${HOST}:${PORT}`.  
   The **built file** (`server/dist/index.js`) had not been rebuilt and still contained the old startup code:
   - Log: `Server ready (${env}) at http://localhost:${PORT}` and health check with `http://localhost:${PORT}/healthz`.
   So the process that actually runs in production (and in Fly) was the old one: logs showed “Server ready … http://localhost:3000” and the **log** suggested a localhost-only app even though the **binding** in that same file was already `listen(PORT, HOST)` with `HOST = '0.0.0.0'`.

2. **Why Fly showed the warning**  
   Fly checks that something is listening on the expected address (e.g. `0.0.0.0:3000` or `:3000`). The warning “Found these processes… /.fly/hallpass :22” means at the time of the check Fly only saw its own hallpass process (or the app hadn’t finished starting). With a correct bind to `0.0.0.0:3000`, a single startup log that includes the actual bind address, and a successful health check, the warning should stop appearing once the running process is the one built from the fixed source (see below).

## What was fixed

- **Startup log** in the process that runs in production (both in source and in the built artifact):
  - No more “Server ready … http://localhost:3000”.
  - One line that includes: `Server listening on http://0.0.0.0:${PORT}`, plus `NODE_ENV`, `PORT`, `HOST`, and the result of `server.address()` after `listen` (so you see the real bound address).
- **Binding** was already correct (`HOST = '0.0.0.0'`, `listen(PORT, HOST)`); no change there.
- **fly.toml** already has `internal_port = 3000`; no change.
- **Dockerfile** already runs `CMD ["npm","run","start"]` → `node dist/index.js`; no change.

## Exact code/config changes (diff)

### server/src/index.ts

```diff
 httpServer.listen(PORT, HOST, () => {
   const env = process.env.NODE_ENV || 'development'
-  console.log(`Server listening on http://${HOST}:${PORT} (${env})`)
-  console.log(`Health check: curl -i -H "Accept: application/json" http://${HOST}:${PORT}/healthz`)
+  const addr = httpServer.address()
+  const bound = addr && typeof addr === 'object' ? `${addr.address}:${addr.port}` : ''
+  console.log(`Server listening on http://${HOST}:${PORT} (${env}) NODE_ENV=${process.env.NODE_ENV ?? ''} PORT=${PORT} HOST=${HOST} bound=${bound}`)
 })
```

### server/dist/index.js (kept in sync with source)

Same logical change: replace the two old log lines with the single new log line that includes `server.address()` (and NODE_ENV, PORT, HOST, bound).

No changes to fly.toml or Dockerfile.

## Commands for you to run

```bash
cd step4_1_fix
npm run build
fly deploy -a syracuse-pitch
```

After deploy, check logs:

```bash
fly logs -a syracuse-pitch
```

## What you should see in Fly logs after deploy

- One startup line like:
  - `Server listening on http://0.0.0.0:3000 (production) NODE_ENV=production PORT=3000 HOST=0.0.0.0 bound=0.0.0.0:3000`
- So:
  - Bind address in the log is **http://0.0.0.0:3000** (no localhost).
  - **bound=0.0.0.0:3000** confirms the HTTP server is actually listening on `0.0.0.0:3000`.
- Health checks should succeed (Fly’s `http_service.checks` hit `/healthz` on `internal_port` 3000); you may see 200s in the logs or in the Fly dashboard.

The Fly warning “The app is not listening on the expected address… Found these processes… /.fly/hallpass :22” should no longer appear once the new image (built from the fixed source and dist) is what’s running and the app has started and bound to `0.0.0.0:3000`.

## Validate locally (optional)

```bash
cd step4_1_fix
npm run build
node server/dist/index.js
```

You should see the same single log line with `HOST=0.0.0.0`, `bound=0.0.0.0:3000`, and:

```bash
curl -i -H "Accept: application/json" http://0.0.0.0:3000/healthz
```

should return 200 and JSON.
