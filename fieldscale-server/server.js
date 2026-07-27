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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Session signing key. Prefer the SESSION_SECRET env var. If it isn't set, generate one ONCE and
// persist it under the data dir so sessions survive restarts (instead of logging everyone out every
// deploy). We still warn, because a real env var is the production best practice.
const SESSION_SECRET_FROM_ENV = !!process.env.SESSION_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  const secretFile = path.join(DATA_DIR, '.session-secret');
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, s, { mode: 0o600 });
    console.warn('[fieldscale] WARNING: SESSION_SECRET env not set — generated a persistent secret at ' + secretFile + '.');
    console.warn('[fieldscale] Sessions will survive restarts, but setting SESSION_SECRET in your environment is the production best practice.');
    return s;
  } catch (e) {
    console.warn('[fieldscale] WARNING: SESSION_SECRET not set and could not persist one — using a per-boot secret (everyone logs out on restart).');
    return crypto.randomBytes(32).toString('hex');
  }
})();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// The deployment owner can name themselves platform admin here, regardless of who signed up
// first. Set PLATFORM_ADMIN_USERNAME to your username and you always get the cross-company view.
const PLATFORM_ADMIN_USERNAME = (process.env.PLATFORM_ADMIN_USERNAME || '').trim().toLowerCase();
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
// Site-visit files attached to a lead — on disk, metadata on the lead doc (doc.files), managed only
// by the upload/delete endpoints so a normal lead save can never wipe them.
const LEAD_FILES_DIR = path.join(DATA_DIR, 'lead-files');
function leadFileDir(id){ return path.join(LEAD_FILES_DIR, id); }
function leadFilePath(id, fid){ return path.join(leadFileDir(id), fid); }
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

// ---------- Floor Plans (a standalone sketch tool: walls + fixtures on a scaled grid) ----------
// Its own store, walled off per company, mirroring leads. The full drawing (walls/fixtures/rooms)
// lives in a per-plan doc on disk; db.json keeps only lightweight listing metadata.
const PLANS_DIR = path.join(DATA_DIR, 'plans');
// NOTE: named floorPlanPath (NOT planPath) — the takeoff tool already has a planPath() for its
// PDF plan sets. A duplicate planPath() here would win via hoisting and silently redirect the
// takeoff's PDF reads/writes to the wrong place (broke plan upload + loading).
function floorPlanPath(id){ return path.join(PLANS_DIR, id + '.json'); }
function readPlanDoc(id){
  const f = floorPlanPath(id);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writePlanDoc(id, doc){
  if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
  writeJsonAtomic(floorPlanPath(id), doc || {});
}

// ---------- Receipts attached to a job (kept on disk for the life of the job) ----------
// Files live under data/receipts/<jobId>/<receiptId>; the metadata lives on the job record
// (job.receipts), so a client save of the job doc can never clobber them.
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
function receiptDir(jobId){ return path.join(RECEIPTS_DIR, jobId); }
function receiptPath(jobId, rid){ return path.join(receiptDir(jobId), rid); }
// Subcontractor compliance docs (COI, W-9, license…) — files on disk, metadata on the company profile's sub record.
const SUBDOCS_DIR = path.join(DATA_DIR, 'sub-docs');
function subDocDir(subId){ return path.join(SUBDOCS_DIR, subId); }
function subDocPath(subId, docId){ return path.join(subDocDir(subId), docId); }
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
  parsed.plans = parsed.plans || [];
  parsed.purchaseOrders = parsed.purchaseOrders || [];
  parsed.customers = parsed.customers || []; // per-customer notes + activity log (records are derived otherwise)
  parsed.audit = parsed.audit || []; // activity log / audit trail (capped)
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
  (db.plans || []).forEach(p => { if (!p.companyId) p.companyId = company.id; });
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

// ---------- Activity log / audit trail ----------
// Records who did what, per company. Capped so the db file can't grow forever. Caller saves the db.
function logAudit(me, action, detail) {
  try {
    db.audit.push({ at: Date.now(), companyId: me && me.companyId ? me.companyId : '',
      userId: me && me.id ? me.id : '', username: (me && me.username) || '', action: String(action || ''),
      detail: String(detail || '').slice(0, 300) });
    if (db.audit.length > 5000) db.audit = db.audit.slice(-4000);
  } catch (e) { /* logging must never break the request */ }
}

// ---------- Automatic backups ----------
// Snapshot the structured JSON data (db + all record docs) into DATA_DIR/backups daily, keeping the
// last 14. Plan PDFs and receipt photos are excluded — they're big and the customer has the originals.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
let lastBackup = null;
function runBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, 'backup-' + stamp);
    fs.mkdirSync(dest, { recursive: true });
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, path.join(dest, 'db.json'));
    const dirs = [COMPANIES_DIR, ESTIMATES_DIR, EST_REV_DIR, TEMPLATES_DIR, INVOICES_DIR, PO_DIR, JOBS_DIR, WORKORDERS_DIR, LEADS_DIR, PRICEBOOKS_DIR];
    for (const d of dirs) { if (fs.existsSync(d)) fs.cpSync(d, path.join(dest, path.basename(d)), { recursive: true }); }
    const keep = 14;
    const all = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort();
    while (all.length > keep) { const old = all.shift(); try { fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true }); } catch (e) {} }
    lastBackup = { at: Date.now(), name: 'backup-' + stamp, ok: true };
    console.log('[fieldscale] backup written:', dest);
  } catch (e) {
    lastBackup = { at: Date.now(), ok: false, error: e.message };
    console.warn('[fieldscale] backup failed:', e.message);
  }
}

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
    hideFinancials: !!u.hideFinancials,
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
// Who can see money (job costs, profit, reports): owners/admins always; members unless an admin has
// turned their "sees financials" off; field employees never (they're blocked separately).
function canSeeFinancials(u) { return !!u && u.role !== 'field' && (u.role === 'owner' || u.role === 'admin' || !u.hideFinancials); }
// Field employees can only touch job work: their jobs, and the field data they enter (daily logs,
// time, task check-offs, photos) plus their own account basics. Everything else is 403.
function fieldAllowed(pathname, method) {
  if (pathname === '/api/me' && method === 'GET') return true;
  if (pathname === '/api/branding' && method === 'GET') return true;
  if (pathname === '/api/password' && method === 'POST') return true;
  if (pathname === '/api/jobs' && method === 'GET') return true;
  if (pathname === '/api/schedule' && method === 'GET') return true;
  if (/^\/api\/jobs\/[a-zA-Z0-9_]+$/.test(pathname) && (method === 'GET' || method === 'PUT')) return true;
  if (/^\/api\/jobs\/[a-zA-Z0-9_]+\/receipts$/.test(pathname) && (method === 'GET' || method === 'POST')) return true;
  if (/^\/api\/jobs\/[a-zA-Z0-9_]+\/receipts\/[a-zA-Z0-9_]+$/.test(pathname) && (method === 'GET' || method === 'DELETE')) return true;
  return false;
}
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
// Company-wide auto-numbering for jobs ('job') and work orders ('wo'). Auto-starts at J-0001 / WO-0001;
// the starting/next number is settable on the Company page (mirrors the invoice counter).
const NUM_DEFAULT = { job: 'J-', wo: 'WO-' };
function nextNumber(company, k) {
  if (!company || company[k + 'Seq'] == null) return NUM_DEFAULT[k] + '0001';
  return (company[k + 'Prefix'] || '') + String(company[k + 'Seq']).padStart(company[k + 'Pad'] || 0, '0');
}
function assignNumber(company, k) {
  if (!company) return NUM_DEFAULT[k] + '0001';
  if (company[k + 'Seq'] == null) { company[k + 'Prefix'] = NUM_DEFAULT[k]; company[k + 'Pad'] = 4; company[k + 'Seq'] = 1; }
  const no = (company[k + 'Prefix'] || '') + String(company[k + 'Seq']).padStart(company[k + 'Pad'] || 0, '0');
  company[k + 'Seq'] = company[k + 'Seq'] + 1;
  return no;
}
function setNextNumber(company, k, str) {
  if (!company) return;
  if (String(str == null ? '' : str).trim() === '') { company[k + 'Seq'] = null; company[k + 'Prefix'] = ''; company[k + 'Pad'] = 0; return; }
  const p = parseInvoiceNo(str); if (!p) return;
  company[k + 'Prefix'] = p.prefix; company[k + 'Pad'] = p.pad; company[k + 'Seq'] = p.num;
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

// ---------- AI features (Claude) ----------
// One shared path so every AI feature is billed, rate-limited and error-handled the same way.
// AI_MOCK lets the test suite exercise the full request→parse→UI flow without a real key.
const AI_MOCK = process.env.AI_MOCK === '1';
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
function aiEnabled() { return AI_MOCK || !!ANTHROPIC_API_KEY; }
const AI_OFF_MSG = 'AI features are off — no ANTHROPIC_API_KEY is set on the server yet.';
function aiErr(e) { return e && e.message ? ('AI error: ' + e.message) : 'AI request failed.'; }
async function aiCall({ system, messages, max_tokens, model, beta }) {
  const headers = { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
  if (beta) headers['anthropic-beta'] = beta;
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: model || AI_MODEL, max_tokens: Math.min(max_tokens || 1024, MAX_AI_TOKENS), system, messages })
  });
  const data = await anthropicRes.json();
  if (data.error) throw new Error(data.error.message || 'Anthropic API error');
  return (data.content || []).map(b => b.text || '').join('\n').trim();
}
// Build one user message (optional images first, then the prompt) and return the model's text.
// In AI_MOCK mode it returns the supplied canned response so the pipeline is testable offline.
async function aiText({ system, user, images, documents, max_tokens, model, mock }) {
  if (AI_MOCK) return typeof mock === 'function' ? mock() : (mock || '');
  const content = [];
  (documents || []).forEach(d => content.push({ type: 'document', source: { type: 'base64', media_type: d.mime || 'application/pdf', data: d.data } }));
  (images || []).forEach(img => content.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/png', data: img.data } }));
  content.push({ type: 'text', text: user });
  // PDF documents ride on Anthropic's document beta so they work on the pinned api version.
  const beta = (documents && documents.length) ? 'pdfs-2024-09-25' : undefined;
  return aiCall({ system, messages: [{ role: 'user', content }], max_tokens, model, beta });
}
// Accept a PDF data URL (or raw base64 PDF) for the document reader. Returns null if it isn't a PDF.
function parseDocInput(input) {
  if (!input || typeof input !== 'string') return null;
  const m = input.match(/^data:application\/pdf;base64,(.*)$/i);
  if (!m) return null;
  const data = m[1];
  if (data.length > 8 * 1024 * 1024) return null; // ~6MB
  return { mime: 'application/pdf', data };
}
// Pull the first JSON object/array out of a reply (models sometimes wrap it in prose or ```json fences).
function parseJSONLoose(text) {
  if (!text) return null;
  let t = String(text);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1];
  const start = t.search(/[\[{]/); if (start < 0) return null;
  const open = t[start], close = open === '{' ? '}' : ']';
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) { const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true; else if (c === open) depth++; else if (c === close) { if (--depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { return null; }
}
// ---------- Outbound email (provider-agnostic, over HTTP so no extra deps) ----------
// Configure via env: EMAIL_PROVIDER (resend|sendgrid|postmark), EMAIL_API_KEY, EMAIL_FROM
// (e.g. "Acme Builders <no-reply@acme.com>" — must be a verified sender on the provider).
// Until those are set, emailConfigured() is false and callers fall back gracefully.
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || '').toLowerCase();
const EMAIL_API_KEY = process.env.EMAIL_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
function emailConfigured() { return !!(EMAIL_PROVIDER && EMAIL_API_KEY && EMAIL_FROM); }
async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!emailConfigured()) throw new Error('not_configured');
  if (!to) throw new Error('No recipient email.');
  let url, headers = { 'Content-Type': 'application/json' }, body;
  if (EMAIL_PROVIDER === 'resend') {
    url = 'https://api.resend.com/emails'; headers.Authorization = 'Bearer ' + EMAIL_API_KEY;
    body = { from: EMAIL_FROM, to: [to], subject, html, text }; if (replyTo) body.reply_to = replyTo;
  } else if (EMAIL_PROVIDER === 'sendgrid') {
    url = 'https://api.sendgrid.com/v3/mail/send'; headers.Authorization = 'Bearer ' + EMAIL_API_KEY;
    const fromEmail = (EMAIL_FROM.match(/<([^>]+)>/) || [null, EMAIL_FROM])[1];
    const fromName = (EMAIL_FROM.match(/^([^<]+)</) || [null, ''])[1].trim();
    body = { personalizations: [{ to: [{ email: to }] }], from: { email: fromEmail, name: fromName || undefined },
      subject, content: [{ type: 'text/plain', value: text || '' }, { type: 'text/html', value: html || '' }] };
    if (replyTo) body.reply_to = { email: replyTo };
  } else if (EMAIL_PROVIDER === 'postmark') {
    url = 'https://api.postmarkapp.com/email'; headers['X-Postmark-Server-Token'] = EMAIL_API_KEY; headers.Accept = 'application/json';
    body = { From: EMAIL_FROM, To: to, Subject: subject, HtmlBody: html, TextBody: text }; if (replyTo) body.ReplyTo = replyTo;
  } else {
    throw new Error('Unknown EMAIL_PROVIDER "' + EMAIL_PROVIDER + '" (use resend, sendgrid, or postmark).');
  }
  if (process.env.EMAIL_API_URL) url = process.env.EMAIL_API_URL;  // override (self-hosted proxy / testing)
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('Email provider error (' + r.status + '): ' + t.slice(0, 200)); }
  return { ok: true };
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

// A data-URL or raw base64 → { mime, data } for the vision endpoints. Caps size to protect the bill.
function parseImageInput(image) {
  if (!image || typeof image !== 'string') return null;
  let mime = 'image/png', data = image;
  const m = image.match(/^data:(image\/[a-z+]+);base64,(.*)$/i);
  if (m) { mime = m[1]; data = m[2]; }
  if (data.length > 8 * 1024 * 1024) return null; // ~6MB image
  return { mime, data };
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

// ---------- Generic per-IP rate limiting for public endpoints (anti-spam / anti-abuse) ----------
const rateBuckets = new Map(); // key -> { count, resetAt }
function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown'; }
// Returns true when the caller has exceeded `max` requests in the rolling `windowMs`.
function rateLimited(bucket, req, max, windowMs) {
  const now = Date.now();
  const key = bucket + ':' + clientIp(req);
  let rec = rateBuckets.get(key);
  if (!rec || rec.resetAt <= now) { rec = { count: 0, resetAt: now + windowMs }; rateBuckets.set(key, rec); }
  rec.count += 1;
  if (rateBuckets.size > 5000) { for (const [k, v] of rateBuckets) { if (v.resetAt <= now) rateBuckets.delete(k); } }
  return rec.count > max;
}
const TOO_MANY = { error: 'Too many requests — please slow down and try again in a few minutes.' };

// ---------- Security headers (applied to every response) ----------
// CSP allows the app's inline scripts/handlers (it's built with them), Google Fonts, the pdf.js CDN
// used by the takeoff viewer, and blob/data URLs for PDF generation — while blocking framing
// (clickjacking), plugins, and stray script/base origins. HSTS only over HTTPS.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' https://fonts.gstatic.com data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline' blob: https://cdnjs.cloudflare.com",
  "worker-src 'self' blob: https://cdnjs.cloudflare.com",
  "connect-src 'self' https://cdnjs.cloudflare.com",
  "manifest-src 'self'",
  "form-action 'self'"
].join('; ');
function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', CSP);
  if ((req.headers['x-forwarded-proto'] || '') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

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
  applySecurityHeaders(req, res);

  try {
    // ---- Health check (hosting platforms ping this) ----
    if (pathname === '/api/health') {
      return sendJSON(res, 200, { ok: true, users: db.users.length });
    }

    // ---- Is AI turned on? (safe to be public — reports only whether a key is set, never the key) ----
    if (pathname === '/api/ai/status') {
      return sendJSON(res, 200, { enabled: aiEnabled(), model: aiEnabled() ? AI_MODEL : null });
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
      if (rateLimited('register', req, 5, 60 * 60 * 1000)) return sendJSON(res, 429, TOO_MANY); // 5/hour/IP
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
      logAudit(user, 'auth.login', 'Signed in');
      saveDB(db);
      return sendJSON(res, 200, { token: createToken(user), username: user.username, role: user.role });
    }

    // ---- Public (no login): a client viewing / approving a shared estimate by token ----
    if (pathname === '/api/public/estimate' && req.method === 'GET') {
      if (rateLimited('pubest', req, 120, 10 * 60 * 1000)) return sendJSON(res, 429, TOO_MANY);
      const token = (parsed.query && parsed.query.token) || '';
      const est = token ? db.estimates.find(e => e.shareToken === token) : null;
      if (!est) return sendJSON(res, 404, { error: 'This link is no longer valid.' });
      const doc = readEstimateDoc(est.id);
      // Only expose what a client should see — the proposal, not internal notes.
      const lines = (doc.lines || []).map(l => ({ name: l.name, code: l.code, unit: l.unit,
        qty: l.qty, unitCost: l.unitCost, mode: l.mode, unitPrice: l.unitPrice, material: l.material,
        laborHours: l.laborHours, laborRate: l.laborRate, mkEff: l.mkEff, taxEff: l.taxEff, optional: !!l.optional }));
      return sendJSON(res, 200, { name: est.name, status: est.status,
        company: doc.company || {}, client: doc.client || {}, project: doc.project || '',
        estimateNo: doc.estimateNo || '', date: doc.date || '', validUntil: doc.validUntil || '',
        lines, markupPct: doc.markupPct || 0, profitPct: doc.profitPct || 0, taxPct: doc.taxPct || 0,
        showQty: doc.showQty !== false, showUnit: doc.showUnit !== false,
        showUnitPrice: doc.showUnitPrice !== false, showLineTotal: doc.showLineTotal !== false,
        estimateClass: doc.estimateClass || 'residential',
        validDays: doc.validDays || 0, depositPct: doc.depositPct || 0, balanceDue: doc.balanceDue || '',
        discount: doc.discount || 0, discountType: doc.discountType || 'pct',
        notes: doc.notes || '', terms: doc.terms || '', signature: doc.signature || null });
    }
    if (pathname === '/api/public/estimate-accept' && req.method === 'POST') {
      if (rateLimited('accept', req, 20, 10 * 60 * 1000)) return sendJSON(res, 429, TOO_MANY);
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
    // Client portal (no login): a customer views their job's status, estimates & invoices by token.
    if (pathname === '/api/public/portal' && req.method === 'GET') {
      if (rateLimited('portal', req, 120, 10 * 60 * 1000)) return sendJSON(res, 429, TOO_MANY);
      const token = (parsed.query && parsed.query.token) || '';
      const job = token ? db.jobs.find(j => j.portalToken === token) : null;
      if (!job) return sendJSON(res, 404, { error: 'This link is no longer valid.' });
      const jd = readJobDoc(job.id) || {};
      const comp = readCompany(job.companyId) || {};
      const companyRec = companyById(job.companyId);
      const estimates = [];
      if (job.fromEstimateId) {
        const est = db.estimates.find(e => e.id === job.fromEstimateId && e.companyId === job.companyId);
        if (est) estimates.push({ name: est.name, status: est.status, total: Number(est.total) || 0,
          approveToken: est.status === 'accepted' ? '' : (est.shareToken || '') });
      }
      const invoices = db.invoices.filter(i => i.companyId === job.companyId &&
        ((job.fromEstimateId && i.fromEstimateId === job.fromEstimateId) || i.fromJobId === job.id)).map(i => {
        const idoc = readInvoiceDoc(i.id) || {};
        const total = Number(i.total) || 0, paid = Number(i.amountPaid) || 0;
        return { invoiceNo: idoc.invoiceNo || '', name: i.name, total: Math.round(total * 100) / 100,
          paid: Math.round(paid * 100) / 100, balance: Math.round((total - paid) * 100) / 100,
          status: invoiceStatus(total, paid), payLink: (idoc.payLink && /^https?:\/\//i.test(idoc.payLink)) ? idoc.payLink : '' };
      });
      const changeOrders = (jd.changeOrders || []).map(c => ({ id: c.id, description: c.description || '',
        priceDelta: Number(c.priceDelta) || 0, status: c.status || 'pending' }));
      return sendJSON(res, 200, {
        company: { name: comp.name || (companyRec && companyRec.name) || '', logo: comp.logo || '', phone: comp.phone || '',
          email: comp.email || '', website: comp.website || '', license: comp.license || '', address: comp.address || '' },
        job: { name: job.name, client: (jd.client && jd.client.name) || job.client || '', project: jd.project || '',
          status: job.status || 'scheduled', percentComplete: Math.max(0, Math.min(100, Number(jd.percentComplete) || 0)),
          startDate: jd.startDate || '', dueDate: jd.dueDate || '' },
        message: jd.clientMessage || '', estimates, invoices, changeOrders
      });
    }
    // Client portal: the customer approves or declines a change order.
    if (pathname === '/api/public/portal/co' && req.method === 'POST') {
      if (rateLimited('portalco', req, 30, 10 * 60 * 1000)) return sendJSON(res, 429, TOO_MANY);
      const b = await readBody(req);
      const job = b.token ? db.jobs.find(j => j.portalToken === b.token) : null;
      if (!job) return sendJSON(res, 404, { error: 'This link is no longer valid.' });
      const jd = readJobDoc(job.id) || {};
      const co = (jd.changeOrders || []).find(c => c.id === b.coId);
      if (!co) return sendJSON(res, 404, { error: 'Change order not found.' });
      if (co.status === 'approved' || co.status === 'rejected') return sendJSON(res, 200, { status: co.status });
      co.status = (b.decision === 'approved') ? 'approved' : 'rejected';
      co.decidedAt = Date.now();
      writeJobDoc(job.id, jd);
      job.updatedAt = Date.now();
      saveDB(db);
      return sendJSON(res, 200, { status: co.status });
    }
    // Public lead-capture form: a website visitor submits their info and it becomes a new lead.
    if (pathname === '/api/public/lead' && req.method === 'POST') {
      if (rateLimited('lead', req, 10, 10 * 60 * 1000)) return sendJSON(res, 429, TOO_MANY); // anti-spam

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
      if (rateLimited('leadform', req, 60, 10 * 60 * 1000)) return sendJSON(res, 429, TOO_MANY);
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

      // Field employees are locked to job work only — the server (not just the UI) blocks everything
      // else so estimates, pricing, invoices, reports and settings are never reachable by them.
      if (me.role === 'field' && !fieldAllowed(pathname, req.method)) {
        return sendJSON(res, 403, { error: 'Your field account doesn’t have access to that.' });
      }

      // GET /api/me
      if (pathname === '/api/me' && req.method === 'GET') {
        const company = companyById(me.companyId);
        return sendJSON(res, 200, {
          username: me.username, role: me.role, id: me.id,
          companyId: me.companyId, companyName: company ? company.name : '',
          platformAdmin: isPlatformAdmin(me),
          hideFinancials: !canSeeFinancials(me),
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
            role: role === 'admin' ? 'admin' : (role === 'field' ? 'field' : 'member'),
            platformAdmin: false,
            disabled: false, tokenVersion: 1, aiCalls: 0,
            createdAt: Date.now(), lastLoginAt: null
          };
          db.users.push(user);
          logAudit(me, 'user.create', 'Created ' + user.username + ' (' + user.role + ')');
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
            const { role, disabled, password, hideFinancials } = await readBody(req);
            if (typeof hideFinancials === 'boolean') target.hideFinancials = hideFinancials;
            if (target.id === me.id && role === 'member') {
              return sendJSON(res, 400, { error: "You can't remove your own admin access." });
            }
            if (target.id === me.id && disabled === true) {
              return sendJSON(res, 400, { error: "You can't disable your own account." });
            }
            if (target.role === 'admin' && (role === 'member' || role === 'field' || disabled === true) && companyAdminCount(me.companyId) <= 1) {
              return sendJSON(res, 400, { error: 'This is the only admin left. Promote someone else first.' });
            }
            if (role === 'admin' || role === 'member' || role === 'field') target.role = role; // never 'owner' via API
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
            const changes = [];
            if (role === 'admin' || role === 'member' || role === 'field') changes.push('role→' + role);
            if (typeof disabled === 'boolean') changes.push(disabled ? 'disabled' : 'enabled');
            if (password !== undefined) changes.push('password reset');
            logAudit(me, 'user.update', target.username + ': ' + (changes.join(', ') || 'updated'));
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
            logAudit(me, 'user.delete', 'Deleted ' + target.username);
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

      // ===================== AI ASSISTANT FEATURES =====================
      // Each one: check the key is set, rate-limit the caller, do the work, count the call.
      const aiBlocked = () => { if (!aiEnabled()) { sendJSON(res, 503, { error: AI_OFF_MSG }); return true; }
        const lim = checkAiRateLimit(userId); if (lim) { sendJSON(res, 429, { error: lim }); return true; } return false; };
      const aiDone = () => { me.aiCalls = (me.aiCalls || 0) + 1; saveDB(db); };

      // ---- Scope of work from rough notes (also drives the estimate "Write scope" button) ----
      if (pathname === '/api/ai/scope' && req.method === 'POST') {
        if (aiBlocked()) return;
        const { notes, trade, projectType } = await readBody(req);
        if (!notes || !String(notes).trim()) return sendJSON(res, 400, { error: 'Add a few notes for the AI to work from.' });
        const system = 'You are a professional construction estimator. Turn the contractor\'s rough notes into a clear, well-organized Scope of Work for a customer proposal. Use short paragraphs or bullet points describing what is included and how the work will be done. Be specific and professional. Do NOT invent prices, brand names, dimensions, or commitments not implied by the notes. Only list exclusions the notes mention. Output plain text, no markdown headers.';
        const user = (trade ? 'Trade: ' + trade + '\n' : '') + (projectType ? 'Project: ' + projectType + '\n' : '') + 'Notes:\n' + String(notes).slice(0, 4000);
        try { const text = await aiText({ system, user, max_tokens: 1200, mock: () => 'Contractor will furnish all labor, materials, and equipment to complete the following:\n\n• ' + String(notes).slice(0, 200) + '\n• Clean up and haul away debris on completion.' });
          aiDone(); return sendJSON(res, 200, { text });
        } catch (e) { return sendJSON(res, 502, { error: aiErr(e) }); }
      }

      // ---- Draft a change order from a plain-language request ----
      if (pathname === '/api/ai/changeorder' && req.method === 'POST') {
        if (aiBlocked()) return;
        const { request: reqText } = await readBody(req);
        if (!reqText || !String(reqText).trim()) return sendJSON(res, 400, { error: 'Describe the change so the AI can draft it.' });
        const system = 'You draft construction change orders. Given a plain-language request, return ONLY JSON: {"title":"short title","scope":"1-2 sentence professional description of the added/changed work","reason":"why (customer request, field condition, etc.)","priceNote":"a short note on how it should be priced, e.g. T&M or a lump sum — do NOT invent a dollar amount"}. No prose outside the JSON.';
        try { const text = await aiText({ system, user: String(reqText).slice(0, 3000), max_tokens: 700, mock: () => '{"title":"Added work","scope":"Furnish and install the additional work described by the client.","reason":"Client request.","priceNote":"Recommend pricing as a lump sum once quantities are confirmed."}' });
          const co = parseJSONLoose(text) || { title: 'Change order', scope: text, reason: '', priceNote: '' };
          aiDone(); return sendJSON(res, 200, { changeOrder: co });
        } catch (e) { return sendJSON(res, 502, { error: aiErr(e) }); }
      }

      // ---- Summarize a job's daily logs into a friendly customer update ----
      if (pathname === '/api/ai/logsummary' && req.method === 'POST') {
        if (aiBlocked()) return;
        const { jobId, logs } = await readBody(req);
        let logText = '';
        if (jobId) { const job = db.jobs.find(j => j.id === jobId && j.companyId === me.companyId); if (!job) return sendJSON(res, 404, { error: 'Job not found.' });
          const doc = readJobDoc(job.id) || {};
          logText = (doc.dailyLogs || []).map(l => [l.date, l.crew ? ('crew: ' + l.crew) : '', l.weather, l.workDone || l.note].filter(Boolean).join(' — ')).join('\n'); }
        else logText = String(logs || '');
        if (!logText.trim()) return sendJSON(res, 400, { error: 'No daily logs to summarize yet.' });
        const system = 'You write short, friendly progress updates a contractor can send a homeowner. From the crew\'s daily logs, write 2-4 warm, plain-language sentences on what got done and what\'s next. No jargon, no pricing, no promises about dates unless the logs state them. Output plain text.';
        try { const text = await aiText({ system, user: 'Daily logs:\n' + logText.slice(0, 4000), max_tokens: 500, mock: () => 'Great progress on your project this week — the crew completed the work noted in the logs and kept the site tidy. We\'ll continue with the next phase shortly and keep you posted.' });
          aiDone(); return sendJSON(res, 200, { text });
        } catch (e) { return sendJSON(res, 502, { error: aiErr(e) }); }
      }

      // ---- Conversational search across the company's records ----
      if (pathname === '/api/ai/search' && req.method === 'POST') {
        if (aiBlocked()) return;
        const { query } = await readBody(req);
        if (!query || !String(query).trim()) return sendJSON(res, 400, { error: 'Type a question.' });
        const cid = me.companyId;
        const jobs = db.jobs.filter(j => j.companyId === cid).map(j => `JOB "${j.name}" client=${j.client||'?'} status=${j.status||'?'}`);
        const ests = db.estimates.filter(e => e.companyId === cid).map(e => `ESTIMATE "${e.name}" client=${e.client||'?'} total=$${Math.round(e.total||0)} status=${e.status||'?'}`);
        const invs = db.invoices.filter(i => i.companyId === cid).map(i => `INVOICE #${i.invoiceNo||'?'} client=${i.client||'?'} total=$${Math.round(i.total||0)} paid=$${Math.round(i.amountPaid||0)} status=${invoiceStatus(i.total,i.amountPaid)}`);
        const leads = db.leads.filter(l => l.companyId === cid).map(l => `LEAD "${l.name}" stage=${l.stage||'?'} value=$${Math.round(l.value||0)}`);
        const corpus = [...jobs, ...ests, ...invs, ...leads].join('\n').slice(0, 12000);
        const system = 'You answer a contractor\'s questions using ONLY the records provided. Be concise and specific; cite the record names/numbers. If the answer isn\'t in the data, say so plainly. Never invent records or figures.';
        try { const text = await aiText({ system, user: 'Records:\n' + (corpus || '(no records yet)') + '\n\nQuestion: ' + String(query).slice(0, 500), max_tokens: 700, mock: () => 'Based on your records: ' + (corpus ? corpus.split('\n')[0] : 'no records yet') + '.' });
          aiDone(); return sendJSON(res, 200, { text });
        } catch (e) { return sendJSON(res, 502, { error: aiErr(e) }); }
      }

      // ---- Read a receipt photo → structured expense fields ----
      if (pathname === '/api/ai/receipt' && req.method === 'POST') {
        if (aiBlocked()) return;
        const { image } = await readBody(req);
        const pdf = parseDocInput(image);
        const img = pdf ? null : parseImageInput(image);
        if (!pdf && !img) return sendJSON(res, 400, { error: 'Send a receipt or vendor invoice — a photo or a PDF, under ~6MB.' });
        const system = 'You read receipts and vendor invoices for a contractor\'s bookkeeping. Return ONLY JSON: {"vendor":"","date":"YYYY-MM-DD or empty","total":number,"tax":number,"category":"Materials|Fuel|Tools|Subcontractor|Permit|Other","summary":"short line of what was bought"}. "total" is the final amount due including tax. If a field is unreadable, use "" or 0. No prose outside the JSON.';
        try { const text = await aiText({ system, user: 'Extract the receipt/invoice fields.', images: img ? [img] : undefined, documents: pdf ? [pdf] : undefined, max_tokens: 500, model: AI_MODEL, mock: () => '{"vendor":"Test Supply Co","date":"2026-07-26","total":142.55,"tax":9.55,"category":"Materials","summary":"Lumber and fasteners"}' });
          const data = parseJSONLoose(text) || {};
          aiDone(); return sendJSON(res, 200, { receipt: data });
        } catch (e) { return sendJSON(res, 502, { error: aiErr(e) }); }
      }

      // ---- Suggest takeoff items from a plan image (AI suggestions to verify) ----
      if (pathname === '/api/ai/takeoff' && req.method === 'POST') {
        if (aiBlocked()) return;
        const { image, trade } = await readBody(req);
        const img = parseImageInput(image);
        if (!img) return sendJSON(res, 400, { error: 'Send an image of the plan/drawing (under ~6MB).' });
        const system = 'You are a construction estimator reviewing a plan image. Suggest likely takeoff items to price. Return ONLY JSON: {"items":[{"item":"","qty":number,"unit":"SF|LF|EA|CY|LS","note":"basis/assumption"}],"disclaimer":"These are AI estimates from a drawing — verify against the real plans."}. Estimate quantities only when the drawing supports it; otherwise use 0 and explain in note.';
        try { const text = await aiText({ system, user: (trade ? 'Trade focus: ' + trade + '. ' : '') + 'Suggest takeoff items.', images: [img], max_tokens: 1500, mock: () => '{"items":[{"item":"Wall framing","qty":0,"unit":"LF","note":"Measure walls to confirm"}],"disclaimer":"These are AI estimates from a drawing — verify against the real plans."}' });
          const data = parseJSONLoose(text) || { items: [], disclaimer: 'Could not read the drawing — please verify manually.' };
          aiDone(); return sendJSON(res, 200, data);
        } catch (e) { return sendJSON(res, 502, { error: aiErr(e) }); }
      }

      // ---- Flag jobs at risk of losing money (data-driven, AI explains) ----
      if (pathname === '/api/ai/risk' && req.method === 'POST') {
        if (aiBlocked()) return;
        if (!canSeeFinancials(me)) return sendJSON(res, 403, { error: 'Financial access required.' });
        const cid = me.companyId;
        const rows = db.jobs.filter(j => j.companyId === cid && j.status !== 'complete').map(j => {
          const doc = readJobDoc(j.id) || {}; const c = doc.costing || {};
          const contract = Number(c.contract) || 0, budget = Number(c.budget) || 0;
          const cost = (doc.timeEntries || []).reduce((s, t) => s + (Number(t.hours) || 0) * (Number(t.rate) || 0), 0)
            + (doc.materials || []).reduce((s, m) => s + (Number(m.cost) || 0), 0)
            + (j.receipts ? 0 : 0);
          const pct = Number(doc.percentComplete) || 0;
          return { name: j.name, client: j.client || '', contract, budget, costToDate: Math.round(cost), percentComplete: pct };
        });
        if (!rows.length) return sendJSON(res, 200, { text: 'No open jobs to analyze yet.' });
        const system = 'You are a construction job-cost analyst. Given each open job\'s contract, budget, cost-to-date and % complete, flag which are at risk of losing money and briefly why (e.g. cost pace exceeds % complete, cost near/over budget). Be concise: one short line per at-risk job, then a one-line overall note. If none look risky, say so. No invented numbers.';
        try { const text = await aiText({ system, user: 'Jobs:\n' + JSON.stringify(rows), max_tokens: 800, mock: () => 'Reviewed ' + rows.length + ' open job(s). None show clear signs of loss based on the current numbers. Keep logging costs to keep this accurate.' });
          aiDone(); return sendJSON(res, 200, { text, jobs: rows });
        } catch (e) { return sendJSON(res, 502, { error: aiErr(e) }); }
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
        const co = companyById(me.companyId);
        return sendJSON(res, 200, { profile: readCompany(me.companyId), invoiceNext: nextInvoiceNo(co),
          jobNext: nextNumber(co, 'job'), woNext: nextNumber(co, 'wo') });
      }
      if (pathname === '/api/company' && req.method === 'PUT') {
        const { profile, invoiceNext, jobNext, woNext } = await readBody(req);
        // Let the company set/adjust the next invoice / job / work-order number (blank = auto from 1).
        if (invoiceNext !== undefined) {
          const company = companyById(me.companyId);
          if (company) {
            const parsed = parseInvoiceNo(invoiceNext);
            if (parsed) { company.invoicePrefix = parsed.prefix; company.invoicePad = parsed.pad; company.invoiceSeq = parsed.num; }
            else if (String(invoiceNext || '').trim() === '') { company.invoiceSeq = null; company.invoicePrefix = ''; company.invoicePad = 0; }
          }
        }
        if (jobNext !== undefined) setNextNumber(companyById(me.companyId), 'job', jobNext);
        if (woNext !== undefined) setNextNumber(companyById(me.companyId), 'wo', woNext);
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
          // Employee roster — name, charged hourly rate, contact + payroll employee #. Reused for
          // time entries and crew dispatch. Preserve it if this save didn't include it.
          team: Array.isArray(p.team) ? p.team.slice(0, 200).map(t => ({
            id: String(t.id || ('tm_' + crypto.randomBytes(4).toString('hex'))).slice(0, 40),
            name: String(t.name || '').slice(0, 80),
            role: String(t.role || '').slice(0, 80),
            rate: Number(t.rate) || 0,
            email: String(t.email || '').slice(0, 120),
            phone: String(t.phone || '').slice(0, 60),
            empNo: String(t.empNo || '').slice(0, 60),
            certs: String(t.certs || '').slice(0, 300),
            certExpires: String(t.certExpires || '').slice(0, 20)
          })).filter(t => t.name || t.role || t.email || t.phone || t.empNo) : (existingProfile.team || []),
          // Reusable task/checklist templates for jobs. Preserved if omitted.
          taskTemplates: Array.isArray(p.taskTemplates) ? p.taskTemplates.slice(0, 100).map(tt => ({
            id: String(tt.id || ('tt_' + crypto.randomBytes(4).toString('hex'))).slice(0, 40),
            name: String(tt.name || '').slice(0, 120),
            tasks: Array.isArray(tt.tasks) ? tt.tasks.slice(0, 200).map(x => String(x || '').slice(0, 300)).filter(Boolean) : []
          })).filter(tt => tt.name) : (existingProfile.taskTemplates || []),
          // Subcontractor roster + compliance (W-9 on file, insurance/license expiry). Preserved if omitted.
          subs: Array.isArray(p.subs) ? (function(){ const prevDocs={}; (existingProfile.subs||[]).forEach(s=>{ prevDocs[s.id]=s.docs||[]; });
            return p.subs.slice(0, 300).map(sb => { const id=String(sb.id || ('sb_' + crypto.randomBytes(4).toString('hex'))).slice(0, 40);
            return {
            id,
            name: String(sb.name || '').slice(0, 120),
            trade: String(sb.trade || '').slice(0, 80),
            contact: String(sb.contact || '').slice(0, 80),
            phone: String(sb.phone || '').slice(0, 60),
            email: String(sb.email || '').slice(0, 120),
            w9: !!sb.w9,
            coiExpires: String(sb.coiExpires || '').slice(0, 20),
            licenseExpires: String(sb.licenseExpires || '').slice(0, 20),
            notes: String(sb.notes || '').slice(0, 2000), docs: prevDocs[id] || []
          }; }).filter(sb => sb.name || sb.trade || sb.email || sb.phone); })() : (existingProfile.subs || []),
          // Markup-by-category & tax rules: per-category markup % and taxable flag, matched by line Code.
          markupRules: Array.isArray(p.markupRules) ? p.markupRules.slice(0, 60).map(r => ({
            code: String(r.code || '').slice(0, 80),
            markupPct: Number(r.markupPct) || 0,
            taxable: !!r.taxable
          })).filter(r => r.code) : (existingProfile.markupRules || []),
          // Editable contract template (with {{placeholders}}). Preserve it if this save didn't include it.
          contractTemplate: typeof p.contractTemplate === 'string' ? p.contractTemplate.slice(0, 20000) : (existingProfile.contractTemplate || '')
        };
        writeCompany(me.companyId, clean);
        // Keep the company RECORD's name in sync with the profile's Company Name field, so the
        // header, home page, and everywhere else that reads the record show the name you edited.
        const companyRec = companyById(me.companyId);
        if (companyRec && clean.name) companyRec.name = clean.name;
        logAudit(me, 'company.update', 'Updated company profile');
        saveDB(db); // persist the name sync + any invoice/job/WO-counter change on the company record
        const coRec = companyById(me.companyId);
        return sendJSON(res, 200, { profile: clean, invoiceNext: nextInvoiceNo(coRec), jobNext: nextNumber(coRec, 'job'), woNext: nextNumber(coRec, 'wo') });
      }

      // ---- Employee roster (name, rate, email, phone, payroll #) ----
      if (pathname === '/api/team' && req.method === 'GET') {
        return sendJSON(res, 200, { team: (readCompany(me.companyId) || {}).team || [] });
      }
      if (pathname === '/api/team' && req.method === 'PUT') {
        if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Only the owner or an admin can manage employees.' });
        const { team } = await readBody(req);
        const prof = readCompany(me.companyId) || {};
        prof.team = Array.isArray(team) ? team.slice(0, 200).map(t => ({
          id: String(t.id || ('tm_' + crypto.randomBytes(4).toString('hex'))).slice(0, 40),
          name: String(t.name || '').slice(0, 80),
          role: String(t.role || '').slice(0, 80),
          rate: Number(t.rate) || 0,
          email: String(t.email || '').slice(0, 120),
          phone: String(t.phone || '').slice(0, 60),
          empNo: String(t.empNo || '').slice(0, 60),
          certs: String(t.certs || '').slice(0, 300),
          certExpires: String(t.certExpires || '').slice(0, 20)
        })).filter(t => t.name || t.role || t.email || t.phone || t.empNo) : [];
        writeCompany(me.companyId, prof);
        return sendJSON(res, 200, { team: prof.team });
      }

      // ---- Reusable task templates (job checklists) ----
      if (pathname === '/api/task-templates' && req.method === 'GET') {
        return sendJSON(res, 200, { templates: (readCompany(me.companyId) || {}).taskTemplates || [] });
      }
      if (pathname === '/api/task-templates' && req.method === 'POST') {
        const { name, tasks } = await readBody(req);
        if (!String(name || '').trim()) return sendJSON(res, 400, { error: 'Name the template.' });
        const prof = readCompany(me.companyId) || {};
        prof.taskTemplates = prof.taskTemplates || [];
        prof.taskTemplates.push({ id: 'tt_' + crypto.randomBytes(4).toString('hex'),
          name: String(name).slice(0, 120),
          tasks: (Array.isArray(tasks) ? tasks : []).slice(0, 200).map(x => String(x || '').slice(0, 300)).filter(Boolean) });
        writeCompany(me.companyId, prof);
        return sendJSON(res, 200, { templates: prof.taskTemplates });
      }
      const ttDelMatch = pathname.match(/^\/api\/task-templates\/([a-zA-Z0-9_]+)$/);
      if (ttDelMatch && req.method === 'DELETE') {
        const prof = readCompany(me.companyId) || {};
        prof.taskTemplates = (prof.taskTemplates || []).filter(t => t.id !== ttDelMatch[1]);
        writeCompany(me.companyId, prof);
        return sendJSON(res, 200, { templates: prof.taskTemplates });
      }

      // ---- Subcontractors (roster + compliance) ----
      if (pathname === '/api/subs' && req.method === 'GET') {
        return sendJSON(res, 200, { subs: (readCompany(me.companyId) || {}).subs || [] });
      }
      if (pathname === '/api/subs' && req.method === 'PUT') {
        if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Only the owner or an admin can manage subcontractors.' });
        const { subs } = await readBody(req);
        const prof = readCompany(me.companyId) || {};
        // Uploaded docs are server-managed (files on disk); a list save must never trust client doc
        // metadata — preserve each sub's existing docs by id instead.
        const prevDocs = {}; (prof.subs || []).forEach(s => { prevDocs[s.id] = s.docs || []; });
        prof.subs = Array.isArray(subs) ? subs.slice(0, 300).map(sb => {
          const id = String(sb.id || ('sb_' + crypto.randomBytes(4).toString('hex'))).slice(0, 40);
          return {
            id, name: String(sb.name || '').slice(0, 120), trade: String(sb.trade || '').slice(0, 80),
            contact: String(sb.contact || '').slice(0, 80), phone: String(sb.phone || '').slice(0, 60),
            email: String(sb.email || '').slice(0, 120), w9: !!sb.w9,
            coiExpires: String(sb.coiExpires || '').slice(0, 20), licenseExpires: String(sb.licenseExpires || '').slice(0, 20),
            notes: String(sb.notes || '').slice(0, 2000), docs: prevDocs[id] || []
          };
        }).filter(sb => sb.name || sb.trade || sb.email || sb.phone) : [];
        writeCompany(me.companyId, prof);
        return sendJSON(res, 200, { subs: prof.subs });
      }
      // Upload a compliance doc (COI / W-9 / other) to a subcontractor. Streams to disk like receipts.
      const subDocUp = pathname.match(/^\/api\/subs\/([a-zA-Z0-9_]+)\/docs$/);
      if (subDocUp && req.method === 'POST') {
        if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Only the owner or an admin can manage subcontractors.' });
        const prof = readCompany(me.companyId) || {};
        const sub = (prof.subs || []).find(s => s.id === subDocUp[1]);
        if (!sub) return sendJSON(res, 404, { error: 'Save the subcontractor first, then upload documents.' });
        const did = 'd_' + crypto.randomBytes(8).toString('hex');
        const dir = subDocDir(sub.id);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = subDocPath(sub.id, did) + '.tmp';
        const ws = fs.createWriteStream(tmp);
        let bytes = 0, failed = false;
        const fail = (e, code) => { if (failed) return; failed = true; try { ws.destroy(); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} if (!res.headersSent) sendJSON(res, code || 500, { error: (e && e.message) || String(e) }); };
        req.on('data', (c) => { bytes += c.length; if (bytes > MAX_RECEIPT_BYTES) { fail(new Error('File is too large (max 25 MB).'), 413); try { req.destroy(); } catch (_) {} } });
        ws.on('error', fail); req.on('error', fail);
        ws.on('finish', () => {
          if (failed) return;
          try { fs.renameSync(tmp, subDocPath(sub.id, did)); } catch (e) { return fail(e); }
          let kind = String((parsed.query && parsed.query.kind) || 'other').toLowerCase();
          if (['coi', 'w9', 'other'].indexOf(kind) < 0) kind = 'other';
          const meta = { id: did, kind,
            name: String((parsed.query && parsed.query.name) || (kind === 'coi' ? 'COI' : kind === 'w9' ? 'W-9' : 'Document')).slice(0, 200),
            mime: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100),
            size: bytes, uploadedAt: Date.now() };
          sub.docs = sub.docs || [];
          sub.docs.push(meta);
          if (kind === 'w9') sub.w9 = true;   // a W-9 on file marks the checkbox
          writeCompany(me.companyId, prof);
          logAudit(me, 'sub.doc.add', (sub.name || 'sub') + ' — ' + kind);
          sendJSON(res, 200, meta);
        });
        req.pipe(ws);
        return;
      }
      // View (stream) or delete one subcontractor doc.
      const subDocMatch = pathname.match(/^\/api\/subs\/([a-zA-Z0-9_]+)\/docs\/([a-zA-Z0-9_]+)$/);
      if (subDocMatch) {
        const prof = readCompany(me.companyId) || {};
        const sub = (prof.subs || []).find(s => s.id === subDocMatch[1]);
        if (!sub) return sendJSON(res, 404, { error: 'Subcontractor not found.' });
        const meta = (sub.docs || []).find(d => d.id === subDocMatch[2]);
        if (!meta) return sendJSON(res, 404, { error: 'Document not found.' });
        if (req.method === 'GET') {
          const f = subDocPath(sub.id, meta.id);
          if (!fs.existsSync(f)) return sendJSON(res, 404, { error: 'File missing.' });
          const stat = fs.statSync(f);
          res.writeHead(200, { 'Content-Type': meta.mime || 'application/octet-stream', 'Content-Length': stat.size,
            'Content-Disposition': 'inline; filename="' + encodeURIComponent(meta.name) + '"', 'Cache-Control': 'private, max-age=3600' });
          const rs = fs.createReadStream(f);
          rs.on('error', () => { if (!res.headersSent) sendJSON(res, 500, { error: 'Could not read the file.' }); else res.destroy(); });
          rs.pipe(res);
          return;
        }
        if (req.method === 'DELETE') {
          if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Only the owner or an admin can manage subcontractors.' });
          sub.docs = (sub.docs || []).filter(d => d.id !== meta.id);
          try { fs.unlinkSync(subDocPath(sub.id, meta.id)); } catch (e) {}
          writeCompany(me.companyId, prof);
          logAudit(me, 'sub.doc.remove', (sub.name || 'sub') + ' — ' + meta.kind);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // ---- Security status + activity log (owner/admin) ----
      if (pathname === '/api/security' && req.method === 'GET') {
        if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Owners and admins only.' });
        let backupCount = 0;
        try { backupCount = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).length; } catch (e) {}
        return sendJSON(res, 200, {
          secretFromEnv: SESSION_SECRET_FROM_ENV,
          securityHeaders: true,
          lastBackup: lastBackup,
          backupCount
        });
      }
      // Owner/admin can trigger a backup on demand.
      if (pathname === '/api/security/backup' && req.method === 'POST') {
        if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Owners and admins only.' });
        runBackup();
        logAudit(me, 'backup.run', 'Manual backup');
        saveDB(db);
        return sendJSON(res, 200, { lastBackup });
      }
      if (pathname === '/api/audit' && req.method === 'GET') {
        if (!isCompanyAdmin(me)) return sendJSON(res, 403, { error: 'Owners and admins only.' });
        const rows = db.audit.filter(a => a.companyId === me.companyId).slice(-200).reverse();
        return sendJSON(res, 200, { rows });
      }

      // ---- Estimating: list / create estimates ----
      if (pathname === '/api/estimates' && req.method === 'GET') {
        const list = db.estimates.filter(e => e.companyId === me.companyId)
          .map(e => ({ id: e.id, name: e.name, client: e.client || '', total: e.total || 0,
                       status: e.jobId ? 'job' : (e.status || 'draft'), jobId: e.jobId || '',
                       createdAt: e.createdAt, updatedAt: e.updatedAt }))
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
          logAudit(me, 'estimate.delete', 'Deleted estimate "' + (est.name || est.id) + '"');
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
      // Email the customer the proposal + its online-approval link, straight from the app.
      const estSendMatch = pathname.match(/^\/api\/estimates\/([a-zA-Z0-9_]+)\/send-approval$/);
      if (estSendMatch && req.method === 'POST') {
        const est = db.estimates.find(e => e.id === estSendMatch[1] && e.companyId === me.companyId);
        if (!est) return sendJSON(res, 404, { error: 'Estimate not found.' });
        const body = await readBody(req);
        const edoc = readEstimateDoc(est.id) || {};
        const to = (body.to && String(body.to).trim()) || (edoc.client && edoc.client.email) || '';
        if (!to) return sendJSON(res, 400, { error: "Add the customer's email on the estimate first, then send." });
        if (!est.shareToken) { est.shareToken = crypto.randomBytes(16).toString('hex'); est.updatedAt = Date.now(); saveDB(db); }
        const proto = (req.headers['x-forwarded-proto'] || 'https');
        const link = proto + '://' + (req.headers['host'] || '') + '/accept.html?token=' + est.shareToken;
        const company = (edoc.company && edoc.company.name) || (companyById(me.companyId) || {}).name || 'Our company';
        const clientName = (edoc.client && edoc.client.name) || 'there';
        const subject = (body.subject && String(body.subject).slice(0, 200)) || ('Your proposal from ' + company + (edoc.project ? (' — ' + edoc.project) : ''));
        const intro = (body.message && String(body.message)) || ('Thank you for the opportunity. Your proposal' + (edoc.project ? (' for ' + edoc.project) : '') + ' is ready to review and approve online.');
        const replyTo = (edoc.company && edoc.company.email) || undefined;
        const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e242c;line-height:1.55">'
          + '<p>Hi ' + esc(clientName) + ',</p><p>' + esc(intro) + '</p>'
          + '<p style="margin:20px 0"><a href="' + esc(link) + '" style="display:inline-block;background:#2F6DB0;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">Review &amp; approve your proposal</a></p>'
          + '<p style="color:#5c6672;font-size:12px">Or paste this link into your browser:<br>' + esc(link) + '</p>'
          + '<p>Thank you,<br>' + esc(company) + '</p></div>';
        const text = 'Hi ' + clientName + ',\n\n' + intro + '\n\nReview & approve your proposal:\n' + link + '\n\nThank you,\n' + company;
        if (!emailConfigured()) return sendJSON(res, 200, { sent: false, reason: 'not_configured', link, to });
        try {
          await sendEmail({ to, subject, html, text, replyTo });
          logAudit(me, 'estimate.email-approval', est.name + ' → ' + to);
          return sendJSON(res, 200, { sent: true, to });
        } catch (e) {
          if (e.message === 'not_configured') return sendJSON(res, 200, { sent: false, reason: 'not_configured', link, to });
          return sendJSON(res, 502, { error: 'Could not send the email: ' + e.message, link });
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
        // Default markup (Overhead + Profit) for lines without a category rule. Per line we use the
        // snapshot the estimate saved (mkEff / taxEff) so the invoice bills exactly what was quoted.
        const defMk = (Number(edoc.markupPct) || 0) + (Number(edoc.profitPct) || 0);
        // Fold at FULL precision (don't round per line) so the invoice total equals the estimate
        // the customer approved — rounding each line first made it drift by a few cents.
        // Optional add-ons/alternates are excluded — they weren't part of the quoted Total.
        const billLines = (edoc.lines || []).filter(l => !l.optional);
        const lines = billLines.map(l => {
          const effMk = (l.mkEff !== undefined && l.mkEff !== null) ? Number(l.mkEff) : defMk;
          return { id: 'l_' + crypto.randomBytes(6).toString('hex'), name: l.name, code: l.code, unit: l.unit,
            description: l.description || '', qty: Number(l.qty) || 0, unitCost: (Number(l.unitCost) || 0) * (1 + effMk / 100) };
        });
        // Carry any discount from the estimate so the invoice bills exactly what was quoted.
        const discountType = edoc.discountType === 'amt' ? 'amt' : 'pct';
        const discountInput = Number(edoc.discount) || 0;
        // Tax base = the taxable portion of each line (category rules can flip a trade on/off).
        // Default: build-up material is taxed; flat prices are tax-included. Carried as a fixed amount.
        const materialBase = billLines.reduce((s, l) => {
          const taxable = (l.taxEff !== undefined && l.taxEff !== null) ? !!l.taxEff : (l.mode === 'buildup');
          if (!taxable) return s;
          const base = l.mode === 'buildup' ? (Number(l.material) || 0) : (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
          return s + base;
        }, 0);
        const materialTax = Math.round(materialBase * (Number(edoc.taxPct) || 0) / 100 * 100) / 100;
        const doc = {
          company: edoc.company || {}, client: edoc.client || {}, project: edoc.project || '',
          invoiceNo: '', date: '', dueDate: '', lines, taxPct: 0, taxAmount: materialTax,
          discount: discountInput, discountType,
          notes: edoc.notes || '', terms: edoc.terms || '', amountPaid: 0, fromEstimateId: est.id
        };
        const subtotal = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
        let discount = discountType === 'amt' ? discountInput : subtotal * discountInput / 100;
        discount = Math.min(Math.max(discount, 0), subtotal);
        const total = Math.round(((subtotal - discount) + materialTax) * 100) / 100;
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
      // Progress billing: create an invoice for one draw (a % of the job's contract).
      if (pathname === '/api/invoices/from-draw' && req.method === 'POST') {
        const { jobId, drawId } = await readBody(req);
        const job = db.jobs.find(j => j.id === jobId && j.companyId === me.companyId);
        if (!job) return sendJSON(res, 404, { error: 'Job not found.' });
        const jdoc = readJobDoc(job.id) || {};
        const draw = (jdoc.draws || []).find(d => d.id === drawId);
        if (!draw) return sendJSON(res, 404, { error: 'Draw not found.' });
        if (draw.billed) return sendJSON(res, 400, { error: 'This draw has already been invoiced.' });
        const c = jdoc.costing || {};
        const coAdj = (jdoc.changeOrders || []).reduce((a, x) => a + (x.status === 'approved' ? (Number(x.priceDelta) || 0) : 0), 0);
        const contract = (Number(c.contract) || 0) + coAdj;
        const amount = Math.round(contract * (Number(draw.percent) || 0) / 100 * 100) / 100;
        const doc = {
          company: jdoc.company || {}, client: jdoc.client || {}, project: jdoc.project || job.name || '',
          invoiceNo: '', date: '', dueDate: '', taxPct: 0, taxAmount: 0, discount: 0, discountType: 'pct',
          lines: [{ id: 'l_' + crypto.randomBytes(6).toString('hex'), name: 'Progress draw — ' + (draw.label || '') + ' (' + (Number(draw.percent) || 0) + '% of contract)', code: '', unit: '', qty: 1, unitCost: amount }],
          notes: '', terms: '', amountPaid: 0, fromEstimateId: job.fromEstimateId || '', fromJobId: job.id
        };
        const autoNo = assignInvoiceNo(companyById(me.companyId));
        if (autoNo) doc.invoiceNo = autoNo;
        const inv = { id: 'i_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: (job.name || 'Job') + ' — ' + (draw.label || 'Draw'), client: (jdoc.client && jdoc.client.name) || job.client || '',
          total: amount, amountPaid: 0, fromEstimateId: job.fromEstimateId || '', fromJobId: job.id, createdAt: Date.now(), updatedAt: Date.now() };
        writeInvoiceDoc(inv.id, doc);
        db.invoices.push(inv);
        draw.billed = true; draw.invoiceId = inv.id; writeJobDoc(job.id, jdoc);
        logAudit(me, 'invoice.draw', 'Draw "' + (draw.label || '') + '" on ' + (job.name || ''));
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
          logAudit(me, 'invoice.delete', 'Deleted invoice "' + (inv.name || inv.id) + '"');
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
        if (!canSeeFinancials(me)) return sendJSON(res, 403, { error: 'No access to financial reports.' });
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

      // ---- Accounting export: every invoice, for import into QuickBooks / Xero / a spreadsheet ----
      if (pathname === '/api/reports/invoices' && req.method === 'GET') {
        if (!canSeeFinancials(me)) return sendJSON(res, 403, { error: 'No access to financial reports.' });
        const rows = db.invoices.filter(i => i.companyId === me.companyId).map(i => {
          const d = readInvoiceDoc(i.id) || {};
          const total = Number(i.total) || 0, paid = Number(i.amountPaid) || 0;
          return { invoiceNo: d.invoiceNo || '', customer: (d.client && d.client.name) || i.client || '',
            email: (d.client && d.client.email) || '', date: d.date || '', dueDate: d.dueDate || '',
            project: d.project || '', total: Math.round(total * 100) / 100, paid: Math.round(paid * 100) / 100,
            balance: Math.round((total - paid) * 100) / 100, status: invoiceStatus(total, paid) };
        }).sort((a, b) => (a.date < b.date ? 1 : -1));
        return sendJSON(res, 200, { rows });
      }

      // ---- Owner analytics: monthly revenue trend, jobs by status, headline KPIs ----
      if (pathname === '/api/reports/analytics' && req.method === 'GET') {
        if (!canSeeFinancials(me)) return sendJSON(res, 403, { error: 'No access to financial reports.' });
        const invs = db.invoices.filter(i => i.companyId === me.companyId);
        const now = new Date();
        const months = [];
        for (let k = 5; k >= 0; k--) { const d = new Date(now.getFullYear(), now.getMonth() - k, 1); months.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: d.toLocaleString(undefined, { month: 'short' }), invoiced: 0, collected: 0 }); }
        const idx = {}; months.forEach(m => idx[m.key] = m);
        invs.forEach(i => {
          const d = new Date(i.createdAt || Date.now());
          const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
          if (idx[key]) { idx[key].invoiced += Number(i.total) || 0; idx[key].collected += Number(i.amountPaid) || 0; }
        });
        months.forEach(m => { m.invoiced = Math.round(m.invoiced * 100) / 100; m.collected = Math.round(m.collected * 100) / 100; });
        const jobsByStatus = {};
        db.jobs.filter(j => j.companyId === me.companyId).forEach(j => { const s = j.status || 'scheduled'; jobsByStatus[s] = (jobsByStatus[s] || 0) + 1; });
        const ests = db.estimates.filter(e => e.companyId === me.companyId);
        const accepted = ests.filter(e => e.status === 'accepted').length, rejected = ests.filter(e => e.status === 'rejected').length;
        const winRate = (accepted + rejected) > 0 ? Math.round(accepted / (accepted + rejected) * 100) : null;
        const totalInvoiced = invs.reduce((s, i) => s + (Number(i.total) || 0), 0);
        const totalCollected = invs.reduce((s, i) => s + (Number(i.amountPaid) || 0), 0);
        return sendJSON(res, 200, {
          months, jobsByStatus, winRate,
          totalInvoiced: Math.round(totalInvoiced * 100) / 100,
          totalCollected: Math.round(totalCollected * 100) / 100,
          outstanding: Math.round((totalInvoiced - totalCollected) * 100) / 100,
          activeJobs: (jobsByStatus['in progress'] || 0) + (jobsByStatus['scheduled'] || 0)
        });
      }

      // ---- Work-in-progress (WIP): earned revenue vs billed for active jobs ----
      if (pathname === '/api/reports/wip' && req.method === 'GET') {
        if (!canSeeFinancials(me)) return sendJSON(res, 403, { error: 'No access to financial reports.' });
        const myInvoices = db.invoices.filter(i => i.companyId === me.companyId);
        const rows = db.jobs.filter(j => j.companyId === me.companyId && j.status !== 'complete' && j.status !== 'cancelled').map(j => {
          const jd = readJobDoc(j.id) || {}; const c = jd.costing || {};
          const co = (jd.changeOrders || []).reduce((a, x) => { if (x.status === 'approved') a += Number(x.priceDelta) || 0; return a; }, 0);
          const contract = (Number(c.contract) || 0) + co;
          const pct = Math.max(0, Math.min(100, Number(jd.percentComplete) || 0));
          const earned = Math.round(contract * pct / 100 * 100) / 100;
          // Billed = invoices raised off the same estimate as this job.
          const billed = j.fromEstimateId ? myInvoices.filter(i => i.fromEstimateId === j.fromEstimateId).reduce((s, i) => s + (Number(i.total) || 0), 0) : 0;
          const variance = Math.round((billed - earned) * 100) / 100; // + = over-billed, - = under-billed
          return { id: j.id, name: j.name, client: j.client || '', status: j.status || 'scheduled',
            contract: Math.round(contract * 100) / 100, pct, earned, billed: Math.round(billed * 100) / 100, variance };
        }).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
        const totals = rows.reduce((t, r) => { t.contract += r.contract; t.earned += r.earned; t.billed += r.billed; return t; }, { contract: 0, earned: 0, billed: 0 });
        totals.contract = Math.round(totals.contract * 100) / 100; totals.earned = Math.round(totals.earned * 100) / 100;
        totals.billed = Math.round(totals.billed * 100) / 100; totals.variance = Math.round((totals.billed - totals.earned) * 100) / 100;
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
            const crew = Array.isArray(jd.crew) ? jd.crew
              : String(jd.crew || '').split(',').map(s => s.trim()).filter(Boolean);
            return { id: j.id, name: j.name, client: j.client || '', status: j.status || 'scheduled',
                     start: jd.startDate || '', due: jd.dueDate || '', crew,
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
            const base = { id: j.id, number: j.number || '', name: j.name, client: j.client || '', status: j.status || 'scheduled',
                     createdAt: j.createdAt, updatedAt: j.updatedAt };
            // People without financial access never see money — omit contract/margin from their list.
            return canSeeFinancials(me) ? Object.assign(base, { contract, margin }) : base;
          })
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/jobs' && req.method === 'POST') {
        const { name, client, doc } = await readBody(req);
        const job = { id: 'j_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          number: assignNumber(companyById(me.companyId), 'job'),
          name: name || 'Untitled Job', client: client || '', status: 'scheduled',
          createdAt: Date.now(), updatedAt: Date.now() };
        writeJobDoc(job.id, doc || {});
        db.jobs.push(job);
        saveDB(db);
        return sendJSON(res, 200, { id: job.id, number: job.number });
      }
      // Turn a won estimate into a job (the scope of work to schedule and do).
      if (pathname === '/api/jobs/from-estimate' && req.method === 'POST') {
        const { estimateId } = await readBody(req);
        const est = db.estimates.find(e => e.id === estimateId && e.companyId === me.companyId);
        if (!est) return sendJSON(res, 404, { error: 'Estimate not found.' });
        const edoc = readEstimateDoc(est.id);
        // Freeze the job's budget from the estimate: cost basis = sum(qty x unitCost);
        // contract (revenue) = cost + markup, per line (category rules may vary the markup).
        const defMkJob = (Number(edoc.markupPct) || 0) + (Number(edoc.profitPct) || 0);
        const jobLines = (edoc.lines || []).filter(l => !l.optional); // optional add-ons aren't in the contract
        const budget = jobLines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
        const contract = Math.round(jobLines.reduce((s, l) => {
          const effMk = (l.mkEff !== undefined && l.mkEff !== null) ? Number(l.mkEff) : defMkJob;
          return s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0) * (1 + effMk / 100);
        }, 0) * 100) / 100;
        const doc = {
          company: edoc.company || {}, client: edoc.client || {}, project: edoc.project || '',
          lines: jobLines.map(l => ({ id: 'l_' + crypto.randomBytes(6).toString('hex'),
            name: l.name, code: l.code, unit: l.unit, qty: Number(l.qty) || 0, done: false })),
          // Seed the task checklist from the proposal line items so the crew has the scope to work through.
          tasks: jobLines.filter(l => (l.name || '').trim()).map(l => ({ id: 'tk_' + crypto.randomBytes(5).toString('hex'),
            text: (l.name + (l.qty ? (' — ' + l.qty + (l.unit ? ' ' + l.unit : '')) : '')).trim(), done: false })),
          startDate: '', dueDate: '', notes: edoc.notes || '', fromEstimateId: est.id,
          costing: { budget: Math.round(budget * 100) / 100, contract, actualCost: 0 }
        };
        const job = { id: 'j_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          number: assignNumber(companyById(me.companyId), 'job'),
          name: est.name || 'Job', client: (edoc.client && edoc.client.name) || est.client || '',
          status: 'scheduled', fromEstimateId: est.id, createdAt: Date.now(), updatedAt: Date.now() };
        writeJobDoc(job.id, doc);
        db.jobs.push(job);
        est.jobId = job.id; est.updatedAt = Date.now();   // so the estimate list shows "Job"
        saveDB(db);
        return sendJSON(res, 200, { id: job.id, number: job.number });
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
        if (!canSeeFinancials(me)) return sendJSON(res, 403, { error: 'No access to financials.' });
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
      // Create (or fetch) the client-portal link for a job.
      const jobPortalMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_]+)\/portal$/);
      if (jobPortalMatch && req.method === 'POST') {
        if (me.role === 'field') return sendJSON(res, 403, { error: 'Not allowed.' });
        const job = db.jobs.find(j => j.id === jobPortalMatch[1] && j.companyId === me.companyId);
        if (!job) return sendJSON(res, 404, { error: 'Job not found.' });
        if (!job.portalToken) { job.portalToken = crypto.randomBytes(16).toString('hex'); job.updatedAt = Date.now(); saveDB(db); }
        return sendJSON(res, 200, { token: job.portalToken });
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
          // Field employees can ONLY add field data (daily logs, time, task check-offs). The server
          // merges those onto the saved job and ignores everything else (name, client, status,
          // budget, contract, costs, change orders) so they can never alter money or job settings.
          if (me.role === 'field') {
            const existing = readJobDoc(job.id) || {};
            if (doc && typeof doc === 'object') {
              const merged = Object.assign({}, existing);
              ['dailyLogs', 'timeEntries', 'tasks', 'punch'].forEach(k => { if (doc[k] !== undefined) merged[k] = doc[k]; });
              writeJobDoc(job.id, merged);
            }
            job.updatedAt = Date.now();
            saveDB(db);
            return sendJSON(res, 200, { id: job.id, updatedAt: job.updatedAt, status: job.status });
          }
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
          logAudit(me, 'job.delete', 'Deleted job "' + (job.name || job.id) + '"');
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // ---- Work orders: list / create / from-job / get / put / delete ----
      if (pathname === '/api/workorders' && req.method === 'GET') {
        const list = db.workOrders.filter(w => w.companyId === me.companyId)
          .map(w => ({ id: w.id, number: w.number || '', title: w.title, jobName: w.jobName || '', assignee: w.assignee || '',
                       status: w.status || 'open', scheduledDate: w.scheduledDate || '',
                       createdAt: w.createdAt, updatedAt: w.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/workorders' && req.method === 'POST') {
        const { title, assignee, jobId, jobName, doc } = await readBody(req);
        const wo = { id: 'w_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          number: assignNumber(companyById(me.companyId), 'wo'),
          title: title || 'Untitled Work Order', assignee: assignee || '', jobId: jobId || '', jobName: jobName || '',
          status: 'open', scheduledDate: '', createdAt: Date.now(), updatedAt: Date.now() };
        writeWorkOrderDoc(wo.id, doc || {});
        db.workOrders.push(wo);
        saveDB(db);
        return sendJSON(res, 200, { id: wo.id, number: wo.number });
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
          number: assignNumber(companyById(me.companyId), 'wo'),
          title: job.name || 'Work Order', assignee: '', jobId: job.id, jobName: job.name || '',
          status: 'open', scheduledDate: '', createdAt: Date.now(), updatedAt: Date.now() };
        writeWorkOrderDoc(wo.id, doc);
        db.workOrders.push(wo);
        saveDB(db);
        return sendJSON(res, 200, { id: wo.id, number: wo.number });
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
        const sv = ld.siteVisit || {};
        const noteParts = [];
        if (ld.notes) noteParts.push('From lead: ' + ld.notes);
        if (sv.scope) noteParts.push('Site visit — scope: ' + sv.scope);
        if (sv.access) noteParts.push('Access: ' + sv.access);
        const doc = { company: {}, client: { name: lead.name || '', email: ld.email || '', address: ld.address || '' },
          project: lead.workType || '', lines: [], markupPct: 0, taxPct: 0,
          notes: noteParts.join('\n'), discount: 0, discountType: 'pct' };
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
          if (doc !== undefined) {
            const merged = Object.assign({}, doc);
            merged.files = (readLeadDoc(lead.id).files) || [];  // files are server-managed; never trust the client save
            writeLeadDoc(lead.id, merged);
          }
          lead.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: lead.id, updatedAt: lead.updatedAt, stage: lead.stage });
        }
        if (req.method === 'DELETE') {
          db.leads = db.leads.filter(l => l.id !== lead.id);
          try { fs.unlinkSync(leadPath(lead.id)); } catch (e) {}
          try { fs.rmSync(leadFileDir(lead.id), { recursive: true, force: true }); } catch (e) {}
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }
      // ---- Site-visit files on a lead (upload / view / delete) ----
      const leadFileUp = pathname.match(/^\/api\/leads\/([a-zA-Z0-9_]+)\/files$/);
      if (leadFileUp && req.method === 'POST') {
        const lead = db.leads.find(l => l.id === leadFileUp[1] && l.companyId === me.companyId);
        if (!lead) return sendJSON(res, 404, { error: 'Lead not found.' });
        const fid = 'lf_' + crypto.randomBytes(8).toString('hex');
        const dir = leadFileDir(lead.id);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = leadFilePath(lead.id, fid) + '.tmp';
        const ws = fs.createWriteStream(tmp);
        let bytes = 0, failed = false;
        const fail = (e, code) => { if (failed) return; failed = true; try { ws.destroy(); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} if (!res.headersSent) sendJSON(res, code || 500, { error: (e && e.message) || String(e) }); };
        req.on('data', (c) => { bytes += c.length; if (bytes > MAX_RECEIPT_BYTES) { fail(new Error('File is too large (max 25 MB).'), 413); try { req.destroy(); } catch (_) {} } });
        ws.on('error', fail); req.on('error', fail);
        ws.on('finish', () => {
          if (failed) return;
          try { fs.renameSync(tmp, leadFilePath(lead.id, fid)); } catch (e) { return fail(e); }
          const meta = { id: fid, name: String((parsed.query && parsed.query.name) || 'file').slice(0, 200),
            mime: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100), size: bytes, uploadedAt: Date.now() };
          const d = readLeadDoc(lead.id); d.files = d.files || []; d.files.push(meta); writeLeadDoc(lead.id, d);
          lead.updatedAt = Date.now(); saveDB(db);
          sendJSON(res, 200, meta);
        });
        req.pipe(ws);
        return;
      }
      const leadFileMatch = pathname.match(/^\/api\/leads\/([a-zA-Z0-9_]+)\/files\/([a-zA-Z0-9_]+)$/);
      if (leadFileMatch) {
        const lead = db.leads.find(l => l.id === leadFileMatch[1] && l.companyId === me.companyId);
        if (!lead) return sendJSON(res, 404, { error: 'Lead not found.' });
        const d = readLeadDoc(lead.id); const meta = (d.files || []).find(f => f.id === leadFileMatch[2]);
        if (!meta) return sendJSON(res, 404, { error: 'File not found.' });
        if (req.method === 'GET') {
          const f = leadFilePath(lead.id, meta.id);
          if (!fs.existsSync(f)) return sendJSON(res, 404, { error: 'File missing.' });
          const stat = fs.statSync(f);
          res.writeHead(200, { 'Content-Type': meta.mime || 'application/octet-stream', 'Content-Length': stat.size,
            'Content-Disposition': 'inline; filename="' + encodeURIComponent(meta.name) + '"', 'Cache-Control': 'private, max-age=3600' });
          const rs = fs.createReadStream(f); rs.on('error', () => { if (!res.headersSent) sendJSON(res, 500, { error: 'Could not read the file.' }); else res.destroy(); }); rs.pipe(res);
          return;
        }
        if (req.method === 'DELETE') {
          d.files = (d.files || []).filter(f => f.id !== meta.id); writeLeadDoc(lead.id, d);
          try { fs.unlinkSync(leadFilePath(lead.id, meta.id)); } catch (e) {}
          lead.updatedAt = Date.now(); saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // ---- Floor Plans (standalone sketch tool) ----
      if (pathname === '/api/plans' && req.method === 'GET') {
        const list = db.plans.filter(p => p.companyId === me.companyId)
          .map(p => ({ id: p.id, name: p.name, client: p.client || '', jobId: p.jobId || '',
                       createdAt: p.createdAt, updatedAt: p.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }
      if (pathname === '/api/plans' && req.method === 'POST') {
        const { name, client, jobId, doc } = await readBody(req);
        const plan = { id: 'pl_' + crypto.randomBytes(8).toString('hex'), userId, companyId: me.companyId,
          name: (name && String(name).slice(0, 200)) || 'Untitled Plan', client: (client && String(client).slice(0, 200)) || '',
          jobId: (jobId && String(jobId).slice(0, 64)) || '', createdAt: Date.now(), updatedAt: Date.now() };
        writePlanDoc(plan.id, doc || {});
        db.plans.push(plan);
        saveDB(db);
        logAudit(me, 'plan.create', plan.name);
        return sendJSON(res, 200, { id: plan.id });
      }
      const planMatch = pathname.match(/^\/api\/plans\/([a-zA-Z0-9_]+)$/);
      if (planMatch) {
        const plan = db.plans.find(p => p.id === planMatch[1] && p.companyId === me.companyId);
        if (!plan) return sendJSON(res, 404, { error: 'Plan not found.' });
        if (req.method === 'GET') {
          return sendJSON(res, 200, { id: plan.id, name: plan.name, client: plan.client || '', jobId: plan.jobId || '',
            createdAt: plan.createdAt, updatedAt: plan.updatedAt, doc: readPlanDoc(plan.id) });
        }
        if (req.method === 'PUT') {
          const { name, client, jobId, doc } = await readBody(req);
          if (name !== undefined) plan.name = String(name).slice(0, 200);
          if (client !== undefined) plan.client = String(client).slice(0, 200);
          if (jobId !== undefined) plan.jobId = String(jobId).slice(0, 64);
          if (doc !== undefined) writePlanDoc(plan.id, doc);
          plan.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: plan.id, updatedAt: plan.updatedAt });
        }
        if (req.method === 'DELETE') {
          db.plans = db.plans.filter(p => p.id !== plan.id);
          try { fs.unlinkSync(floorPlanPath(plan.id)); } catch (e) {}
          saveDB(db);
          logAudit(me, 'plan.delete', plan.name);
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
          plans: db.plans.filter(p => p.companyId === me.companyId).map(p => ({
            id: p.id, name: p.name, client: p.client, jobId: p.jobId,
            createdAt: p.createdAt, updatedAt: p.updatedAt, doc: readPlanDoc(p.id)
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
    // Log the detail server-side; return a generic message so internals aren't leaked to clients.
    const known = err && (err.message === 'Invalid JSON body' || err.message === 'Request body too large');
    console.error('[fieldscale] request error:', (err && err.stack) || err);
    if (!res.headersSent) sendJSON(res, known ? 400 : 500, { error: known ? err.message : 'Something went wrong on our end. Please try again.' });
  }
});

server.listen(PORT, () => {
  console.log(`[fieldscale] Server running on http://localhost:${PORT}`);
  if (db.users.length === 0) {
    console.log('[fieldscale] No accounts yet. The first account you create becomes the administrator.');
  }
  if (!SESSION_SECRET_FROM_ENV) console.warn('[fieldscale] Reminder: set the SESSION_SECRET environment variable for production.');
  // Automatic backups: one shortly after boot, then daily.
  setTimeout(runBackup, 10000);
  setInterval(runBackup, 24 * 60 * 60 * 1000);
});
