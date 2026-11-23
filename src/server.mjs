import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openStore, backup, integrity, listBackups } from './db.mjs';
import * as engine from './engine.mjs';
import * as tasks from './tasks.mjs';
import { checkGuard, modelSelfCheck, audit } from './guard.mjs';
import * as vision from './vision.mjs';
import * as vector from './vector.mjs';
import * as tools from './tools.mjs';

const store = openStore({});
const WEB = path.join(store.root, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8'
};

function argOf(name, fallback) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return fallback;
}

function send(res, code, body, type) {
  const isBuf = Buffer.isBuffer(body);
  const text = isBuf ? body : (typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, {
    'content-type': type || (isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8'),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > 40 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); } catch (err) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function q(url, key, fallback) {
  const v = url.searchParams.get(key);
  return v === null ? fallback : v;
}

function partIdOf(name) {
  if (!name) return null;
  const row = store.db.prepare('SELECT id FROM partition WHERE name = ?').get(String(name));
  return row ? row.id : null;
}

function stateBundle(partition) {
  const overview = engine.overview(store);
  const pid = partIdOf(partition);
  const target = partition || (overview.partitions[0] && overview.partitions[0].name) || null;
  const tid = partIdOf(target);
  const items = tid ? engine.itemList(store, tid, { limit: 400 }) : [];
  const events = store.db.prepare('SELECT id, partition_id, task_id, query, ts, returned, used, top_score, items, redundant FROM recall_event ' + (tid ? 'WHERE partition_id = ? ' : '') + 'ORDER BY ts DESC LIMIT 60')
    .all.apply(store.db.prepare('SELECT id, partition_id, task_id, query, ts, returned, used, top_score, items, redundant FROM recall_event ' + (tid ? 'WHERE partition_id = ? ' : '') + 'ORDER BY ts DESC LIMIT 60'), tid ? [tid] : []);
  const guards = store.db.prepare('SELECT * FROM guard_event ' + (tid ? 'WHERE partition_id = ? ' : '') + 'ORDER BY ts DESC LIMIT 40')
    .all.apply(store.db.prepare('SELECT * FROM guard_event ' + (tid ? 'WHERE partition_id = ? ' : '') + 'ORDER BY ts DESC LIMIT 40'), tid ? [tid] : []);
  return {
    overview: overview,
    activePartition: target,
    items: items,
    timeline: tid ? engine.timeline(store, tid, 30) : engine.timeline(store, null, 30),
    recallEvents: events,
    guardEvents: guards,
    recycle: tid ? engine.listRecycle(store, tid) : engine.listRecycle(store, null),
    reports: store.db.prepare('SELECT r.*, p.name AS partition FROM report r JOIN partition p ON p.id = r.partition_id ' + (tid ? 'WHERE r.partition_id = ? ' : '') + 'ORDER BY r.created_at DESC LIMIT 50')
      .all.apply(store.db.prepare('SELECT r.*, p.name AS partition FROM report r JOIN partition p ON p.id = r.partition_id ' + (tid ? 'WHERE r.partition_id = ? ' : '') + 'ORDER BY r.created_at DESC LIMIT 50'), tid ? [tid] : []),
    tasks: store.db.prepare('SELECT * FROM task ' + (tid ? 'WHERE partition_id = ? ' : '') + 'ORDER BY started_at DESC LIMIT 50')
      .all.apply(store.db.prepare('SELECT * FROM task ' + (tid ? 'WHERE partition_id = ? ' : '') + 'ORDER BY started_at DESC LIMIT 50'), tid ? [tid] : []),
    audit: audit(store, { partition: target }),
    backups: listBackups(store),
    integrity: integrity(store),
    now: Date.now()
  };
}

const routes = {
  'GET /api/health': function () {
    return { ok: true, service: 'xiaofeiyu-memory', version: 1, root: store.root, integrity: integrity(store), shadow: store.shadow.size(), now: Date.now() };
  },
  'GET /api/state': function (ctx) { return stateBundle(ctx.url.searchParams.get('partition')); },
  'GET /api/overview': function () { return engine.overview(store); },
  'GET /api/config': function () { return store.config; },
  'GET /api/partitions': function () { return { partitions: engine.listPartitions(store) }; },
  'GET /api/items': function (ctx) {
    const pid = partIdOf(q(ctx.url, 'partition', ''));
    if (!pid) throw new Error('unknown partition');
    return { items: engine.itemList(store, pid, { limit: Number(q(ctx.url, 'limit', 500)), includeArchived: q(ctx.url, 'includeArchived', '') === '1' }) };
  },
  'GET /api/item': function (ctx) { return engine.getItem(store, q(ctx.url, 'id', ''), { days: Number(q(ctx.url, 'days', 120)) }); },
  'GET /api/curve': function (ctx) {
    const id = q(ctx.url, 'id', '');
    const days = Number(q(ctx.url, 'days', store.config.curve.displayDays || 120));
    if (id) return engine.projectCurve(store.db.prepare('SELECT * FROM item WHERE id = ?').get(String(id)), store.config, days);
    return engine.projectCurve({ id: 'baseline', stability: store.config.curve.stabilityBaseDays, last_access_at: Date.now() }, store.config, days);
  },
  'GET /api/timeline': function (ctx) { return { points: engine.timeline(store, partIdOf(q(ctx.url, 'partition', '')), Number(q(ctx.url, 'days', 30))) }; },
  'GET /api/events': function (ctx) {
    const pid = partIdOf(q(ctx.url, 'partition', ''));
    const limit = Number(q(ctx.url, 'limit', 100));
    const sql = 'SELECT * FROM recall_event ' + (pid ? 'WHERE partition_id = ? ' : '') + 'ORDER BY ts DESC LIMIT ?';
    const stmt = store.db.prepare(sql);
    return { events: stmt.all.apply(stmt, pid ? [pid, limit] : [limit]) };
  },
  'GET /api/guard/events': function (ctx) {
    const pid = partIdOf(q(ctx.url, 'partition', ''));
    const limit = Number(q(ctx.url, 'limit', 100));
    const sql = 'SELECT * FROM guard_event ' + (pid ? 'WHERE partition_id = ? ' : '') + 'ORDER BY ts DESC LIMIT ?';
    const stmt = store.db.prepare(sql);
    return { events: stmt.all.apply(stmt, pid ? [pid, limit] : [limit]) };
  },
  'GET /api/audit': function (ctx) { return audit(store, { partition: q(ctx.url, 'partition', '') || null, hours: Number(q(ctx.url, 'hours', 168)) }); },
  'GET /api/recycle': function (ctx) { return { items: engine.listRecycle(store, partIdOf(q(ctx.url, 'partition', ''))) }; },
  'GET /api/reports': function (ctx) {
    if (q(ctx.url, 'trash', '') === '1') {
      return { reports: tasks.listReports(store, { trash: true, partitionId: partIdOf(q(ctx.url, 'partition', '')), limit: Number(q(ctx.url, 'limit', 100)) }) };
    }
    const pid = partIdOf(q(ctx.url, 'partition', ''));
    const sql = 'SELECT r.*, p.name AS partition FROM report r JOIN partition p ON p.id = r.partition_id ' + (pid ? 'WHERE r.partition_id = ? AND r.deleted_at IS NULL ' : 'WHERE r.deleted_at IS NULL ') + 'ORDER BY r.created_at DESC LIMIT 200';
    const stmt = store.db.prepare(sql);
    return { reports: stmt.all.apply(stmt, pid ? [pid] : []) };
  },
  'GET /api/report': function (ctx) {
    const file = path.resolve(String(q(ctx.url, 'path', '')));
    if (!file.startsWith(path.resolve(store.paths.reportsDir))) throw new Error('report path outside reports dir');
    if (!fs.existsSync(file)) throw new Error('report file missing');
    return { path: file, markdown: fs.readFileSync(file, 'utf8') };
  },
  'GET /api/attachment': function (ctx) {
    const row = engine.attachmentById(store, q(ctx.url, 'id', ''));
    if (!row) throw new Error('unknown attachment');
    if (!fs.existsSync(row.path)) throw new Error('attachment file missing');
    const buf = fs.readFileSync(row.path);
    return { __raw: true, buf: buf, mime: row.mime };
  },
  'GET /api/export': function (ctx) {
    return tasks.exportBundle(store, { partition: q(ctx.url, 'partition', '') || null, withEvents: q(ctx.url, 'withEvents', '1') === '1', withConfig: q(ctx.url, 'withConfig', '0') === '1' });
  },
  'POST /api/partitions': function (ctx) { return engine.ensurePartition(store, ctx.body); },
  'POST /api/remember': function (ctx) { return engine.remember(store, ctx.body); },
  'POST /api/recall': function (ctx) { return engine.recall(store, ctx.body); },
  'POST /api/feedback': function (ctx) { return engine.feedback(store, ctx.body); },
  'POST /api/delete': function (ctx) { return engine.deleteItem(store, ctx.body); },
  'POST /api/restore': function (ctx) { return engine.restoreItem(store, ctx.body.id); },
  'POST /api/purge': function (ctx) { return engine.purgeDeleted(store, ctx.body); },
  'POST /api/attach': function (ctx) { return engine.attachToItem(store, ctx.body); },
  'POST /api/attach/caption': function (ctx) { return engine.setCaption(store, ctx.body); },
  'POST /api/attach/describe': function (ctx) { return vision.describeImage(store, ctx.body); },
  'GET /api/vision': function () { return vision.visionStatus(store); },
  'GET /api/vector/status': function () {
    const s = vector.vectorStatus(store);
    s.backend = vector.annBackend(store);
    return s;
  },
  'POST /api/vector/reindex': async function (ctx) {
    const part = ctx.body.partition ? engine.partitionByName(store, ctx.body.partition) : null;
    if (ctx.body.partition && !part) throw new Error('unknown partition');
    return vector.reindex(store, { partitionId: part ? part.id : null, provider: !!ctx.body.provider });
  },
  'POST /api/vector/enrich': async function (ctx) {
    const part = ctx.body.partition ? engine.partitionByName(store, ctx.body.partition) : null;
    if (ctx.body.partition && !part) throw new Error('unknown partition');
    return vector.enrichSemantics(store, { partitionId: part ? part.id : null, limit: ctx.body.limit });
  },
  'POST /api/report/delete': function (ctx) { return tasks.deleteReport(store, { id: ctx.body.id, path: ctx.body.path, reason: ctx.body.reason }); },
  'POST /api/report/restore': function (ctx) { return tasks.restoreReport(store, { id: ctx.body.id, path: ctx.body.path }); },
  'POST /api/report/purge': function (ctx) { return tasks.purgeReports(store, { id: ctx.body.id, path: ctx.body.path, olderThanDays: ctx.body.olderThanDays }); },
  'GET /api/caption/status': function (ctx) { return vision.captionStatus(store, { partitionId: partIdOf(q(ctx.url, 'partition', '')) }); },
  'POST /api/caption/batch': async function (ctx) {
    const part = ctx.body.partition ? engine.partitionByName(store, ctx.body.partition) : null;
    if (ctx.body.partition && !part) throw new Error('unknown partition');
    return vision.batchCaption(store, { partitionId: part ? part.id : null, limit: ctx.body.limit, includeCaptioned: !!ctx.body.includeCaptioned, prompt: ctx.body.prompt });
  },
  'POST /api/attach/delete': function (ctx) { return engine.deleteAttachment(store, ctx.body.id, !!ctx.body.hard); },
  'POST /api/sweep': function () { return engine.sweep(store); },
  'POST /api/backup': function () { return backup(store); },
  'POST /api/guard/check': function (ctx) { return checkGuard(store, ctx.body); },
  'POST /api/guard/model-check': async function (ctx) {
    const row = store.db.prepare('SELECT * FROM guard_event WHERE id = ?').get(String(ctx.body.id || ''));
    if (!row) throw new Error('unknown guard event');
    return modelSelfCheck(store, { id: row.id, level: row.level, score: row.score, reasons: JSON.parse(row.reasons || '[]'), metrics: { estTokens: row.context_tokens } });
  },
  'POST /api/task/start': function (ctx) { return tasks.startTask(store, ctx.body); },
  'POST /api/task/log': function (ctx) { return tasks.taskLog(store, ctx.body); },
  'POST /api/task/end': function (ctx) { return tasks.endTask(store, ctx.body); },
  'POST /api/task/report': function (ctx) { return tasks.writeReport(store, ctx.body); },
  'POST /api/import': function (ctx) { return tasks.importBundle(store, ctx.body.bundle || ctx.body, { renamePartition: ctx.body.renamePartition }); },
  'GET /api/search': function (ctx) {
    return tools.searchItems(store, {
      partition: q(ctx.url, 'partition', '') || q(ctx.url, 'name', ''),
      q: q(ctx.url, 'q', '') || q(ctx.url, 'query', ''), tags: q(ctx.url, 'tags', ''),
      state: q(ctx.url, 'state', 'all'), kind: q(ctx.url, 'kind', ''), sort: q(ctx.url, 'sort', ''),
      limit: q(ctx.url, 'limit', 20), offset: q(ctx.url, 'offset', 0)
    });
  },
  'GET /api/digest': function (ctx) { return tools.digest(store, { partition: q(ctx.url, 'partition', ''), days: q(ctx.url, 'days', 7) }); },
  'GET /api/explain': function (ctx) { return tools.explain(store, { id: q(ctx.url, 'id', ''), query: q(ctx.url, 'query', '') }); },
  'GET /api/links': function (ctx) { return tools.links(store, { id: q(ctx.url, 'id', '') }); },
  'GET /api/expand': function (ctx) { return tools.expand(store, { id: q(ctx.url, 'id', ''), depth: q(ctx.url, 'depth', 1) }); },
  'GET /api/dedupe': function (ctx) { return tools.dedupe(store, { partition: q(ctx.url, 'partition', ''), threshold: q(ctx.url, 'threshold', 0.92) }); },
  'GET /api/selfcheck': function (ctx) { return tools.health(store, { partition: q(ctx.url, 'partition', ''), fix: q(ctx.url, 'fix', '') === '1' }); },
  'POST /api/link': function (ctx) { return tools.link(store, ctx.body); },
  'POST /api/unlink': function (ctx) { return tools.unlink(store, ctx.body); },
  'POST /api/pin': function (ctx) { return tools.setPinned(store, ctx.body); },
  'POST /api/summarize': function (ctx) {
    const part = ctx.body.partition ? engine.partitionByName(store, ctx.body.partition) : null;
    if (!part) throw new Error('unknown partition');
    return tools.summarize(store, { partition: part.name, limit: ctx.body.limit, title: ctx.body.title, taskId: ctx.body.taskId });
  },
  'PUT /api/config': function (ctx) { return tasks.updateConfig(store, ctx.body); }
};

const server = http.createServer(async function (req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, 'http://localhost');
  const key = req.method + ' ' + url.pathname;
  try {
    if (routes[key]) {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = await routes[key]({ url: url, body: body || {}, req: req });
      if (result && result.__raw) {
        res.writeHead(200, { 'content-type': result.mime || 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(result.buf);
      }
      return send(res, 200, result);
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'no route ' + key });
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'not found: ' + url.pathname, 'text/plain; charset=utf-8');
    }
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  } catch (err) {
    return send(res, 400, { error: String(err && err.message ? err.message : err) });
  }
});

const port = Number(argOf('port', process.env.MEMORY_PORT || store.config.server.port || 8787));
const host = String(argOf('host', store.config.server.host || '127.0.0.1'));
server.listen(port, host, function () {
  const line = '小肥鱼记忆库 · http://' + host + ':' + port + '  (data: ' + store.paths.dbPath + ')';
  console.log(line);
  try { fs.writeFileSync(path.join(store.paths.dataDir, 'server.json'), JSON.stringify({ pid: process.pid, host: host, port: port, startedAt: Date.now() }, null, 2)); } catch (err) {}
});
process.on('SIGINT', function () { try { backup(store); } catch (err) {} process.exit(0); });
