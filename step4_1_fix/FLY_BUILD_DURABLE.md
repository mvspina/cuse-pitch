# Durable Fly binding fix – one source of truth, no hand-editing dist

## 1. Build pipeline verification

- **Root** `package.json`: `"build": "npm run build --prefix client && npm run build --prefix server"` → server build runs after client.
- **Server** `package.json` previously: `"build": "node -e \"try{ require('child_process').execSync('tsc ...') }catch(e){}\nprocess.exit(0)\""` → **TypeScript errors were swallowed** (catch empty, exit(0) always), so dist could be stale or broken.
- **Fix:** Server build now runs `tsc -p tsconfig.json` directly so the build **fails** on TS errors, then writes `build-stamp.json` with a timestamp. `tsconfig.json` has `noEmitOnError: true` so dist is only emitted on success.

## 2. Single source of truth; no manual dist

- **Source of truth:** `server/src` only. All startup and bind logic (including log and build stamp) lives in `server/src/index.ts`.
- **dist:** `server/dist` is in `.gitignore`. It is **not** committed. It is produced only by `npm run build` (locally or inside Docker).
- **Chosen approach: Option B – do not commit dist; always build in Docker.**  
  - **Why:** `.gitignore` already had `server/dist` and `client/dist`. Dockerfile already runs `COPY . .` then `RUN npm run build`. So every `fly deploy` builds a fresh image that runs `npm run build` inside the container and produces dist from the copied source. No risk of committed dist drifting from source. No need for a predeploy step. If someone had committed dist in the past, adding `.dockerignore` (see below) ensures the image never uses copied dist and always uses the one from `RUN npm run build`.

## 3. Fly runs freshly built dist

- **Dockerfile:** Unchanged order: `COPY . .` then `RUN npm install` / `RUN npm run install:all` / `RUN npm run build`. So the image always builds dist (and build-stamp) inside the container from the copied source.
- **`.dockerignore` added:** Excludes `server/dist`, `client/dist`, `server/build-stamp.json`, `node_modules`, `.git`, `*.log`, `.env`. So the build context does not send local dist or stamp; the only dist in the image is the one produced by `RUN npm run build`.
- **Build stamp:** During `npm run build` in the server, the script writes `server/build-stamp.json` with `{ "timestamp": "<ISO string>" }`. At startup, the server reads this file (if present) and logs `build=<timestamp>` in the single startup line. So you can confirm in Fly logs that the running process is from the image that was just built (new timestamp per deploy).

---

## Exact file diffs

### server/package.json

```diff
- "build":"node -e \"try{require('child_process').execSync('tsc -p tsconfig.json',{stdio:'inherit'})}catch(e){}\nprocess.exit(0)\""
+ "build":"tsc -p tsconfig.json && node -e \"require('fs').writeFileSync('build-stamp.json', JSON.stringify({timestamp: new Date().toISOString()}))\""
```

### server/tsconfig.json

```diff
- "noEmitOnError":false
+ "noEmitOnError":true
```

### server/src/index.ts

```diff
 httpServer.listen(PORT, HOST, () => {
   const env = process.env.NODE_ENV || 'development'
   const addr = httpServer.address()
   const bound = addr && typeof addr === 'object' ? `${addr.address}:${addr.port}` : ''
-  console.log(`Server listening on http://${HOST}:${PORT} (${env}) NODE_ENV=${process.env.NODE_ENV ?? ''} PORT=${PORT} HOST=${HOST} bound=${bound}`)
+  let buildStamp = 'none'
+  try {
+    const stampPath = path.join(__dirname, '..', 'build-stamp.json')
+    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')) as { timestamp?: string }
+    buildStamp = stamp?.timestamp ?? 'unknown'
+  } catch { /* ignore */ }
+  console.log(`Server listening on http://${HOST}:${PORT} (${env}) NODE_ENV=${process.env.NODE_ENV ?? ''} PORT=${PORT} HOST=${HOST} bound=${bound} build=${buildStamp}`)
 })
```

### .gitignore

```diff
 server/dist
+server/build-stamp.json
 client/dist
```

### .dockerignore (new file)

```
# Prefer image dist from npm run build; avoid copying stale local dist
server/dist
client/dist
server/build-stamp.json
node_modules
.git
*.log
.env
```

### Dockerfile

No changes. It already has `RUN npm run build` after `COPY . .`.

---

## Single command to run

```bash
fly deploy -a syracuse-pitch
```

(You can run `npm run build` locally first to verify; for Fly, the image is built on deploy and runs `npm run build` inside the container.)

---

## What you should see in Fly logs after deploy

One startup line that includes:

- **Bind address:** `http://0.0.0.0:3000` (or your `PORT`).
- **bound=0.0.0.0:3000** (or `bound=0.0.0.0:<port>`).
- **build=** an ISO timestamp (e.g. `build=2025-02-20T19:45:00.000Z`) from the image build. Each new deploy will show a new timestamp, proving the new image and new code are running.

Example:

```text
Server listening on http://0.0.0.0:3000 (production) NODE_ENV=production PORT=3000 HOST=0.0.0.0 bound=0.0.0.0:3000 build=2025-02-20T19:45:00.000Z
```

Health checks to `/healthz` should continue to return 200.
