// Fieldscale backend — plain Node.js, zero external dependencies.
//
// Handles:
//   - User accounts (register / login / change password)
//   - Roles: the FIRST account created becomes the admin. Admins can add, disable,
//     delete, promote, and reset the password of any account.
//   - Signup control: admins can close open registration so only they can add people.
//   - Private per-user project storage (nobody can read anyone else's projects)
//   - A server-side proxy to Claude's API, so the Anthropic key never reaches the browser
//   - Per-user rate limiting on AI calls, so one person can't run up a huge bill
//
// Run: ANTHROPIC_API_KEY=sk-ant-... SESSION_SECRET=some-long-random-string node server.js

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('[fieldscale] WARNING: SESSION_SECRET not set — using a random one generated at startup.');
  console.warn('[fieldscale] Everyone will be logged out any time the server restarts. Set SESSION_SECRET in your environment for production.');
  return crypto.randomBytes(32).toString('hex');
})();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// How many AI calls one user may make per hour. Protects your Anthropic bill.
const AI_CALLS_PER_HOUR = parseInt(process.env.AI_CALLS_PER_HOUR || '100', 10);
// Ceiling on the token budget any single AI request may ask for. Wall tracing is the
// hungry one (a response full of coordinates); 8000 covers it with room to spare.
const MAX_AI_TOKENS = parseInt(process.env.MAX_AI_TOKENS || '8000', 10);
const MIN_PASSWORD_LENGTH = 8;

// ---------- Project storage layout ----------
// The PDF is ~99.9% of a project's bytes and NEVER changes after upload. The takeoff
// (walls, areas, counts, types, scales) is a few hundred KB of text and changes constantly.
// Storing them together meant every autosave rewrote the whole plan set — and because
// db.json is rewritten whole on every save, it meant rewriting EVERY user's plan set too.
//
// So they live apart, on disk, one folder per project:
//   data/projects/<id>/plan.pdf        the PDF, written once
//   data/projects/<id>/current.json    the takeoff — small, rewritten on every save
//   data/projects/<id>/snap-<ts>.json  point-in-time copies of the takeoff
//
// db.json now holds only metadata. A snapshot costs a few hundred KB, not 27MB, which is
// what makes keeping 20 of them affordable.
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const MAX_SNAPSHOTS = parseInt(process.env.MAX_SNAPSHOTS || '20', 10);
// Autosave fires every ~20s. Snapshotting every one of those would give you 20 snapshots
// covering seven minutes — useless. Space them out so the history reaches back hours.
const SNAPSHOT_MIN_INTERVAL_MS = parseInt(process.env.SNAPSHOT_MIN_INTERVAL_MS || '300000', 10); // 5 min

function projectDir(id){ return path.join(PROJECTS_DIR, id); }
function ensureProjectDir(id){
  const d = projectDir(id);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function planPath(id){ return path.join(projectDir(id), 'plan.pdf'); }
function currentPath(id){ return path.join(projectDir(id), 'current.json'); }

function readTakeoff(id){
  const f = currentPath(id);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}

// Writes via a temp file then renames. A rename is atomic on POSIX, so a crash mid-write
// can't leave a half-written current.json — you'd get the old one intact, not a corrupt
// file where someone's whole takeoff used to be.
function writeJsonAtomic(file, obj){
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function listSnapshots(id){
  const d = projectDir(id);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter(f => f.startsWith('snap-') && f.endsWith('.json'))
    .map(f => ({ file: f, at: parseInt(f.slice(5, -5), 10) || 0 }))
    .sort((a, b) => b.at - a.at);
}

// Copy the CURRENT saved state aside before it gets overwritten. This is the whole point:
// the thing worth keeping is what was there before this save, not after it.
function rotateSnapshot(id, force){
  const cur = currentPath(id);
  if (!fs.existsSync(cur)) return;
  const snaps = listSnapshots(id);
  const newest = snaps.length ? snaps[0].at : 0;
  if (!force && (Date.now() - newest) < SNAPSHOT_MIN_INTERVAL_MS) return;

  const stamp = Date.now();
  try {
    fs.copyFileSync(cur, path.join(projectDir(id), `snap-${stamp}.json`));
  } catch (e) { return; }

  // Prune the oldest beyond the cap.
  const all = listSnapshots(id);
  all.slice(MAX_SNAPSHOTS).forEach(sn => {
    try { fs.unlinkSync(path.join(projectDir(id), sn.file)); } catch (e) {}
  });
}

if (!ANTHROPIC_API_KEY) {
  console.warn('[fieldscale] WARNING: ANTHROPIC_API_KEY not set — AI features (auto-scale, AI select, sheet naming) will not work.');
}

// ---------- Tiny JSON "database" (fine for a small team; swap for real DB later if needed) ----------
function loadDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], projects: [], settings: { allowSignups: true } }, null, 2));
  }
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // Fill in anything missing so older db.json files keep working after an upgrade.
  parsed.users = parsed.users || [];
  parsed.projects = parsed.projects || [];
  parsed.settings = Object.assign({ allowSignups: true }, parsed.settings || {});
  parsed.users.forEach((u, i) => {
    if (!u.role) u.role = i === 0 ? 'admin' : 'member'; // existing installs: oldest account becomes admin
    if (typeof u.disabled !== 'boolean') u.disabled = false;
    if (typeof u.tokenVersion !== 'number') u.tokenVersion = 1;
    if (typeof u.aiCalls !== 'number') u.aiCalls = 0;
  });
  migrateProjectsToDisk(parsed);
  return parsed;
}

// Projects saved before the split have their PDF and takeoff sitting inside db.json.
// Move them out to disk, once, on startup. Runs on every boot but does nothing after the
// first — a project is migrated when it no longer carries a `data` blob.
function migrateProjectsToDisk(db) {
  if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  let moved = 0;
  db.projects.forEach(p => {
    if (!p.data) return;              // already migrated
    ensureProjectDir(p.id);
    const data = p.data || {};
    if (data.pdfBase64) {
      try {
        fs.writeFileSync(planPath(p.id), Buffer.from(data.pdfBase64, 'base64'));
        p.hasPdf = true;
      } catch (e) {
        console.warn(`[fieldscale] Could not migrate PDF for project ${p.id}: ${e.message}`);
      }
      delete data.pdfBase64;
    }
    try { writeJsonAtomic(currentPath(p.id), data); } catch (e) {
      console.warn(`[fieldscale] Could not migrate takeoff for project ${p.id}: ${e.message}`);
      return;
    }
    delete p.data;                    // db.json is metadata only from here on
    moved++;
  });
  if (moved) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    console.log(`[fieldscale] Migrated ${moved} project(s) out of db.json onto disk. Nothing was lost.`);
  }
}
// Write to a temp file first, then rename. A crash mid-write can't leave a half-written
// db.json behind — the rename is atomic.
function saveDB(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
let db = loadDB();

// ---------- Password hashing (scrypt, built into Node — no bcrypt dependency needed) ----------
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function validatePassword(pw) {
  if (!pw || typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
function validateUsername(name) {
  const uname = (name || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(uname)) {
    return { error: 'Username must be 3–32 characters: letters, numbers, dots, dashes or underscores.' };
  }
  return { uname };
}

// ---------- Session tokens (simple signed tokens — no JWT library needed) ----------
// The token carries a "tv" (token version). Bumping a user's tokenVersion instantly
// invalidates every token they hold — that's how a password reset or a disable kicks
// someone out of sessions they already have open.
function createToken(user) {
  const payload = JSON.stringify({ uid: user.id, tv: user.tokenVersion, exp: Date.now() + 30 * 24 * 3600 * 1000 });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}
function verifyToken(token) {
  if (!token) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
// Returns the live user record, or null if the token is bad / expired / revoked / disabled.
function getAuthedUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = db.users.find(u => u.id === payload.uid);
  if (!user) return null;
  if (user.disabled) return null;
  if (payload.tv !== user.tokenVersion) return null; // password was reset, or sessions revoked
  return user;
}
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    aiCalls: u.aiCalls || 0,
    projectCount: db.projects.filter(p => p.userId === u.id).length
  };
}
function adminCount() {
  return db.users.filter(u => u.role === 'admin' && !u.disabled).length;
}

// ---------- Rate limiting for AI calls (in-memory, per user, rolling hour) ----------
const aiCallLog = new Map(); // userId -> array of timestamps
function checkAiRateLimit(userId) {
  const now = Date.now();
  const hourAgo = now - 3600 * 1000;
  const recent = (aiCallLog.get(userId) || []).filter(t => t > hourAgo);
  if (recent.length >= AI_CALLS_PER_HOUR) {
    const oldest = recent[0];
    const minutes = Math.max(1, Math.ceil((oldest + 3600 * 1000 - now) / 60000));
    return `You've hit the limit of ${AI_CALLS_PER_HOUR} AI requests per hour. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  recent.push(now);
  aiCallLog.set(userId, recent);
  return null;
}

// ---------- Login throttling (slows down password guessing) ----------
const loginFails = new Map(); // username -> { count, until }
function loginBlocked(uname) {
  const rec = loginFails.get(uname);
  if (rec && rec.until > Date.now()) {
    const secs = Math.ceil((rec.until - Date.now()) / 1000);
    return `Too many failed attempts. Try again in ${secs} second${secs === 1 ? '' : 's'}.`;
  }
  return null;
}
function noteLoginFail(uname) {
  const rec = loginFails.get(uname) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) { rec.until = Date.now() + 60 * 1000; rec.count = 0; } // 1 minute cool-off
  loginFails.set(uname, rec);
}

// ---------- Helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const MAX = 25 * 1024 * 1024; // 25MB cap (project blobs can include a base64 PDF)
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA fallback: unknown routes serve index.html so client-side view logic can handle them
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexContent) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(indexContent);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  });
}

// ---------- Request handler ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    // ---- Health check (hosting platforms ping this) ----
    if (pathname === '/api/health') {
      return sendJSON(res, 200, { ok: true, users: db.users.length });
    }

    // ---- Public config: tells the login screen whether to show "Create one" ----
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJSON(res, 200, {
        allowSignups: db.settings.allowSignups || db.users.length === 0, // first account can always be made
        firstRun: db.users.length === 0,
        minPasswordLength: MIN_PASSWORD_LENGTH
      });
    }

    // ---- Auth: register ----
    if (pathname === '/api/register' && req.method === 'POST') {
      const isFirstUser = db.users.length === 0;
      if (!db.settings.allowSignups && !isFirstUser) {
        return sendJSON(res, 403, { error: 'New signups are closed. Ask an administrator to create an account for you.' });
      }
      const { username, password } = await readBody(req);
      const nameCheck = validateUsername(username);
      if (nameCheck.error) return sendJSON(res, 400, { error: nameCheck.error });
      const pwErr = validatePassword(password);
      if (pwErr) return sendJSON(res, 400, { error: pwErr });
      if (db.users.find(u => u.username === nameCheck.uname)) {
        return sendJSON(res, 409, { error: 'That username is already taken.' });
      }
      const { salt, hash } = hashPassword(password);
      const user = {
        id: 'u_' + crypto.randomBytes(8).toString('hex'),
        username: nameCheck.uname,
        salt, hash,
        role: isFirstUser ? 'admin' : 'member', // the very first account runs the place
        disabled: false,
        tokenVersion: 1,
        aiCalls: 0,
        createdAt: Date.now(),
        lastLoginAt: Date.now()
      };
      db.users.push(user);
      saveDB(db);
      return sendJSON(res, 200, { token: createToken(user), username: user.username, role: user.role });
    }

    // ---- Auth: login ----
    if (pathname === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      const uname = (username || '').trim().toLowerCase();
      const blocked = loginBlocked(uname);
      if (blocked) return sendJSON(res, 429, { error: blocked });

      const user = db.users.find(u => u.username === uname);
      if (!user || !verifyPassword(password || '', user.salt, user.hash)) {
        noteLoginFail(uname);
        return sendJSON(res, 401, { error: 'Incorrect username or password.' });
      }
      if (user.disabled) {
        return sendJSON(res, 403, { error: 'This account has been disabled. Contact an administrator.' });
      }
      loginFails.delete(uname);
      user.lastLoginAt = Date.now();
      saveDB(db);
      return sendJSON(res, 200, { token: createToken(user), username: user.username, role: user.role });
    }

    // ---- Everything past this point requires a valid session ----
    if (pathname.startsWith('/api/')) {
      const me = getAuthedUser(req);
      if (!me) return sendJSON(res, 401, { error: 'Not logged in (or session expired) — please log in again.' });
      const userId = me.id;

      // GET /api/me
      if (pathname === '/api/me' && req.method === 'GET') {
        return sendJSON(res, 200, { username: me.username, role: me.role, id: me.id });
      }

      // POST /api/password — change your own password
      if (pathname === '/api/password' && req.method === 'POST') {
        const { currentPassword, newPassword } = await readBody(req);
        if (!verifyPassword(currentPassword || '', me.salt, me.hash)) {
          return sendJSON(res, 401, { error: 'Your current password is not correct.' });
        }
        const pwErr = validatePassword(newPassword);
        if (pwErr) return sendJSON(res, 400, { error: pwErr });
        const { salt, hash } = hashPassword(newPassword);
        me.salt = salt; me.hash = hash;
        me.tokenVersion += 1; // log out other devices
        saveDB(db);
        return sendJSON(res, 200, { token: createToken(me), changed: true });
      }

      // ======================= ADMIN =======================
      if (pathname.startsWith('/api/admin/')) {
        if (me.role !== 'admin') return sendJSON(res, 403, { error: 'Administrators only.' });

        // GET /api/admin/users — everyone, with activity info
        if (pathname === '/api/admin/users' && req.method === 'GET') {
          return sendJSON(res, 200, {
            users: db.users.map(publicUser).sort((a, b) => a.createdAt - b.createdAt),
            settings: db.settings,
            aiCallsPerHour: AI_CALLS_PER_HOUR
          });
        }

        // POST /api/admin/users — create an account for someone
        if (pathname === '/api/admin/users' && req.method === 'POST') {
          const { username, password, role } = await readBody(req);
          const nameCheck = validateUsername(username);
          if (nameCheck.error) return sendJSON(res, 400, { error: nameCheck.error });
          const pwErr = validatePassword(password);
          if (pwErr) return sendJSON(res, 400, { error: pwErr });
          if (db.users.find(u => u.username === nameCheck.uname)) {
            return sendJSON(res, 409, { error: 'That username is already taken.' });
          }
          const { salt, hash } = hashPassword(password);
          const user = {
            id: 'u_' + crypto.randomBytes(8).toString('hex'),
            username: nameCheck.uname, salt, hash,
            role: role === 'admin' ? 'admin' : 'member',
            disabled: false, tokenVersion: 1, aiCalls: 0,
            createdAt: Date.now(), lastLoginAt: null
          };
          db.users.push(user);
          saveDB(db);
          return sendJSON(res, 200, { user: publicUser(user) });
        }

        // PATCH/DELETE /api/admin/users/:id
        const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([a-zA-Z0-9_]+)$/);
        if (adminUserMatch) {
          const target = db.users.find(u => u.id === adminUserMatch[1]);
          if (!target) return sendJSON(res, 404, { error: 'That account no longer exists.' });

          if (req.method === 'PATCH') {
            const { role, disabled, password } = await readBody(req);

            // Guardrails: don't let an admin lock everyone (including themselves) out.
            if (target.id === me.id && role === 'member') {
              return sendJSON(res, 400, { error: "You can't remove your own administrator access. Promote someone else first." });
            }
            if (target.id === me.id && disabled === true) {
              return sendJSON(res, 400, { error: "You can't disable your own account." });
            }
            if (target.role === 'admin' && (role === 'member' || disabled === true) && adminCount() <= 1) {
              return sendJSON(res, 400, { error: 'This is the only administrator. Promote someone else first.' });
            }

            if (role === 'admin' || role === 'member') target.role = role;
            if (typeof disabled === 'boolean') {
              target.disabled = disabled;
              if (disabled) target.tokenVersion += 1; // kick them out of any open session immediately
            }
            if (password !== undefined) {
              const pwErr = validatePassword(password);
              if (pwErr) return sendJSON(res, 400, { error: pwErr });
              const { salt, hash } = hashPassword(password);
              target.salt = salt; target.hash = hash;
              target.tokenVersion += 1; // old sessions die with the old password
            }
            saveDB(db);
            return sendJSON(res, 200, { user: publicUser(target) });
          }

          if (req.method === 'DELETE') {
            if (target.id === me.id) {
              return sendJSON(res, 400, { error: "You can't delete your own account." });
            }
            if (target.role === 'admin' && adminCount() <= 1) {
              return sendJSON(res, 400, { error: 'This is the only administrator. Promote someone else first.' });
            }
            const removedProjects = db.projects.filter(p => p.userId === target.id).length;
            db.projects = db.projects.filter(p => p.userId !== target.id); // their projects go too
            db.users = db.users.filter(u => u.id !== target.id);
            saveDB(db);
            return sendJSON(res, 200, { deleted: true, removedProjects });
          }
        }

        // PUT /api/admin/settings — e.g. open or close signups
        if (pathname === '/api/admin/settings' && req.method === 'PUT') {
          const { allowSignups } = await readBody(req);
          if (typeof allowSignups === 'boolean') db.settings.allowSignups = allowSignups;
          saveDB(db);
          return sendJSON(res, 200, { settings: db.settings });
        }

        return sendJSON(res, 404, { error: 'Unknown admin route.' });
      }
      // ===================== END ADMIN =====================

      // GET /api/projects — list this user's projects (metadata only, not full data)
      if (pathname === '/api/projects' && req.method === 'GET') {
        const list = db.projects
          .filter(p => p.userId === userId)
          .map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }

      // POST /api/projects — create a new project (metadata only; PDF is uploaded separately)
      if (pathname === '/api/projects' && req.method === 'POST') {
        const { name, data } = await readBody(req);
        const project = {
          id: 'p_' + crypto.randomBytes(8).toString('hex'),
          userId, name: name || 'Untitled Project',
          hasPdf: false,
          createdAt: Date.now(), updatedAt: Date.now()
        };
        ensureProjectDir(project.id);
        writeJsonAtomic(currentPath(project.id), data || {});
        db.projects.push(project);
        saveDB(db);
        return sendJSON(res, 200, { id: project.id, name: project.name, updatedAt: project.updatedAt });
      }

      // /api/projects/:id/pdf — the plan set. Written once, read once. Kept out of every
      // other request so a 27MB payload isn't riding along on a 20-second autosave.
      const pdfMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_]+)\/pdf$/);
      if (pdfMatch) {
        const project = db.projects.find(p => p.id === pdfMatch[1] && p.userId === userId);
        if (!project) return sendJSON(res, 404, { error: 'Project not found.' });

        if (req.method === 'PUT') {
          const { pdfBase64 } = await readBody(req);
          if (!pdfBase64) return sendJSON(res, 400, { error: 'No PDF supplied.' });
          ensureProjectDir(project.id);
          fs.writeFileSync(planPath(project.id), Buffer.from(pdfBase64, 'base64'));
          project.hasPdf = true;
          project.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { ok: true });
        }
        if (req.method === 'GET') {
          if (!project.hasPdf || !fs.existsSync(planPath(project.id))) {
            return sendJSON(res, 200, { pdfBase64: null });
          }
          const buf = fs.readFileSync(planPath(project.id));
          return sendJSON(res, 200, { pdfBase64: buf.toString('base64') });
        }
      }

      // /api/projects/:id/snapshots — the version history.
      const snapListMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_]+)\/snapshots$/);
      if (snapListMatch && req.method === 'GET') {
        const project = db.projects.find(p => p.id === snapListMatch[1] && p.userId === userId);
        if (!project) return sendJSON(res, 404, { error: 'Project not found.' });
        const snaps = listSnapshots(project.id).map(sn => {
          let counts = null;
          try {
            const d = JSON.parse(fs.readFileSync(path.join(projectDir(project.id), sn.file), 'utf8'));
            counts = {
              items: (d.items || []).length,
              walls: (d.walls || []).length,
              areas: (d.areas || []).length
            };
          } catch (e) {}
          return { at: sn.at, counts };
        });
        return sendJSON(res, 200, snaps);
      }

      // POST /api/projects/:id/restore — roll back to a snapshot. The state being replaced
      // is snapshotted first, so "restore" is itself undoable. Restoring a bad restore is
      // exactly the moment you'd want that.
      const restoreMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_]+)\/restore$/);
      if (restoreMatch && req.method === 'POST') {
        const project = db.projects.find(p => p.id === restoreMatch[1] && p.userId === userId);
        if (!project) return sendJSON(res, 404, { error: 'Project not found.' });
        const { at } = await readBody(req);
        const file = path.join(projectDir(project.id), `snap-${parseInt(at, 10)}.json`);
        if (!fs.existsSync(file)) return sendJSON(res, 404, { error: 'That snapshot no longer exists.' });

        rotateSnapshot(project.id, true);           // keep what we're about to overwrite
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        writeJsonAtomic(currentPath(project.id), data);
        project.updatedAt = Date.now();
        saveDB(db);
        return sendJSON(res, 200, { restored: true, data });
      }

      // /api/projects/:id — get / update / delete a single project (must belong to this user)
      const projMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_]+)$/);
      if (projMatch) {
        const id = projMatch[1];
        const project = db.projects.find(p => p.id === id && p.userId === userId);
        if (!project) return sendJSON(res, 404, { error: 'Project not found.' });

        if (req.method === 'GET') {
          // The takeoff only. The PDF comes from /pdf, separately.
          return sendJSON(res, 200, {
            id: project.id, name: project.name, hasPdf: !!project.hasPdf,
            createdAt: project.createdAt, updatedAt: project.updatedAt,
            data: readTakeoff(project.id)
          });
        }
        if (req.method === 'PUT') {
          const { name, data, manual } = await readBody(req);
          if (name !== undefined) project.name = name;
          if (data !== undefined) {
            ensureProjectDir(project.id);
            // Snapshot the OUTGOING state before it's overwritten. A manual save is an
            // intentional checkpoint, so it always snapshots; autosaves are spaced out.
            rotateSnapshot(project.id, !!manual);
            writeJsonAtomic(currentPath(project.id), data);
          }
          project.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: project.id, name: project.name, updatedAt: project.updatedAt });
        }
        if (req.method === 'DELETE') {
          db.projects = db.projects.filter(p => p.id !== id);
          try { fs.rmSync(projectDir(id), { recursive: true, force: true }); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // POST /api/claude — proxies a vision request to Anthropic using the server-held key
      if (pathname === '/api/claude' && req.method === 'POST') {
        if (!ANTHROPIC_API_KEY) {
          return sendJSON(res, 500, { error: 'Server has no ANTHROPIC_API_KEY configured — ask whoever deployed this to set one.' });
        }
        const limited = checkAiRateLimit(userId);
        if (limited) return sendJSON(res, 429, { error: limited });

        const { image, prompt, max_tokens } = await readBody(req);
        if (!image || !prompt) return sendJSON(res, 400, { error: 'Missing image or prompt.' });

        // The browser asks for a token budget, but it doesn't get to name any number it
        // likes — that's our Anthropic bill. The per-hour limit caps how MANY calls a
        // person can make; this caps how expensive each one is allowed to be.
        // 8000 comfortably fits a wall-tracing response (lots of coordinates).
        const tokenBudget = Math.min(Math.max(parseInt(max_tokens, 10) || 500, 1), MAX_AI_TOKENS);

        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: tokenBudget,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
                { type: 'text', text: prompt }
              ]
            }]
          })
        });
        const data = await anthropicRes.json();
        if (data.error) return sendJSON(res, 502, { error: data.error.message || 'Anthropic API error' });

        me.aiCalls = (me.aiCalls || 0) + 1; // so admins can see who's using what
        saveDB(db);

        const textOut = (data.content || []).map(b => b.text || '').join('\n');
        return sendJSON(res, 200, { text: textOut });
      }

      return sendJSON(res, 404, { error: 'Unknown API route.' });
    }

    // ---- Static frontend ----
    serveStatic(req, res, pathname);
  } catch (err) {
    sendJSON(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`[fieldscale] Server running on http://localhost:${PORT}`);
  if (db.users.length === 0) {
    console.log('[fieldscale] No accounts yet. The first account you create becomes the administrator.');
  }
});
