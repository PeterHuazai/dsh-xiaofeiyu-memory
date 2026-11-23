import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_VERSION = 1;

export const DEFAULT_CONFIG = {
  version: 1,
  curve: {
    stabilityBaseDays: 7,
    stabilityGrowth: 0.6,
    readGrowth: 0.12,
    maxStabilityDays: 3650,
    forgetThreshold: 0.25,
    archiveThreshold: 0.02,
    trunkImportance: 4,
    displayDays: 120
  },
  recall: {
    detail: 'index',
    indexBodyChars: 90,
    topK: 8,
    minScore: 0.12,
    includeDormant: false,
    redundancyWindowMin: 30,
    maxRepeatReads: 3,
    weightRelevance: 1.0,
    weightRetention: 0.65,
    weightImportance: 1.0,
    pinnedBoost: 0.15
  },
  guard: {
    contextWarnTokens: 120000,
    contextBlockTokens: 200000,
    hitRateFloor: 0.25,
    hitRateWindow: 20,
    staleShareCeiling: 0.5,
    warnScore: 0.5,
    blockScore: 0.75,
    weights: { context: 0.45, hitRate: 0.25, redundancy: 0.2, stale: 0.1 },
    modelCheck: { enabled: false, endpoint: '', model: '', apiKeyEnv: 'MEMORY_GUARD_API_KEY', timeoutMs: 8000 }
  },
  server: { port: 8787, host: '127.0.0.1' },
  backup: { keep: 7, intervalMin: 60 },
  tokens: { charsPerToken: 1.7 },
  reports: { dir: 'data/reports' },
  lifecycle: { recycleDays: 30 },
  multimodal: { enabled: true, attachmentsDir: 'data/attachments', vision: { enabled: false, endpoint: '', model: '', apiKeyEnv: 'MEMORY_VISION_API_KEY', timeoutMs: 15000 } },
  vector: {
    enabled: true,
    dims: 256,
    vectorWeight: 0.6,
    vectorFloor: 0.15,
    fpWeight: 1.5,
    backend: 'sqlite',
    provider: { enabled: false, endpoint: '', model: '', apiKeyEnv: 'MEMORY_EMBED_API_KEY', batchSize: 32, timeoutMs: 20000 },
    deepseek: { enabled: false, endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY', timeoutMs: 30000, maxItemsPerRun: 50 }
  }
};

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS partition (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  name TEXT UNIQUE NOT NULL,",
  "  title TEXT NOT NULL,",
  "  description TEXT NOT NULL DEFAULT '',",
  "  created_at INTEGER NOT NULL,",
  "  archived INTEGER NOT NULL DEFAULT 0",
  ");",
  "CREATE TABLE IF NOT EXISTS item (",
  "  id TEXT PRIMARY KEY,",
  "  partition_id INTEGER NOT NULL REFERENCES partition(id) ON DELETE CASCADE,",
  "  kind TEXT NOT NULL DEFAULT 'fact',",
  "  title TEXT NOT NULL,",
  "  body TEXT NOT NULL DEFAULT '',",
  "  tags TEXT NOT NULL DEFAULT '[]',",
  "  importance INTEGER NOT NULL DEFAULT 3,",
  "  pinned INTEGER NOT NULL DEFAULT 0,",
  "  state TEXT NOT NULL DEFAULT 'active',",
  "  stability REAL NOT NULL DEFAULT 7,",
  "  created_at INTEGER NOT NULL,",
  "  updated_at INTEGER NOT NULL,",
  "  last_access_at INTEGER NOT NULL,",
  "  access_count INTEGER NOT NULL DEFAULT 0,",
  "  hit_count INTEGER NOT NULL DEFAULT 0,",
  "  redundant_reads INTEGER NOT NULL DEFAULT 0,",
  "  content_hash TEXT NOT NULL,",
  "  source TEXT NOT NULL DEFAULT '',",
  "  task_id TEXT,",
  "  superseded_by TEXT,",
  "  deleted_at INTEGER,",
  "  delete_reason TEXT",
  ");",
  "CREATE INDEX IF NOT EXISTS item_partition ON item(partition_id, state);",
  "CREATE INDEX IF NOT EXISTS item_hash ON item(partition_id, content_hash);",
  "CREATE TABLE IF NOT EXISTS recall_event (",
  "  id TEXT PRIMARY KEY,",
  "  partition_id INTEGER NOT NULL,",
  "  task_id TEXT,",
  "  session_id TEXT,",
  "  query TEXT NOT NULL,",
  "  ts INTEGER NOT NULL,",
  "  returned INTEGER NOT NULL DEFAULT 0,",
  "  used INTEGER,",
  "  top_score REAL NOT NULL DEFAULT 0,",
  "  items TEXT NOT NULL DEFAULT '[]',",
  "  redundant INTEGER NOT NULL DEFAULT 0,",
  "  latency_ms REAL NOT NULL DEFAULT 0",
  ");",
  "CREATE INDEX IF NOT EXISTS recall_partition ON recall_event(partition_id, ts);",
  "CREATE TABLE IF NOT EXISTS task (",
  "  id TEXT PRIMARY KEY,",
  "  partition_id INTEGER NOT NULL,",
  "  title TEXT NOT NULL,",
  "  status TEXT NOT NULL DEFAULT 'open',",
  "  started_at INTEGER NOT NULL,",
  "  ended_at INTEGER,",
  "  context_tokens INTEGER NOT NULL DEFAULT 0,",
  "  report_path TEXT,",
  "  summary TEXT NOT NULL DEFAULT '',",
  "  log TEXT NOT NULL DEFAULT '[]'",
  ");",
  "CREATE INDEX IF NOT EXISTS task_partition ON task(partition_id, started_at);",
  "CREATE TABLE IF NOT EXISTS report (",
  "  id TEXT PRIMARY KEY,",
  "  task_id TEXT,",
  "  partition_id INTEGER NOT NULL,",
  "  title TEXT NOT NULL,",
  "  path TEXT NOT NULL,",
  "  summary TEXT NOT NULL DEFAULT '',",
  "  tokens INTEGER NOT NULL DEFAULT 0,",
  "  created_at INTEGER NOT NULL",
  ");",
  "CREATE TABLE IF NOT EXISTS guard_event (",
  "  id TEXT PRIMARY KEY,",
  "  partition_id INTEGER,",
  "  task_id TEXT,",
  "  ts INTEGER NOT NULL,",
  "  level TEXT NOT NULL,",
  "  score REAL NOT NULL,",
  "  reasons TEXT NOT NULL DEFAULT '[]',",
  "  context_tokens INTEGER NOT NULL DEFAULT 0,",
  "  action TEXT NOT NULL DEFAULT '',",
  "  model_verdict TEXT,",
  "  source TEXT NOT NULL DEFAULT 'real',",
  "  deleted_at INTEGER",
  ");",
  "CREATE INDEX IF NOT EXISTS guard_ts ON guard_event(ts);",
  "CREATE TABLE IF NOT EXISTS item_vector (",
  "  item_id TEXT PRIMARY KEY,",
  "  partition_id INTEGER NOT NULL,",
  "  model TEXT NOT NULL,",
  "  dims INTEGER NOT NULL,",
  "  vec BLOB NOT NULL,",
  "  text_hash TEXT NOT NULL,",
  "  created_at INTEGER NOT NULL",
  ");",
  "CREATE INDEX IF NOT EXISTS item_vector_part ON item_vector(partition_id, model);",
  "CREATE TABLE IF NOT EXISTS semantic_cache (",
  "  text_hash TEXT PRIMARY KEY,",
  "  model TEXT NOT NULL,",
  "  text TEXT NOT NULL,",
  "  created_at INTEGER NOT NULL DEFAULT 0",
  ");",
  "CREATE TABLE IF NOT EXISTS attachment (",
  "  id TEXT PRIMARY KEY,",
  "  item_id TEXT,",
  "  partition_id INTEGER NOT NULL,",
  "  path TEXT NOT NULL,",
  "  mime TEXT NOT NULL DEFAULT 'image/png',",
  "  bytes INTEGER NOT NULL DEFAULT 0,",
  "  sha256 TEXT NOT NULL,",
  "  caption TEXT NOT NULL DEFAULT '',",
  "  width INTEGER NOT NULL DEFAULT 0,",
  "  height INTEGER NOT NULL DEFAULT 0,",
  "  created_at INTEGER NOT NULL",
  ");",
  "CREATE INDEX IF NOT EXISTS attach_item ON attachment(item_id);",
  "CREATE TABLE IF NOT EXISTS item_link (",
  "  id TEXT PRIMARY KEY,",
  "  partition_id INTEGER NOT NULL,",
  "  from_id TEXT NOT NULL,",
  "  to_id TEXT NOT NULL,",
  "  relation TEXT NOT NULL DEFAULT 'related',",
  "  created_at INTEGER NOT NULL,",
  "  UNIQUE(from_id, to_id, relation)",
  ");",
  "CREATE INDEX IF NOT EXISTS item_link_to ON item_link(to_id);"
].join('\n');

export function nowMs() { return Date.now(); }

export function uid(prefix) {
  const t = Date.now().toString(36).slice(-5);
  const r = crypto.randomBytes(4).toString('hex');
  return (prefix ? prefix + '-' : '') + t + r;
}

export function hashOf(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

export function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = Object.assign({}, base);
  for (const k of Object.keys(patch)) out[k] = k in base ? deepMerge(base[k], patch[k]) : patch[k];
  return out;
}

export class ShadowLog {
  constructor(dir) { this.dir = dir; mkdirp(dir); }
  fileFor(ts) {
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return path.join(this.dir, y + '-' + m + '-' + day + '.jsonl');
  }
  append(op, row) {
    const ts = Date.now();
    try { fs.appendFileSync(this.fileFor(ts), JSON.stringify({ ts: ts, op: op, row: row }) + '\n', 'utf8'); }
    catch (err) { process.stderr.write('[shadow] append failed: ' + err.message + '\n'); }
  }
  files() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter(function (f) { return f.endsWith('.jsonl'); }).sort();
  }
  readAll() {
    const out = [];
    for (const f of this.files()) {
      const txt = fs.readFileSync(path.join(this.dir, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (err) { /* torn tail line, skip */ }
      }
    }
    return out;
  }
  size() {
    let n = 0, bytes = 0;
    for (const f of this.files()) { n += 1; bytes += fs.statSync(path.join(this.dir, f)).size; }
    return { files: n, bytes: bytes };
  }
}

export function dataPaths(root) {
  const dataDir = path.join(root, 'data');
  return {
    dataDir: dataDir,
    dbPath: path.join(dataDir, 'memory.db'),
    shadowDir: path.join(dataDir, 'shadow'),
    backupDir: path.join(dataDir, 'backups'),
    reportsDir: path.join(dataDir, 'reports'),
    configPath: path.join(dataDir, 'config.json')
  };
}

export function loadConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), raw);
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

export function saveConfig(dataDir, cfg) {
  atomicWrite(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

function columns(db, table) {
  try { return db.prepare('PRAGMA table_info(' + table + ')').all().map(function (c) { return c.name; }); }
  catch (err) { return []; }
}

export function migrate(db) {
  const cols = columns(db, 'item');
  if (cols.length && cols.indexOf('deleted_at') < 0) { try { db.exec('ALTER TABLE item ADD COLUMN deleted_at INTEGER'); } catch (err) {} }
  if (cols.length && cols.indexOf('delete_reason') < 0) { try { db.exec('ALTER TABLE item ADD COLUMN delete_reason TEXT'); } catch (err) {} }
  const rcols = columns(db, 'report');
  if (rcols.length && rcols.indexOf('deleted_at') < 0) { try { db.exec('ALTER TABLE report ADD COLUMN deleted_at INTEGER'); } catch (err) {} }
  if (rcols.length && rcols.indexOf('trash_path') < 0) { try { db.exec('ALTER TABLE report ADD COLUMN trash_path TEXT'); } catch (err) {} }
  const gcols = columns(db, 'guard_event');
  if (gcols.length && gcols.indexOf('source') < 0) { try { db.exec("ALTER TABLE guard_event ADD COLUMN source TEXT NOT NULL DEFAULT 'real'"); } catch (err) {} }
  if (gcols.length && gcols.indexOf('deleted_at') < 0) { try { db.exec('ALTER TABLE guard_event ADD COLUMN deleted_at INTEGER'); } catch (err) {} }
}

export function openStore(opts) {
  const o = opts || {};
  const root = o.root || process.env.MEMORY_ROOT || ROOT;
  const p = dataPaths(root);
  mkdirp(p.dataDir); mkdirp(p.shadowDir); mkdirp(p.backupDir); mkdirp(p.reportsDir); mkdirp(path.join(p.dataDir, 'attachments'));
  // allowExtension 只在创建时能打开：sqlite-vec 必须它才能 loadExtension，老 Node 不支持就退回普通打开
  let db;
  try {
    db = new DatabaseSync(p.dbPath, { allowExtension: true });
  } catch (err) {
    db = new DatabaseSync(p.dbPath);
  }
  try { db.exec('PRAGMA journal_mode=WAL'); } catch (err) { /* best effort */ }
  try { db.exec('PRAGMA busy_timeout=5000'); } catch (err) { /* 并发写时等服务端释放锁 */ }
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  migrate(db);
  const store = {
    root: root,
    paths: p,
    db: db,
    config: loadConfig(p.dataDir),
    shadow: new ShadowLog(p.shadowDir),
    close: function () { try { db.close(); } catch (e) { /* 已关闭 */ } }
  };
  const meta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const seen = meta.get('schema_version');
  if (!seen) {
    ins.run('schema_version', String(SCHEMA_VERSION));
    ins.run('created_at', String(Date.now()));
  }
  return store;
}

export function integrity(store) {
  try {
    const row = store.db.prepare('PRAGMA quick_check').get();
    const val = row ? Object.values(row)[0] : 'unknown';
    return { ok: String(val) === 'ok', detail: String(val) };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export function backup(store) {
  const cfg = store.config.backup || {};
  const keep = Number(cfg.keep || 7);
  try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (err) { /* ignore */ }
  const d = new Date();
  const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' +
    String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
  const dest = path.join(store.paths.backupDir, 'memory-' + stamp + '.db');
  fs.copyFileSync(store.paths.dbPath, dest);
  const files = fs.readdirSync(store.paths.backupDir).filter(function (f) { return f.endsWith('.db'); }).sort();
  while (files.length > keep) {
    const drop = files.shift();
    try { fs.unlinkSync(path.join(store.paths.backupDir, drop)); } catch (err) { /* ignore */ }
  }
  return { path: dest, kept: files.length + 1 };
}

export function listBackups(store) {
  const dir = store.paths.backupDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.db'); }).sort().map(function (f) {
    const st = fs.statSync(path.join(dir, f));
    return { name: f, bytes: st.size, mtime: st.mtimeMs };
  });
}

const REPLAYABLE = {
  partition: 'INSERT OR REPLACE INTO partition (id, name, title, description, created_at, archived) VALUES (?, ?, ?, ?, ?, ?)',
  item: 'INSERT OR REPLACE INTO item (id, partition_id, kind, title, body, tags, importance, pinned, state, stability, created_at, updated_at, last_access_at, access_count, hit_count, redundant_reads, content_hash, source, task_id, superseded_by, deleted_at, delete_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  recall_event: 'INSERT OR REPLACE INTO recall_event (id, partition_id, task_id, session_id, query, ts, returned, used, top_score, items, redundant, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  task: 'INSERT OR REPLACE INTO task (id, partition_id, title, status, started_at, ended_at, context_tokens, report_path, summary, log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  report: 'INSERT OR REPLACE INTO report (id, task_id, partition_id, title, path, summary, tokens, created_at, deleted_at, trash_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  guard_event: "INSERT OR REPLACE INTO guard_event (id, partition_id, task_id, ts, level, score, reasons, context_tokens, action, model_verdict, source, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'real'), ?)",
  attachment: 'INSERT OR REPLACE INTO attachment (id, item_id, partition_id, path, mime, bytes, sha256, caption, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  item_link: 'INSERT OR REPLACE INTO item_link (id, partition_id, from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?, ?)'
};

export const REPLAY_COLUMNS = {
  partition: ['id', 'name', 'title', 'description', 'created_at', 'archived'],
  item: ['id', 'partition_id', 'kind', 'title', 'body', 'tags', 'importance', 'pinned', 'state', 'stability', 'created_at', 'updated_at', 'last_access_at', 'access_count', 'hit_count', 'redundant_reads', 'content_hash', 'source', 'task_id', 'superseded_by', 'deleted_at', 'delete_reason'],
  recall_event: ['id', 'partition_id', 'task_id', 'session_id', 'query', 'ts', 'returned', 'used', 'top_score', 'items', 'redundant', 'latency_ms'],
  task: ['id', 'partition_id', 'title', 'status', 'started_at', 'ended_at', 'context_tokens', 'report_path', 'summary', 'log'],
  report: ['id', 'task_id', 'partition_id', 'title', 'path', 'summary', 'tokens', 'created_at', 'deleted_at', 'trash_path'],
  guard_event: ['id', 'partition_id', 'task_id', 'ts', 'level', 'score', 'reasons', 'context_tokens', 'action', 'model_verdict', 'source', 'deleted_at'],
  attachment: ['id', 'item_id', 'partition_id', 'path', 'mime', 'bytes', 'sha256', 'caption', 'width', 'height', 'created_at'],
  item_link: ['id', 'partition_id', 'from_id', 'to_id', 'relation', 'created_at']
};

export function rebuildFromShadow(root, shadowDir) {
  const p = dataPaths(root);
  const dir = shadowDir || p.shadowDir;
  const cache = new DatabaseSync(p.dbPath);
  cache.exec(SCHEMA);
  const log = new ShadowLog(dir);
  const entries = log.readAll();
  cache.exec('PRAGMA foreign_keys=OFF');
  cache.exec('BEGIN');
  let applied = 0;
  try {
    for (const e of entries) {
      if (e.op === 'guard_event_delete') {
        const gid = (e.row || {}).id;
        if (gid) { try { cache.prepare('DELETE FROM guard_event WHERE id = ?').run(String(gid)); applied += 1; } catch (err) { /* skip */ } }
        continue;
      }
      const sql = REPLAYABLE[e.op];
      if (!sql) continue;
      const cols = REPLAY_COLUMNS[e.op];
      const row = e.row || {};
      const values = cols.map(function (c) { const v = row[c]; return v === undefined ? null : v; });
      try { const stmt = cache.prepare(sql); stmt.run.apply(stmt, values); applied += 1; } catch (err) { /* skip bad row */ }
    }
    cache.exec('COMMIT');
  } catch (err) {
    try { cache.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw err;
  }
  cache.exec('PRAGMA foreign_keys=ON');
  try { cache.close(); } catch (e) { /* ignore */ }
  return { entries: entries.length, applied: applied };
}
