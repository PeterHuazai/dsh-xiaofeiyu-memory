import fs from 'node:fs';
import path from 'node:path';
import { nowMs, uid, atomicWrite, deepMerge, saveConfig } from './db.mjs';
import { ensurePartition, remember, partitionByName, clamp } from './engine.mjs';

function slug(text) {
  return String(text || 'task').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

function stamp(ts) {
  const d = new Date(ts);
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' +
    String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
}

function jsonParse(text, fallback) { try { const v = JSON.parse(text); return v === null || v === undefined ? fallback : v; } catch (err) { return fallback; } }

function taskRow(store, id) {
  const row = store.db.prepare('SELECT * FROM task WHERE id = ?').get(String(id || ''));
  if (!row) throw new Error('unknown task: ' + id);
  return row;
}

function trunkOf(store, partId) {
  const minImp = Number((store.config.curve || {}).trunkImportance || 4);
  return store.db.prepare("SELECT id, title, kind, importance, pinned, stability FROM item WHERE partition_id = ? AND state = 'active' AND (pinned = 1 OR importance >= ?) ORDER BY pinned DESC, importance DESC, last_access_at DESC LIMIT 12")
    .all(partId, minImp).map(function (r) { return { id: r.id, title: r.title, kind: r.kind, importance: r.importance, pinned: !!r.pinned }; });
}

export function startTask(store, input) {
  const o = input || {};
  const db = store.db;
  const part = ensurePartition(store, { name: o.partition || o.partitionName, title: o.partitionTitle });
  const now = nowMs();
  const id = uid('t');
  const title = String(o.title || '未命名任务');
  const log = [{ ts: now, note: '任务开启' }];
  db.prepare('INSERT INTO task (id, partition_id, title, status, started_at, ended_at, context_tokens, report_path, summary, log) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)')
    .run(id, part.id, title, 'running', now, Number(o.contextTokens || 0), '', JSON.stringify(log));
  const row = db.prepare('SELECT * FROM task WHERE id = ?').get(id);
  store.shadow.append('task', row);
  const seed = remember(store, {
    partition: part.name,
    kind: 'task',
    title: '任务开启：' + title,
    body: '目标：' + String(o.goal || o.description || '（未填）') + '\n状态：进行中\n任务ID：' + id,
    tags: ['task'],
    importance: 4,
    taskId: id,
    source: 'task'
  });
  return {
    task: row,
    seedItem: seed.item.id,
    trunk: trunkOf(store, part.id),
    directive: '先读 trunk 主干，再 recall（detail=index）取相关条目；干活中把长期结论 remember 进去，用了召回结果就 feedback；结束前 task end 写汇报。'
  };
}

export function taskLog(store, input) {
  const o = input || {};
  const row = taskRow(store, o.taskId || o.id);
  const log = jsonParse(row.log, []);
  const now = nowMs();
  log.push({ ts: now, note: String(o.note || o.text || ''), tokens: Number(o.tokens || 0) });
  const tokens = Number(o.tokens || row.context_tokens || 0);
  store.db.prepare('UPDATE task SET log = ?, context_tokens = ? WHERE id = ?').run(JSON.stringify(log), tokens, row.id);
  const next = store.db.prepare('SELECT * FROM task WHERE id = ?').get(row.id);
  store.shadow.append('task', next);
  return { task: next, log: log };
}

export function writeReport(store, input) {
  const o = input || {};
  const db = store.db;
  const part = ensurePartition(store, { name: o.partition || o.partitionName, title: o.partitionTitle });
  const now = nowMs();
  const id = uid('rep');
  const title = String(o.title || '任务汇报');
  const dir = store.paths.reportsDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, stamp(now) + '-' + slug(title) + '.md');
  const taskRow0 = o.taskId ? db.prepare('SELECT * FROM task WHERE id = ?').get(String(o.taskId)) : null;
  const totalItems = db.prepare("SELECT COUNT(*) AS n FROM item WHERE partition_id = ? AND state != 'deleted'").get(part.id).n;
  const header = [
    '# ' + title,
    '',
    '- 分区：' + part.name,
    '- 任务：' + (taskRow0 ? taskRow0.id + ' · ' + taskRow0.title : '(无关联任务)'),
    '- 生成时间：' + new Date(now).toISOString(),
    '- 记忆条目总数：' + String(totalItems),
    '',
    '---',
    ''
  ].join('\n');
  const markdown = o.markdown ? String(o.markdown) : String(o.summary || '(空)');
  atomicWrite(file, header + markdown + '\n');
  const tokens = Math.round(fs.statSync(file).size / Number((store.config.tokens || {}).charsPerToken || 1.7));
  db.prepare('INSERT INTO report (id, task_id, partition_id, title, path, summary, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, o.taskId || null, part.id, title, file, String(o.summary || '').slice(0, 500), tokens, now);
  const row = db.prepare('SELECT * FROM report WHERE id = ?').get(id);
  store.shadow.append('report', row);
  if (o.taskId) {
    db.prepare('UPDATE task SET report_path = ?, summary = ? WHERE id = ?').run(file, String(o.summary || '').slice(0, 500), o.taskId);
    store.shadow.append('task', db.prepare('SELECT * FROM task WHERE id = ?').get(o.taskId));
  }
  const item = remember(store, {
    partition: part.name,
    kind: 'report',
    title: '汇报：' + title,
    body: String(o.summary || '') + '\n文件：' + file,
    tags: ['report'],
    importance: 3,
    taskId: o.taskId || null,
    source: 'report'
  });
  return { report: row, path: file, item: item.item.id, tokens: tokens };
}

export function endTask(store, input) {
  const o = input || {};
  const db = store.db;
  const row = taskRow(store, o.taskId || o.id);
  const now = nowMs();
  db.prepare('UPDATE task SET status = ?, ended_at = ?, summary = ?, context_tokens = ? WHERE id = ?')
    .run(o.abort ? 'aborted' : 'done', now, String(o.summary || row.summary || ''), Number(o.tokens || row.context_tokens || 0), row.id);
  const next = db.prepare('SELECT * FROM task WHERE id = ?').get(row.id);
  store.shadow.append('task', next);
  let report = null;
  if (o.markdown || o.summary) {
    const part = partitionById(store, row.partition_id);
    report = writeReport(store, {
      partition: o.partition || (part ? part.name : 'default'),
      taskId: row.id,
      title: o.title || row.title,
      summary: o.summary || row.summary,
      markdown: o.markdown
    });
  }
  return { task: next, report: report };
}

export function partitionById(store, id) {
  return store.db.prepare('SELECT * FROM partition WHERE id = ?').get(String(id || '')) || null;
}
export function exportBundle(store, input) {
  const o = input || {};
  const db = store.db;
  const parts = o.partition
    ? [partitionByName(store, o.partition)].filter(Boolean)
    : db.prepare('SELECT * FROM partition ORDER BY created_at ASC').all();
  const bundle = { format: 'xiaofeiyu-memory-bundle', version: 1, exportedAt: nowMs(), partitions: [], items: [], tasks: [], reports: [], events: [] };
  for (const part of parts) {
    bundle.partitions.push({ id: part.id, name: part.name, title: part.title, description: part.description, created_at: part.created_at });
    const items = db.prepare("SELECT * FROM item WHERE partition_id = ? AND state != 'deleted' ORDER BY created_at ASC").all(part.id);
    for (const it of items) bundle.items.push(Object.assign({}, it, { partition: part.name }));
    for (const t of db.prepare('SELECT * FROM task WHERE partition_id = ? ORDER BY started_at ASC').all(part.id)) {
      bundle.tasks.push(Object.assign({}, t, { partition: part.name }));
    }
    for (const r of db.prepare('SELECT * FROM report WHERE partition_id = ? AND deleted_at IS NULL ORDER BY created_at ASC').all(part.id)) {
      bundle.reports.push(Object.assign({}, r, { partition: part.name, markdown: fs.existsSync(r.path) ? fs.readFileSync(r.path, 'utf8') : '' }));
    }
    if (o.withEvents) {
      for (const e of db.prepare('SELECT * FROM recall_event WHERE partition_id = ? ORDER BY ts ASC').all(part.id)) {
        bundle.events.push(Object.assign({}, e, { partition: part.name }));
      }
    }
  }
  if (o.withConfig) bundle.config = store.config;
  return bundle;
}

export function importBundle(store, bundle, opts) {
  const o = opts || {};
  const b = bundle || {};
  const db = store.db;
  const rename = o.renamePartition ? String(o.renamePartition) : '';
  const partMap = new Map();
  let partsMade = 0;
  const list = Array.isArray(b.partitions) && b.partitions.length ? b.partitions : [{ name: rename || 'imported', title: '导入的分区' }];
  for (let i = 0; i < list.length; i++) {
    const src = list[i] || {};
    const name = (rename && (list.length === 1 || i === 0)) ? rename : String(src.name || 'imported');
    const existed = !!db.prepare('SELECT id FROM partition WHERE name = ?').get(name);
    const part = ensurePartition(store, { name: name, title: src.title || name, description: src.description || '' });
    if (!existed) partsMade += 1;
    partMap.set(String(src.name || name), part.name);
  }
  const nameOf = function (row) {
    const key = String(row.partition || (b.partitions && b.partitions[0] && b.partitions[0].name) || rename || 'imported');
    return partMap.get(key) || rename || key;
  };
  let created = 0;
  const itemIdMap = new Map();
  for (const it of (b.items || [])) {
    const res = remember(store, {
      partition: nameOf(it),
      kind: it.kind, title: it.title, body: it.body,
      tags: Array.isArray(it.tags) ? it.tags : [],
      importance: it.importance, pinned: !!it.pinned,
      source: it.source || 'import', taskId: null
    });
    if (!res.deduped) created += 1;
    if (it.id) itemIdMap.set(String(it.id), res.item.id);
  }
  let reports = 0;
  for (const r of (b.reports || [])) {
    const part = nameOf(r);
    const title = String(r.title || '导入的汇报');
    const file = path.join(store.paths.reportsDir, stamp(nowMs()) + '-' + slug(title) + '-imported.md');
    fs.mkdirSync(store.paths.reportsDir, { recursive: true });
    atomicWrite(file, String(r.markdown || r.summary || '(空)'));
    db.prepare('INSERT INTO report (id, task_id, partition_id, title, path, summary, tokens, created_at) VALUES (?, NULL, (SELECT id FROM partition WHERE name = ?), ?, ?, ?, ?, ?)')
      .run(uid('rep'), part, title, file, String(r.summary || '').slice(0, 500), Number(r.tokens || 0), Number(r.created_at || nowMs()));
    reports += 1;
  }
  return { partitions: partMap.size, partitionsCreated: partsMade, items: created, skipped: (b.items || []).length - created, reports: reports };
}

export function updateConfig(store, patch) {
  const next = deepMerge(store.config, patch || {});
  next.version = Number(store.config.version || 1) + 1;
  const c = next.curve || (next.curve = {});
  c.stabilityBaseDays = clamp(Number(c.stabilityBaseDays || 7), 0.1, 3650);
  c.stabilityGrowth = clamp(Number(c.stabilityGrowth === undefined ? 0.6 : c.stabilityGrowth), 0, 10);
  c.readGrowth = clamp(Number(c.readGrowth === undefined ? 0.12 : c.readGrowth), 0, 10);
  c.maxStabilityDays = clamp(Number(c.maxStabilityDays || 3650), 1, 36500);
  c.forgetThreshold = clamp(Number(c.forgetThreshold === undefined ? 0.25 : c.forgetThreshold), 0.001, 0.95);
  c.archiveThreshold = clamp(Number(c.archiveThreshold === undefined ? 0.02 : c.archiveThreshold), 0, 0.5);
  c.trunkImportance = clamp(Math.round(Number(c.trunkImportance || 4)), 1, 5);
  c.displayDays = clamp(Math.round(Number(c.displayDays || 120)), 7, 3650);
  const r = next.recall || (next.recall = {});
  r.topK = clamp(Math.round(Number(r.topK || 8)), 1, 50);
  r.minScore = clamp(Number(r.minScore || 0), 0, 5);
  r.indexBodyChars = clamp(Math.round(Number(r.indexBodyChars || 90)), 20, 4000);
  r.maxRepeatReads = clamp(Math.round(Number(r.maxRepeatReads || 3)), 1, 20);
  r.redundancyWindowMin = clamp(Math.round(Number(r.redundancyWindowMin || 30)), 1, 1440);
  r.weightRelevance = clamp(Number(r.weightRelevance === undefined ? 1 : r.weightRelevance), 0, 5);
  r.weightRetention = clamp(Number(r.weightRetention === undefined ? 0.65 : r.weightRetention), 0, 5);
  r.weightImportance = clamp(Number(r.weightImportance === undefined ? 1 : r.weightImportance), 0, 5);
  r.pinnedBoost = clamp(Number(r.pinnedBoost === undefined ? 0.15 : r.pinnedBoost), 0, 3);
  const g = next.guard || (next.guard = {});
  g.contextWarnTokens = clamp(Math.round(Number(g.contextWarnTokens || 120000)), 1000, 2000000);
  g.contextBlockTokens = clamp(Math.round(Number(g.contextBlockTokens || 200000)), g.contextWarnTokens, 4000000);
  g.hitRateFloor = clamp(Number(g.hitRateFloor), 0, 1);
  g.warnScore = clamp(Number(g.warnScore === undefined ? 0.5 : g.warnScore), 0, 1);
  g.blockScore = clamp(Number(g.blockScore === undefined ? 0.75 : g.blockScore), g.warnScore, 1);
  const lc = next.lifecycle || (next.lifecycle = {});
  lc.recycleDays = clamp(Math.round(Number(lc.recycleDays || 30)), 1, 3650);
  const bk = next.backup || (next.backup = {});
  bk.keep = clamp(Math.round(Number(bk.keep || 7)), 1, 100);
  const tk = next.tokens || (next.tokens = {});
  tk.charsPerToken = clamp(Number(tk.charsPerToken || 1.7), 0.5, 10);
  const v = next.vector || (next.vector = {});
  v.enabled = v.enabled === undefined ? true : !!v.enabled;
  v.dims = clamp(Math.round(Number(v.dims || 256)), 32, 1024);
  v.vectorWeight = clamp(Number(v.vectorWeight === undefined ? 0.6 : v.vectorWeight), 0, 3);
  v.vectorFloor = clamp(Number(v.vectorFloor === undefined ? 0.15 : v.vectorFloor), 0, 1);
  v.fpWeight = clamp(Number(v.fpWeight === undefined ? 1.5 : v.fpWeight), 0, 4);
  v.backend = ['sqlite', 'sqlite-vec', 'qdrant'].indexOf(String(v.backend || 'sqlite')) >= 0 ? String(v.backend || 'sqlite') : 'sqlite';
  if (v.provider) v.provider.batchSize = clamp(Math.round(Number(v.provider.batchSize || 32)), 1, 128);
  if (v.deepseek) v.deepseek.maxItemsPerRun = clamp(Math.round(Number(v.deepseek.maxItemsPerRun || 50)), 1, 500);
  const mm = next.multimodal || (next.multimodal = {});
  if (mm.vision) mm.vision.timeoutMs = clamp(Math.round(Number(mm.vision.timeoutMs || 15000)), 1000, 300000);
  store.config = next;
  saveConfig(store.paths.dataDir, next);
  store.shadow.append('config', { version: next.version, config: next });
  return next;
}

// ---------- 汇报文档的回收站（软删除可恢复；彻底删只走 purge） ----------
function reportTrashDir(store) {
  const d = path.join(store.paths.reportsDir, '.trash');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function reportRow(store, input) {
  const o = input || {};
  if (o.id) return store.db.prepare('SELECT * FROM report WHERE id = ?').get(String(o.id)) || null;
  if (o.path) return store.db.prepare('SELECT * FROM report WHERE path = ?').get(String(o.path)) || null;
  return null;
}

export function listReports(store, input) {
  const o = input || {};
  const sql = 'SELECT r.*, p.name AS partition FROM report r JOIN partition p ON p.id = r.partition_id '
    + (o.trash ? 'WHERE r.deleted_at IS NOT NULL ' : 'WHERE r.deleted_at IS NULL ')
    + (o.partitionId ? 'AND r.partition_id = ? ' : '')
    + 'ORDER BY r.created_at DESC LIMIT ?';
  const stmt = store.db.prepare(sql);
  const lim = Math.min(Number(o.limit || 200), 1000);
  const rows = o.partitionId ? stmt.all(o.partitionId, lim) : stmt.all(lim);
  const days = Number((store.config.lifecycle || {}).recycleDays || 30);
  return rows.map(function (r) {
    const out = Object.assign({}, r);
    out.inTrash = !!r.deleted_at;
    if (r.deleted_at) {
      out.expiresAt = Number(r.deleted_at) + days * 86400000;
      out.expired = out.expiresAt < nowMs();
    }
    out.fileExists = !!r.path && fs.existsSync(r.path);
    return out;
  });
}

export function deleteReport(store, input) {
  const db = store.db;
  const row = reportRow(store, input);
  if (!row) throw new Error('unknown report: ' + (input.id || input.path || ''));
  if (row.deleted_at) return { report: row, alreadyDeleted: true, trashPath: row.trash_path };
  const now = nowMs();
  let trashPath = null;
  if (fs.existsSync(row.path)) {
    trashPath = path.join(reportTrashDir(store), now + '-' + path.basename(String(row.path)));
    fs.renameSync(row.path, trashPath);
  }
  db.prepare('UPDATE report SET deleted_at = ?, trash_path = ? WHERE id = ?').run(now, trashPath, row.id);
  const next = db.prepare('SELECT * FROM report WHERE id = ?').get(row.id);
  store.shadow.append('report', next);
  const days = Number((store.config.lifecycle || {}).recycleDays || 30);
  return { report: next, trashPath: trashPath, fileMoved: !!trashPath, restoreUntil: now + days * 86400000 };
}

export function restoreReport(store, input) {
  const db = store.db;
  const row = reportRow(store, input);
  if (!row) throw new Error('unknown report: ' + (input.id || input.path || ''));
  if (!row.deleted_at) return { report: row, alreadyActive: true };
  let restored = false;
  if (row.trash_path && fs.existsSync(row.trash_path)) {
    fs.mkdirSync(path.dirname(String(row.path)), { recursive: true });
    fs.renameSync(row.trash_path, row.path);
    restored = true;
  }
  db.prepare('UPDATE report SET deleted_at = NULL, trash_path = NULL WHERE id = ?').run(row.id);
  const next = db.prepare('SELECT * FROM report WHERE id = ?').get(row.id);
  store.shadow.append('report', next);
  return { report: next, fileRestored: restored, fileExists: fs.existsSync(next.path) };
}

export function purgeReports(store, input) {
  const o = input || {};
  const db = store.db;
  const days = Number(o.olderThanDays === undefined ? (store.config.lifecycle || {}).recycleDays || 30 : o.olderThanDays);
  const cutoff = nowMs() - days * 86400000;
  let rows;
  if (o.id) rows = db.prepare('SELECT * FROM report WHERE id = ? AND deleted_at IS NOT NULL').all(String(o.id));
  else if (o.path) rows = db.prepare('SELECT * FROM report WHERE path = ? AND deleted_at IS NOT NULL').all(String(o.path));
  else rows = db.prepare('SELECT * FROM report WHERE deleted_at IS NOT NULL AND deleted_at <= ?').all(cutoff);
  let files = 0;
  for (const r of rows) {
    for (const p of [r.trash_path, r.path]) {
      if (p && fs.existsSync(p) && String(p).indexOf(store.paths.reportsDir) === 0) {
        try { fs.unlinkSync(p); files += 1; } catch (err) { /* 占用就留给下一轮 */ }
      }
    }
    db.prepare('DELETE FROM report WHERE id = ?').run(r.id);
    store.shadow.append('report_delete', { id: r.id, hard: true, ts: nowMs(), reason: 'purge' });
  }
  return { purged: rows.length, filesRemoved: files, olderThanDays: days };
}
