// Fieldscale backend — plain Node.js, zero external dependencies.
// Handles: user accounts (register/login), private per-user project storage,
// and a server-side proxy to Claude's API so the Anthropic key never reaches the browser.
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
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!ANTHROPIC_API_KEY) {
  console.warn('[fieldscale] WARNING: ANTHROPIC_API_KEY not set — AI features (auto-scale, AI select, sheet naming) will not work.');
}

// ---------- Tiny JSON "database" (fine for a small team; swap for real DB later if needed) ----------
function loadDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], projects: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
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
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}

// ---------- Session tokens (simple signed tokens — no JWT library needed) ----------
function createToken(userId) {
  const payload = JSON.stringify({ uid: userId, exp: Date.now() + 30 * 24 * 3600 * 1000 }); // 30 day session
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}
function verifyToken(token) {
  if (!token) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload.uid;
  } catch { return null; }
}
function getAuthedUserId(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return verifyToken(token);
}

// ---------- Helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- Request handler ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    // ---- Auth: register ----
    if (pathname === '/api/register' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      if (!username || !password || password.length < 6) {
        return sendJSON(res, 400, { error: 'Username and a password of at least 6 characters are required.' });
      }
      const uname = username.trim().toLowerCase();
      if (db.users.find(u => u.username === uname)) {
        return sendJSON(res, 409, { error: 'That username is already taken.' });
      }
      const { salt, hash } = hashPassword(password);
      const user = { id: 'u_' + crypto.randomBytes(8).toString('hex'), username: uname, salt, hash, createdAt: Date.now() };
      db.users.push(user);
      saveDB(db);
      return sendJSON(res, 200, { token: createToken(user.id), username: user.username });
    }

    // ---- Auth: login ----
    if (pathname === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      const uname = (username || '').trim().toLowerCase();
      const user = db.users.find(u => u.username === uname);
      if (!user || !verifyPassword(password || '', user.salt, user.hash)) {
        return sendJSON(res, 401, { error: 'Incorrect username or password.' });
      }
      return sendJSON(res, 200, { token: createToken(user.id), username: user.username });
    }

    // ---- Everything past this point requires a valid session ----
    if (pathname.startsWith('/api/')) {
      const userId = getAuthedUserId(req);
      if (!userId) return sendJSON(res, 401, { error: 'Not logged in (or session expired) — please log in again.' });

      // GET /api/me
      if (pathname === '/api/me' && req.method === 'GET') {
        const user = db.users.find(u => u.id === userId);
        return sendJSON(res, 200, { username: user ? user.username : null });
      }

      // GET /api/projects — list this user's projects (metadata only, not full data)
      if (pathname === '/api/projects' && req.method === 'GET') {
        const list = db.projects
          .filter(p => p.userId === userId)
          .map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return sendJSON(res, 200, list);
      }

      // POST /api/projects — create a new project
      if (pathname === '/api/projects' && req.method === 'POST') {
        const { name, data } = await readBody(req);
        const project = {
          id: 'p_' + crypto.randomBytes(8).toString('hex'),
          userId, name: name || 'Untitled Project', data: data || {},
          createdAt: Date.now(), updatedAt: Date.now()
        };
        db.projects.push(project);
        saveDB(db);
        return sendJSON(res, 200, { id: project.id, name: project.name, updatedAt: project.updatedAt });
      }

      // /api/projects/:id — get / update / delete a single project (must belong to this user)
      const projMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_]+)$/);
      if (projMatch) {
        const id = projMatch[1];
        const project = db.projects.find(p => p.id === id && p.userId === userId);
        if (!project) return sendJSON(res, 404, { error: 'Project not found.' });

        if (req.method === 'GET') {
          return sendJSON(res, 200, project);
        }
        if (req.method === 'PUT') {
          const { name, data } = await readBody(req);
          if (name !== undefined) project.name = name;
          if (data !== undefined) project.data = data;
          project.updatedAt = Date.now();
          saveDB(db);
          return sendJSON(res, 200, { id: project.id, name: project.name, updatedAt: project.updatedAt });
        }
        if (req.method === 'DELETE') {
          db.projects = db.projects.filter(p => p.id !== id);
          saveDB(db);
          return sendJSON(res, 200, { deleted: true });
        }
      }

      // POST /api/claude — proxies a vision request to Anthropic using the server-held key
      if (pathname === '/api/claude' && req.method === 'POST') {
        if (!ANTHROPIC_API_KEY) {
          return sendJSON(res, 500, { error: 'Server has no ANTHROPIC_API_KEY configured — ask whoever deployed this to set one.' });
        }
        const { image, prompt, max_tokens } = await readBody(req);
        if (!image || !prompt) return sendJSON(res, 400, { error: 'Missing image or prompt.' });

        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: max_tokens || 500,
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
});
