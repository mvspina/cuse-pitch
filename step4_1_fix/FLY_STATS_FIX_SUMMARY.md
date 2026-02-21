# Fly.io listen + stats persistence fix

## 1. Root cause for `userIds=[]` at game end

**Cause:** `room.seatUserId` was not always updated when a logged-in user had a seat.

- **joinRoom / joinInvite:** We only set `seatUserId.set(seat, authedId)` when the user *just* took a new seat in the “no seat → take first free” block. If they already had a seat (e.g. rejoin with a token that already had a seat, or host path that set seat 0 but we didn’t run that block again), we never called `seatUserId.set(seat, authedId)` for that seat.
- **reconnectRoom:** We attached the socket to the token but never updated `seatUserId` for that token’s seat when `authedId` was present. So a reconnect with a valid token and a logged-in session could leave their seat without a userId in `seatUserId`.

So at game end we iterate `room.seatUserId.entries()` and often got no entries (or only the host), and logged `userIds=[]`.

**Fix:** Whenever we have a seated user and an authenticated id, set the seat → userId mapping:

- **joinRoom / joinInvite:** After resolving `seat` (either from existing token or from taking a new seat), always do `if (seat !== null && authedId) { room.seatUserId.set(seat, authedId); room.tokenUserId.set(token, authedId); }`.
- **reconnectRoom:** After attaching the socket, get `seat = playerIndexForToken(room, token)` and do the same: `if (seat !== null && authedId) { room.seatUserId.set(seat, authedId); room.tokenUserId.set(token, authedId); }`.

Stats store path and shape are unchanged; the issue was only that we didn’t record userIds for all seated, logged-in users.

---

## 2. Code changes (files and key diffs)

### `server/src/index.ts`

- **Listen / log**
  - Log message changed to: `Server listening on 0.0.0.0:${PORT} (${env})` and health check URL uses `0.0.0.0` so Fly’s “expected address” is clearly shown. `HOST` and `PORT` were already `'0.0.0.0'` and `Number(process.env.PORT) || 3000`; no change to the `listen(PORT, HOST, ...)` call.

- **joinRoom**
  - After the block that optionally takes a new seat, added:
    - `if (seat !== null && authedId) { room.seatUserId.set(seat, authedId); room.tokenUserId.set(token, authedId); }`
  - Join log now includes `userId=%s` (or `anonymous`).

- **joinInvite**
  - Same as joinRoom: always set `seatUserId` and `tokenUserId` when `seat !== null && authedId`.
  - Join log now includes `userId=%s` (or `anonymous`).

- **reconnectRoom**
  - After `attachSocketToToken` and `socket.join(code)`:
    - `const seat = playerIndexForToken(room, token)`
    - `if (seat !== null && authedId) { room.seatUserId.set(seat, authedId); room.tokenUserId.set(token, authedId); }`
  - Reconnect log now includes `seat=%s userId=%s` (or `anonymous`).

- **takeSeat**
  - When `authedId` is set and we update `seatUserId`/`tokenUserId`, added log: `[ROOM] seat assignment room=%s seat=%s userId=%s`.

- **action handler (game start)**
  - When `payload.action.type === 'START_HAND'`, after updating `room.state`, added log: `[ROOM] game start hand room=%s handNumber=%s seatUserId size=%s`.

- **action handler (game end)**
  - Before the “persisting stats for userIds” log, build `seatToUserId` from `room.seatUserId.entries()` and log: `[STATS] game ended room=%s winnerTeamId=%s seat->userId=%s persisting userIds=%s` so you see the full seat → userId map and the list of userIds we persist.

No other files were modified. Session/CORS/trust proxy and stats store path and shape are unchanged.

---

## 3. Verification checklist

### Build

```bash
cd step4_1_fix
npm run build
```

Expect server and client to build without errors.

### Deploy

```bash
fly deploy -a syracuse-pitch
```

### Logs (what to look for)

```bash
fly logs -a syracuse-pitch
```

- On startup: `Server listening on 0.0.0.0:3000 (production)` (or your `PORT`).
- When a logged-in user joins: `[ROOM] join room=... seat=... userId=<number> ...` (not `userId=anonymous`).
- When they take a seat (if applicable): `[ROOM] seat assignment room=... seat=... userId=...`.
- When a hand starts: `[ROOM] game start hand room=... handNumber=... seatUserId size=<n>` with `n > 0` if anyone is logged in and seated.
- When a game ends: `[STATS] game ended room=... seat->userId={"0":"123",...} persisting userIds=["123",...]` with non-empty `seat->userId` and `userIds` when at least one seated player was logged in.
- After a persisted game: `[STATS] write complete path=/data/stats.json players=<n> sizeBytes=<size>` with `players >= 1` and `sizeBytes` clearly above the ~25-byte empty-object size.

### Stats file on the Fly volume

```bash
fly ssh console -a syracuse-pitch -C "sh -lc 'ls -al /data; wc -c /data/stats.json; cat /data/stats.json'"
```

- `/data` should list `stats.json` (and e.g. `sessions/` if used).
- `wc -c /data/stats.json` should show a size that grows after a full game (hundreds of bytes or more, not ~25).
- `cat /data/stats.json` should show a JSON object with a `statsByUserId` key and at least one entry keyed by your userId, with non-zero fields (e.g. `gamesPlayed`, `wins`, `losses`, `bidsAttempted`, `bidsMade`, etc.) after you complete a full game while logged in.

### End-to-end

1. Log in at https://syracuse-pitch.fly.dev (or your app URL).
2. Create a room or join one; take a seat if needed.
3. Play a full game to completion (one team reaches target score).
4. Re-run the `fly logs` and `fly ssh console ... cat /data/stats.json` steps above and confirm:
   - Logs show non-empty `seat->userId` and `userIds` at game end.
   - `stats.json` contains your userId under `statsByUserId` with updated stats.
