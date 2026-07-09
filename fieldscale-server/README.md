# Fieldscale — Construction Takeoff Tool

A browser-based construction takeoff app (PDF plan viewer, calibrated measurements,
a reusable Wall/Linear/Area/Count type library, AI-assisted scale detection and
sheet naming, full-plan-set search) with a small backend for private accounts and
saved projects.

## What's in here

- `server.js` — the entire backend. Plain Node.js, **zero external dependencies**
  (uses only built-in modules: `http`, `crypto`, `fs`, `path`). Handles user
  accounts, private per-user project storage, and proxies AI requests to Anthropic
  so your API key never reaches the browser.
- `public/index.html` — the entire frontend (one file: HTML/CSS/JS).
- `data/db.json` — created automatically on first run. This is your database
  (users + projects), stored as a single JSON file. Fine for a small team; see
  "Scaling up" below if that ever stops being true.

## Running it locally

Requires Node.js 18 or newer (for built-in `fetch`). No `npm install` needed —
there are no dependencies.

```bash
cd fieldscale-server
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY and SESSION_SECRET
node server.js
```

Then open `http://localhost:3000`. Create an account, log in, upload a plan.

Environment variables (see `.env.example`):
- `ANTHROPIC_API_KEY` — required for AI features (Auto-Detect Scale, AI Select,
  automatic sheet naming). Get one at console.anthropic.com. **This is billed to
  your Anthropic account** — every AI call (scale detection, region analysis, and
  one call per sheet for auto-naming) uses your credits.
- `SESSION_SECRET` — any long random string. Signs login sessions. If you don't
  set this, the server generates a random one on every restart, which logs
  everyone out every time it restarts/redeploys. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `PORT` — defaults to 3000.

## Deploying so your team can access it

You need a host that runs a real Node.js process continuously (not a static-site
host — this has a backend). Reasonable options for a 2-5 person team, roughly
cheapest/simplest first:

- **Render** (render.com) — free tier available, easy "New Web Service from a Git
  repo" flow, set env vars in their dashboard. Good default choice.
- **Railway** (railway.app) — similarly simple, usage-based pricing.
- **Fly.io** — a bit more configuration, good if you want more control.

General steps (same shape on any of them):
1. Push this folder to a GitHub repo.
2. Connect that repo to the hosting platform.
3. Set the build command to nothing (no build step needed) and the start command
   to `node server.js`.
4. Set the `ANTHROPIC_API_KEY` and `SESSION_SECRET` environment variables in the
   platform's dashboard — **never commit them to the repo**.
5. Deploy. Give your team the URL.

**Important:** `data/db.json` lives on the server's local disk. Most hosting
platforms' free/basic tiers use *ephemeral* disks — meaning your database can be
wiped on redeploy or restart. Check your platform's docs for a "persistent disk"
or "volume" option and mount it at the `data/` folder, or you will eventually lose
everyone's saved projects. This is the single most important thing to get right
before relying on this for real work.

## Scaling up (if/when needed)

This is intentionally simple — one JSON file as the database, no user roles, no
password reset flow, no rate limiting. That's a reasonable starting point for a
small internal team, not a public product. If this grows past a handful of users
or becomes business-critical, the next steps would be:
- Swap `data/db.json` for a real database (Postgres is the usual choice)
- Add password reset (currently there's no way to recover a forgotten password —
  someone with server access would need to manually reset it in `data/db.json`)
- Add rate limiting on `/api/claude` so one person can't accidentally run up a
  huge bill
- HTTPS is handled automatically by Render/Railway/Fly; if self-hosting elsewhere,
  put this behind a reverse proxy (e.g. Caddy/nginx) for TLS

## Security notes

- Passwords are hashed with `scrypt` (Node's built-in, no plaintext storage).
- Sessions are signed tokens (HMAC-SHA256), 30-day expiry, sent as
  `Authorization: Bearer <token>`.
- The Anthropic API key lives only in the server's environment variables —
  it is never sent to or stored in the browser.
- Each user can only see and modify their own projects (enforced server-side on
  every request, not just hidden in the UI).
