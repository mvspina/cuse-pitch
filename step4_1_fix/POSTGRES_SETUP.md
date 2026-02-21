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

## "Consumer app already contains a secret named DATABASE_URL"

If `fly postgres attach ...` fails with an error that the consumer app already has a `DATABASE_URL` secret:

1. **Preferred:** If the app was previously attached to a Postgres app (including the same one), **detach first**. Detach removes the `DATABASE_URL` secret from the consumer, so you can then attach again.
   ```bash
   fly postgres detach <postgres-app-name> --app syracuse-pitch
   fly postgres attach syracuse-pitch-db --app syracuse-pitch
   ```

2. **If there was no attachment** (e.g. you set `DATABASE_URL` manually), unset the secret, then attach:
   ```bash
   fly secrets unset DATABASE_URL --app syracuse-pitch
   fly postgres attach syracuse-pitch-db --app syracuse-pitch
   ```

After a successful attach, deploy and confirm in logs that migrations ran and the server started.
