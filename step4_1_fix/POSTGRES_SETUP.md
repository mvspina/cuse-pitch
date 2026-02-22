# Fly Postgres setup for syracuse-pitch

## Attach and detach (use `--app`)

- **Attach** a Postgres app to the consumer app (sets `DATABASE_URL` on the consumer):
  ```bash
  fly postgres attach <postgres-app-name> --app <consumer-app-name>
  ```
  Example:
  ```bash
  fly postgres attach syracuse-pitch-db --app syracuse-pitch
  ```

- **Detach** a Postgres app from the consumer (removes the `DATABASE_URL` secret from the consumer):
  ```bash
  fly postgres detach <postgres-app-name> --app <consumer-app-name>
  ```
  Example:
  ```bash
  fly postgres detach syracuse-pitch-db --app syracuse-pitch
  ```

- **Check attachment** (list users on the Postgres app; the consumer app’s username appears when attached):
  ```bash
  fly postgres users list --app <postgres-app-name>
  ```
  Example:
  ```bash
  fly postgres users list --app syracuse-pitch-db
  ```

## Recovery when attach fails

### "Database user already exists"

Attach creates a new Postgres user for the consumer app. If that user was created in a previous attach (e.g. `syracuse_pitch_app`), attach can fail with **database user already exists**. Use a **new, unique database user** each time you re-attach:

- Check existing users: `fly postgres users list --app syracuse-pitch-db`
- Pick a name that does **not** appear in the list, e.g. `syracuse_pitch_app2`, `syracuse_pitch_app3`, etc.
- Run the [canonical recovery sequence](#canonical-recovery-sequence) below, using `--database-name syracuse_pitch --database-user <unique_new_user>` in step 4.

### "DATABASE_URL already exists"

If attach fails because the consumer app **already has a `DATABASE_URL` secret** (from a previous attach or manual set), clear it first using the [canonical recovery sequence](#canonical-recovery-sequence) below. Detach removes the secret from Fly’s perspective; `fly secrets unset` and `fly secrets deploy` ensure the app no longer has the secret so attach can set it again.

### Canonical recovery sequence

Use this sequence when attach fails due to **database user already exists** and/or **DATABASE_URL already exists**:

1. **Detach** the Postgres app from the consumer (removes the attachment and the `DATABASE_URL` secret from the consumer):
   ```bash
   fly postgres detach syracuse-pitch-db --app syracuse-pitch
   ```

2. **Unset** the secret on the consumer (in case it was set manually or still present):
   ```bash
   fly secrets unset DATABASE_URL --app syracuse-pitch
   ```

3. **Deploy secrets** so the app’s machines drop the old secret:
   ```bash
   fly secrets deploy --app syracuse-pitch
   ```

4. **Attach** again with a **unique new database user**. `<unique_new_user>` must be a name that does not already exist on the Postgres app (e.g. `syracuse_pitch_app2`, `syracuse_pitch_app3`). Use a different suffix each time you re-run attach:
   ```bash
   fly postgres attach syracuse-pitch-db --app syracuse-pitch --database-name syracuse_pitch --database-user <unique_new_user>
   ```
   Example:
   ```bash
   fly postgres attach syracuse-pitch-db --app syracuse-pitch --database-name syracuse_pitch --database-user syracuse_pitch_app2
   ```
   Add `--yes` for non-interactive use.

5. **Deploy** the app so it uses the new `DATABASE_URL`:
   ```bash
   fly deploy --app syracuse-pitch
   ```

After a successful attach, deploy and confirm in logs that migrations ran and the server started.
