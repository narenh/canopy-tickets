# Canopy Tickets

A small tool for tracking AMC seat blocks you've bought so friends can later
claim seats. Right now this covers the admin side: creating showtimes,
picking which seats you actually bought on a real AMC seat map, and marking
which seats in the auditorium are otherwise unavailable. Everything is
persisted server-side, behind a password.

The public "browse showtimes and claim a seat" view isn't built yet — this
is just the create/manage side for now.

## How it works

- `server.js` — Express app: password-gated auth (signed cookie) + a JSON
  REST API for showtimes.
- `lib/store.js` — persistence: showtimes are stored as one JSON file on
  disk (`data/showtimes.json`), written atomically. No database needed at
  this scale.
- `views/admin.html` — the showtime list + seat-map editor. Only served to
  authenticated requests.
- `public/login.html` — the password screen.

## Running locally

```bash
npm install
ADMIN_PASSWORD=whatever npm start
```

Then visit `http://localhost:3000`. If you don't set `ADMIN_PASSWORD`, the
server generates a random one and prints it to the console on startup.

## Deploying on Coolify

This repo is currently set to Coolify's "static" build pack — switch it to
**Dockerfile** (or "Application"/"Docker" depending on your Coolify
version) so it actually runs the Node server instead of being served as
static files. The included `Dockerfile` builds and runs the app directly.

1. In the Coolify resource settings, change the build pack from **Static**
   to **Dockerfile**.
2. Set environment variables:
   - `ADMIN_PASSWORD` — your password for the editor.
   - `SESSION_SECRET` — a long random string (e.g. `openssl rand -hex 32`),
     so logins survive restarts/redeploys.
3. Add a **persistent volume** — this is where `showtimes.json` lives.
   Without it, every redeploy gives the container a brand-new, empty
   filesystem and your showtimes are gone. The `Dockerfile`'s `VOLUME`
   line does *not* do this by itself — it just marks the path as
   volume-worthy; Coolify still needs to be told to actually attach a
   persistent volume there. In the Coolify UI, on this resource, open the
   **Storages** tab and add an entry with:
   - **Destination Path**: `/app/data` (must match `DATA_DIR`, default
     `/app/data` — leave `DATA_DIR` unset unless you changed this)
   - Name: anything (e.g. `canopy-data`)
   Save it, then redeploy so the running container picks it up.
4. Coolify will set `PORT` automatically; the app listens on whatever
   `PORT` is provided (defaulting to `3000`).
5. Deploy. Visit the app URL, enter your `ADMIN_PASSWORD`, and start adding
   showtimes.

### Confirming persistence actually works

On every boot the server logs how many showtimes it found on disk, e.g.:

```
[canopy-tickets] DATA_DIR=/app/data (3 showtime(s) found on disk at startup)
```

Check this in Coolify's deployment logs right after a redeploy. If it says
`0` but you know you'd already added showtimes, the volume above isn't
actually attached (Storages tab is empty, wrong destination path, or it
was added but the resource hasn't been redeployed since) — fix that and
redeploy again; nothing else changes.
