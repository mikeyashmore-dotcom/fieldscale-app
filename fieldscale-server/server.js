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
// Set high enough that auto-naming a large plan set (commercial sets run 100-400+ sheets)
// finishes in one pass; sheet naming is one cheap vision call each. Tune down via env if needed.
const AI_CALLS_PER_HOUR = parseInt(process.env.AI_CALLS_PER_HOUR || '1000', 10);
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

function readPricebookFile(userId){
  const f = pricebookPath(userId);
  if (!fs.existsSync(f)) return null; // null = "this user has never saved one yet"
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { items: Array.isArray(d.items) ? d.items : [], assemblies: Array.isArray(d.assemblies) ? d.assemblies : [] };
  } catch (e) { return { items: [], assemblies: [] }; }
}
function readPricebook(userId){
  const d = readPricebookFile(userId);
  return d === null ? null : d.items;
}
function readAssemblies(userId){
  const d = readPricebookFile(userId);
  return d === null ? [] : d.assemblies;
}
// Persist items and/or assemblies without clobbering the other half of the file.
function writePricebook(userId, items, assemblies){
  if (!fs.existsSync(PRICEBOOKS_DIR)) fs.mkdirSync(PRICEBOOKS_DIR, { recursive: true });
  const cur = readPricebookFile(userId) || { items: [], assemblies: [] };
  const out = {
    items: items !== undefined ? items : cur.items,
    assemblies: assemblies !== undefined ? assemblies : cur.assemblies
  };
  writeJsonAtomic(pricebookPath(userId), out);
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
// Estimate versions (revision history) — snapshots of the estimate doc on disk.
const EST_REV_DIR = path.join(DATA_DIR, 'estimate-revisions');
function estRevDir(estId){ return path.join(EST_REV_DIR, estId); }
function estRevPath(estId, rid){ return path.join(estRevDir(estId), rid + '.json'); }
function readEstRev(estId, rid){
  const f = estRevPath(estId, rid);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
function writeEstRev(estId, rid, snapshot){
  const d = estRevDir(estId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  writeJsonAtomic(estRevPath(estId, rid), snapshot || {});
}

// ---------- Reusable estimate templates (the estimate body, minus client-specific info) ----------
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
function templatePath(id){ return path.join(TEMPLATES_DIR, id + '.json'); }
function readTemplateDoc(id){
  const f = templatePath(id);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writeTemplateDoc(id, doc){
  if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  writeJsonAtomic(templatePath(id), doc || {});
}
// Keep only the reusable parts of an estimate doc (never the customer/project).
function templateBodyFrom(doc){
  doc = doc || {};
  return {
    lines: (Array.isArray(doc.lines) ? doc.lines : []).map(l => ({
      id: 'l_' + crypto.randomBytes(6).toString('hex'),
      name: String(l.name || '').slice(0, 200), code: String(l.code || '').slice(0, 60),
      unit: String(l.unit || '').slice(0, 20), qty: Number(l.qty) || 0, unitCost: Number(l.unitCost) || 0,
      material: Number(l.material) || 0, laborHours: Number(l.laborHours) || 0, laborRate: Number(l.laborRate) || 0,
      internalNote: String(l.internalNote || '').slice(0, 500)
    })).slice(0, 2000),
    markupPct: Number(doc.markupPct) || 0, taxPct: Number(doc.taxPct) || 0,
    discount: Number(doc.discount) || 0, discountType: doc.discountType === 'amt' ? 'amt' : 'pct',
    notes: String(doc.notes || '').slice(0, 20000), terms: String(doc.terms || '').slice(0, 20000)
  };
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
// ---------- Purchase orders (materials ordered from suppliers; mirrors invoices) ----------
const PO_DIR = path.join(DATA_DIR, 'purchase-orders');
function poPath(id){ return path.join(PO_DIR, id + '.json'); }
function readPODoc(id){
  const f = poPath(id);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writePODoc(id, doc){
  if (!fs.existsSync(PO_DIR)) fs.mkdirSync(PO_DIR, { recursive: true });
  writeJsonAtomic(poPath(id), doc || {});
}
const PO_STATUSES = ['draft', 'ordered', 'received'];
function poStatus(s){ return PO_STATUSES.indexOf(s) >= 0 ? s : 'draft'; }

// ---------- Customers (a hub view; the "records" are derived from leads/estimates/jobs/invoices
//            that share a client name — only notes + a manual activity log are stored). ----------
function custKey(name){ return String(name || '').trim().toLowerCase().replace(/\s+/g, ' '); }

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

// ---------- Work orders (an assignment to do the work — belongs to a job, or standalone) ----------
const WORKORDERS_DIR = path.join(DATA_DIR, 'workorders');
function workOrderPath(id){ return path.join(WORKORDERS_DIR, id + '.json'); }
function readWorkOrderDoc(id){
  const f = workOrderPath(id);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writeWorkOrderDoc(id, doc){
  if (!fs.existsSync(WORKORDERS_DIR)) fs.mkdirSync(WORKORDERS_DIR, { recursive: true });
  writeJsonAtomic(workOrderPath(id), doc || {});
}
const WO_STATUSES = ['open', 'in progress', 'complete', 'on hold'];

// ---------- Leads / CRM (the sales front of the funnel: lead -> estimate -> job -> invoice) ----------
const LEADS_DIR = path.join(DATA_DIR, 'leads');
function leadPath(id){ return path.join(LEADS_DIR, id + '.json'); }
function readLeadDoc(id){
  const f = leadPath(id);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writeLeadDoc(id, doc){
  if (!fs.existsSync(LEADS_DIR)) fs.mkdirSync(LEADS_DIR, { recursive: true });
  writeJsonAtomic(leadPath(id), doc || {});
}
const LEAD_STAGES = ['new', 'contacted', 'estimating', 'won', 'lost', 'on hold'];

// ---------- Receipts attached to a job (kept on disk for the life of the job) ----------
// Files live under data/receipts/<jobId>/<receiptId>; the metadata lives on the job record
// (job.receipts), so a client save of the job doc can never clobber them.
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
function receiptDir(jobId){ return path.join(RECEIPTS_DIR, jobId); }
function receiptPath(jobId, rid){ return path.join(receiptDir(jobId), rid); }
const MAX_RECEIPT_BYTES = 25 * 1024 * 1024; // a phone photo or a PDF receipt, not a plan set

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
  parsed.templates = parsed.templates || [];
  parsed.invoices = parsed.invoices || [];
  parsed.jobs = parsed.jobs || [];
  parsed.workOrders = parsed.workOrders || [];
  parsed.leads = parsed.leads || [];
  parsed.purchaseOrders = parsed.purchaseOrders || [];
  parsed.customers = parsed.customers || []; // per-customer notes + activity log (records are derived otherwise)
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

// ---------- Modular ("à la carte") access: which parts of the product a company can use ----------
// A company can be sold just the takeoff, just estimating, etc. Company profile + owner tools are
// always available. If a company has no explicit list yet, everything is on (no behaviour change).
const ALL_MODULES = ['takeoff', 'estimating', 'invoicing', 'jobs', 'crm'];
function companyModules(company) {
  if (!company || !Array.isArray(company.modules)) return ALL_MODULES.slice();
  return ALL_MODULES.filter(m => company.modules.includes(m));
}

// ---------- Auto-incrementing invoice numbers (per company) ----------
// The company record holds a running counter: a prefix (e.g. "INV-"), the next integer to use,
// and the zero-pad width. We seed it the first time a user types an invoice number, then count up.
function parseInvoiceNo(s) {
  const m = String(s == null ? '' : s).match(/^(.*?)(\d+)\s*$/); // trailing integer + optional prefix
  if (!m) return null;
  return { prefix: m[1], num: parseInt(m[2], 10), pad: m[2].length };
}
function nextInvoiceNo(company) {
  if (!company || company.invoiceSeq == null) return null;
  return (company.invoicePrefix || '') + String(company.invoiceSeq).padStart(company.invoicePad || 0, '0');
}
// Returns the next number and advances the counter (or null if not seeded yet).
function assignInvoiceNo(company) {
  const no = nextInvoiceNo(company);
  if (no == null) return null;
  company.invoiceSeq = company.invoiceSeq + 1;
  return no;
}
// Purchase-order numbers auto-count from PO-0001 per company (simpler than invoices — no config UI).
function assignPONo(company) {
  if (!company) return 'PO-0001';
  if (company.poSeq == null) company.poSeq = 1;
  const no = 'PO-' + String(company.poSeq).padStart(4, '0');
  company.poSeq = company.poSeq + 1;
  return no;
}
// Seed the counter from the first invoice number a user enters by hand (no-op once seeded).
function maybeSeedInvoiceSeq(company, invoiceNoStr) {
  if (!company || company.invoiceSeq != null) return;
  const p = parseInvoiceNo(invoiceNoStr);
  if (!p) return;
  company.invoicePrefix = p.prefix;
  company.invoicePad = p.pad;
  company.invoiceSeq = p.num + 1; // the next invoice counts up from the one just entered
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

    // ---- Public (no login): a client viewing / approving a shared estimate by token ----
    if (pathname === '/api/public/estimate' && req.method === 'GET') {
      const token = (parsed.query && parsed.query.token) || '';
      const est = token ? db.estimates.find(e => e.shareToken === token) : null;
      if (!est) return sendJSON(res, 404, { error: 'This link is no longer valid.' });
      const doc = readEstimateDoc(est.id);
      // Only expose what a client should see — the proposal, not internal notes.
      const lines = (doc.lines || []).map(l => ({ name: l.name, code: l.code, unit: l.unit,
        qty: l.qty, unitCost: l.unitCost, mode: l.mode, unitPrice: l.unitPrice, material: l.material,
        laborHours: l.laborHours, laborRate: l.laborRate }));
      return sendJSON(res, 200, { name: est.name, status: est.status,
        company: doc.company || {}, client: doc.client || {}, project: doc.project || '',
        estimateNo: doc.estimateNo || '', date: doc.date || '', validUntil: doc.validUntil || '',
        lines, markupPct: doc.markupPct || 0, taxPct: doc.taxPct || 0,
        discount: doc.discount || 0, discountType: doc.discountType || 'pct',
        notes: doc.notes || '', terms: doc.terms || '', signature: doc.signature || null });
    }
    if (pathname === '/api/public/estimate-accept' && req.method === 'POST') {
      const b = await readBody(req);
      const est = b.token ? db.estimates.find(e => e.shareToken === b.token) : null;
      if (!est) return sendJSON(res, 404, { error: 'This link is no longer valid.' });
      const name = String(b.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'Please type your name to approve.' });
      const doc = readEstimateDoc(est.id);
      if (doc.signature && doc.signature.name) return sendJSON(res, 200, { alreadyAccepted: true, at: doc.signature.at });
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
      doc.signature = { name: name.slice(0, 120), at: Date.now(), ip: String(ip).slice(0, 60) };
      writeEstimateDoc(est.id, doc);
      est.status = 'accepted'; est.updatedAt = Date.now();
      saveDB(db);
      return sendJSON(res, 200, { accepted: true, at: doc.signature.at });
    }
    // Public lead-capture form: a website visitor submits their info and it becomes a new lead.
    if (pathname === '/api/public/lead' && req.method === 'POST') {
      const b = await readBody(req);
      const company = b.token ? db.companies.find(c => c.leadFormToken === b.token) : null;
      if (!company) return sendJSON(res, 404, { error: 'This form is no longer active.' });
      const name = String(b.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'Please enter your name.' });
      const owner = db.users.find(u => u.companyId === company.id && u.role === 'owner') || db.users.find(u => u.companyId === company.id);
      const lead = { id: 'ld_' + crypto.randomBytes(8).toString('hex'), userId: owner ? owner.id : '',
        companyId: company.id, name: name.slice(0, 200), workType: String(b.workType || '').slice(0, 200),
        value: 0, stage: 'new', source: 'Website form', followUp: '', createdAt: Date.now(), updatedAt: Date.now() };
      writeLeadDoc(lead.id, { phone: String(b.phone || '').slice(0, 60), email: String(b.email || '').slice(0, 120),
        address: String(b.address || '').slice(0, 300), notes: String(b.notes || '').slice(0, 4000) });
      db.leads.push(lead);
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }
    // The public form fetches the company name to show a friendly heading.
    if (pathname === '/api/public/lead-form' && req.method === 'GET') {
      const token = (parsed.query && parsed.query.token) || '';
      const company = token ? db.companies.find(c => c.leadFormToken === token) : null;
      if (!company) return sendJSON(res, 404, { error: 'This form is no longer active.' });
      return sendJSON(res, 200, { companyName: company.name || '' });
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
          platformAdmin: isPlatformAdmin(me),
          modules: companyModules(company)
        });
      }

      // GET /api/branding — the company name + logo, used to brand the app header on every page.
      // The profile's Company Name field is the source of truth.
      if (pathname === '/api/branding' && req.method === 'GET') {
        const prof = readCompany(me.companyId) || {};
        const company = companyById(me.companyId);
        return sendJSON(res, 200, { companyName: prof.name || (company && company.name) || '', logo: prof.logo || '' });
      }

      // GET /api/lead-form-token — the token that powers the public website lead-capture form.
      if (pathname === '/api/lead-form-token' && req.method === 'GET') {
        const company = companyById(me.companyId);
        if (!company) return sendJSON(res, 404, { error: 'Company not found.' });
        if (!company.leadFormToken) { company.leadFormToken = crypto.randomBytes(12).toString('hex'); saveDB(db); }
        return sendJSON(res, 200, { token: company.leadFormToken });
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
            aiCalls: users.reduce((s, u) => s + (u.aiCalls || 0), 0),
            modules: companyModules(c)
          };
        }).sort((a, b) => a.createdAt - b.createdAt);
        return sendJSON(res, 200, { companies, allModules: ALL_MODULES });
      }
      // Set which modules a company can use (platform admin only).
      const compModMatch = pathname.match(/^\/api\/platform\/companies\/([a-zA-Z0-9_]+)\/modules$/);
      if (compModMatch && req.method === 'PUT') {
        if (!isPlatformAdmin(me)) return sendJSON(res, 403, { error: 'Platform administrator only.' });
        const company = companyById(compModMatch[1]);
        if (!company) return sendJSON(res, 404, { error: 'Company not found.' });
        const { modules } = await readBody(req);
        if (!Array.isArray(modules)) return sendJSON(res, 400, { error: 'modules must be an array.' });
        company.modules = ALL_MODULES.filter(m => modules.includes(m));
        saveDB(db);
        return sendJSON(res, 200, { id: company.id, modules: companyModules(company) });
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
          // No plan? Tell the client plainly (204) instead of a null-in-JSON body.
          if (!project.hasPdf || !fs.existsSync(planPath(project.id))) {
            res.writeHead(204); return res.end();
          }
          // Stream the raw PDF straight from disk. A 100MB plan set must NOT be read into memory
          // and base64-inflated into one JSON string — that's what OOM'd/timed out on large sets.
          const p = planPath(project.id);
          const stat = fs.statSync(p);
          // A project's plan PDF is written once and never changes (new upload = new project id),
          // so let the browser cache it hard. This stops every reference tab / reload from
          // re-downloading the whole plan set — the big win for reference-tab speed.
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': stat.size,
            'Cache-Control': 'private, max-age=31536000, immutable' });
          const rs = fs.createReadStream(p);
          rs.on('error', () => { if (!res.headersSent) sendJSON(res, 500, { error: 'Could not read the plan.' }); else res.destroy(); });
          rs.pipe(res);
          return;
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
        const file = readPricebookFile(me.companyId);
        if (file === null) { writePricebook(me.companyId, DEFAULT_PRICEBOOK, []); return sendJSON(res, 200, { items: DEFAULT_PRICEBOOK, assemblies: [] }); }
        return sendJSON(res, 200, { items: file.items, assemblies: file.assemblies });
      }
      // PUT replaces the whole list. We re-shape every row server-side so the file can only
      // ever hold clean, expected fields — the browser doesn't get to store arbitrary junk.
      // Assemblies (optional) bundle price-book items into one line; each component references an
      // item id plus a per-unit qty. Cost is computed at estimate time by resolving those items.
      if (pathname === '/api/pricebook' && req.method === 'PUT') {
        const body = await readBody(req);
        const { items, assemblies } = body;
        if (!Array.isArray(items)) return sendJSON(res, 400, { error: 'items must be an array.' });
        const clean = items.slice(0, 2000).map(it => ({
          id: String(it.id || ('pi_' + crypto.randomBytes(6).toString('hex'))).slice(0, 40),
          name: String(it.name || '').slice(0, 120),
          category: String(it.category || '').slice(0, 60),
          unit: String(it.unit || '').slice(0, 20),
          material: Number(it.material) || 0,
          laborHours: Number(it.laborHours) || 0,
          laborRate: Number(it.laborRate) || 0,
          labor: Number(it.labor) || 0, // legacy labor $ kept for backward compatibility
          waste: Number(it.waste) || 0
        }));
        let cleanAsm;
        if (assemblies !== undefined) {
          if (!Array.isArray(assemblies)) return sendJSON(res, 400, { error: 'assemblies must be an array.' });
          cleanAsm = assemblies.slice(0, 2000).map(a => ({
            id: String(a.id || ('asm_' + crypto.randomBytes(6).toString('hex'))).slice(0, 40),
            name: String(a.name || '').slice(0, 120),
            category: String(a.category || '').slice(0, 60),
            unit: String(a.unit || '').slice(0, 20),
            components: (Array.isArray(a.components) ? a.components : []).slice(0, 200).map(c => ({
              itemId: String(c.itemId || '').slice(0, 40),
              qty: Number(c.qty) || 0
            }))
          }));
        }
        writePricebook(me.companyId, clean, cleanAsm);
        return sendJSON(res, 200, { items: clean, assemblies: cleanAsm !== undefined ? cleanAsm : readAssemblies(me.companyId) });
      }

      // ---- Company profile: get / save (shared by everyone in the company) ----
      if (pathname === '/api/company' && req.method === 'GET') {
        return sendJSON(res, 200, { profile: readCompany(me.companyId), invoiceNext: nextInvoiceNo(companyById(me.companyId)) });
      }
      if (pathname === '/api/company' && req.method === 'PUT') {
        const { profile, invoiceNext } = await readBody(req);
        // Let the company set/adjust the next invoice number directly (blank clears auto-numbering).
        if (invoiceNext !== undefined) {
          const company = companyById(me.companyId);
          if (company) {
            const parsed = parseInvoiceNo(invoiceNext);
            if (parsed) { company.invoicePrefix = parsed.prefix; company.invoicePad = parsed.pad; company.invoiceSeq = parsed.num; }
            else if (String(invoiceNext || '').trim() === '') { company.invoiceSeq = null; company.invoicePrefix = ''; company.invoicePad = 0; }
          }
        }
        const p = profile || {};
        const existingProfile = readCompany(me.companyId) || {};
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
          logo: logoOk ? p.logo : '',
          // Team / labor rates — a small roster the app reuses for time entries and crew dispatch.
          team: Array.isArray(p.team) ? p.team.slice(0, 100).map(t => ({
            id: String(t.id || ('tm_' + crypto.randomBytes(4).toString('hex'))).slice(0, 40),
            name: String(t.name || '').slice(0, 80),
            role: String(t.role || '').slice(0, 80),
            rate: Number(t.rate) || 0
          })).filter(t => t.name || t.role) : [],
          // Editable contract template (with {{placeholders}}). Preserve it if this save didn't include it.
          contractTemplate: typeof p.contractTemplate === 'string' ? p.contractTemplate.slice(0, 20000) : (existingProfile.contractTemplate || '')
        };
        writeCompany(me.companyId, clean);
        // Keep the company RECORD's name in sync with the profile's Company Name field, so the
        // header, home page, and everywhere else that reads the record show the name you edited.
        const companyRec = companyById(me.companyId);
        if (companyRec && clean.name) companyRec.name = clean.name;
        saveDB(db); // persist the name sync + any invoice-counter change on the company record
        return sendJSON(res, 200, { profile: clean, invoiceNext: nextInvoiceNo(companyById(me.companyId)) });
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

      // ---- Reusable estimate templates ----
      if (pathname === '/api/templates' && req.method === 'GET') {
        const list = db.templates.filter(t => t.companyId === me.companyId)
          .map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, updatedAt: t.updatedAt }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/templates' && req.method === 'POST') {
        const { name, doc } = await readBody(req);
        const tpl = { id: 't_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: String(name || 'Untitled template').slice(0, 200), createdAt: Date.now(), updatedAt: Date.now() };
        writeTemplateDoc(tpl.id, templateBodyFrom(doc));
        db.templates.push(tpl);
        saveDB(db);
        return sendJSON(res, 200, { id: tpl.id });
      }
      // Create a new estimate pre-filled from a template (customer/project left blank).
      if (pathname === '/api/estimates/from-template' && req.method === 'POST') {
        const { templateId, name } = await readBody(req);
        const tpl = db.templates.find(t => t.id === templateId && t.companyId === me.companyId);
        if (!tpl) return sendJSON(res, 404, { error: 'Template not found.' });
        const body = templateBodyFrom(readTemplateDoc(tpl.id));
        const est = { id: 'e_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: String(name || tpl.name).slice(0, 200), client: '', total: 0, status: 'draft',
          createdAt: Date.now(), updatedAt: Date.now() };
        writeEstimateDoc(est.id, Object.assign({ company: {}, client: {}, project: '' }, body));
        db.estimates.push(est);
        saveDB(db);
        return sendJSON(res, 200, { id: est.id });
      }
      const tplMatch = pathname.match(/^\/api\/templates\/([a-zA-Z0-9_]+)$/);
      if (tplMatch) {
        const tpl = db.templates.find(t => t.id === tplMatch[1] && t.companyId === me.companyId);
        if (!tpl) return sendJSON(res, 404, { error: 'Template not found.' });
        if (req.method === 'GET') return sendJSON(res, 200, { id: tpl.id, name: tpl.name, doc: readTemplateDoc(tpl.id) });
        if (req.method === 'DELETE') {
          db.templates = db.templates.filter(t => t.id !== tpl.id);
          try { fs.unlinkSync(templatePath(tpl.id)); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }
      // ---- Estimating: one estimate (get / update / delete; must belong to this user) ----
      // ---- Estimate versions (revision history) ----
      const estRevListMatch = pathname.match(/^\/api\/estimates\/([a-zA-Z0-9_]+)\/revisions$/);
      if (estRevListMatch) {
        const est = db.estimates.find(e => e.id === estRevListMatch[1] && e.companyId === me.companyId);
        if (!est) return sendJSON(res, 404, { error: 'Estimate not found.' });
        if (req.method === 'GET') {
          return sendJSON(res, 200, (est.revisions || []).slice().sort((a, b) => b.createdAt - a.createdAt));
        }
        if (req.method === 'POST') {
          const { label } = await readBody(req);
          const rid = 'rev_' + crypto.randomBytes(6).toString('hex');
          writeEstRev(est.id, rid, { doc: readEstimateDoc(est.id), name: est.name, client: est.client, total: est.total });
          est.revisions = est.revisions || [];
          est.revisions.push({ id: rid, label: String(label || '').slice(0, 120) || ('Version ' + (est.revisions.length + 1)),
            total: est.total || 0, createdAt: Date.now() });
          if (est.revisions.length > 50) { // keep the last 50; drop the oldest files
            est.revisions.slice(0, est.revisions.length - 50).forEach(r => { try { fs.unlinkSync(estRevPath(est.id, r.id)); } catch (e) {} });
            est.revisions = est.revisions.slice(-50);
          }
          saveDB(db);
          return sendJSON(res, 200, { id: rid });
        }
      }
      const estRestoreMatch = pathname.match(/^\/api\/estimates\/([a-zA-Z0-9_]+)\/restore$/);
      if (estRestoreMatch && req.method === 'POST') {
        const est = db.estimates.find(e => e.id === estRestoreMatch[1] && e.companyId === me.companyId);
        if (!est) return sendJSON(res, 404, { error: 'Estimate not found.' });
        const { revisionId } = await readBody(req);
        const snap = readEstRev(est.id, revisionId);
        if (!snap) return sendJSON(res, 404, { error: 'Version not found.' });
        writeEstimateDoc(est.id, snap.doc || {});
        if (typeof snap.total === 'number') est.total = snap.total;
        if (snap.client !== undefined) est.client = snap.client;
        est.updatedAt = Date.now();
        saveDB(db);
        return sendJSON(res, 200, { ok: true });
      }

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
          try { fs.rmSync(estRevDir(est.id), { recursive: true, force: true }); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }
      // Create (or fetch) a public share link so a client can view & approve an estimate online.
      const estShareMatch = pathname.match(/^\/api\/estimates\/([a-zA-Z0-9_]+)\/share$/);
      if (estShareMatch && req.method === 'POST') {
        const est = db.estimates.find(e => e.id === estShareMatch[1] && e.companyId === me.companyId);
        if (!est) return sendJSON(res, 404, { error: 'Estimate not found.' });
        if (!est.shareToken) { est.shareToken = crypto.randomBytes(16).toString('hex'); est.updatedAt = Date.now(); saveDB(db); }
        return sendJSON(res, 200, { token: est.shareToken });
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
        const d = doc || {};
        if (!d.invoiceNo) { const no = assignInvoiceNo(companyById(me.companyId)); if (no) d.invoiceNo = no; }
        writeInvoiceDoc(inv.id, d);
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
        // Fold markup into each unit price at FULL precision (don't round per line) so the invoice
        // total equals the estimate the customer approved — rounding each line first made the
        // invoice drift from the estimate by a few cents up to a dollar or two.
        const lines = (edoc.lines || []).map(l => ({
          id: 'l_' + crypto.randomBytes(6).toString('hex'), name: l.name, code: l.code, unit: l.unit,
          qty: Number(l.qty) || 0, unitCost: (Number(l.unitCost) || 0) * mk
        }));
        // Carry any discount from the estimate so the invoice bills exactly what was quoted.
        const discountType = edoc.discountType === 'amt' ? 'amt' : 'pct';
        const discountInput = Number(edoc.discount) || 0;
        const doc = {
          company: edoc.company || {}, client: edoc.client || {}, project: edoc.project || '',
          invoiceNo: '', date: '', dueDate: '', lines, taxPct: Number(edoc.taxPct) || 0,
          discount: discountInput, discountType,
          notes: edoc.notes || '', terms: edoc.terms || '', amountPaid: 0, fromEstimateId: est.id
        };
        const subtotal = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
        let discount = discountType === 'amt' ? discountInput : subtotal * discountInput / 100;
        discount = Math.min(Math.max(discount, 0), subtotal);
        const total = Math.round((subtotal - discount) * (1 + doc.taxPct / 100) * 100) / 100;
        const autoNo = assignInvoiceNo(companyById(me.companyId));
        if (autoNo) doc.invoiceNo = autoNo;
        const inv = { id: 'i_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: est.name || 'Invoice', client: (edoc.client && edoc.client.name) || est.client || '',
          total, amountPaid: 0, fromEstimateId: est.id, createdAt: Date.now(), updatedAt: Date.now() };
        writeInvoiceDoc(inv.id, doc);
        db.invoices.push(inv);
        saveDB(db);
        return sendJSON(res, 200, { id: inv.id });
      }
      // Duplicate an invoice into a fresh unpaid draft — the building block for recurring invoices.
      const invDupMatch = pathname.match(/^\/api\/invoices\/([a-zA-Z0-9_]+)\/duplicate$/);
      if (invDupMatch && req.method === 'POST') {
        const src = db.invoices.find(i => i.id === invDupMatch[1] && i.companyId === me.companyId);
        if (!src) return sendJSON(res, 404, { error: 'Invoice not found.' });
        const sdoc = readInvoiceDoc(src.id) || {};
        const company = companyById(me.companyId);
        const doc = JSON.parse(JSON.stringify(sdoc));
        doc.amountPaid = 0; doc.date = ''; doc.dueDate = '';
        doc.invoiceNo = assignInvoiceNo(company) || '';
        // Advance the recurring schedule marker on the ORIGINAL if it recurs.
        if (Number(sdoc.recurEvery) > 0) {
          const base = sdoc.recurNextDate ? new Date(sdoc.recurNextDate) : new Date();
          base.setMonth(base.getMonth() + Number(sdoc.recurEvery));
          sdoc.recurNextDate = base.toISOString().slice(0, 10);
          writeInvoiceDoc(src.id, sdoc);
        }
        const inv = { id: 'i_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: src.name, client: src.client || '', total: Number(src.total) || 0, amountPaid: 0,
          createdAt: Date.now(), updatedAt: Date.now() };
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
          if (doc !== undefined) {
            maybeSeedInvoiceSeq(companyById(me.companyId), doc.invoiceNo); // remember the first # they type
            writeInvoiceDoc(inv.id, doc);
          }
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

      // ---- Purchase orders: list / create / get / update / delete ----
      if (pathname === '/api/purchase-orders' && req.method === 'GET') {
        const jobName = {}; db.jobs.forEach(j => { if (j.companyId === me.companyId) jobName[j.id] = j.name; });
        const list = db.purchaseOrders.filter(p => p.companyId === me.companyId)
          .map(p => ({ id: p.id, name: p.name, supplier: p.supplier || '', jobId: p.jobId || '',
            jobName: p.jobId ? (jobName[p.jobId] || '') : '', total: p.total || 0, status: poStatus(p.status),
            createdAt: p.createdAt, updatedAt: p.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/purchase-orders' && req.method === 'POST') {
        const { name, supplier, jobId, doc } = await readBody(req);
        const po = { id: 'po_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: name || 'Untitled PO', supplier: supplier || '', jobId: jobId || '',
          total: 0, status: 'draft', createdAt: Date.now(), updatedAt: Date.now() };
        const d = doc || {};
        if (!d.poNo) d.poNo = assignPONo(companyById(me.companyId));
        writePODoc(po.id, d);
        db.purchaseOrders.push(po);
        saveDB(db);
        return sendJSON(res, 200, { id: po.id });
      }
      const poMatch = pathname.match(/^\/api\/purchase-orders\/([a-zA-Z0-9_]+)$/);
      if (poMatch) {
        const po = db.purchaseOrders.find(p => p.id === poMatch[1] && p.companyId === me.companyId);
        if (!po) return sendJSON(res, 404, { error: 'Purchase order not found.' });
        if (req.method === 'GET') {
          return sendJSON(res, 200, { id: po.id, name: po.name, supplier: po.supplier, jobId: po.jobId || '',
            total: po.total, status: poStatus(po.status), createdAt: po.createdAt, updatedAt: po.updatedAt,
            doc: readPODoc(po.id) });
        }
        if (req.method === 'PUT') {
          const { name, supplier, jobId, total, status, doc } = await readBody(req);
          if (name !== undefined) po.name = String(name).slice(0, 200);
          if (supplier !== undefined) po.supplier = String(supplier).slice(0, 200);
          if (jobId !== undefined) po.jobId = String(jobId).slice(0, 60);
          if (typeof total === 'number') po.total = total;
          if (status !== undefined) po.status = poStatus(status);
          if (doc !== undefined) writePODoc(po.id, doc);
          po.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: po.id, updatedAt: po.updatedAt, status: poStatus(po.status) });
        }
        if (req.method === 'DELETE') {
          db.purchaseOrders = db.purchaseOrders.filter(p => p.id !== po.id);
          try { fs.unlinkSync(poPath(po.id)); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // ---- Customers: a hub aggregated by client name across leads / estimates / jobs / invoices ----
      if (pathname === '/api/customers' && req.method === 'GET') {
        const map = {}; // key -> aggregate
        const bump = (name, patch) => {
          const k = custKey(name); if (!k) return null;
          if (!map[k]) map[k] = { key: k, name: (name || '').trim(), leads: 0, estimates: 0, jobs: 0,
            invoices: 0, quoted: 0, invoiced: 0, paid: 0, lastActivity: 0 };
          const c = map[k]; Object.keys(patch).forEach(f => { if (f === 'lastActivity') c[f] = Math.max(c[f], patch[f] || 0); else c[f] += patch[f] || 0; });
          return c;
        };
        db.leads.filter(l => l.companyId === me.companyId).forEach(l => bump(l.name, { leads: 1, lastActivity: l.updatedAt || 0 }));
        db.estimates.filter(e => e.companyId === me.companyId).forEach(e => bump(e.client, { estimates: 1, quoted: Number(e.total) || 0, lastActivity: e.updatedAt || 0 }));
        db.jobs.filter(j => j.companyId === me.companyId).forEach(j => bump(j.client, { jobs: 1, lastActivity: j.updatedAt || 0 }));
        db.invoices.filter(i => i.companyId === me.companyId).forEach(i => bump(i.client, { invoices: 1, invoiced: Number(i.total) || 0, paid: Number(i.amountPaid) || 0, lastActivity: i.updatedAt || 0 }));
        // Include named customers that only exist as a saved note.
        db.customers.filter(c => c.companyId === me.companyId).forEach(c => { const x = bump(c.displayName || c.key, { lastActivity: c.updatedAt || 0 }); });
        const list = Object.values(map).map(c => ({ ...c, quoted: Math.round(c.quoted * 100) / 100,
          invoiced: Math.round(c.invoiced * 100) / 100, paid: Math.round(c.paid * 100) / 100,
          outstanding: Math.round((c.invoiced - c.paid) * 100) / 100 }))
          .sort((a, b) => b.lastActivity - a.lastActivity);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/customer' && req.method === 'GET') {
        const k = custKey((parsed.query && parsed.query.name) || '');
        if (!k) return sendJSON(res, 400, { error: 'A customer name is required.' });
        const leads = db.leads.filter(l => l.companyId === me.companyId && custKey(l.name) === k)
          .map(l => ({ id: l.id, name: l.name, stage: l.stage, value: l.value, updatedAt: l.updatedAt }));
        const estimates = db.estimates.filter(e => e.companyId === me.companyId && custKey(e.client) === k)
          .map(e => ({ id: e.id, name: e.name, status: e.status, total: e.total, updatedAt: e.updatedAt }));
        const jobs = db.jobs.filter(j => j.companyId === me.companyId && custKey(j.client) === k)
          .map(j => ({ id: j.id, name: j.name, status: j.status, updatedAt: j.updatedAt }));
        const invoices = db.invoices.filter(i => i.companyId === me.companyId && custKey(i.client) === k)
          .map(i => ({ id: i.id, name: i.name, total: i.total, amountPaid: i.amountPaid, status: invoiceStatus(i.total, i.amountPaid), updatedAt: i.updatedAt }));
        const rec = db.customers.find(c => c.companyId === me.companyId && c.key === k) || null;
        const displayName = (rec && rec.displayName) || (leads[0] && leads[0].name) || (estimates[0] && '') || k;
        // Build a timeline from derived records + the manual activity log.
        const tl = [];
        leads.forEach(l => tl.push({ ts: l.updatedAt, type: 'lead', text: 'Lead — ' + (l.stage || 'new'), link: '/lead.html?id=' + l.id }));
        estimates.forEach(e => tl.push({ ts: e.updatedAt, type: 'estimate', text: 'Estimate “' + (e.name || '') + '” — ' + (e.status || 'draft') + (e.total ? (' — $' + e.total) : ''), link: '/estimate.html?id=' + e.id }));
        jobs.forEach(j => tl.push({ ts: j.updatedAt, type: 'job', text: 'Job “' + (j.name || '') + '” — ' + (j.status || 'scheduled'), link: '/job.html?id=' + j.id }));
        invoices.forEach(i => tl.push({ ts: i.updatedAt, type: 'invoice', text: 'Invoice “' + (i.name || '') + '” — ' + invoiceStatus(i.total, i.amountPaid) + (i.total ? (' — $' + i.total) : ''), link: '/invoice.html?id=' + i.id }));
        (rec ? rec.activity || [] : []).forEach(a => tl.push({ ts: a.ts, type: 'note', text: a.text, link: '' }));
        tl.sort((a, b) => b.ts - a.ts);
        const totals = {
          quoted: estimates.reduce((s, e) => s + (Number(e.total) || 0), 0),
          invoiced: invoices.reduce((s, i) => s + (Number(i.total) || 0), 0),
          paid: invoices.reduce((s, i) => s + (Number(i.amountPaid) || 0), 0)
        };
        totals.outstanding = Math.round((totals.invoiced - totals.paid) * 100) / 100;
        return sendJSON(res, 200, { key: k, name: displayName, notes: (rec && rec.notes) || '',
          leads, estimates, jobs, invoices, timeline: tl, totals });
      }
      // Add a manual activity entry and/or set the customer's notes.
      if (pathname === '/api/customer' && (req.method === 'POST' || req.method === 'PUT')) {
        const b = await readBody(req);
        const k = custKey(b.name || '');
        if (!k) return sendJSON(res, 400, { error: 'A customer name is required.' });
        let rec = db.customers.find(c => c.companyId === me.companyId && c.key === k);
        if (!rec) { rec = { id: 'cu_' + crypto.randomBytes(8).toString('hex'), companyId: me.companyId,
          key: k, displayName: (b.name || '').trim(), notes: '', activity: [], createdAt: Date.now(), updatedAt: Date.now() };
          db.customers.push(rec); }
        if (typeof b.notes === 'string') rec.notes = b.notes.slice(0, 20000);
        if (b.activityText && String(b.activityText).trim()) {
          rec.activity = rec.activity || [];
          rec.activity.push({ id: 'ac_' + crypto.randomBytes(5).toString('hex'), ts: Date.now(), text: String(b.activityText).slice(0, 2000) });
        }
        rec.updatedAt = Date.now();
        saveDB(db);
        return sendJSON(res, 200, { ok: true });
      }

      // ---- Reports: business summary (AR aging, job profitability, estimate win-rate) ----
      if (pathname === '/api/reports/summary' && req.method === 'GET') {
        const DAY = 86400000, now = Date.now();
        // Accounts receivable — what customers still owe, bucketed by how overdue it is.
        const ar = { totalInvoiced: 0, totalPaid: 0, outstanding: 0,
          buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 }, items: [] };
        db.invoices.filter(i => i.companyId === me.companyId).forEach(i => {
          const total = Number(i.total) || 0, paid = Number(i.amountPaid) || 0;
          ar.totalInvoiced += total; ar.totalPaid += paid;
          const owed = Math.round((total - paid) * 100) / 100;
          if (owed <= 0.005) return;
          ar.outstanding += owed;
          const doc = readInvoiceDoc(i.id) || {};
          const due = doc.dueDate ? Date.parse(doc.dueDate) : null;
          const daysOver = due ? Math.floor((now - due) / DAY) : 0;
          let bucket = 'current';
          if (daysOver > 90) bucket = 'd90plus';
          else if (daysOver > 60) bucket = 'd61_90';
          else if (daysOver > 30) bucket = 'd31_60';
          else if (daysOver > 0) bucket = 'd1_30';
          ar.buckets[bucket] += owed;
          ar.items.push({ id: i.id, name: i.name, client: i.client || '', owed,
            dueDate: doc.dueDate || '', daysOver: daysOver > 0 ? daysOver : 0,
            status: invoiceStatus(total, paid) });
        });
        ar.outstanding = Math.round(ar.outstanding * 100) / 100;
        ar.items.sort((a, b) => b.daysOver - a.daysOver || b.owed - a.owed);
        // Job profitability — contract vs. cost vs. profit (change orders folded in).
        const jobs = { contract: 0, cost: 0, profit: 0, items: [] };
        // Production — jobs running behind schedule, plus total labor hours logged.
        const todayISO = new Date().toISOString().slice(0, 10);
        const production = { activeJobs: 0, completeJobs: 0, totalHours: 0, behind: [] };
        db.jobs.filter(j => j.companyId === me.companyId).forEach(j => {
          const jd = readJobDoc(j.id) || {}, c = jd.costing || {};
          const co = (jd.changeOrders || []).reduce((a, x) => {
            if (x.status === 'approved') { a.price += Number(x.priceDelta) || 0; a.cost += Number(x.costDelta) || 0; }
            return a;
          }, { price: 0, cost: 0 });
          const contract = Math.round(((Number(c.contract) || 0) + co.price) * 100) / 100;
          const cost = Math.round(((Number(c.budget) || 0) + co.cost) * 100) / 100;
          const profit = Math.round((contract - cost) * 100) / 100;
          const margin = contract > 0 ? Math.round(profit / contract * 1000) / 10 : null;
          jobs.contract += contract; jobs.cost += cost; jobs.profit += profit;
          jobs.items.push({ id: j.id, name: j.name, client: j.client || '',
            status: j.status || 'scheduled', contract, cost, profit, margin });
          // production rollup
          const status = j.status || 'scheduled';
          if (status === 'complete') production.completeJobs++; else production.activeJobs++;
          production.totalHours += (jd.timeEntries || []).reduce((s, t) => s + (Number(t.hours) || 0), 0);
          if (status !== 'complete' && jd.dueDate && jd.dueDate < todayISO) {
            production.behind.push({ id: j.id, name: j.name, client: j.client || '', status,
              dueDate: jd.dueDate, daysLate: Math.floor((Date.now() - Date.parse(jd.dueDate)) / 86400000) });
          }
        });
        production.totalHours = Math.round(production.totalHours * 10) / 10;
        production.behind.sort((a, b) => b.daysLate - a.daysLate);
        jobs.contract = Math.round(jobs.contract * 100) / 100;
        jobs.cost = Math.round(jobs.cost * 100) / 100;
        jobs.profit = Math.round(jobs.profit * 100) / 100;
        jobs.margin = jobs.contract > 0 ? Math.round(jobs.profit / jobs.contract * 1000) / 10 : null;
        jobs.items.sort((a, b) => b.contract - a.contract);
        // Estimate win-rate — decided = accepted + rejected; win rate = accepted / decided.
        const est = { counts: { draft: 0, sent: 0, accepted: 0, rejected: 0 },
          value: { accepted: 0, rejected: 0, outstanding: 0 }, winRate: null, valueWinRate: null };
        db.estimates.filter(e => e.companyId === me.companyId).forEach(e => {
          const s = (e.status || 'draft'); const total = Number(e.total) || 0;
          if (est.counts[s] === undefined) est.counts[s] = 0;
          est.counts[s] += 1;
          if (s === 'accepted') est.value.accepted += total;
          else if (s === 'rejected') est.value.rejected += total;
          else est.value.outstanding += total; // draft/sent = still open
        });
        const decided = (est.counts.accepted || 0) + (est.counts.rejected || 0);
        est.winRate = decided > 0 ? Math.round((est.counts.accepted || 0) / decided * 1000) / 10 : null;
        const decidedVal = est.value.accepted + est.value.rejected;
        est.valueWinRate = decidedVal > 0 ? Math.round(est.value.accepted / decidedVal * 1000) / 10 : null;
        ['accepted', 'rejected', 'outstanding'].forEach(k => est.value[k] = Math.round(est.value[k] * 100) / 100);

        // Lead sources — how many leads each source brings and how many turn into won work.
        var srcMap = {};
        db.leads.filter(l => l.companyId === me.companyId).forEach(l => {
          var k = (l.source || '').trim() || '(unspecified)';
          if (!srcMap[k]) srcMap[k] = { source: k, leads: 0, won: 0, lost: 0, wonValue: 0 };
          srcMap[k].leads++;
          if (l.stage === 'won') { srcMap[k].won++; srcMap[k].wonValue += Number(l.value) || 0; }
          else if (l.stage === 'lost') srcMap[k].lost++;
        });
        var leadSources = Object.values(srcMap).map(s => {
          var d = s.won + s.lost;
          return { ...s, wonValue: Math.round(s.wonValue * 100) / 100, conversion: d > 0 ? Math.round(s.won / d * 1000) / 10 : null };
        }).sort((a, b) => b.leads - a.leads);

        // Cash-flow forecast — expected money in from unpaid invoices, bucketed by when they're due.
        var cf = { overdue: 0, d0_30: 0, d31_60: 0, d61_90: 0, later: 0, undated: 0, total: 0 };
        db.invoices.filter(i => i.companyId === me.companyId).forEach(i => {
          var owed = Math.round(((Number(i.total) || 0) - (Number(i.amountPaid) || 0)) * 100) / 100;
          if (owed <= 0.005) return;
          cf.total += owed;
          var idoc = readInvoiceDoc(i.id) || {};
          if (!idoc.dueDate) { cf.undated += owed; return; }
          var days = Math.floor((Date.parse(idoc.dueDate) - Date.now()) / 86400000);
          if (days < 0) cf.overdue += owed; else if (days <= 30) cf.d0_30 += owed;
          else if (days <= 60) cf.d31_60 += owed; else if (days <= 90) cf.d61_90 += owed; else cf.later += owed;
        });
        Object.keys(cf).forEach(k => cf[k] = Math.round(cf[k] * 100) / 100);

        return sendJSON(res, 200, { ar, jobs, estimates: est, leadSources, cashflow: cf, production });
      }

      // ---- Payroll / timesheet export: every time entry across all jobs ----
      if (pathname === '/api/reports/timesheet' && req.method === 'GET') {
        const rows = [];
        const byWorker = {};
        db.jobs.filter(j => j.companyId === me.companyId).forEach(j => {
          const jd = readJobDoc(j.id) || {};
          (jd.timeEntries || []).forEach(t => {
            const hours = Number(t.hours) || 0, rate = Number(t.rate) || 0;
            const amount = Math.round(hours * rate * 100) / 100;
            const worker = (t.worker || '').trim() || '(unnamed)';
            rows.push({ worker, date: t.date || '', hours, rate, amount, job: j.name || '', note: t.note || '' });
            if (!byWorker[worker]) byWorker[worker] = { worker, hours: 0, amount: 0 };
            byWorker[worker].hours += hours; byWorker[worker].amount += amount;
          });
        });
        rows.sort((a, b) => (a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : (a.date < b.date ? -1 : 1)));
        const totals = Object.values(byWorker).map(w => ({ ...w, hours: Math.round(w.hours * 100) / 100, amount: Math.round(w.amount * 100) / 100 }))
          .sort((a, b) => (a.worker < b.worker ? -1 : 1));
        return sendJSON(res, 200, { rows, totals });
      }

      // ---- Schedule: jobs with their start/due dates for the calendar ----
      if (pathname === '/api/schedule' && req.method === 'GET') {
        const list = db.jobs.filter(j => j.companyId === me.companyId)
          .map(j => {
            const jd = readJobDoc(j.id) || {};
            const c = jd.costing || {};
            const co = (jd.changeOrders || []).reduce((a, x) => {
              if (x.status === 'approved') a.price += Number(x.priceDelta) || 0; return a;
            }, { price: 0 });
            return { id: j.id, name: j.name, client: j.client || '', status: j.status || 'scheduled',
                     start: jd.startDate || '', due: jd.dueDate || '',
                     crew: Array.isArray(jd.crew) ? jd.crew : [],
                     contract: Math.round(((Number(c.contract) || 0) + co.price) * 100) / 100 };
          });
        return sendJSON(res, 200, list);
      }
      // ---- Follow-ups & reminders: leads due for follow-up + overdue invoices to chase ----
      if (pathname === '/api/followups' && req.method === 'GET') {
        const DAY = 86400000, now = Date.now();
        const todayStr = new Date(now).toISOString().slice(0, 10);
        const leads = db.leads.filter(l => l.companyId === me.companyId && l.followUp &&
            l.stage !== 'won' && l.stage !== 'lost')
          .map(l => ({ id: l.id, name: l.name, stage: l.stage, followUp: l.followUp, value: l.value,
            overdue: l.followUp <= todayStr }))
          .sort((a, b) => (a.followUp < b.followUp ? -1 : 1));
        const invoices = [];
        db.invoices.filter(i => i.companyId === me.companyId).forEach(i => {
          const owed = Math.round(((Number(i.total) || 0) - (Number(i.amountPaid) || 0)) * 100) / 100;
          if (owed <= 0.005) return;
          const doc = readInvoiceDoc(i.id) || {};
          const due = doc.dueDate ? Date.parse(doc.dueDate) : null;
          const daysOver = due ? Math.floor((now - due) / DAY) : 0;
          invoices.push({ id: i.id, name: i.name, client: i.client || '', owed, dueDate: doc.dueDate || '',
            daysOver: daysOver > 0 ? daysOver : 0, overdue: daysOver > 0 });
        });
        invoices.sort((a, b) => b.daysOver - a.daysOver || b.owed - a.owed);
        // Recurring invoices due to be generated (recurNextDate on or before today).
        const recurring = [];
        db.invoices.filter(i => i.companyId === me.companyId).forEach(i => {
          const doc = readInvoiceDoc(i.id) || {};
          if (Number(doc.recurEvery) > 0 && doc.recurNextDate) {
            recurring.push({ id: i.id, name: i.name, client: i.client || '', every: Number(doc.recurEvery),
              nextDate: doc.recurNextDate, due: doc.recurNextDate <= todayStr });
          }
        });
        recurring.sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1));
        return sendJSON(res, 200, { leads, invoices, recurring, today: todayStr });
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
          status: 'scheduled', fromEstimateId: est.id, createdAt: Date.now(), updatedAt: Date.now() };
        writeJobDoc(job.id, doc);
        db.jobs.push(job);
        saveDB(db);
        return sendJSON(res, 200, { id: job.id });
      }
      // Upload a receipt to a job (streamed raw bytes; metadata stored on the job record).
      const rcptUpMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_]+)\/receipts$/);
      if (rcptUpMatch && req.method === 'POST') {
        const job = db.jobs.find(j => j.id === rcptUpMatch[1] && j.companyId === me.companyId);
        if (!job) return sendJSON(res, 404, { error: 'Job not found.' });
        const rid = 'r_' + crypto.randomBytes(8).toString('hex');
        const dir = receiptDir(job.id);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = receiptPath(job.id, rid) + '.tmp';
        const ws = fs.createWriteStream(tmp);
        let bytes = 0, failed = false;
        const fail = (e, code) => { if (failed) return; failed = true; try { ws.destroy(); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} if (!res.headersSent) sendJSON(res, code || 500, { error: (e && e.message) || String(e) }); };
        req.on('data', (c) => { bytes += c.length; if (bytes > MAX_RECEIPT_BYTES) { fail(new Error('Receipt is too large (max 25 MB).'), 413); try { req.destroy(); } catch (_) {} } });
        ws.on('error', fail); req.on('error', fail);
        ws.on('finish', () => {
          if (failed) return;
          try { fs.renameSync(tmp, receiptPath(job.id, rid)); } catch (e) { return fail(e); }
          const meta = { id: rid, name: String((parsed.query && parsed.query.name) || 'receipt').slice(0, 200),
            mime: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100),
            size: bytes, uploadedAt: Date.now() };
          job.receipts = job.receipts || [];
          job.receipts.push(meta);
          job.updatedAt = Date.now();
          saveDB(db);
          sendJSON(res, 200, meta);
        });
        req.pipe(ws);
        return;
      }
      // Get (stream) or delete one receipt.
      const rcptMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_]+)\/receipts\/([a-zA-Z0-9_]+)$/);
      if (rcptMatch) {
        const job = db.jobs.find(j => j.id === rcptMatch[1] && j.companyId === me.companyId);
        if (!job) return sendJSON(res, 404, { error: 'Job not found.' });
        const meta = (job.receipts || []).find(r => r.id === rcptMatch[2]);
        if (!meta) return sendJSON(res, 404, { error: 'Receipt not found.' });
        if (req.method === 'GET') {
          const f = receiptPath(job.id, meta.id);
          if (!fs.existsSync(f)) return sendJSON(res, 404, { error: 'Receipt file missing.' });
          const stat = fs.statSync(f);
          res.writeHead(200, { 'Content-Type': meta.mime || 'application/octet-stream', 'Content-Length': stat.size,
            'Content-Disposition': 'inline; filename="' + encodeURIComponent(meta.name) + '"', 'Cache-Control': 'private, max-age=3600' });
          const rs = fs.createReadStream(f);
          rs.on('error', () => { if (!res.headersSent) sendJSON(res, 500, { error: 'Could not read the receipt.' }); else res.destroy(); });
          rs.pipe(res);
          return;
        }
        if (req.method === 'DELETE') {
          job.receipts = (job.receipts || []).filter(r => r.id !== meta.id);
          try { fs.unlinkSync(receiptPath(job.id, meta.id)); } catch (e) {}
          job.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }
      // Per-job dashboard: costing rolled up with the totals of any invoices billed from the
      // same estimate (contract / invoiced / paid / outstanding / profit on one screen).
      const jobSummaryMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_]+)\/summary$/);
      if (jobSummaryMatch && req.method === 'GET') {
        const job = db.jobs.find(j => j.id === jobSummaryMatch[1] && j.companyId === me.companyId);
        if (!job) return sendJSON(res, 404, { error: 'Job not found.' });
        const jdoc = readJobDoc(job.id);
        const cost = jdoc.costing || {};
        const co = (jdoc.changeOrders || []).reduce((a, x) => {
          if (x.status === 'approved') { a.price += Number(x.priceDelta) || 0; a.cost += Number(x.costDelta) || 0; }
          return a;
        }, { price: 0, cost: 0 });
        const contract = (Number(cost.contract) || 0) + co.price;
        const budget = (Number(cost.budget) || 0) + co.cost;
        const laborCost = (jdoc.timeEntries || []).reduce((s, t) => s + (Number(t.hours) || 0) * (Number(t.rate) || 0), 0);
        const actualCost = (jdoc.costs || []).reduce((s, c) => s + (Number(c.amount) || 0), 0) + laborCost;
        const round = n => Math.round(n * 100) / 100;
        // Purchase orders raised against this job — committed (ordered + received) vs. received so far.
        let poCommitted = 0, poReceived = 0, poCount = 0;
        db.purchaseOrders.filter(p => p.companyId === me.companyId && p.jobId === job.id).forEach(p => {
          const st = poStatus(p.status), amt = Number(p.total) || 0;
          if (st === 'ordered' || st === 'received') { poCommitted += amt; poCount++; }
          if (st === 'received') poReceived += amt;
        });
        // Invoices billed from the same estimate are considered this job's invoices.
        let invoiced = 0, paid = 0, invoiceCount = 0;
        const estId = job.fromEstimateId || jdoc.fromEstimateId; // record first, doc as fallback
        if (estId) {
          db.invoices.filter(i => i.companyId === me.companyId).forEach(inv => {
            const invEst = inv.fromEstimateId || readInvoiceDoc(inv.id).fromEstimateId;
            if (invEst === estId) {
              invoiced += Number(inv.total) || 0; paid += Number(inv.amountPaid) || 0; invoiceCount++;
            }
          });
        }
        return sendJSON(res, 200, {
          contract: round(contract), changeOrderPrice: round(co.price), budget: round(budget),
          actualCost: round(actualCost),
          estProfit: round(contract - budget), estMargin: contract > 0 ? round((contract - budget) / contract * 100) : null,
          actualProfit: round(contract - actualCost), actualMargin: contract > 0 ? round((contract - actualCost) / contract * 100) : null,
          invoiced: round(invoiced), paid: round(paid), outstanding: round(invoiced - paid), invoiceCount,
          poCommitted: round(poCommitted), poReceived: round(poReceived), poCount
        });
      }
      const jobMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_]+)$/);
      if (jobMatch) {
        const job = db.jobs.find(j => j.id === jobMatch[1] && j.companyId === me.companyId);
        if (!job) return sendJSON(res, 404, { error: 'Job not found.' });
        if (req.method === 'GET') {
          return sendJSON(res, 200, { id: job.id, name: job.name, client: job.client, status: job.status,
            createdAt: job.createdAt, updatedAt: job.updatedAt, receipts: job.receipts || [], doc: readJobDoc(job.id) });
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
          try { fs.rmSync(receiptDir(job.id), { recursive: true, force: true }); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // ---- Work orders: list / create / from-job / get / put / delete ----
      if (pathname === '/api/workorders' && req.method === 'GET') {
        const list = db.workOrders.filter(w => w.companyId === me.companyId)
          .map(w => ({ id: w.id, title: w.title, jobName: w.jobName || '', assignee: w.assignee || '',
                       status: w.status || 'open', scheduledDate: w.scheduledDate || '',
                       createdAt: w.createdAt, updatedAt: w.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/workorders' && req.method === 'POST') {
        const { title, assignee, jobId, jobName, doc } = await readBody(req);
        const wo = { id: 'w_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          title: title || 'Untitled Work Order', assignee: assignee || '', jobId: jobId || '', jobName: jobName || '',
          status: 'open', scheduledDate: '', createdAt: Date.now(), updatedAt: Date.now() };
        writeWorkOrderDoc(wo.id, doc || {});
        db.workOrders.push(wo);
        saveDB(db);
        return sendJSON(res, 200, { id: wo.id });
      }
      // Create a work order from a job — carry the job's scope items into the WO checklist.
      if (pathname === '/api/workorders/from-job' && req.method === 'POST') {
        const { jobId } = await readBody(req);
        const job = db.jobs.find(j => j.id === jobId && j.companyId === me.companyId);
        if (!job) return sendJSON(res, 404, { error: 'Job not found.' });
        const jdoc = readJobDoc(job.id);
        const tasks = (jdoc.lines || []).map(l => ({ id: 'wt_' + crypto.randomBytes(5).toString('hex'),
          text: [l.name, l.qty ? ('(' + l.qty + (l.unit ? ' ' + l.unit : '') + ')') : ''].filter(Boolean).join(' '),
          done: false }));
        const doc = { instructions: jdoc.notes || '', tasks, materials: '', equipment: '', notes: '',
          estHours: '', client: (jdoc.client && jdoc.client.name) || job.client || '' };
        const wo = { id: 'w_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          title: job.name || 'Work Order', assignee: '', jobId: job.id, jobName: job.name || '',
          status: 'open', scheduledDate: '', createdAt: Date.now(), updatedAt: Date.now() };
        writeWorkOrderDoc(wo.id, doc);
        db.workOrders.push(wo);
        saveDB(db);
        return sendJSON(res, 200, { id: wo.id });
      }
      const woMatch = pathname.match(/^\/api\/workorders\/([a-zA-Z0-9_]+)$/);
      if (woMatch) {
        const wo = db.workOrders.find(w => w.id === woMatch[1] && w.companyId === me.companyId);
        if (!wo) return sendJSON(res, 404, { error: 'Work order not found.' });
        if (req.method === 'GET') {
          return sendJSON(res, 200, { id: wo.id, title: wo.title, assignee: wo.assignee, jobId: wo.jobId,
            jobName: wo.jobName, status: wo.status, scheduledDate: wo.scheduledDate,
            createdAt: wo.createdAt, updatedAt: wo.updatedAt, doc: readWorkOrderDoc(wo.id) });
        }
        if (req.method === 'PUT') {
          const { title, assignee, jobId, jobName, status, scheduledDate, doc } = await readBody(req);
          if (title !== undefined) wo.title = String(title).slice(0, 200);
          if (assignee !== undefined) wo.assignee = String(assignee).slice(0, 200);
          if (jobId !== undefined) wo.jobId = String(jobId).slice(0, 40);
          if (jobName !== undefined) wo.jobName = String(jobName).slice(0, 200);
          if (status !== undefined && WO_STATUSES.includes(status)) wo.status = status;
          if (scheduledDate !== undefined) wo.scheduledDate = String(scheduledDate).slice(0, 20);
          if (doc !== undefined) writeWorkOrderDoc(wo.id, doc);
          wo.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: wo.id, updatedAt: wo.updatedAt, status: wo.status });
        }
        if (req.method === 'DELETE') {
          db.workOrders = db.workOrders.filter(w => w.id !== wo.id);
          try { fs.unlinkSync(workOrderPath(wo.id)); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // ---- Leads / CRM: list / create / get / put / delete / convert-to-estimate ----
      if (pathname === '/api/leads' && req.method === 'GET') {
        const list = db.leads.filter(l => l.companyId === me.companyId)
          .map(l => ({ id: l.id, name: l.name, workType: l.workType || '', value: Number(l.value) || 0,
                       stage: l.stage || 'new', source: l.source || '', followUp: l.followUp || '',
                       createdAt: l.createdAt, updatedAt: l.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/leads' && req.method === 'POST') {
        const { name, doc } = await readBody(req);
        const lead = { id: 'ld_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: name || 'New Lead', workType: '', value: 0, stage: 'new', source: '', followUp: '',
          createdAt: Date.now(), updatedAt: Date.now() };
        writeLeadDoc(lead.id, doc || {});
        db.leads.push(lead);
        saveDB(db);
        return sendJSON(res, 200, { id: lead.id });
      }
      // Turn a lead into an estimate — prefill the client from the lead, mark the lead as estimating.
      if (pathname === '/api/estimates/from-lead' && req.method === 'POST') {
        const { leadId } = await readBody(req);
        const lead = db.leads.find(l => l.id === leadId && l.companyId === me.companyId);
        if (!lead) return sendJSON(res, 404, { error: 'Lead not found.' });
        const ld = readLeadDoc(lead.id);
        const doc = { company: {}, client: { name: lead.name || '', address: ld.address || '' },
          project: lead.workType || '', lines: [], markupPct: 0, taxPct: 0,
          notes: ld.notes ? ('From lead: ' + ld.notes) : '', discount: 0, discountType: 'pct' };
        const est = { id: 'e_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: (lead.name ? lead.name + ' — ' : '') + (lead.workType || 'Estimate'), client: lead.name || '',
          total: 0, status: 'draft', createdAt: Date.now(), updatedAt: Date.now() };
        writeEstimateDoc(est.id, doc);
        db.estimates.push(est);
        lead.stage = 'estimating'; lead.estimateId = est.id; lead.updatedAt = Date.now();
        saveDB(db);
        return sendJSON(res, 200, { id: est.id });
      }
      const leadMatch = pathname.match(/^\/api\/leads\/([a-zA-Z0-9_]+)$/);
      if (leadMatch) {
        const lead = db.leads.find(l => l.id === leadMatch[1] && l.companyId === me.companyId);
        if (!lead) return sendJSON(res, 404, { error: 'Lead not found.' });
        if (req.method === 'GET') {
          return sendJSON(res, 200, { id: lead.id, name: lead.name, workType: lead.workType, value: lead.value,
            stage: lead.stage, source: lead.source, followUp: lead.followUp, estimateId: lead.estimateId || '',
            createdAt: lead.createdAt, updatedAt: lead.updatedAt, doc: readLeadDoc(lead.id) });
        }
        if (req.method === 'PUT') {
          const { name, workType, value, stage, source, followUp, doc } = await readBody(req);
          if (name !== undefined) lead.name = String(name).slice(0, 200);
          if (workType !== undefined) lead.workType = String(workType).slice(0, 120);
          if (value !== undefined) lead.value = Number(value) || 0;
          if (stage !== undefined && LEAD_STAGES.includes(stage)) lead.stage = stage;
          if (source !== undefined) lead.source = String(source).slice(0, 120);
          if (followUp !== undefined) lead.followUp = String(followUp).slice(0, 20);
          if (doc !== undefined) writeLeadDoc(lead.id, doc);
          lead.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: lead.id, updatedAt: lead.updatedAt, stage: lead.stage });
        }
        if (req.method === 'DELETE') {
          db.leads = db.leads.filter(l => l.id !== lead.id);
          try { fs.unlinkSync(leadPath(lead.id)); } catch (e) {}
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
        const workOrders = db.workOrders.filter(w => w.companyId === me.companyId).map(w => ({
          id: w.id, title: w.title, assignee: w.assignee, jobId: w.jobId, jobName: w.jobName,
          status: w.status, scheduledDate: w.scheduledDate,
          createdAt: w.createdAt, updatedAt: w.updatedAt, doc: readWorkOrderDoc(w.id)
        }));
        const purchaseOrders = db.purchaseOrders.filter(p => p.companyId === me.companyId).map(p => ({
          id: p.id, name: p.name, supplier: p.supplier, jobId: p.jobId, total: p.total, status: p.status,
          createdAt: p.createdAt, updatedAt: p.updatedAt, doc: readPODoc(p.id)
        }));
        return sendJSON(res, 200, {
          fieldscaleBackup: 1, companyName: company ? company.name : '',
          profile: readCompany(me.companyId), pricebook: readPricebook(me.companyId) || [],
          assemblies: readAssemblies(me.companyId),
          templates: db.templates.filter(t => t.companyId === me.companyId).map(t => ({
            id: t.id, name: t.name, createdAt: t.createdAt, updatedAt: t.updatedAt, doc: readTemplateDoc(t.id)
          })),
          leads: db.leads.filter(l => l.companyId === me.companyId).map(l => ({
            id: l.id, name: l.name, workType: l.workType, value: l.value, stage: l.stage, source: l.source,
            followUp: l.followUp, createdAt: l.createdAt, updatedAt: l.updatedAt, doc: readLeadDoc(l.id)
          })),
          customers: db.customers.filter(c => c.companyId === me.companyId).map(c => ({
            id: c.id, key: c.key, displayName: c.displayName, notes: c.notes, activity: c.activity || [],
            createdAt: c.createdAt, updatedAt: c.updatedAt
          })),
          projects, estimates, invoices, jobs, workOrders, purchaseOrders
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
        if (Array.isArray(b.assemblies)) writePricebook(me.companyId, undefined, b.assemblies);
        (Array.isArray(b.templates) ? b.templates : []).forEach(tb => {
          let tpl = db.templates.find(x => x.id === tb.id && x.companyId === me.companyId);
          if (!tpl) {
            tpl = { id: (typeof tb.id === 'string' && tb.id) ? tb.id : ('t_' + crypto.randomBytes(8).toString('hex')),
              userId: me.id, companyId: me.companyId, name: tb.name || 'Restored template',
              createdAt: tb.createdAt || Date.now(), updatedAt: Date.now() };
            db.templates.push(tpl);
          }
          if (tb.doc) writeTemplateDoc(tpl.id, tb.doc);
        });
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
        let woN = 0;
        (Array.isArray(b.workOrders) ? b.workOrders : []).forEach(wb => {
          let wo = db.workOrders.find(x => x.id === wb.id && x.companyId === me.companyId);
          if (!wo) {
            wo = { id: (typeof wb.id === 'string' && wb.id) ? wb.id : ('w_' + crypto.randomBytes(8).toString('hex')),
              userId: me.id, companyId: me.companyId, title: wb.title || 'Restored work order', assignee: wb.assignee || '',
              jobId: wb.jobId || '', jobName: wb.jobName || '',
              status: WO_STATUSES.includes(wb.status) ? wb.status : 'open', scheduledDate: wb.scheduledDate || '',
              createdAt: wb.createdAt || Date.now(), updatedAt: Date.now() };
            db.workOrders.push(wo);
          }
          if (wb.doc) writeWorkOrderDoc(wo.id, wb.doc);
          wo.updatedAt = Date.now(); woN++;
        });
        let leadN = 0;
        (Array.isArray(b.leads) ? b.leads : []).forEach(lb => {
          let lead = db.leads.find(x => x.id === lb.id && x.companyId === me.companyId);
          if (!lead) {
            lead = { id: (typeof lb.id === 'string' && lb.id) ? lb.id : ('ld_' + crypto.randomBytes(8).toString('hex')),
              userId: me.id, companyId: me.companyId, name: lb.name || 'Restored lead', workType: lb.workType || '',
              value: Number(lb.value) || 0, stage: LEAD_STAGES.includes(lb.stage) ? lb.stage : 'new',
              source: lb.source || '', followUp: lb.followUp || '',
              createdAt: lb.createdAt || Date.now(), updatedAt: Date.now() };
            db.leads.push(lead);
          }
          if (lb.doc) writeLeadDoc(lead.id, lb.doc);
          lead.updatedAt = Date.now(); leadN++;
        });
        let poN = 0;
        (Array.isArray(b.purchaseOrders) ? b.purchaseOrders : []).forEach(pb => {
          let po = db.purchaseOrders.find(x => x.id === pb.id && x.companyId === me.companyId);
          if (!po) {
            po = { id: (typeof pb.id === 'string' && pb.id) ? pb.id : ('po_' + crypto.randomBytes(8).toString('hex')),
              userId: me.id, companyId: me.companyId, name: pb.name || 'Restored PO', supplier: pb.supplier || '',
              jobId: pb.jobId || '', total: Number(pb.total) || 0, status: poStatus(pb.status),
              createdAt: pb.createdAt || Date.now(), updatedAt: Date.now() };
            db.purchaseOrders.push(po);
          }
          if (pb.doc) writePODoc(po.id, pb.doc);
          po.updatedAt = Date.now(); poN++;
        });
        (Array.isArray(b.customers) ? b.customers : []).forEach(cb => {
          const key = custKey(cb.key || cb.displayName || '');
          if (!key) return;
          let rec = db.customers.find(x => x.companyId === me.companyId && x.key === key);
          if (!rec) { rec = { id: 'cu_' + crypto.randomBytes(8).toString('hex'), companyId: me.companyId,
            key, displayName: cb.displayName || '', notes: '', activity: [], createdAt: cb.createdAt || Date.now(), updatedAt: Date.now() };
            db.customers.push(rec); }
          if (typeof cb.notes === 'string') rec.notes = cb.notes;
          if (Array.isArray(cb.activity)) rec.activity = cb.activity;
          rec.updatedAt = Date.now();
        });
        saveDB(db);
        return sendJSON(res, 200, { restored: true, projects: projN, estimates: estN, invoices: invN, jobs: jobN, workOrders: woN, leads: leadN, purchaseOrders: poN });
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
