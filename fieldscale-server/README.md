# Fieldscale — Estimating, Takeoff, Invoicing & Job Costing for Contractors

From the first measurement to final profit, in one place. Fieldscale takes a small
contractor — in any trade — from a plan **takeoff** and a clean **estimate**, to the
**job**, the **invoice**, and a straight answer on whether the job actually made money.
No more juggling a takeoff app, a spreadsheet estimate, and a separate invoice tool that
don't talk to each other.

## The workflow it's built around

The whole app is one connected pipeline. Each step carries the customer, measurements,
scope and pricing forward automatically — you never retype them:

**Lead → Estimate / Proposal → (customer approves) → Job → Invoice → Profit**

1. **Lead** — capture a prospect (or let one come in through a public lead form).
2. **Estimate** — measure the plans or enter quantities, price it from your own price
   book, bundle items into assemblies, and send the customer a clean PDF proposal with a
   link to approve it online.
3. **Job** — turn a won estimate into a scheduled job with a scope-of-work checklist and
   status tracking. Its budget is locked in from the estimate.
4. **Invoice** — turn the job/estimate into an auto-numbered invoice in one click, with
   unpaid / partial / paid tracking.
5. **Job costing** — log real labor, material, sub and equipment costs (and change
   orders) as the work runs, and see profit, margin, and over/under budget on every job.

## What's in here

- `server.js` — the entire backend. Plain Node.js, **zero external dependencies**
  (uses only built-in modules: `http`, `crypto`, `fs`, `path`, `url`). Handles accounts
  and roles, per-company data, all of the above records, and proxies AI requests to
  Anthropic so your API key never reaches the browser. There is **no build step** and
  nothing to `npm install`.
- `public/` — the frontend. A set of plain HTML pages (one per screen) plus a shared
  nav (`app-nav.js`) and theme (`fs-theme.css`). Main screens:
  - Takeoff/plan viewer: `index.html`
  - Leads: `leads.html`, `lead.html`, plus a public intake form (`lead-form.html`)
  - Estimates & proposals: `estimates.html` / `proposals.html`, `estimate.html`
  - Customer approval (public, no login): `accept.html`
  - Jobs & scheduling: `jobs.html`, `job.html`, `schedule.html`, `followups.html`
  - Invoices: `invoices.html`, `invoice.html`
  - Purchase orders & work orders: `purchase-orders.html`, `po.html`,
    `workorders.html`, `workorder.html`
  - Customers: `customers.html`, `customer.html`
  - Reports & company/price-book settings: `reports.html`, `company.html`, `admin.html`
- `data/` — created automatically on first run. Your database. See below.

### What the takeoff screen does

Open a PDF plan set, set the scale (per sheet — a 1/4" floor plan and a 1"=20' site plan
can live in the same PDF), and measure walls, linear runs, areas, and counts against a
reusable type library. Drawn geometry belongs to the sheet it was drawn on. Claude helps
name sheets and select regions. The takeoff quantities feed straight into an estimate.

## Where your data lives

The database is a set of plain JSON files under `DATA_DIR` (defaults to `data/`), created
automatically on first run:

- `db.json` — users, companies, and settings.
- One folder per record type: `leads/`, `estimates/`, `estimate-revisions/`,
  `templates/`, `jobs/`, `workorders/`, `invoices/`, `purchase-orders/`, `customers/`,
  `pricebooks/`, `companies/`, `projects/` (takeoffs), and `receipts/`.

This is deliberately simple — fine for a small team. See "Scaling up" if that ever stops
being true. **Whatever is in `DATA_DIR` is the only copy of everyone's work — back it up.**

## Accounts, companies, and roles

- Data is scoped **per company**. Everyone in a company shares that company's customers,
  price book and records; they can't see another company's data.
- **The first account created on a server becomes the owner.** On a fresh server the
  login screen says so. Create yours before you give anyone the link.
- Three roles: **owner** (full control, including billing/company settings), **admin**
  (manage users and most settings), and **member** (day-to-day use). Owners/admins see
  **Manage Users** in the account menu (top right). From there you can:
  - **Add an account** — set a username and a temporary password; they change it after.
  - **Reset password** — for anyone who's forgotten theirs. This signs them out
    everywhere.
  - **Make admin / member** — promote or demote.
  - **Disable** — instantly blocks login but *keeps* their work. Reversible; use it when
    someone leaves.
  - **Delete** — removes the account **and everything they own**. Permanent.
  - **Sign-ups toggle** — when on, anyone with the link can create their own account.
    Turn it off once your team is set up.
- Guardrails: you can't demote, disable, or delete your own account, and the last
  remaining owner can't be removed — the server can't be locked out.
- Every member can change their own password from the account menu.

## AI usage and cost control

Some actions (AI sheet naming, AI Select) call Anthropic and are billed to your Anthropic
account. Two protections:

- Each user is capped at **100 AI requests per hour** by default. Change it with the
  `AI_CALLS_PER_HOUR` environment variable.
- The Manage Users panel shows a running **AI call count per person**.

## Running it locally

Requires Node.js 18 or newer (for built-in `fetch`). No `npm install` needed — there are
no dependencies.

```bash
cd fieldscale-server
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY and SESSION_SECRET
node server.js
```

Then open `http://localhost:3000` and create the first (owner) account.

Environment variables (see `.env.example`):
- `ANTHROPIC_API_KEY` — required for AI features. Get one at console.anthropic.com.
  **This is billed to your Anthropic account.**
- `SESSION_SECRET` — any long random string. Signs login sessions. If you don't set this,
  the server generates a random one on every restart, which logs everyone out every time
  it restarts/redeploys. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `PORT` — defaults to 3000.
- `DATA_DIR` — where the database lives. Point this at a persistent disk in production.
- `AI_CALLS_PER_HOUR` — per-user AI cap. Defaults to 100.

## Deploying so your team can access it

You need a host that runs a real Node.js process continuously (not a static-site host —
this has a backend). Reasonable options for a small team:

- **Render** (render.com) — free tier, easy "New Web Service from a Git repo" flow, set
  env vars in their dashboard. Good default choice.
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
6. Deploy. Open the URL and create your owner account **before** sharing the link.

**The one thing you must not skip:** the database lives on the server's disk. Most
platforms' default disks are *ephemeral* — wiped on every redeploy or restart. Attach a
**persistent disk / volume**, mount it (e.g. at `/data`), and set `DATA_DIR=/data`.
Without this you will eventually lose every account and every record. Do this before
anyone relies on it for real work.

## Testing it end to end

There's a real-browser test that walks the whole pipeline (register → lead → estimate →
customer approval → job → invoice) and reports pass/fail. It lives outside this folder so
the app stays dependency-free:

```bash
cd ../../fieldscale-e2e && ./run.sh
```

It spins up a throwaway copy with an empty database, so it never touches real data.

## Scaling up (if/when needed)

Deliberately simple: JSON files as the database. A reasonable starting point for a small
team, not a public product at scale. If this grows past a handful of companies or becomes
business-critical:
- Swap the JSON store for a real database (Postgres is the usual choice).
- Add email-based password reset (today, only an owner/admin can reset a forgotten one).
- HTTPS is handled automatically by Render/Railway/Fly; if self-hosting elsewhere, put
  this behind a reverse proxy (e.g. Caddy/nginx) for TLS.

## Security notes

- Passwords are hashed with `scrypt` (Node's built-in, no plaintext storage) and must be
  at least 8 characters.
- Sessions are signed tokens (HMAC-SHA256), 30-day expiry, sent as
  `Authorization: Bearer <token>`. Each token carries a version number — resetting a
  password or disabling an account bumps it, instantly invalidating that person's open
  sessions.
- Repeated failed logins are throttled (5 misses = a 1-minute cool-off).
- The Anthropic API key lives only in the server's environment — never sent to or stored
  in the browser.
- Data is scoped per company and per role, enforced server-side on every request, not
  just hidden in the UI. Public links (lead intake form, estimate approval) are the only
  no-login surfaces and are scoped to a single record by an unguessable token.
- The database is written atomically (temp file + rename), so a crash mid-write can't
  corrupt it.
