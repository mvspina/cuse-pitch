# Admin usernames & Postgres verification

## What is persisted

- **Postgres is used** via the `pg` package; `DATABASE_URL` is read in `server/src/db/pool.ts`.
- **A `users` table exists** and is created by migrations in `server/src/db/migrate.ts`. It stores:
  - `id` (bigserial)
  - `username` (text, unique, not null)
  - `email` (text, unique)
  - `password_hash` (text, not null)
  - `created_at` (timestamptz)
- **Usernames are stored in Postgres.** Auth (login/register) and session use this table; `getUserById` / `getUserByUsername` read from it. No separate “usernames only” table was added; the admin endpoint reads from `users`.

## GET /admin/usernames

- **URL:** `GET /admin/usernames`
- **Auth:** Requires `ADMIN_KEY` (from `process.env.ADMIN_KEY`).
  - Header: `Admin-Key: <value>`
  - Or query: `?admin_key=<value>` or `?ADMIN_KEY=<value>`
- **Response:** `200` JSON: `{ usernames: string[] }` (usernames only, no emails, hashes, or other PII).
- **Errors:** `401` if key missing/wrong; `500` if the DB query fails.

## Migrations on deploy

- Migrations run at server startup in `bootstrap()` via `runMigrationsOnly()` (see `server/src/index.ts`). No extra deploy step is required as long as the app starts after `DATABASE_URL` is set.

## SQL (existing users table from migrations)

The table is created by the existing migration. Equivalent SQL:

```sql
CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  email text UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
```

No new migration file was added; the app already runs this as part of `migrate.ts`.

## Fly: DATABASE_URL and ADMIN_KEY

1. **DATABASE_URL**  
   Set when attaching Postgres to the app (recommended):

   ```bash
   fly postgres attach <postgres-app-name> --app syracuse-pitch
   ```

   Example from the repo:

   ```bash
   fly postgres attach syracuse-pitch-db --app syracuse-pitch
   ```

   Or set manually:

   ```bash
   fly secrets set DATABASE_URL="postgres://..." --app syracuse-pitch
   ```

2. **ADMIN_KEY** (required for `/admin/usernames`):

   ```bash
   fly secrets set ADMIN_KEY="your-secret-admin-key" --app syracuse-pitch
   ```

3. **Deploy after setting secrets:**

   ```bash
   fly deploy --app syracuse-pitch
   ```

## Quick test (local)

```bash
# With ADMIN_KEY set in .env or export
curl -H "Admin-Key: $ADMIN_KEY" http://localhost:3000/admin/usernames
# Or
curl "http://localhost:3000/admin/usernames?admin_key=$ADMIN_KEY"
```

Expected: `{"usernames":["alice","bob",...]}` (or `[]` if no users).
