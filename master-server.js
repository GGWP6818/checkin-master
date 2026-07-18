const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── Credentials from env ─────────────────────────────────────────────
const GH_TOKEN = process.env.GH_TOKEN || '';
const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';

const GH_USER = process.env.GH_USER || 'GGWP6818';
const TURSO_ORG = process.env.TURSO_ORG || 'ggwp6818';
const TURSO_LOCATION = process.env.TURSO_LOCATION || 'aws-ap-northeast-1';
const TEMPLATE_REPO = process.env.TEMPLATE_REPO || 'checkin-template';
const MASTER_TOKEN = process.env.MASTER_TOKEN || crypto.randomBytes(16).toString('hex');

// ── SQLite DB ─────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'master.db'));
db.pragma('journal_mode = WAL');

function initMasterDB() {
  db.exec(`CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    github_repo TEXT NOT NULL,
    turso_db TEXT NOT NULL,
    turso_db_url TEXT NOT NULL,
    turso_db_token TEXT NOT NULL,
    render_service_id TEXT NOT NULL,
    render_url TEXT,
    status TEXT DEFAULT 'creating',
    created_at TEXT DEFAULT (datetime('now')),
    error_msg TEXT
  )`);
  console.log('Master DB initialized');
}

// ── API Helpers ───────────────────────────────────────────────────────

async function githubAPI(method, path, body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.github.com${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function tursoAPI(method, path, body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${TURSO_TOKEN}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.turso.tech${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`Turso API: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function renderAPI(method, path, body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.render.com/v1${path}`, opts);
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(`Render API: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function generateRandomString(len = 12) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

// ── Core: Create New Instance ─────────────────────────────────────────

async function createInstance(clientName) {
  const instanceId = 'inst_' + Date.now().toString(36) + '_' + generateRandomString(6);
  const repoName = `checkin-${clientName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}`;
  const slug = clientName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) + '-' + Date.now().toString(36).slice(-8);

  console.log(`[${instanceId}] Creating instance for "${clientName}" → repo: ${repoName}`);

  // Step 1: Fork template repo
  console.log(`[${instanceId}] Forking repo...`);
  const fork = await githubAPI('POST', `/repos/${GH_USER}/${TEMPLATE_REPO}/forks`, {
    name: repoName,
    default_branch_only: true
  });
  console.log(`[${instanceId}] Forked: ${fork.full_name}`);

  // Step 2: Create Turso database (ensure default group exists)
  console.log(`[${instanceId}] Creating Turso DB: ${slug}`);
  const TURSO_GROUP = process.env.TURSO_GROUP || 'default';
  // Ensure group exists
  try {
    await tursoAPI('POST', `/v1/organizations/${TURSO_ORG}/groups`, {
      name: TURSO_GROUP,
      location: process.env.TURSO_LOCATION || 'aws-ap-northeast-1'
    });
  } catch (e) {
    // Group may already exist, continue
    if (!e.message.includes('already')) console.log(`Group note: ${e.message}`);
  }
  const tursoDbResp = await tursoAPI('POST', `/v1/organizations/${TURSO_ORG}/databases`, {
    name: slug,
    group: TURSO_GROUP
  });
  const tursoDb = tursoDbResp.database || tursoDbResp;
  console.log(`[${instanceId}] Turso DB: ${tursoDb.Name}`);

  // Step 3: Create Turso token for the DB
  const tok = await tursoAPI('POST', `/v1/organizations/${TURSO_ORG}/databases/${tursoDb.Name}/auth/tokens?expiration=never`, {
    authorization: 'full-access'
  });
  const dbUrl = `libsql://${tursoDb.Hostname}`;
  const dbToken = tok.jwt;
  console.log(`[${instanceId}] DB URL: ${dbUrl}`);

  // Step 4: Update forked repo's server.js with new credentials
  const jwtSecret = 'checkin-' + generateRandomString(16);
  const adminToken = 'admin-' + generateRandomString(16);

  // Get server.js content from template
  const templateFile = await githubAPI('GET', `/repos/${GH_USER}/${repoName}/contents/server.js`);
  let serverContent = Buffer.from(templateFile.content, 'base64').toString('utf-8');

  // Replace Turso credentials in server.js
  serverContent = serverContent.replace(
    /const TURSO_URL = process\.env\.TURSO_URL \|\| '.*?'/,
    `const TURSO_URL = process.env.TURSO_URL || '${dbUrl}'`
  );
  serverContent = serverContent.replace(
    /const TURSO_TOKEN = process\.env\.TURSO_TOKEN \|\| '.*?'/,
    `const TURSO_TOKEN = process.env.TURSO_TOKEN || '${dbToken}'`
  );
  serverContent = serverContent.replace(
    /const JWT_SECRET = process\.env\.JWT_SECRET \|\| '.*?'/,
    `const JWT_SECRET = process.env.JWT_SECRET || '${jwtSecret}'`
  );
  serverContent = serverContent.replace(
    /const ADMIN_TOKEN = process\.env\.ADMIN_TOKEN \|\| '.*?'/,
    `const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '${adminToken}'`
  );

  await githubAPI('PUT', `/repos/${GH_USER}/${repoName}/contents/server.js`, {
    message: 'Configure Turso credentials for deployment',
    content: Buffer.from(serverContent).toString('base64'),
    sha: templateFile.sha
  });
  console.log(`[${instanceId}] Updated server.js with credentials`);

  // Step 5: Create Render web service
  // Wait a moment for GitHub to process the commit
  await new Promise(r => setTimeout(r, 3000));

  const serviceName = `checkin-${clientName.toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 20)}`;
  console.log(`[${instanceId}] Creating Render service: ${serviceName}`);

  const renderService = await renderAPI('POST', '/services', {
    type: 'web_service',
    name: serviceName,
    ownerId: await getRenderOwnerId(),
    repo: `${GH_USER}/${repoName}`,
    branch: 'main',
    buildCommand: 'npm install',
    startCommand: 'node server.js',
    plan: 'free',
    envVars: [
      { key: 'TURSO_URL', value: dbUrl },
      { key: 'TURSO_TOKEN', value: dbToken },
      { key: 'JWT_SECRET', value: jwtSecret },
      { key: 'ADMIN_TOKEN', value: adminToken }
    ]
  });

  console.log(`[${instanceId}] Render service: ${renderService.id}`);

  // Save to master DB
  db.prepare(`INSERT INTO instances (id, client_name, github_repo, turso_db, turso_db_url, turso_db_token, render_service_id, render_url, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deploying')`).run(instanceId, clientName, repoName, tursoDb.Name, dbUrl, dbToken, renderService.id, '');

  return {
    id: instanceId,
    clientName,
    githubRepo: repoName,
    githubUrl: `https://github.com/${GH_USER}/${repoName}`,
    tursoDb: tursoDb.Name,
    tursoDbUrl: dbUrl,
    renderServiceId: renderService.id,
    adminToken
  };
}

let cachedOwnerId = null;
async function getRenderOwnerId() {
  if (cachedOwnerId) return cachedOwnerId;
  const owners = await renderAPI('GET', '/owners');
  cachedOwnerId = owners[0]?.owner?.id || owners[0]?.id;
  return cachedOwnerId;
}

// ── Express App ───────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers['x-master-token'] || req.query.token;
  if (token !== MASTER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// List all instances
app.get('/api/instances', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create new instance
app.post('/api/instances', authMiddleware, async (req, res) => {
  const { client_name } = req.body;
  if (!client_name) return res.status(400).json({ error: 'client_name required' });

  try {
    const instance = await createInstance(client_name);
    res.json(instance);
  } catch (e) {
    console.error('Create failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get single instance
app.get('/api/instances/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// Delete instance
app.delete('/api/instances/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM instances WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Refresh instance status
app.post('/api/instances/:id/refresh', authMiddleware, async (req, res) => {
  try {
    const inst = db.prepare('SELECT * FROM instances WHERE id = ?').get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });

    // Check Render service status
    try {
      const svc = await renderAPI('GET', `/services/${inst.render_service_id}`);
      const status = svc.suspended === 'suspended' ? 'suspended' : 'live';
      const url = svc.serviceDetails?.url || inst.render_url;
      db.prepare('UPDATE instances SET status = ?, render_url = ? WHERE id = ?').run(status, url, req.params.id);
      res.json({ status, url });
    } catch (e) {
      res.json({ status: inst.status, url: inst.render_url });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check (requires auth)
app.get('/api/health', authMiddleware, (req, res) => {
  res.json({ ok: true, instances: 'running' });
});

// Serve master panel
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'master.html'));
});

// Start
initMasterDB();
app.listen(PORT, () => {
  console.log(`Master Panel running on port ${PORT}`);
  console.log(`Master Token: ${MASTER_TOKEN}`);
});
