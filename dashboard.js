// Web dashboard to connect / start / pause / cut / stop all recorders and watch their status.
// Usage: node dashboard.js   then open http://localhost:3000   (DASH_PORT to change the port)
// It runs record.js once per env file (env.live1 .. env.live4) and talks to each over IPC.
// Listens on 127.0.0.1 only; bot tokens are never sent to the browser.
//
// States:  idle (no bots connected) -> standby (bots sit in their channels) -> recording <-> paused
//          recording/paused --cut--> standby (files finalized, bots stay)     any --stop--> idle (bots leave)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const dotenv = require('dotenv');
const { DEFAULTS, normalize } = require('./settings');

const PORT = parseInt(process.env.DASH_PORT, 10) || 3000;
const HOST = '127.0.0.1';
const ENV_FILES = ['env.live1', 'env.live2', 'env.live3', 'env.live4'].filter((f) => fs.existsSync(path.join(__dirname, f)));
if (ENV_FILES.length === 0) {
  console.error('No env.live1..4 files found. Run node build-env.js first.');
  process.exit(1);
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const parsed = ENV_FILES.map((f) => dotenv.parse(fs.readFileSync(path.join(__dirname, f))));
const GUILD_ID = parsed[0].GUILD_ID || '';

// ---------- settings (settings.json; first run is seeded from the env files) ----------
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function loadSettings() {
  try { return normalize(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}
  const e = parsed[0];
  return normalize({
    format: (e.OUTPUT_FORMAT || '').toLowerCase(),
    announce: e.ANNOUNCE,
    outputDir: e.OUTPUT_DIR || DEFAULTS.outputDir,
    bitrates: { mp3: { track: e.MP3_TRACK_KBPS, mix: e.MP3_MIX_KBPS } },
  });
}
let settings = loadSettings();
const outputRoot = () => path.resolve(__dirname, settings.outputDir);

// ---------- state ----------
let mode = 'idle'; // idle | standby | recording | paused | cutting | stopping
let session = null; // { name, dir, startedAt, pausedAt, pausedTotal }
const procs = new Map(); // env file -> { child, alive, cutting, recorders }
const logs = [];
const clients = new Set();
let disk = null;

const bots = (i, state) => list(parsed[i].CHANNEL_IDS).map((id) => ({
  id, label: null, tag: null, state, recMs: 0, speaking: [], tracks: 0, bytes: 0, error: null,
}));
for (const [i, f] of ENV_FILES.entries()) procs.set(f, { child: null, alive: false, cutting: false, recorders: bots(i, 'offline') });

function log(line) {
  const entry = { t: Date.now(), line };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  console.log(line);
  sse('log', entry);
}

// ---------- recorder processes ----------
function spawnProc(f, i) {
  const p = procs.get(f);
  p.recorders = bots(i, 'connecting');
  p.alive = true;
  p.cutting = false;
  const child = fork(path.join(__dirname, 'record.js'), [f], {
    cwd: __dirname,
    env: { ...process.env, JOIN_STAGGER_MS: String(settings.staggerMs) },
    silent: true,
  });
  p.child = child;
  const pipeLines = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) log(`[${f}] ${l}`);
    });
  };
  pipeLines(child.stdout);
  pipeLines(child.stderr);
  child.on('message', (m) => {
    if (m?.type === 'status') p.recorders = m.recorders;
    else if (m?.type === 'cut-done') { p.cutting = false; checkCutDone(); }
  });
  child.on('exit', (code, sig) => {
    p.alive = false;
    p.cutting = false;
    const clean = mode === 'stopping';
    if (!clean) log(`[${f}] recorder process exited unexpectedly (code ${code ?? sig})`);
    p.recorders = p.recorders.map((r) => (r.state === 'stopped' ? r : { ...r, speaking: [], state: clean ? 'stopped' : 'crashed' }));
    if (![...procs.values()].some((x) => x.alive)) {
      mode = 'idle';
      session = null;
      log('All recorders stopped.');
      pushStatus();
    } else checkCutDone();
  });
}

// Start any recorder process that isn't running (first connect, or recovering from a crash).
function ensureProcs() {
  for (const [i, f] of ENV_FILES.entries()) if (!procs.get(f).alive) spawnProc(f, i);
}

const alive = () => [...procs.values()].filter((p) => p.alive);
const sendAll = (msg) => { for (const p of alive()) p.child.send(msg); };

function checkCutDone() {
  if (mode !== 'cutting' || alive().some((p) => p.cutting)) return;
  mode = 'standby';
  const s = session;
  session = null;
  log(`Recording ended and saved in ${s?.dir}. Bots are still connected; press Start for a new recording.`);
  pushStatus();
}

// Folder for one recording: the name the user typed (or a timestamp), never reusing an existing folder.
function resolveSession(name) {
  let clean = (name || '').trim().replace(/[^\w .()-]+/g, '_').replace(/^[.\s]+/, '').slice(0, 80).trim();
  if (!clean) clean = new Date().toISOString().replace(/[:.]/g, '-');
  let dir = path.join(outputRoot(), clean);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(outputRoot(), `${clean}_${n}`);
  return { name: path.basename(dir), dir };
}

const actions = {
  // Bring the bots into their channels without recording.
  connect() {
    if (mode !== 'idle' && mode !== 'standby') throw new Error(`Cannot connect while ${mode}`);
    ensureProcs();
    if (mode === 'idle') { mode = 'standby'; log('Connecting bots (not recording yet)...'); }
  },
  // Begin a recording. Bots already in their channels just start recording; the rest are connected first.
  start({ folderName } = {}) {
    if (mode !== 'idle' && mode !== 'standby') throw new Error(`Cannot start while ${mode}`);
    const s = resolveSession(folderName);
    fs.mkdirSync(s.dir, { recursive: true }); // fail early if the folder is not writable
    ensureProcs();
    session = { ...s, startedAt: Date.now(), pausedAt: null, pausedTotal: 0 };
    mode = 'recording';
    sendAll({ cmd: 'record', dir: s.dir, settings });
    log(`Recording started in ${s.dir}`);
  },
  pause() {
    if (mode !== 'recording') throw new Error(`Cannot pause while ${mode}`);
    mode = 'paused';
    session.pausedAt = Date.now();
    sendAll({ cmd: 'pause' });
    log('Paused. Bots stay in their channels; audio is not recorded.');
  },
  resume() {
    if (mode !== 'paused') throw new Error(`Cannot resume while ${mode}`);
    session.pausedTotal += Date.now() - session.pausedAt;
    session.pausedAt = null;
    mode = 'recording';
    sendAll({ cmd: 'resume' });
    log('Resumed.');
  },
  // End the current recording (finalize files); the bots stay in their channels.
  cut() {
    if (mode !== 'recording' && mode !== 'paused') throw new Error(`Cannot cut while ${mode}`);
    if (session.pausedAt) { session.pausedTotal += Date.now() - session.pausedAt; session.pausedAt = null; }
    mode = 'cutting';
    for (const p of alive()) { p.cutting = true; p.child.send({ cmd: 'cut' }); }
    log('Ending recording: finalizing files (bots stay in their channels)...');
  },
  // Bots leave their channels; any recording in progress is finalized first.
  stop() {
    if (mode !== 'standby' && mode !== 'recording' && mode !== 'paused') throw new Error(`Cannot stop while ${mode}`);
    if (session?.pausedAt) { session.pausedTotal += Date.now() - session.pausedAt; session.pausedAt = null; }
    mode = 'stopping';
    sendAll({ cmd: 'stop' });
    log('Stopping: bots leave their channels, then files are finalized...');
    if (alive().length === 0) { mode = 'idle'; session = null; }
  },
  reconnect({ id } = {}) {
    if (mode !== 'standby' && mode !== 'recording' && mode !== 'paused') throw new Error(`Cannot reconnect while ${mode}`);
    const p = [...procs.values()].find((x) => x.recorders.some((r) => r.id === id));
    if (!p) throw new Error('Unknown channel');
    if (!p.alive) throw new Error('That recorder process has exited; press Start (or Connect) to relaunch it');
    p.child.send({ cmd: 'reconnect', id });
    log(`Manual reconnect requested for ${p.recorders.find((r) => r.id === id).label || id}`);
  },
  settings({ settings: next } = {}) {
    const s = normalize(next);
    const dir = path.resolve(__dirname, s.outputDir);
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); } catch (e) {
      throw new Error(`Save location is not usable: ${e.message}`);
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
    settings = s;
    refreshDisk();
    log(`Settings saved: ${s.format}, ${s.mode === 'both' ? 'mix + speaker tracks' : s.mode === 'mix' ? 'full mix only' : 'speaker tracks only'}. Applies from the next recording.`);
  },
};

// ---------- snapshot + SSE ----------
function snapshot() {
  const now = Date.now();
  return {
    state: mode,
    now,
    guildId: GUILD_ID,
    settings,
    outputDir: outputRoot(),
    session: session && {
      name: session.name,
      dir: session.dir,
      startedAt: session.startedAt,
      recMs: (session.pausedAt ?? now) - session.startedAt - session.pausedTotal,
      pausedMs: session.pausedTotal + (session.pausedAt ? now - session.pausedAt : 0),
    },
    bots: [...procs.values()].flatMap((p) => p.recorders),
    disk,
  };
}

function sse(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const pushStatus = () => { if (clients.size) sse('status', snapshot()); };
setInterval(pushStatus, 1000);

async function refreshDisk() {
  try {
    let dir = outputRoot();
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    const s = await fs.promises.statfs(dir);
    disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch { disk = null; }
}
refreshDisk();
setInterval(refreshDisk, 15_000);

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try { total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch {}
  }
  return total;
}

function pastSessions() {
  const root = outputRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(root, e.name);
      const channels = fs.readdirSync(dir, { withFileTypes: true }).filter((c) => c.isDirectory()).length;
      return { name: e.name, dir, channels, bytes: dirSize(dir), mtime: fs.statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 30);
}

// ---------- http ----------
const INDEX = path.join(__dirname, 'dashboard.html');
const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const server = http.createServer((req, res) => {
  // Block DNS-rebinding and cross-site requests: only our own page may talk to this server.
  if (!allowedHosts.has(req.headers.host)) { res.writeHead(403).end('Forbidden'); return; }
  const url = req.url.split('?')[0];
  const action = url.startsWith('/api/') ? url.slice(5) : null;

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(INDEX).pipe(res);
  } else if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`event: backlog\ndata: ${JSON.stringify(logs.slice(-200))}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else if (req.method === 'GET' && url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(pastSessions()));
  } else if (req.method === 'POST' && action && Object.hasOwn(actions, action)) {
    const origin = req.headers.origin;
    if ((origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) || !/^application\/json/.test(req.headers['content-type'] || '')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let body = '';
    req.on('data', (d) => { if (body.length < 16384) body += d; });
    req.on('end', () => {
      try {
        actions[action](JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, state: mode }));
        pushStatus();
      } catch (e) {
        res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  } else {
    res.writeHead(404).end('Not found');
  }
});

server.listen(PORT, HOST, () => console.log(`Dashboard: http://localhost:${PORT}`));
server.on('error', (e) => { console.error(`Cannot listen on port ${PORT}: ${e.message}`); process.exit(1); });

// Ctrl+C on the dashboard: stop recorders cleanly first, so nothing is left unfinalized.
let quitting = false;
function quit() {
  if (quitting) process.exit(1); // second Ctrl+C: force
  quitting = true;
  if (mode === 'idle') process.exit(0);
  console.log('\nStopping recorders before exit (Ctrl+C again to force quit)...');
  const t = setInterval(() => {
    if (mode === 'idle') { clearInterval(t); process.exit(0); }
    if (mode === 'standby' || mode === 'recording' || mode === 'paused') actions.stop(); // also covers a cut that finishes meanwhile
  }, 500);
}
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
