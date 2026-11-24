import fs from 'node:fs';
import path from 'node:path';
import { nowMs, uid, atomicWrite, deepMerge, saveConfig, listBackups } from './db.mjs';
import { ensurePartition, remember, partitionByName, clamp, archiveTrunk, sweep, trunkSnapshot, retentionOf, mergeSimilar, itemList, listPartitions, hitStats } from './engine.mjs';
import { audit } from './guard.mjs';

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
  const wasOpen = row.status !== 'done' && row.status !== 'aborted';
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
  let trunk = null;
  let swept = null;
  if (o.archive !== false && wasOpen) {
    const part = partitionById(store, row.partition_id);
    try {
      trunk = archiveTrunk(store, { partition: part ? part.name : '', taskId: row.id, title: o.title || row.title, summary: o.summary || row.summary });
    } catch (err) { trunk = { error: String((err && err.message) || err) }; }
    try { swept = sweep(store, { partitionId: row.partition_id }); } catch (err) { swept = { error: String((err && err.message) || err) }; }
  }
  return { task: next, report: report, trunk: trunk, swept: swept };
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
  const inc = Array.isArray(o.include) && o.include.length ? o.include : null;
  const want = function (k) { return !inc || inc.indexOf(k) >= 0; };
  const bundle = { format: 'xiaofeiyu-memory-bundle', version: 1, exportedAt: nowMs(), partitions: [], items: [], tasks: [], reports: [], events: [], guardEvents: [] };
  for (const part of parts) {
    bundle.partitions.push({ id: part.id, name: part.name, title: part.title, description: part.description, created_at: part.created_at });
    if (want('items')) {
      const items = db.prepare("SELECT * FROM item WHERE partition_id = ? AND state != 'deleted' ORDER BY created_at ASC").all(part.id);
      for (const it of items) bundle.items.push(Object.assign({}, it, { partition: part.name }));
    }
    if (want('tasks')) {
      for (const t of db.prepare('SELECT * FROM task WHERE partition_id = ? ORDER BY started_at ASC').all(part.id)) {
        bundle.tasks.push(Object.assign({}, t, { partition: part.name }));
      }
    }
    if (want('reports')) {
      for (const r of db.prepare('SELECT * FROM report WHERE partition_id = ? AND deleted_at IS NULL ORDER BY created_at ASC').all(part.id)) {
        bundle.reports.push(Object.assign({}, r, { partition: part.name, markdown: fs.existsSync(r.path) ? fs.readFileSync(r.path, 'utf8') : '' }));
      }
    }
    if (o.withEvents && want('events')) {
      for (const e of db.prepare('SELECT * FROM recall_event WHERE partition_id = ? ORDER BY ts ASC').all(part.id)) {
        bundle.events.push(Object.assign({}, e, { partition: part.name }));
      }
    }
    if (o.withGuardEvents && want('guardEvents')) {
      for (const g of db.prepare('SELECT * FROM guard_event WHERE partition_id = ? AND deleted_at IS NULL ORDER BY ts ASC').all(part.id)) {
        const g2 = Object.assign({}, g, { partition: part.name });
        g2.reasons = JSON.parse(g.reasons || '[]');
        bundle.guardEvents.push(g2);
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

function esc(text) {
  return String(text === null || text === undefined ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}

// ---- 记忆健康日报：一次生成 markdown，给 CLI / API / 看板共用 ----
export function healthReport(store, input) {
  const o = input || {};
  const db = store.db;
  const now = nowMs();
  const days = Math.max(1, Math.min(365, Number(o.days || 7)));
  const since = now - days * 86400000;
  const cfg = store.config;
  const fTh = Number(cfg.curve.forgetThreshold || 0.25);
  const part = o.partition ? partitionByName(store, o.partition) : null;
  const parts = part ? [part] : listPartitions(store);
  const trunkMin = Number(cfg.curve.trunkImportance || 4);
  const lines = [];
  lines.push('# 小肥鱼记忆健康日报');
  lines.push('');
  lines.push('- 生成时间：' + new Date(now).toISOString().slice(0, 16).replace('T', ' ') + '（近 ' + days + ' 天窗口）');
  lines.push('- 分区数：' + parts.length + (part ? '（只看 ' + part.name + '）' : ''));
  lines.push('');
  const totals = { active: 0, dormant: 0, archived: 0, pinned: 0, trunk: 0, stale: 0, recalls: 0, hits: 0, returned: 0, guardOk: 0, guardWarn: 0, guardBlock: 0 };
  for (const pp of parts) {
    const rows = db.prepare('SELECT * FROM item WHERE partition_id = ? AND deleted_at IS NULL').all(pp.id);
    const byState = { active: 0, dormant: 0, archived: 0 };
    let pinned = 0; let stale = 0; let retSum = 0; let counted = 0;
    for (const r of rows) {
      byState[r.state] = (byState[r.state] || 0) + 1;
      if (r.pinned) pinned += 1;
      const ret = retentionOf(r, now, cfg);
      if (r.state !== 'archived') { retSum += ret; counted += 1; }
      if (!r.pinned && Number(r.importance) < trunkMin && ret < fTh) stale += 1;
    }
    const trunk = trunkSnapshot(store, pp.id);
    const stats = hitStats(store, pp.id, days * 24);
    const g = db.prepare('SELECT level, COUNT(*) AS n FROM guard_event WHERE partition_id = ? AND ts >= ? AND deleted_at IS NULL GROUP BY level').all(pp.id, since);
    const guard = { ok: 0, warn: 0, block: 0 };
    for (const row of g) guard[row.level] = Number(row.n);
    const cap = db.prepare("SELECT COUNT(*) AS n FROM attachment a JOIN item i ON i.id = a.item_id WHERE a.partition_id = ? AND i.deleted_at IS NULL AND (a.caption IS NULL OR a.caption = '')").get(pp.id);
    const avgRet = counted ? retSum / counted : 0;
    lines.push('## ' + String(pp.name || pp.title || pp.id) + (pp.title ? ' · ' + pp.title : ''));
    lines.push('');
    lines.push('- 条目：活跃 ' + (byState.active || 0) + ' · 休眠 ' + (byState.dormant || 0) + ' · 归档 ' + (byState.archived || 0) + ' · 钉住 ' + pinned);
    lines.push('- 平均留存：' + (avgRet * 100).toFixed(1) + '% · 濒临遗忘（非主干）：' + stale + ' 条');
    lines.push('- 近 ' + days + ' 天召回：' + stats.recalls + ' 次 · 命中率 ' + (Number(stats.hitRate || 0) * 100).toFixed(1) + '% · 返回条目 ' + stats.returned);
    lines.push('- 守卫：ok ' + guard.ok + ' · warn ' + guard.warn + ' · block ' + guard.block);
    lines.push('- 主干：' + trunk.length + ' 条' + (trunk.length ? '（最高 importance ' + trunk[0].importance + '，强化系数 ' + trunk[0].boost + '）' : ''));
    lines.push('- 待补描述附件：' + Number(cap.n || 0));
    totals.active += byState.active || 0; totals.dormant += byState.dormant || 0; totals.archived += byState.archived || 0;
    totals.pinned += pinned; totals.trunk += trunk.length; totals.stale += stale;
    totals.recalls += stats.recalls; totals.hits += stats.hits; totals.returned += stats.returned;
    totals.guardOk += guard.ok; totals.guardWarn += guard.warn; totals.guardBlock += guard.block;
    lines.push('');
  }
  const audited = audit(store, { partition: part ? part.name : '' });
  const list = (audited && audited.findings) || [];
  lines.push('## 审查结论');
  lines.push('');
  if (!list.length) lines.push('- 无异常');
  for (const fd of list) lines.push('- [' + String(fd.severity || 'info') + '] ' + String(fd.kind || '') + '：' + String(fd.message || ''));
  lines.push('');
  const hitRate = totals.recalls ? totals.hits / totals.recalls : 0;
  lines.push('## 建议');
  lines.push('');
  if (hitRate < Number((cfg.guard || {}).hitRateFloor || 0.25) && totals.recalls >= 5) lines.push('- 命中率 ' + (hitRate * 100).toFixed(1) + '% 低于阈值，建议收紧召回词或重算向量（mem reindex）');
  if (totals.stale > 0) lines.push('- ' + totals.stale + ' 条记忆濒临遗忘且不是主干，可 mem sweep 或把它们写成一条主干结论');
  if (totals.trunk === 0) lines.push('- 还没有主干记忆，建议 mem summarize 或任务收尾自动归档一次');
  if (totals.guardBlock > 0) lines.push('- 出现 ' + totals.guardBlock + ' 次守卫 block，复盘最近那次为什么上下文爆掉');
  const lastBackup = listBackups(store)[0];
  if (!lastBackup) lines.push('- 还没有备份，建议 mem backup');
  lines.push('');
  const markdown = lines.join('\n');
  let filePath = '';
  try {
    const dir = path.join(String(o.dir || store.paths.dataDir), 'reports');
    fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, stamp(now) + '-健康日报.md');
    atomicWrite(filePath, markdown);
  } catch (err) { filePath = ''; }
  return { markdown: markdown, path: filePath, totals: totals, hitRate: Number(hitRate.toFixed(4)), days: days, partition: part ? part.name : '', findings: list };
}

// ---- 静态 Markdown 站点导出：一份自包含的 html + 每分区 md，可以拷走/托管 ----
export function exportSite(store, input) {
  const o = input || {};
  const db = store.db;
  const now = nowMs();
  const cfg = store.config;
  const parts = o.partition ? [partitionByName(store, o.partition)] : listPartitions(store);
  const stampText = stamp(now);
  const outDir = path.resolve(String(o.dir || path.join(store.paths.dataDir, 'site', stampText)));
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const title = String(o.title || '小肥鱼记忆站点');
  const html = [];
  html.push('<!DOCTYPE html>');
  html.push('<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>' + esc(title) + '</title>');
  html.push('<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#0f1417;color:#e6edf3}');
  html.push('header{padding:24px 32px;border-bottom:1px solid #24313a}h1{margin:0;font-size:22px}main{padding:24px 32px;max-width:1100px}');
  html.push('h2{font-size:17px;margin:28px 0 10px;color:#9fd4c4}table{border-collapse:collapse;width:100%;font-size:13px}');
  html.push('th,td{border-bottom:1px solid #1c262c;padding:6px 8px;text-align:left;vertical-align:top}');
  html.push('th{color:#8b9aa6;font-weight:600}.tag{display:inline-block;padding:1px 6px;border-radius:4px;background:#1c262c;color:#8b9aa6;font-size:11px}');
  html.push('.trunk{color:#e8c07a}.muted{color:#7b8b96}pre{white-space:pre-wrap;background:#141b20;padding:12px;border-radius:8px}</style></head><body>');
  html.push('<header><h1>' + esc(title) + '</h1><div class=\"muted\">导出于 ' + new Date(now).toISOString().slice(0, 16).replace('T', ' ') + ' · 分区 ' + parts.length + ' 个</div></header><main>');
  const summary = [];
  for (const pp of parts) {
    const rows = itemList(store, pp.id, { limit: 2000, includeArchived: true });
    const trunk = trunkSnapshot(store, pp.id);
    html.push('<h2 id=\"p-' + esc(pp.name) + '\">' + esc(pp.title || pp.name) + ' <span class=\"tag\">' + esc(pp.name) + '</span></h2>');
    html.push('<div class=\"muted\">条目 ' + rows.length + ' · 主干 ' + trunk.length + '</div>');
    html.push('<table><thead><tr><th>标题</th><th>类型</th><th>重要度</th><th>留存</th><th>更新时间</th></tr></thead><tbody>');
    for (const it of rows) {
      html.push('<tr><td>' + (it.pinned ? '<span class=\"trunk\">★</span> ' : '') + esc(it.title) + '</td>');
      html.push('<td class=\"muted\">' + esc(it.kind) + '</td><td>' + Number(it.importance || 0) + '</td>');
      html.push('<td>' + (Number(it.retention || 0) * 100).toFixed(0) + '%</td>');
      html.push('<td class=\"muted\">' + new Date(Number(it.updated_at || now)).toISOString().slice(0, 10) + '</td></tr>');
    }
    html.push('</tbody></table>');
    const md = [];
    md.push('# ' + String(pp.title || pp.name));
    md.push('');
    md.push('> 分区 `' + String(pp.name) + '` · 条目 ' + rows.length + ' · 主干 ' + trunk.length);
    md.push('');
    if (trunk.length) {
      md.push('## 主干');
      md.push('');
      for (const t of trunk) md.push('- **' + String(t.title) + '**（重要度 ' + t.importance + '，留存 ' + (Number(t.retention || 0) * 100).toFixed(0) + '%，强化系数 ' + t.boost + '）');
      md.push('');
    }
    md.push('## 全部条目');
    md.push('');
    for (const it of rows) {
      md.push('### ' + String(it.title));
      md.push('');
      md.push('- 类型 ' + it.kind + ' · 重要度 ' + it.importance + ' · 留存 ' + (Number(it.retention || 0) * 100).toFixed(0) + '% · 更新 ' + new Date(Number(it.updated_at || now)).toISOString().slice(0, 10));
      if (it.tags && it.tags.length) md.push('- 标签 ' + it.tags.join(', '));
      md.push('');
      md.push(String(it.body || '').slice(0, 4000));
      md.push('');
    }
    const mdName = 'partition-' + String(pp.name).replace(/[^a-zA-Z0-9_-]+/g, '-') + '.md';
    atomicWrite(path.join(outDir, mdName), md.join('\n'));
    files.push(mdName);
    html.push('<p><a class=\"muted\" href=\"./' + mdName + '\">下载本分区 Markdown</a></p>');
    summary.push({ partition: pp.name, items: rows.length, trunk: trunk.length, file: mdName });
  }
  const reports = db.prepare('SELECT id, title, path, summary, created_at FROM report WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50').all();
  html.push('<h2>最近汇报</h2><table><thead><tr><th>标题</th><th>时间</th><th>摘要</th></tr></thead><tbody>');
  for (const r of reports) html.push('<tr><td>' + esc(r.title) + '</td><td class=\"muted\">' + new Date(Number(r.created_at || now)).toISOString().slice(0, 10) + '</td><td class=\"muted\">' + esc(String(r.summary || '').slice(0, 120)) + '</td></tr>');
  html.push('</tbody></table>');
  html.push('<h2>参数</h2><pre>' + esc(JSON.stringify({ curve: cfg.curve, recall: cfg.recall, vector: cfg.vector && { enabled: cfg.vector.enabled, dims: cfg.vector.dims, vectorWeight: cfg.vector.vectorWeight } }, null, 2)) + '</pre>');
  html.push('</main></body></html>');
  atomicWrite(path.join(outDir, 'index.html'), html.join('\n'));
  files.push('index.html');
  return { dir: outDir, files: files, partitions: summary, reports: reports.length, bytes: fs.statSync(path.join(outDir, 'index.html')).size };
}
