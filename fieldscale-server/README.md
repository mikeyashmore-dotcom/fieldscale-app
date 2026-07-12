# Fieldscale — Construction Takeoff Tool

A browser-based construction takeoff app (PDF plan viewer, calibrated measurements,
a reusable Wall/Linear/Area/Count type library, AI-assisted scale detection and
sheet naming, full-plan-set search) with a backend for private accounts, saved
projects, and user management.

## What's in here

- `server.js` — the entire backend. Plain Node.js, **zero external dependencies**
  (uses only built-in modules: `http`, `crypto`, `fs`, `path`). Handles user
  accounts and roles, private per-user project storage, and proxies AI requests to
  Anthropic so your API key never reaches the browser.
- `public/index.html` — the entire frontend (one file: HTML/CSS/JS).
- `data/db.json` — created automatically on first run. This is your database
  (users + projects + settings), stored as a single JSON file. Fine for a small
  team; see "Scaling up" below if that ever stops being true.
- `NOTES.md` — plain-language summary of the project state. Start here.

## Accounts, roles, and user management

- **The first account created becomes the administrator.** On a fresh server the
  login screen says so explicitly. Create yours before you give anyone the link.
- Administrators see **Manage Users** in the account menu (top right). From there:
  - **Add an account** — set a username and a temporary password, hand it to the
    person, they change it themselves afterwards.
  - **Reset password** — for anyone who's forgotten theirs. This immediately signs
    them out of every device.
  - **Make admin / Make member** — promote or demote.
  - **Disable** — instantly kicks them out and blocks login, but *keeps* their
    projects. This is what you want when someone leaves; it's reversible.
  - **Delete** — removes the account **and every project they saved**. Permanent.
  - **Sign-ups toggle** — when on, anyone with the link can create their own
    account. Turn it off once your team is set up, and only you can add people.
- Guardrails: you can't demote, disable, or delete your own account, and the last
  remaining administrator can't be removed. The server can't be locked out.
- Every member can change their own password from the account menu.

## AI usage and cost control

Every AI action (Auto-Detect Scale, AI Select, sheet auto-naming) is billed to your
Anthropic account. Two things protect you:

- Each user is capped at **100 AI requests per hour** by default. Change it with the
  `AI_CALLS_PER_HOUR` environment variable.
- The Manage Users panel shows a running **AI call count per person**, so you can
  see who's using what.

## Running it locally

Requires Node.js 18 or newer (for built-in `fetch`). No `npm install` needed —
there are no dependencies.

```bash
cd fieldscale-server
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY and SESSION_SECRET
node server.js
```

Then open `http://localhost:3000` and create the first (admin) account.

Environment variables (see `.env.example`):
- `ANTHROPIC_API_KEY` — required for AI features. Get one at console.anthropic.com.
  **This is billed to your Anthropic account.**
- `SESSION_SECRET` — any long random string. Signs login sessions. If you don't
  set this, the server generates a random one on every restart, which logs
  everyone out every time it restarts/redeploys. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `PORT` — defaults to 3000.
- `DATA_DIR` — where `db.json` lives. Point this at a persistent disk in production.
- `AI_CALLS_PER_HOUR` — per-user AI cap. Defaults to 100.

## Deploying so your team can access it

You need a host that runs a real Node.js process continuously (not a static-site
host — this has a backend). Reasonable options for a 2–5 person team:

- **Render** (render.com) — free tier available, easy "New Web Service from a Git
  repo" flow, set env vars in their dashboard. Good default choice.
- **Railway** (railway.app) — similarly simple, usage-based pricing.
- **Fly.io** — a bit more configuration, good if you want more control.

General steps (same shape on any of them):
1. Push this folder to a GitHub repo.
2. Connect that repo to the hosting platform.
3. Leave the build command empty (no build step needed); set the start command to
   `node server.js`.
4. Set `ANTHROPIC_API_KEY` and `SESSION_SECRET` in the platform's dashboard —
   **never commit them to the repo**.
5. Add a persistent disk (see below) and set `DATA_DIR` to its mount path.
6. Deploy. Open the URL and create your admin account **before** sharing the link.

**The one thing you must not skip:** `data/db.json` lives on the server's disk.
Most platforms' default disks are *ephemeral* — wiped on every redeploy or restart.
Attach a **persistent disk / volume**, mount it (e.g. at `/data`), and set
`DATA_DIR=/data`. Without this you will eventually lose every account and every
saved project. Do this before anyone relies on it for real work.

## Scaling up (if/when needed)

Deliberately simple: one JSON file as the database. That's a reasonable starting
point for a small internal team, not a public product. If this grows past a handful
of users or becomes business-critical:
- Swap `data/db.json` for a real database (Postgres is the usual choice)
- Add email-based password reset (today, only an admin can reset a forgotten one)
- Add shared/team projects (today every project is private to one person)
- HTTPS is handled automatically by Render/Railway/Fly; if self-hosting elsewhere,
  put this behind a reverse proxy (e.g. Caddy/nginx) for TLS

## Security notes

- Passwords are hashed with `scrypt` (Node's built-in, no plaintext storage) and
  must be at least 8 characters.
- Sessions are signed tokens (HMAC-SHA256), 30-day expiry, sent as
  `Authorization: Bearer <token>`. Each token carries a version number — resetting a
  password or disabling an account bumps it, which instantly invalidates every
  session that person had open.
- Repeated failed logins are throttled (5 misses = a 1-minute cool-off).
- The Anthropic API key lives only in the server's environment variables — it is
  never sent to or stored in the browser.
- Each user can only see and modify their own projects, and only administrators can
  reach `/api/admin/*`. Both are enforced server-side on every request, not just
  hidden in the UI.
- The database is written atomically (temp file + rename), so a crash mid-write
  can't corrupt it.
