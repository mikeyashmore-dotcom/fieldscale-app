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
// The deployment owner can name themselves platform admin here, regardless of who signed up
// first. Set PLATFORM_ADMIN_USERNAME to your username and you always get the cross-company view.
const PLATFORM_ADMIN_USERNAME = (process.env.PLATFORM_ADMIN_USERNAME || '').trim().toLowerCase();
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

// ---------- Estimating: per-user price book ----------
// A price book is this user's saved list of priced work items. It's small text, private to
// one person, and read/written as a whole — so it lives in its own per-user file rather than
// bloating db.json (same reasoning that keeps takeoffs out of db.json).
const PRICEBOOKS_DIR = path.join(DATA_DIR, 'pricebooks');
function pricebookPath(userId){ return path.join(PRICEBOOKS_DIR, userId + '.json'); }

// New price books start EMPTY. This tool serves every trade, so we don't presume one — the
// contractor builds their own list (or loads a generic multi-trade sample from the UI, which
// they then edit to their real costs). Items are classified by CSI MasterFormat division.
const DEFAULT_PRICEBOOK = [];

function readPricebook(userId){
  const f = pricebookPath(userId);
  if (!fs.existsSync(f)) return null; // null = "this user has never saved one yet"
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(d.items) ? d.items : []; }
  catch (e) { return []; }
}
function writePricebook(userId, items){
  if (!fs.existsSync(PRICEBOOKS_DIR)) fs.mkdirSync(PRICEBOOKS_DIR, { recursive: true });
  writeJsonAtomic(pricebookPath(userId), { items });
}

// ---------- Company profile (per-user, set once, auto-fills every estimate) ----------
const COMPANIES_DIR = path.join(DATA_DIR, 'companies');
function companyPath(userId){ return path.join(COMPANIES_DIR, userId + '.json'); }
function readCompany(userId){
  const f = companyPath(userId);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writeCompany(userId, profile){
  if (!fs.existsSync(COMPANIES_DIR)) fs.mkdirSync(COMPANIES_DIR, { recursive: true });
  writeJsonAtomic(companyPath(userId), profile);
}

// ---------- Estimating: proposals/estimates ----------
// db.json holds lightweight metadata per estimate (for listing); the full document — header,
// line items, totals, notes — lives in its own small file on disk, one per estimate.
const ESTIMATES_DIR = path.join(DATA_DIR, 'estimates');
function estimatePath(id){ return path.join(ESTIMATES_DIR, id + '.json'); }
function readEstimateDoc(id){
  const f = estimatePath(id);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writeEstimateDoc(id, doc){
  if (!fs.existsSync(ESTIMATES_DIR)) fs.mkdirSync(ESTIMATES_DIR, { recursive: true });
  writeJsonAtomic(estimatePath(id), doc || {});
}

// ---------- Invoicing (mirrors estimates: db.json metadata + a per-invoice doc on disk) ----------
const INVOICES_DIR = path.join(DATA_DIR, 'invoices');
function invoicePath(id){ return path.join(INVOICES_DIR, id + '.json'); }
function readInvoiceDoc(id){
  const f = invoicePath(id);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writeInvoiceDoc(id, doc){
  if (!fs.existsSync(INVOICES_DIR)) fs.mkdirSync(INVOICES_DIR, { recursive: true });
  writeJsonAtomic(invoicePath(id), doc || {});
}
// ---------- Projects/Jobs (the won work to schedule and do) ----------
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
function jobPath(id){ return path.join(JOBS_DIR, id + '.json'); }
function readJobDoc(id){
  const f = jobPath(id);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writeJobDoc(id, doc){
  if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
  writeJsonAtomic(jobPath(id), doc || {});
}
const JOB_STATUSES = ['scheduled', 'in progress', 'complete', 'on hold'];

// Payment status from what's been paid against the total.
function invoiceStatus(total, paid){
  total = Number(total) || 0; paid = Number(paid) || 0;
  if (paid <= 0) return 'unpaid';
  if (paid + 0.005 >= total) return 'paid';
  return 'partial';
}

if (!ANTHROPIC_API_KEY) {
  console.warn('[fieldscale] WARNING: ANTHROPIC_API_KEY not set — AI features (auto-scale, AI select, sheet naming) will not work.');
}

// ---------- Tiny JSON "database" (fine for a small team; swap for real DB later if needed) ----------
function loadDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], companies: [], projects: [], estimates: [], invoices: [], settings: { allowSignups: true } }, null, 2));
  }
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // Fill in anything missing so older db.json files keep working after an upgrade.
  parsed.users = parsed.users || [];
  parsed.companies = parsed.companies || [];
  parsed.projects = parsed.projects || [];
  parsed.estimates = parsed.estimates || [];
  parsed.invoices = parsed.invoices || [];
  parsed.jobs = parsed.jobs || [];
  parsed.settings = Object.assign({ allowSignups: true }, parsed.settings || {});
  parsed.users.forEach((u) => {
    if (!u.role) u.role = 'member';
    if (typeof u.disabled !== 'boolean') u.disabled = false;
    if (typeof u.tokenVersion !== 'number') u.tokenVersion = 1;
    if (typeof u.aiCalls !== 'number') u.aiCalls = 0;
    if (typeof u.platformAdmin !== 'boolean') u.platformAdmin = false;
  });
  migrateToCompanies(parsed);
  migrateProjectsToDisk(parsed);
  return parsed;
}

// One-time move from the old single-shared-instance model to multi-tenant companies. Folds all
// pre-existing users into one company; the oldest account becomes its owner + the platform admin.
// Per-user price books / company profiles become the company's shared copies. Idempotent.
function migrateToCompanies(db) {
  if (db.users.length === 0 || !db.users.some(u => !u.companyId)) return;
  let company = db.companies[0];
  if (!company) {
    const owner = db.users.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
    company = { id: 'c_' + crypto.randomBytes(8).toString('hex'), name: 'My Company', createdAt: Date.now(), ownerId: owner.id };
    db.companies.push(company);
  }
  const ownerId = company.ownerId;
  db.users.forEach(u => {
    if (!u.companyId) u.companyId = company.id;
    if (u.id === ownerId) { u.role = 'owner'; u.platformAdmin = true; }
    else if (u.role !== 'admin' && u.role !== 'owner') u.role = 'member';
  });
  db.projects.forEach(p => { if (!p.companyId) p.companyId = company.id; });
  db.estimates.forEach(e => { if (!e.companyId) e.companyId = company.id; });
  // The owner's private price book + company profile become the company's shared copies.
  const move = (dir) => {
    try {
      const oldF = path.join(dir, ownerId + '.json'), newF = path.join(dir, company.id + '.json');
      if (fs.existsSync(oldF) && !fs.existsSync(newF)) fs.copyFileSync(oldF, newF);
    } catch (e) {}
  };
  move(PRICEBOOKS_DIR); move(COMPANIES_DIR);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  console.log('[fieldscale] Migrated existing account(s) into a company (multi-tenant). Nothing was lost.');
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
    companyId: u.companyId,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    aiCalls: u.aiCalls || 0,
    projectCount: db.projects.filter(p => p.userId === u.id).length,
    estimateCount: db.estimates.filter(e => e.userId === u.id).length
  };
}
// Platform admin = the first-ever account OR whoever the PLATFORM_ADMIN_USERNAME env var names.
// The env var wins regardless of sign-up order, so the deployment owner is never locked out.
function isPlatformAdmin(u) {
  return !!u && (u.platformAdmin === true || (PLATFORM_ADMIN_USERNAME && (u.username || '').toLowerCase() === PLATFORM_ADMIN_USERNAME));
}
// A "company admin" (owner or admin) can manage users within their own company.
function isCompanyAdmin(u) { return !!u && (u.role === 'owner' || u.role === 'admin'); }
function companyAdminCount(companyId) {
  return db.users.filter(u => u.companyId === companyId && (u.role === 'owner' || u.role === 'admin') && !u.disabled).length;
}
function companyById(id) { return db.companies.find(c => c.id === id) || null; }

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
    // Upload cap. Real architectural plan sets (a whole hotel, multi-sheet) plus their takeoff
    // easily exceed 25MB — hitting the old cap dropped the connection mid-save ("Failed to fetch").
    // Default 100MB; tune with MAX_UPLOAD_MB. (Mind server RAM: the body is buffered to decode it.)
    const MAX = (parseInt(process.env.MAX_UPLOAD_MB, 10) || 100) * 1024 * 1024;
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
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, must-revalidate' });
        res.end(indexContent);
      });
      return;
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
    // HTML pages carry the app's logic, so never let a browser serve a stale copy — always
    // revalidate. (CSS/JS/fonts can still be cached normally.)
    if (ext === '.html') headers['Cache-Control'] = 'no-cache, must-revalidate';
    res.writeHead(200, headers);
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
      const { username, password, companyName } = await readBody(req);
      const nameCheck = validateUsername(username);
      if (nameCheck.error) return sendJSON(res, 400, { error: nameCheck.error });
      const pwErr = validatePassword(password);
      if (pwErr) return sendJSON(res, 400, { error: pwErr });
      if (db.users.find(u => u.username === nameCheck.uname)) {
        return sendJSON(res, 409, { error: 'That username is already taken.' });
      }
      // A public sign-up creates a brand-new COMPANY (tenant); the signer is its owner. The very
      // first account on the whole platform is also the platform admin.
      const userId = 'u_' + crypto.randomBytes(8).toString('hex');
      const company = {
        id: 'c_' + crypto.randomBytes(8).toString('hex'),
        name: String(companyName || '').trim().slice(0, 120) || (nameCheck.uname + "'s company"),
        createdAt: Date.now(), ownerId: userId
      };
      const { salt, hash } = hashPassword(password);
      const user = {
        id: userId,
        username: nameCheck.uname,
        salt, hash,
        companyId: company.id,
        role: 'owner',                 // you own the company you just created
        platformAdmin: isFirstUser,    // the very first account on the platform runs the place
        disabled: false,
        tokenVersion: 1,
        aiCalls: 0,
        createdAt: Date.now(),
        lastLoginAt: Date.now()
      };
      db.companies.push(company);
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
        const company = companyById(me.companyId);
        return sendJSON(res, 200, {
          username: me.username, role: me.role, id: me.id,
          companyId: me.companyId, companyName: company ? company.name : '',
          platformAdmin: isPlatformAdmin(me)
        });
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

      // ============ COMPANY USER MANAGEMENT (scoped to YOUR company) ============
      // An owner/admin manages only the users inside their own company. Cross-company access
      // is impossible here — every lookup is filtered by me.companyId.
      if (pathname.startsWith('/api/admin/')) {
        // Platform-only: open/close new-company sign-ups for the whole platform.
        if (pathname === '/api/admin/settings' && req.method === 'PUT') {
          if (!isPlatformAdmin(me)) return sendJSON(res, 403, { error: 'Platform administrator only.' });
          const { allowSignups } = await readBody(req);
          if (typeof allowSignups === 'boolean') db.settings.allowSignups = allowSignups;
          saveDB(db);
          return sendJSON(res, 200, { settings: db.settings });
        }

        if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Company owners and admins only.' });

        // GET /api/admin/users — only THIS company's users
        if (pathname === '/api/admin/users' && req.method === 'GET') {
          return sendJSON(res, 200, {
            users: db.users.filter(u => u.companyId === me.companyId).map(publicUser).sort((a, b) => a.createdAt - b.createdAt),
            settings: db.settings,
            aiCallsPerHour: AI_CALLS_PER_HOUR
          });
        }

        // POST /api/admin/users — add a sub-user to YOUR company
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
            companyId: me.companyId,                 // always YOUR company — never another's
            role: role === 'admin' ? 'admin' : 'member',
            platformAdmin: false,
            disabled: false, tokenVersion: 1, aiCalls: 0,
            createdAt: Date.now(), lastLoginAt: null
          };
          db.users.push(user);
          saveDB(db);
          return sendJSON(res, 200, { user: publicUser(user) });
        }

        // PATCH/DELETE /api/admin/users/:id — target MUST be in your company
        const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([a-zA-Z0-9_]+)$/);
        if (adminUserMatch) {
          const target = db.users.find(u => u.id === adminUserMatch[1] && u.companyId === me.companyId);
          if (!target) return sendJSON(res, 404, { error: 'That account no longer exists.' });
          if (target.role === 'owner') return sendJSON(res, 400, { error: "The company owner can't be changed here." });

          if (req.method === 'PATCH') {
            const { role, disabled, password } = await readBody(req);
            if (target.id === me.id && role === 'member') {
              return sendJSON(res, 400, { error: "You can't remove your own admin access." });
            }
            if (target.id === me.id && disabled === true) {
              return sendJSON(res, 400, { error: "You can't disable your own account." });
            }
            if (target.role === 'admin' && (role === 'member' || disabled === true) && companyAdminCount(me.companyId) <= 1) {
              return sendJSON(res, 400, { error: 'This is the only admin left. Promote someone else first.' });
            }
            if (role === 'admin' || role === 'member') target.role = role; // never 'owner' via API
            if (typeof disabled === 'boolean') {
              target.disabled = disabled;
              if (disabled) target.tokenVersion += 1;
            }
            if (password !== undefined) {
              const pwErr = validatePassword(password);
              if (pwErr) return sendJSON(res, 400, { error: pwErr });
              const { salt, hash } = hashPassword(password);
              target.salt = salt; target.hash = hash;
              target.tokenVersion += 1;
            }
            saveDB(db);
            return sendJSON(res, 200, { user: publicUser(target) });
          }

          if (req.method === 'DELETE') {
            if (target.id === me.id) return sendJSON(res, 400, { error: "You can't delete your own account." });
            if (target.role === 'admin' && companyAdminCount(me.companyId) <= 1) {
              return sendJSON(res, 400, { error: 'This is the only admin left. Promote someone else first.' });
            }
            // Projects/estimates belong to the COMPANY (shared workspace), so they stay when a
            // sub-user is removed. Only the account goes.
            db.users = db.users.filter(u => u.id !== target.id);
            saveDB(db);
            return sendJSON(res, 200, { deleted: true });
          }
        }

        return sendJSON(res, 404, { error: 'Unknown admin route.' });
      }

      // ============ PLATFORM (super-admin: Mike) — cross-company overview ============
      if (pathname === '/api/platform/companies' && req.method === 'GET') {
        if (!isPlatformAdmin(me)) return sendJSON(res, 403, { error: 'Platform administrator only.' });
        const companies = db.companies.map(c => {
          const users = db.users.filter(u => u.companyId === c.id);
          const owner = users.find(u => u.id === c.ownerId);
          return {
            id: c.id, name: c.name, createdAt: c.createdAt,
            owner: owner ? owner.username : '—',
            users: users.length,
            projects: db.projects.filter(p => p.companyId === c.id).length,
            estimates: db.estimates.filter(e => e.companyId === c.id).length,
            aiCalls: users.reduce((s, u) => s + (u.aiCalls || 0), 0)
          };
        }).sort((a, b) => a.createdAt - b.createdAt);
        return sendJSON(res, 200, { companies });
      }

      // GET /api/platform/users — every account on the platform (platform admin only).
      // Usernames + activity + which company they're in. Passwords are never included — they're
      // one-way hashed and can't be shown to anyone, ever. To help someone, reset their password.
      if (pathname === '/api/platform/users' && req.method === 'GET') {
        if (!isPlatformAdmin(me)) return sendJSON(res, 403, { error: 'Platform administrator only.' });
        const companyNames = Object.fromEntries(db.companies.map(c => [c.id, c.name]));
        const users = db.users.map(u => ({
          username: u.username,
          company: companyNames[u.companyId] || '—',
          role: u.role,
          platformAdmin: !!u.platformAdmin,
          disabled: !!u.disabled,
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt || null
        })).sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0));
        return sendJSON(res, 200, { users });
      }

      // GET /api/projects — list this user's projects (metadata only, not full data)
      if (pathname === '/api/projects' && req.method === 'GET') {
        const list = db.projects
          .filter(p => p.companyId === me.companyId)
          .map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }

      // POST /api/projects — create a new project (metadata only; PDF is uploaded separately)
      if (pathname === '/api/projects' && req.method === 'POST') {
        const { name, data } = await readBody(req);
        const project = {
          id: 'p_' + crypto.randomBytes(8).toString('hex'),
          userId, companyId: me.companyId, name: name || 'Untitled Project',
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
        const project = db.projects.find(p => p.id === pdfMatch[1] && p.companyId === me.companyId);
        if (!project) return sendJSON(res, 404, { error: 'Project not found.' });

        if (req.method === 'PUT') {
          ensureProjectDir(project.id);
          const ct = req.headers['content-type'] || '';
          // Preferred path: the browser streams the raw PDF bytes (Content-Type application/pdf).
          // We pipe them straight to disk, so a 100MB hotel plan set never has to be buffered in
          // memory or base64-inflated into a JSON body (which is what dropped the connection before).
          if (ct.includes('application/pdf') || ct.includes('application/octet-stream')) {
            const tmp = planPath(project.id) + '.tmp';
            const ws = fs.createWriteStream(tmp);
            let failed = false;
            const fail = (e) => { if (failed) return; failed = true; try { fs.unlinkSync(tmp); } catch (_) {} sendJSON(res, 500, { error: 'Could not save the plan: ' + (e && e.message || e) }); };
            ws.on('error', fail);
            req.on('error', fail);
            ws.on('finish', () => {
              if (failed) return;
              try { fs.renameSync(tmp, planPath(project.id)); } catch (e) { return fail(e); }
              project.hasPdf = true; project.updatedAt = Date.now(); saveDB(db);
              sendJSON(res, 200, { ok: true });
            });
            req.pipe(ws);
            return;
          }
          // Legacy path: base64 inside JSON (kept for backward compatibility).
          const { pdfBase64 } = await readBody(req);
          if (!pdfBase64) return sendJSON(res, 400, { error: 'No PDF supplied.' });
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
        const project = db.projects.find(p => p.id === snapListMatch[1] && p.companyId === me.companyId);
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
        const project = db.projects.find(p => p.id === restoreMatch[1] && p.companyId === me.companyId);
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
        const project = db.projects.find(p => p.id === id && p.companyId === me.companyId);
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

      // ---- Estimating: the user's price book (private, per-user) ----
      // GET returns the saved list; a brand-new user gets seeded with the insulation starter
      // set so the estimator has something to work with immediately.
      if (pathname === '/api/pricebook' && req.method === 'GET') {
        let items = readPricebook(me.companyId);
        if (items === null) { items = DEFAULT_PRICEBOOK; writePricebook(me.companyId, items); }
        return sendJSON(res, 200, { items });
      }
      // PUT replaces the whole list. We re-shape every row server-side so the file can only
      // ever hold clean, expected fields — the browser doesn't get to store arbitrary junk.
      if (pathname === '/api/pricebook' && req.method === 'PUT') {
        const { items } = await readBody(req);
        if (!Array.isArray(items)) return sendJSON(res, 400, { error: 'items must be an array.' });
        const clean = items.slice(0, 2000).map(it => ({
          id: String(it.id || ('pi_' + crypto.randomBytes(6).toString('hex'))).slice(0, 40),
          name: String(it.name || '').slice(0, 120),
          category: String(it.category || '').slice(0, 60),
          unit: String(it.unit || '').slice(0, 20),
          material: Number(it.material) || 0,
          labor: Number(it.labor) || 0,
          waste: Number(it.waste) || 0
        }));
        writePricebook(me.companyId, clean);
        return sendJSON(res, 200, { items: clean });
      }

      // ---- Company profile: get / save (shared by everyone in the company) ----
      if (pathname === '/api/company' && req.method === 'GET') {
        return sendJSON(res, 200, { profile: readCompany(me.companyId) });
      }
      if (pathname === '/api/company' && req.method === 'PUT') {
        const { profile } = await readBody(req);
        const p = profile || {};
        // Re-shape server-side so the file only ever holds expected fields. The logo is a data
        // URL kept small (a proposal letterhead, not a hi-res photo); anything else is rejected.
        const logoOk = typeof p.logo === 'string' && p.logo.startsWith('data:image/') && p.logo.length < 800000;
        const clean = {
          name: String(p.name || '').slice(0, 200),
          phone: String(p.phone || '').slice(0, 60),
          email: String(p.email || '').slice(0, 120),
          license: String(p.license || '').slice(0, 80),
          website: String(p.website || '').slice(0, 160),
          address: String(p.address || '').slice(0, 300),
          logo: logoOk ? p.logo : ''
        };
        writeCompany(me.companyId, clean);
        return sendJSON(res, 200, { profile: clean });
      }

      // ---- Estimating: list / create estimates ----
      if (pathname === '/api/estimates' && req.method === 'GET') {
        const list = db.estimates.filter(e => e.companyId === me.companyId)
          .map(e => ({ id: e.id, name: e.name, client: e.client || '', total: e.total || 0,
                       status: e.status || 'draft', createdAt: e.createdAt, updatedAt: e.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/estimates' && req.method === 'POST') {
        const { name, client, doc } = await readBody(req);
        const est = { id: 'e_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: name || 'Untitled Estimate', client: client || '', total: 0, status: 'draft',
          createdAt: Date.now(), updatedAt: Date.now() };
        writeEstimateDoc(est.id, doc || {});
        db.estimates.push(est);
        saveDB(db);
        return sendJSON(res, 200, { id: est.id });
      }
      // ---- Estimating: one estimate (get / update / delete; must belong to this user) ----
      const estMatch = pathname.match(/^\/api\/estimates\/([a-zA-Z0-9_]+)$/);
      if (estMatch) {
        const est = db.estimates.find(e => e.id === estMatch[1] && e.companyId === me.companyId);
        if (!est) return sendJSON(res, 404, { error: 'Estimate not found.' });
        if (req.method === 'GET') {
          return sendJSON(res, 200, { id: est.id, name: est.name, client: est.client, total: est.total,
            status: est.status, createdAt: est.createdAt, updatedAt: est.updatedAt, doc: readEstimateDoc(est.id) });
        }
        if (req.method === 'PUT') {
          const { name, client, total, status, doc } = await readBody(req);
          if (name !== undefined) est.name = String(name).slice(0, 200);
          if (client !== undefined) est.client = String(client).slice(0, 200);
          if (typeof total === 'number') est.total = total;
          if (status !== undefined) est.status = String(status).slice(0, 40);
          if (doc !== undefined) writeEstimateDoc(est.id, doc);
          est.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: est.id, updatedAt: est.updatedAt });
        }
        if (req.method === 'DELETE') {
          db.estimates = db.estimates.filter(e => e.id !== est.id);
          try { fs.unlinkSync(estimatePath(est.id)); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // ---- Invoicing: list / create / convert-from-estimate ----
      if (pathname === '/api/invoices' && req.method === 'GET') {
        const list = db.invoices.filter(i => i.companyId === me.companyId)
          .map(i => ({ id: i.id, name: i.name, client: i.client || '', total: i.total || 0,
                       amountPaid: i.amountPaid || 0, status: invoiceStatus(i.total, i.amountPaid),
                       createdAt: i.createdAt, updatedAt: i.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/invoices' && req.method === 'POST') {
        const { name, client, doc } = await readBody(req);
        const inv = { id: 'i_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: name || 'Untitled Invoice', client: client || '', total: 0, amountPaid: 0,
          createdAt: Date.now(), updatedAt: Date.now() };
        writeInvoiceDoc(inv.id, doc || {});
        db.invoices.push(inv);
        saveDB(db);
        return sendJSON(res, 200, { id: inv.id });
      }
      // Convert an accepted estimate into an invoice. The estimate's markup is folded into the
      // shown line prices (the customer never sees it), so invoice lines are already selling prices.
      if (pathname === '/api/invoices/from-estimate' && req.method === 'POST') {
        const { estimateId } = await readBody(req);
        const est = db.estimates.find(e => e.id === estimateId && e.companyId === me.companyId);
        if (!est) return sendJSON(res, 404, { error: 'Estimate not found.' });
        const edoc = readEstimateDoc(est.id);
        const mk = 1 + (Number(edoc.markupPct) || 0) / 100;
        const lines = (edoc.lines || []).map(l => ({
          id: 'l_' + crypto.randomBytes(6).toString('hex'), name: l.name, code: l.code, unit: l.unit,
          qty: Number(l.qty) || 0, unitCost: Math.round((Number(l.unitCost) || 0) * mk * 100) / 100
        }));
        const doc = {
          company: edoc.company || {}, client: edoc.client || {}, project: edoc.project || '',
          invoiceNo: '', date: '', dueDate: '', lines, taxPct: Number(edoc.taxPct) || 0,
          notes: edoc.notes || '', terms: edoc.terms || '', amountPaid: 0, fromEstimateId: est.id
        };
        const subtotal = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
        const total = Math.round(subtotal * (1 + doc.taxPct / 100) * 100) / 100;
        const inv = { id: 'i_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: est.name || 'Invoice', client: (edoc.client && edoc.client.name) || est.client || '',
          total, amountPaid: 0, createdAt: Date.now(), updatedAt: Date.now() };
        writeInvoiceDoc(inv.id, doc);
        db.invoices.push(inv);
        saveDB(db);
        return sendJSON(res, 200, { id: inv.id });
      }
      const invMatch = pathname.match(/^\/api\/invoices\/([a-zA-Z0-9_]+)$/);
      if (invMatch) {
        const inv = db.invoices.find(i => i.id === invMatch[1] && i.companyId === me.companyId);
        if (!inv) return sendJSON(res, 404, { error: 'Invoice not found.' });
        if (req.method === 'GET') {
          return sendJSON(res, 200, { id: inv.id, name: inv.name, client: inv.client, total: inv.total,
            amountPaid: inv.amountPaid || 0, status: invoiceStatus(inv.total, inv.amountPaid),
            createdAt: inv.createdAt, updatedAt: inv.updatedAt, doc: readInvoiceDoc(inv.id) });
        }
        if (req.method === 'PUT') {
          const { name, client, total, amountPaid, doc } = await readBody(req);
          if (name !== undefined) inv.name = String(name).slice(0, 200);
          if (client !== undefined) inv.client = String(client).slice(0, 200);
          if (typeof total === 'number') inv.total = total;
          if (typeof amountPaid === 'number') inv.amountPaid = amountPaid;
          if (doc !== undefined) writeInvoiceDoc(inv.id, doc);
          inv.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: inv.id, updatedAt: inv.updatedAt, status: invoiceStatus(inv.total, inv.amountPaid) });
        }
        if (req.method === 'DELETE') {
          db.invoices = db.invoices.filter(i => i.id !== inv.id);
          try { fs.unlinkSync(invoicePath(inv.id)); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // ---- Projects/Jobs: list / create / convert-from-estimate ----
      if (pathname === '/api/jobs' && req.method === 'GET') {
        const list = db.jobs.filter(j => j.companyId === me.companyId)
          .map(j => {
            const jd = readJobDoc(j.id) || {};
            const c = jd.costing || {};
            // Approved change orders adjust both the contract (revenue) and the budget (cost).
            const co = (jd.changeOrders || []).reduce((a, x) => {
              if (x.status === 'approved') { a.price += Number(x.priceDelta) || 0; a.cost += Number(x.costDelta) || 0; }
              return a;
            }, { price: 0, cost: 0 });
            const contract = (Number(c.contract) || 0) + co.price;
            const profit = contract - ((Number(c.budget) || 0) + co.cost);
            const margin = contract > 0 ? Math.round(profit / contract * 1000) / 10 : null;
            return { id: j.id, name: j.name, client: j.client || '', status: j.status || 'scheduled',
                     contract, margin, createdAt: j.createdAt, updatedAt: j.updatedAt };
          })
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/jobs' && req.method === 'POST') {
        const { name, client, doc } = await readBody(req);
        const job = { id: 'j_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: name || 'Untitled Job', client: client || '', status: 'scheduled',
          createdAt: Date.now(), updatedAt: Date.now() };
        writeJobDoc(job.id, doc || {});
        db.jobs.push(job);
        saveDB(db);
        return sendJSON(res, 200, { id: job.id });
      }
      // Turn a won estimate into a job (the scope of work to schedule and do).
      if (pathname === '/api/jobs/from-estimate' && req.method === 'POST') {
        const { estimateId } = await readBody(req);
        const est = db.estimates.find(e => e.id === estimateId && e.companyId === me.companyId);
        if (!est) return sendJSON(res, 404, { error: 'Estimate not found.' });
        const edoc = readEstimateDoc(est.id);
        // Freeze the job's budget from the estimate: cost basis = sum(qty x unitCost);
        // contract (revenue for the work) = cost + markup. Tax is a pass-through, not revenue.
        const budget = (edoc.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
        const contract = Math.round((budget * (1 + (Number(edoc.markupPct) || 0) / 100)) * 100) / 100;
        const doc = {
          company: edoc.company || {}, client: edoc.client || {}, project: edoc.project || '',
          lines: (edoc.lines || []).map(l => ({ id: 'l_' + crypto.randomBytes(6).toString('hex'),
            name: l.name, code: l.code, unit: l.unit, qty: Number(l.qty) || 0, done: false })),
          startDate: '', dueDate: '', notes: edoc.notes || '', fromEstimateId: est.id,
          costing: { budget: Math.round(budget * 100) / 100, contract, actualCost: 0 }
        };
        const job = { id: 'j_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: est.name || 'Job', client: (edoc.client && edoc.client.name) || est.client || '',
          status: 'scheduled', createdAt: Date.now(), updatedAt: Date.now() };
        writeJobDoc(job.id, doc);
        db.jobs.push(job);
        saveDB(db);
        return sendJSON(res, 200, { id: job.id });
      }
      const jobMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_]+)$/);
      if (jobMatch) {
        const job = db.jobs.find(j => j.id === jobMatch[1] && j.companyId === me.companyId);
        if (!job) return sendJSON(res, 404, { error: 'Job not found.' });
        if (req.method === 'GET') {
          return sendJSON(res, 200, { id: job.id, name: job.name, client: job.client, status: job.status,
            createdAt: job.createdAt, updatedAt: job.updatedAt, doc: readJobDoc(job.id) });
        }
        if (req.method === 'PUT') {
          const { name, client, status, doc } = await readBody(req);
          if (name !== undefined) job.name = String(name).slice(0, 200);
          if (client !== undefined) job.client = String(client).slice(0, 200);
          if (status !== undefined && JOB_STATUSES.includes(status)) job.status = status;
          if (doc !== undefined) writeJobDoc(job.id, doc);
          job.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: job.id, updatedAt: job.updatedAt, status: job.status });
        }
        if (req.method === 'DELETE') {
          db.jobs = db.jobs.filter(j => j.id !== job.id);
          try { fs.unlinkSync(jobPath(job.id)); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // ---- Full backup / export (company owner or admin) ----
      // Bundles everything that's hard to replace — company profile, price book, every estimate,
      // and every project's takeoff measurements — into one JSON file. Plan PDFs are NOT included
      // (they're large and the contractor still has the originals); everything else is.
      if (pathname === '/api/backup' && req.method === 'GET') {
        if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Company owners and admins only.' });
        const company = companyById(me.companyId);
        const projects = db.projects.filter(p => p.companyId === me.companyId).map(p => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, hasPdf: !!p.hasPdf, takeoff: readTakeoff(p.id)
        }));
        const estimates = db.estimates.filter(e => e.companyId === me.companyId).map(e => ({
          id: e.id, name: e.name, client: e.client, total: e.total, status: e.status,
          createdAt: e.createdAt, updatedAt: e.updatedAt, doc: readEstimateDoc(e.id)
        }));
        const invoices = db.invoices.filter(i => i.companyId === me.companyId).map(i => ({
          id: i.id, name: i.name, client: i.client, total: i.total, amountPaid: i.amountPaid,
          createdAt: i.createdAt, updatedAt: i.updatedAt, doc: readInvoiceDoc(i.id)
        }));
        const jobs = db.jobs.filter(j => j.companyId === me.companyId).map(j => ({
          id: j.id, name: j.name, client: j.client, status: j.status,
          createdAt: j.createdAt, updatedAt: j.updatedAt, doc: readJobDoc(j.id)
        }));
        return sendJSON(res, 200, {
          fieldscaleBackup: 1, companyName: company ? company.name : '',
          profile: readCompany(me.companyId), pricebook: readPricebook(me.companyId) || [],
          projects, estimates, invoices, jobs
        });
      }
      // Restore a backup file into THIS company. Additive/idempotent by id — re-importing the same
      // file just refreshes the same records; it never touches another company's data.
      if (pathname === '/api/restore' && req.method === 'POST') {
        if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Company owners and admins only.' });
        const b = await readBody(req);
        if (!b || b.fieldscaleBackup !== 1) return sendJSON(res, 400, { error: 'That is not a valid Fieldscale backup file.' });
        if (b.profile && typeof b.profile === 'object') writeCompany(me.companyId, b.profile);
        if (Array.isArray(b.pricebook)) writePricebook(me.companyId, b.pricebook);
        let projN = 0, estN = 0;
        (Array.isArray(b.projects) ? b.projects : []).forEach(p => {
          let proj = db.projects.find(x => x.id === p.id && x.companyId === me.companyId);
          if (!proj) {
            proj = { id: (typeof p.id === 'string' && p.id) ? p.id : ('p_' + crypto.randomBytes(8).toString('hex')),
              userId: me.id, companyId: me.companyId, name: p.name || 'Restored project', hasPdf: false,
              createdAt: p.createdAt || Date.now(), updatedAt: Date.now() };
            db.projects.push(proj);
          }
          ensureProjectDir(proj.id);
          if (p.takeoff) writeJsonAtomic(currentPath(proj.id), p.takeoff);
          proj.updatedAt = Date.now(); projN++;
        });
        (Array.isArray(b.estimates) ? b.estimates : []).forEach(e => {
          let est = db.estimates.find(x => x.id === e.id && x.companyId === me.companyId);
          if (!est) {
            est = { id: (typeof e.id === 'string' && e.id) ? e.id : ('e_' + crypto.randomBytes(8).toString('hex')),
              userId: me.id, companyId: me.companyId, name: e.name || 'Restored estimate', client: e.client || '',
              total: e.total || 0, status: e.status || 'draft', createdAt: e.createdAt || Date.now(), updatedAt: Date.now() };
            db.estimates.push(est);
          }
          if (e.doc) writeEstimateDoc(est.id, e.doc);
          est.updatedAt = Date.now(); estN++;
        });
        let invN = 0;
        (Array.isArray(b.invoices) ? b.invoices : []).forEach(iv => {
          let inv = db.invoices.find(x => x.id === iv.id && x.companyId === me.companyId);
          if (!inv) {
            inv = { id: (typeof iv.id === 'string' && iv.id) ? iv.id : ('i_' + crypto.randomBytes(8).toString('hex')),
              userId: me.id, companyId: me.companyId, name: iv.name || 'Restored invoice', client: iv.client || '',
              total: iv.total || 0, amountPaid: iv.amountPaid || 0, createdAt: iv.createdAt || Date.now(), updatedAt: Date.now() };
            db.invoices.push(inv);
          }
          if (iv.doc) writeInvoiceDoc(inv.id, iv.doc);
          inv.updatedAt = Date.now(); invN++;
        });
        let jobN = 0;
        (Array.isArray(b.jobs) ? b.jobs : []).forEach(jb => {
          let job = db.jobs.find(x => x.id === jb.id && x.companyId === me.companyId);
          if (!job) {
            job = { id: (typeof jb.id === 'string' && jb.id) ? jb.id : ('j_' + crypto.randomBytes(8).toString('hex')),
              userId: me.id, companyId: me.companyId, name: jb.name || 'Restored job', client: jb.client || '',
              status: JOB_STATUSES.includes(jb.status) ? jb.status : 'scheduled',
              createdAt: jb.createdAt || Date.now(), updatedAt: Date.now() };
            db.jobs.push(job);
          }
          if (jb.doc) writeJobDoc(job.id, jb.doc);
          job.updatedAt = Date.now(); jobN++;
        });
        saveDB(db);
        return sendJSON(res, 200, { restored: true, projects: projN, estimates: estN, invoices: invN, jobs: jobN });
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
