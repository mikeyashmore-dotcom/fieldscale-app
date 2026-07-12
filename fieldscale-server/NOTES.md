# Fieldscale — Project Notes

> Read this first at the start of a new chat, then say what you want to work on.
> Update the "Where we left off" section whenever something changes.

## What this is

Fieldscale is a construction takeoff tool that runs in a web browser. You open a
PDF plan set, set the scale, and measure walls, areas, linear runs, and counts
against a reusable type library. Claude helps detect the scale, name sheets, and
select regions. Multiple people can use it — each has their own login and their
own private saved projects.

## How it's put together

Two pieces, and that's the whole thing:

- **`public/index.html`** — the entire app you see in the browser. One file:
  the layout, the styling, and all the browser-side logic.
- **`server.js`** — the backend. Plain Node.js with **zero installed packages**.
  It handles logins, stores projects, and forwards AI requests to Anthropic so
  the API key stays on the server and never reaches anyone's browser.
- **`data/db.json`** — the database. A single file, created automatically on
  first run. Holds all users and all projects.

There is no build step. `node server.js` is the whole thing.

## Accounts and roles

- **The first account created on a server becomes the administrator.** Make yours
  first.
- Administrators get a **Manage Users** item in the account menu (top right). From
  there they can add accounts, reset passwords, promote/demote, disable, and
  delete people, and open or close public sign-ups.
- Everyone else is a **member**: they can only see and change their own projects.
- Anyone can change their own password from the account menu.
- AI requests are capped **per person, per hour** (default 100) so nobody can
  accidentally run up the Anthropic bill.

## Running it on your own computer

Needs Node.js 18 or newer. Nothing to install.

```bash
cd fieldscale-server
cp .env.example .env      # then open .env and fill in the values
node server.js
```

Open http://localhost:3000 and create your account — the first one is the admin.

## Scales are per sheet

Every sheet in a plan set keeps its **own** scale — a 1/4" floor plan and a 1"=20' site
plan can sit in the same PDF. The scale button in the top bar always shows the scale of
the sheet you're looking at, and the sheet list shows a filled diamond next to sheets
that have one. If the whole set really is one scale, the scale panel has a "Use this
scale on all sheets" button.

Because of this, drawn geometry (walls, areas, counts, quick measures) belongs to the
sheet it was drawn on and only appears there. The CSV export has a Sheet column.

## Where we left off

- Backend now has: roles, user management, password change, admin password reset,
  session revocation, sign-up lock, login throttling, per-user AI rate limits.
- Scales are now per-sheet, geometry is page-scoped, and new projects are named up
  front (the "＋ New Project" button asks for a name, then opens the file picker).
- **Not deployed yet.** Next step is putting it on a host (Render is the plan) with
  a persistent disk mounted at the `data/` folder — see README for why that matters.
- Not built yet: password reset by email (right now only an admin can reset a
  forgotten password), shared/team projects (everything is private per person).

## Things to remember

- Never put the real `.env` file in GitHub. `.gitignore` already blocks it.
- After every working session, push to GitHub so it stays the source of truth.
- `data/db.json` is the only copy of everyone's work. Back it up.
