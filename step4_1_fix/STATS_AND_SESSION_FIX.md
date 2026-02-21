# Stats persistence and socket user identity fix (Fly.io)

## Plain English summary

**Problem:** On Fly.io, sockets were connecting as anonymous (no session), so `room.seatUserId` stayed empty and game-end stats were never persisted. Sessions and stats also didn’t survive restarts because paths were under the app dir instead of the mounted volume.

**Fix:**

1. **Trust proxy** – Set at the very top so Fly’s proxy is trusted and `req.secure` is correct for cookies.
2. **CORS** – Use an explicit allowlist (`https://syracuse-pitch.fly.dev` and localhost) with `credentials: true` for both Express and Socket.IO so cookies are sent and accepted.
3. **Session cookie** – In production, set `secure: true` (and keep `sameSite: 'lax'`) so the session cookie is sent over HTTPS.
4. **Session store path** – In production, store sessions under `/data/sessions` (via `SESSION_FILE_PATH`) so they live on the Fly volume and survive deploys/restarts.
5. **Socket.IO** – Reuse the same CORS allowlist and credentials; after running session middleware, log when a handshake has no session (anonymous).
6. **Stats** – Stats path was already `/data/stats.json` in production; added a write-size log and a warning when game end finds no authenticated users.
7. **Client** – Use `transports: ['websocket', 'polling']` (websocket first) and keep `withCredentials: true`.

**Result:** Users who log in via the HTTP app get a session cookie; the same cookie is sent on the Socket.IO handshake, so `socket.data.user` is set, `seatUserId` is filled when they join/create rooms, and at game end stats are persisted to `/data/stats.json` for all authenticated players.

---

## Files modified

| File | Changes |
|------|--------|
| **server/src/index.ts** | Set `trust proxy` first. Added `ALLOWED_ORIGINS` and CORS with origin allowlist + credentials. Session: production store path `/data/sessions` (or `SESSION_FILE_PATH`), create dir if needed; cookie `secure: true` in production. Socket.IO: same CORS allowlist + credentials; log `[WS] handshake ... no session (anonymous)` when no user; on connection log when socket is anonymous. Game end: log when `userIds=[]` and warn that no authenticated users in room. |
| **server/src/stats/store.ts** | After each write, log `sizeBytes=%s` so persistence size is visible. |
| **client/src/ui/App.tsx** | Socket.IO client: `transports: ['websocket', 'polling']` (websocket first). |
| **fly.toml** | Added `SESSION_FILE_PATH = "/data/sessions"` under `[env]`. |

---

## Verification

### Local (dev)

```bash
cd step4_1_fix
npm run build   # or npm run dev in server + client
# 1) Open http://localhost:5173
# 2) Log in (or sign up)
# 3) Create a room, play a full game to completion
# 4) Check server logs for:
#    - [WS] connect socketId=... userId=<number>   (not "anonymous")
#    - [STATS] game ended ... persisting stats for userIds=[...]  (non-empty)
#    - [STATS] write complete path=... players=1 (or more) sizeBytes=...
```

### After `fly deploy`

```bash
fly deploy
fly logs
```

**Expected log lines:**

- At startup: `[STATS] using path=/data/stats.json`
- When a logged-in user connects: `[WS] connect socketId=... userId=<number>` (not `userId=anonymous`)
- If session is missing on handshake: `[WS] handshake socketId=... no session (anonymous)` and `[WS] socket anonymous - stats will not be persisted...`
- When a game ends with at least one logged-in player: `[STATS] game ended room=... persisting stats for userIds=[...]` with non-empty list, then `[STATS] write complete path=/data/stats.json players=N sizeBytes=...`
- If no one in the room was logged in: `[STATS] no authenticated users in room (seatUserId empty) - stats will not be persisted...`

**Check file on Fly:**

```bash
fly ssh console
ls -la /data/
cat /data/stats.json
ls -la /data/sessions/
exit
```

You should see `/data/stats.json` (and optionally `/data/sessions/`) with content after at least one completed game by logged-in users.

---

## Environment variables (Fly)

Already in `fly.toml`:

- `NODE_ENV = 'production'`
- `CUSE_PITCH_STATS_PATH = "/data/stats.json"`
- `SESSION_FILE_PATH = "/data/sessions"`

Ensure `SESSION_SECRET` is set (e.g. in Fly secrets) for production:

```bash
fly secrets set SESSION_SECRET="your-random-secret"
```
