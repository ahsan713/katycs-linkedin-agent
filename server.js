require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const fetch    = require('node-fetch');
const path     = require('path');
const fs       = require('fs');
const initSqlJs = require('sql.js');

const app  = express();
const PORT = process.env.PORT || 3100;

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE SETUP ────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'agent.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT    DEFAULT (datetime('now')),
    pillar     INTEGER NOT NULL,
    topic      TEXT    NOT NULL,
    first_line TEXT    NOT NULL,
    full_text  TEXT    NOT NULL,
    word_count INTEGER,
    status     TEXT    DEFAULT 'generated',
    publer_job TEXT,
    scheduled_for TEXT,
    impressions INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS push_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    posts_pushed INTEGER,
    status     TEXT,
    details    TEXT
  )`);

  saveDB();
  console.log('[db] initialised');
}

function saveDB() {
  const data = db.export();
  const buf  = Buffer.from(data);
  if (!fs.existsSync(path.dirname(DB_PATH))) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  fs.writeFileSync(DB_PATH, buf);
}

function getSetting(key, def = '') {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const rows = [];
  stmt.bind([key]);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.length ? rows[0].value : def;
}

function setSetting(key, value) {
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
  saveDB();
}

function getHistory(limit = 40) {
  const stmt = db.prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT ?');
  const rows = [];
  stmt.bind([limit]);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getRecentTopics(pillar, weeks = 8) {
  const cutoff = new Date(Date.now() - weeks * 7 * 24 * 3600 * 1000).toISOString();
  const stmt = db.prepare(
    'SELECT topic FROM posts WHERE pillar = ? AND created_at > ? ORDER BY created_at DESC'
  );
  const rows = [];
  stmt.bind([pillar, cutoff]);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.map(r => r.topic);
}

// ── CONTENT PILLARS ───────────────────────────────────────────
const PILLARS = {
  1: {
    name: 'War Story', tone: 'authoritative',
    topics: [
      'What the $300M VA supply chain program taught me about infrastructure at scale',
      'How we migrated 100,000 workstations at Bank of America with zero data loss',
      'What a $500M federal RTLS deployment taught me about IoT at scale',
      'What bank mergers actually look like from the IT side',
      'Building a hospital from scratch in Saudi Arabia — what CTO really means',
      'What 153 VA hospitals and 700 clinics taught me about nationwide deployment',
      'Why the OppenheimerFunds acquisition integration at Invesco succeeded',
      'What HIPAA compliance at federal scale demands from infrastructure teams',
      'How we handled 900 MHz frequency coexistence across competing RTLS systems',
      'What running a 70-person field team across 50 states actually requires',
    ]
  },
  2: {
    name: 'Advisory', tone: 'analytical',
    topics: [
      'The question I always ask before recommending a cloud migration',
      'Where AI actually helps in advisory work — and where it does not',
      'Why most infrastructure modernization programs fail in the middle',
      'Three things enterprises get wrong about hybrid cloud',
      'What federal IT compliance teaches you about enterprise architecture',
      'Why product thinking makes better infrastructure architects',
      'The difference between a cloud vendor and a cloud strategy',
      'What the best Product Owners in enterprise IT have in common',
      'How to scope an infrastructure advisory engagement in one conversation',
      'What separates a cloud architect from a cloud advisor',
    ]
  },
  3: {
    name: 'Career', tone: 'reflective',
    topics: [
      'What 30 years in IT actually teaches you about career decisions',
      'The technology changed completely four times. One thing did not.',
      'Why I moved from Chicago to Saudi Arabia to build a hospital',
      'Starting in 1992 wiring phones. Here is what I know now.',
      'Why longevity in IT is a skill, not luck',
      'What infrastructure architects have in common with product managers',
      'How to stay relevant through four complete technology platform shifts',
      'What a Six Sigma Black Belt teaches you outside manufacturing',
      'Why the best career moves in IT feel like the riskiest ones',
      'What I would tell myself starting out in enterprise IT in 1992',
    ]
  }
};

function getUnusedTopic(pillar) {
  const used = getRecentTopics(pillar);
  const all  = PILLARS[pillar].topics;
  const available = all.filter(t => !used.some(u => u.toLowerCase().startsWith(t.toLowerCase().substring(0, 25))));
  const pool = available.length ? available : all;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── ANTHROPIC API ─────────────────────────────────────────────
async function generatePost(pillar, topicOverride) {
  const pd    = PILLARS[pillar];
  const topic = topicOverride || getUnusedTopic(pillar);
  const recent = getHistory(8).map(p => `- "${p.first_line}" (${p.topic})`).join('\n') || 'None yet.';

  const prompt = `You are a LinkedIn ghostwriter for Ahsan Abbas — Senior Cloud & Infrastructure Architect, Advisory, Product Owner at Invesco. 30+ years enterprise IT. $800M+ federal program delivery ($300M VA supply chain across 153 hospitals/700+ clinics, $500M VA RTLS). Former AVP Bank of America (100K+ workstation migration). MBA, AWS CSA, Six Sigma Black Belt. Katy TX. Also runs KATYCS Inc.

RECENT POSTS — DO NOT REPEAT THESE ANGLES:
${recent}

PILLAR ${pillar} — ${pd.name} | TOPIC: ${topic} | TONE: ${pd.tone}

WORD COUNT: You MUST write between 200 and 300 words. Count carefully. Hard requirement.

RULES:
- Hook line: starts with a number or counterintuitive claim — NEVER with "I" or "Today I"
- Body: real specifics (dollar amounts, headcounts, locations, timeframes)
- One idea per paragraph, 2–3 sentences max
- Ending: direct statement, not a question
- NO hashtags. NO emojis. NO "what do you think?"

Return ONLY the post text.`;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || getSetting('anthropic_key');
  if (!ANTHROPIC_KEY) throw new Error('No Anthropic API key configured');

  const res  = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await res.json();
  let text = data.content?.[0]?.text;
  if (!text) throw new Error('No content from Anthropic: ' + JSON.stringify(data).substring(0, 200));

  // Word count check — retry once
  const wc = text.trim().split(/\s+/).filter(w => w).length;
  if (wc < 180 || wc > 320) {
    const retry = prompt + `\n\nCRITICAL: Your response was ${wc} words. Rewrite to hit exactly 200–300 words.`;
    const r2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: retry }] })
    });
    const d2 = await r2.json();
    if (d2.content?.[0]?.text) text = d2.content[0].text;
  }

  return { topic, text, pillar, wordCount: text.trim().split(/\s+/).filter(w => w).length };
}

async function generateHashtags(postText, pillar) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || getSetting('anthropic_key');
  if (!ANTHROPIC_KEY) return '#CloudArchitecture #Advisory #InfrastructureModernization';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 80, messages: [{ role: 'user', content: `Pick 3 hashtags for this LinkedIn post from: #CloudArchitecture #Advisory #InfrastructureModernization #RTLS #AWS #ProductOwner #FederalIT #AIAdvisory #EnterpriseIT #SixSigma. Return only 3 hashtags on one line separated by spaces.\n\nPost: ${postText.substring(0, 300)}` }] })
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '#CloudArchitecture #Advisory #InfrastructureModernization';
}

// ── PUBLER API ────────────────────────────────────────────────
async function publerRequest(method, path, body) {
  const key  = getSetting('publer_key');
  const wsId = getSetting('publer_workspace_id');
  if (!key) throw new Error('No Publer API key configured');

  const headers = {
    'Authorization': 'Bearer-API ' + key,
    'Content-Type':  'application/json',
    'Accept':        'application/json'
  };
  if (wsId) headers['Publer-Workspace-Id'] = wsId;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch('https://app.publer.com/api/v1' + path, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: { raw: text.substring(0, 500) } }; }
}

// ── SCHEDULE DATE CALCULATOR ──────────────────────────────────
function getNextScheduleDates(weeksCount) {
  const now   = new Date();
  const dates = [];
  const slots = [
    { dayOffset: 1, hour: 14, minute: 30 }, // Mon 8:30am CST = UTC+14:30
    { dayOffset: 3, hour: 18, minute: 0  }, // Wed 12:00pm CST = UTC+18:00
    { dayOffset: 5, hour: 14, minute: 30 }, // Fri 8:30am CST = UTC+14:30
  ];

  // Find the start of next week (Monday)
  const dow  = now.getUTCDay();
  const diff = dow === 0 ? 1 : 8 - dow;
  const nextMon = new Date(now);
  nextMon.setUTCDate(now.getUTCDate() + diff);
  nextMon.setUTCHours(0, 0, 0, 0);

  const pillars = [1, 2, 3];
  for (let w = 0; w < weeksCount; w++) {
    for (let s = 0; s < 3; s++) {
      const d = new Date(nextMon);
      d.setUTCDate(nextMon.getUTCDate() + slots[s].dayOffset - 1 + (w * 7));
      d.setUTCHours(slots[s].hour, slots[s].minute, 0, 0);
      if (d > now) dates.push({ date: d, pillar: pillars[s] });
    }
  }
  return dates;
}

// ── CORE: GENERATE & PUSH BATCH ──────────────────────────────
async function generateAndPushBatch(weeksCount = 1) {
  const slots     = getNextScheduleDates(weeksCount);
  const label     = getSetting('publer_label') || 'LinkedIn Content';
  const liAccId   = getSetting('publer_account_id');
  const results   = [];
  let   pushed    = 0;

  console.log(`[agent] Generating ${slots.length} posts for ${weeksCount} week(s)`);

  for (const slot of slots) {
    try {
      // Generate post
      const { topic, text, pillar, wordCount } = await generatePost(slot.pillar);
      const hashtags = await generateHashtags(text, pillar);
      const firstLine = text.split('\n').find(l => l.trim()) || text.substring(0, 80);

      // Push to Publer
      const publerBody = {
        bulk: {
          state: 'scheduled',
          posts: [{
            networks: { linkedin: { type: 'status', text } },
            accounts: [{
              id:           liAccId,
              scheduled_at: slot.date.toISOString(),
              labels:       [label],
              comments:     [{ text: hashtags, delay: { duration: 1, unit: 'Minute' } }]
            }]
          }]
        }
      };

      const pushResult = await publerRequest('POST', '/posts/schedule', publerBody);
      const jobId = pushResult.data?.job_id || null;

      // Save to DB
      db.run(
        `INSERT INTO posts (pillar, topic, first_line, full_text, word_count, status, publer_job, scheduled_for)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        [pillar, topic, firstLine, text, wordCount, jobId, slot.date.toISOString()]
      );
      saveDB();

      pushed++;
      results.push({ pillar, topic: topic.substring(0, 60), date: slot.date.toLocaleDateString('en-US'), wordCount, status: 'pushed', jobId });
      console.log(`[agent] ✓ P${pillar} pushed for ${slot.date.toDateString()} — ${wordCount}w`);

      await new Promise(r => setTimeout(r, 800)); // rate limit pause

    } catch (err) {
      console.error(`[agent] ✗ P${slot.pillar} failed:`, err.message);
      results.push({ pillar: slot.pillar, date: slot.date.toLocaleDateString('en-US'), status: 'failed', error: err.message.substring(0, 100) });
    }
  }

  // Log the run
  db.run(
    `INSERT INTO push_log (posts_pushed, status, details) VALUES (?, ?, ?)`,
    [pushed, pushed === slots.length ? 'complete' : 'partial', JSON.stringify(results)]
  );
  saveDB();

  return { pushed, total: slots.length, results };
}

// ── SATURDAY CRON ─────────────────────────────────────────────
// Runs every Saturday at 8:00 AM CST (14:00 UTC)
cron.schedule('0 14 * * 6', async () => {
  const autoEnabled = getSetting('saturday_auto') === 'true';
  if (!autoEnabled) { console.log('[cron] Saturday auto-run is disabled — skipping'); return; }
  const publerKey = getSetting('publer_key');
  const accId     = getSetting('publer_account_id');
  if (!publerKey || !accId) { console.log('[cron] Missing Publer config — skipping'); return; }

  console.log('[cron] Saturday auto-run starting...');
  try {
    const result = await generateAndPushBatch(parseInt(getSetting('auto_weeks') || '1'));
    console.log(`[cron] Done — ${result.pushed}/${result.total} posts pushed`);
  } catch (err) {
    console.error('[cron] Error:', err.message);
  }
}, { timezone: 'America/Chicago' });

// ── API ROUTES ────────────────────────────────────────────────

// Health
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', service: 'katycs-agent', version: '2.0.0', time: new Date().toISOString() });
});

// Get settings (never returns sensitive keys, only status)
app.get('/api/settings', (_, res) => {
  res.json({
    hasAnthropicKey:  !!getSetting('anthropic_key'),
    hasPublerKey:     !!getSetting('publer_key'),
    publerWorkspace:  getSetting('publer_workspace_id'),
    publerAccountId:  getSetting('publer_account_id'),
    publerLabel:      getSetting('publer_label') || 'LinkedIn Content',
    saturdayAuto:     getSetting('saturday_auto') === 'true',
    autoWeeks:        getSetting('auto_weeks') || '1',
  });
});

// Save settings
app.post('/api/settings', (req, res) => {
  const { anthropic_key, publer_key, publer_workspace_id, publer_account_id,
          publer_label, saturday_auto, auto_weeks } = req.body;
  if (anthropic_key)      setSetting('anthropic_key',      anthropic_key);
  if (publer_key)         setSetting('publer_key',         publer_key);
  if (publer_workspace_id) setSetting('publer_workspace_id', publer_workspace_id);
  if (publer_account_id)  setSetting('publer_account_id',  publer_account_id);
  if (publer_label)       setSetting('publer_label',       publer_label);
  if (saturday_auto !== undefined) setSetting('saturday_auto', String(saturday_auto));
  if (auto_weeks)         setSetting('auto_weeks',         String(auto_weeks));
  res.json({ ok: true });
});

// Connect to Publer — fetch workspace and account IDs automatically
app.post('/api/publer/connect', async (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key required' });

  try {
    // Fetch workspaces
    const wsRes = await fetch('https://app.publer.com/api/v1/workspaces', {
      headers: { 'Authorization': 'Bearer-API ' + api_key, 'Accept': 'application/json' }
    });
    const wsData = await wsRes.json();
    if (!Array.isArray(wsData) || !wsData.length) {
      return res.status(400).json({ error: 'No workspaces found. Check your API key.' });
    }
    const ws = wsData[0];

    // Fetch accounts
    const accRes = await fetch('https://app.publer.com/api/v1/accounts', {
      headers: { 'Authorization': 'Bearer-API ' + api_key, 'Publer-Workspace-Id': ws.id, 'Accept': 'application/json' }
    });
    const accData = await accRes.json();
    const accounts = accData?.accounts || accData || [];
    const liAcc = accounts.find(a => a.provider === 'linkedin');
    if (!liAcc) return res.status(400).json({ error: 'No LinkedIn account found in Publer.' });

    // Save all settings
    setSetting('publer_key',          api_key);
    setSetting('publer_workspace_id', ws.id);
    setSetting('publer_account_id',   liAcc.id);

    res.json({ ok: true, workspace: { id: ws.id, name: ws.name }, account: { id: liAcc.id, name: liAcc.name, status: liAcc.status } });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Generate a single post (used by dashboard)
app.post('/api/generate', async (req, res) => {
  const { pillar, topic } = req.body;
  if (!pillar) return res.status(400).json({ error: 'pillar required (1, 2, or 3)' });
  try {
    const result = await generatePost(parseInt(pillar), topic || null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate and push a batch
app.post('/api/generate-and-push', async (req, res) => {
  const weeks = parseInt(req.body.weeks || 1);
  if (!getSetting('publer_key'))     return res.status(400).json({ error: 'Publer not configured' });
  if (!getSetting('publer_account_id')) return res.status(400).json({ error: 'Publer account ID not set' });
  try {
    const result = await generateAndPushBatch(weeks);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get post history
app.get('/api/history', (_, res) => {
  res.json(getHistory(50));
});

// Get push log
app.get('/api/push-log', (_, res) => {
  const stmt = db.prepare('SELECT * FROM push_log ORDER BY created_at DESC LIMIT 20');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json(rows);
});

// Update post status
app.patch('/api/posts/:id', (req, res) => {
  const { status, impressions } = req.body;
  if (status)     db.run('UPDATE posts SET status = ? WHERE id = ?', [status, req.params.id]);
  if (impressions !== undefined) db.run('UPDATE posts SET impressions = ? WHERE id = ?', [impressions, req.params.id]);
  saveDB();
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[katycs-agent] running on port ${PORT}`);
    console.log(`[katycs-agent] Saturday cron scheduled (CST 8:00am)`);
  });
}).catch(err => {
  console.error('[startup] DB init failed:', err.message);
  process.exit(1);
});
