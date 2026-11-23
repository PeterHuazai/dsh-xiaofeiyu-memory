import { nowMs, uid } from './db.mjs';
import { ensurePartition, retentionOf, clamp, hydrate } from './engine.mjs';

function jsonParse(text, fallback) { try { return JSON.parse(text); } catch (err) { return fallback; } }

function windowStats(store, partId, n) {
  const rows = store.db.prepare('SELECT * FROM recall_event WHERE partition_id = ? ORDER BY ts DESC LIMIT ?').all(partId, n);
  let hits = 0, returned = 0, redundant = 0, judged = 0;
  const itemIds = new Set();
  for (const r of rows) {
    if (r.used === null || r.used === undefined) { /* 未反馈：不计入命中率分母 */ }
    else { judged += 1; if (Number(r.used) === 1) hits += 1; }
    returned += Number(r.returned || 0);
    redundant += Number(r.redundant || 0);
    for (const id of jsonParse(r.items, [])) itemIds.add(id);
  }
  return { events: rows.length, judged: judged, hits: hits, returned: returned, redundant: redundant, itemIds: Array.from(itemIds) };
}

function staleShare(store, partId, itemIds, now) {
  if (!itemIds.length) return 0;
  const ph = itemIds.map(function () { return '?'; }).join(',');
  const stmt = store.db.prepare('SELECT id, state, stability, last_access_at, updated_at, created_at FROM item WHERE id IN (' + ph + ')');
  const rows = stmt.all.apply(stmt, itemIds);
  let stale = 0;
  for (const r of rows) {
    const ret = retentionOf(r, now, store.config);
    if (r.state !== 'active' || ret < Number(store.config.curve.forgetThreshold || 0.25)) stale += 1;
  }
  return rows.length ? stale / rows.length : 0;
}

export function checkGuard(store, input) {
  const cfg = store.config.guard;
  const part = ensurePartition(store, { name: input.partition, title: input.partitionTitle });
  const now = nowMs();
  const tokens = Number(input.contextTokens || 0);
  const ratio = Number(store.config.tokens.charsPerToken || 1.7);
  const estTokens = tokens || Math.round(Number(input.chars || 0) / ratio);
  const st = windowStats(store, part.id, Number(cfg.hitRateWindow || 20));
  const ctxPressure = clamp(estTokens / Number(cfg.contextBlockTokens || 200000), 0, 1.2);
  const hitRate = st.judged ? st.hits / st.judged : 1;
  const lowHit = clamp((Number(cfg.hitRateFloor || 0.25) - hitRate) / Math.max(0.01, Number(cfg.hitRateFloor || 0.25)), 0, 1);
  const redundancy = st.events ? clamp(st.redundant / Math.max(1, st.events), 0, 1) : 0;
  const stale = staleShare(store, part.id, st.itemIds.slice(0, 200), now);
  const w = cfg.weights || { context: 0.45, hitRate: 0.25, redundancy: 0.2, stale: 0.1 };
  const score = clamp(Number(w.context) * ctxPressure + Number(w.hitRate) * lowHit + Number(w.redundancy) * redundancy + Number(w.stale) * stale, 0, 1.5);
  let level = score >= Number(cfg.blockScore || 0.75) ? 'block' : (score >= Number(cfg.warnScore || 0.5) ? 'warn' : 'ok');
  // 硬阈值覆盖：上下文体量本身就是一道闸，不靠加权分数也能拦住
  const blockAt = Number(cfg.contextBlockTokens || 200000);
  const warnAt = Number(cfg.contextWarnTokens || 120000);
  if (estTokens >= blockAt) level = 'block';
  else if (estTokens >= warnAt && level === 'ok') level = 'warn';
  const reasons = [];
  if (estTokens >= warnAt && estTokens < blockAt) reasons.push('上下文 ' + estTokens + ' tokens 已越过告警线 ' + warnAt);
  if (ctxPressure >= 0.9) reasons.push('上下文已达 ' + estTokens + ' tokens（阈值 ' + cfg.contextBlockTokens + '），长上下文易漂移');
  if (lowHit > 0.2) reasons.push('近期召回命中率 ' + (hitRate * 100).toFixed(0) + '% 低于下限 ' + (Number(cfg.hitRateFloor) * 100).toFixed(0) + '%');
  if (redundancy > 0.2) reasons.push('重复读取比例 ' + (redundancy * 100).toFixed(0) + '%（窗口 ' + Number(cfg.hitRateWindow) + ' 次召回）');
  if (stale > Number(cfg.staleShareCeiling || 0.5)) reasons.push('召回结果中过时条目占比 ' + (stale * 100).toFixed(0) + '%');
  if (!reasons.length) reasons.push('未发现异常');

  const trunkRows = store.db.prepare("SELECT * FROM item WHERE partition_id = ? AND state = 'active' AND (pinned = 1 OR importance >= ?) ORDER BY importance DESC, last_access_at DESC LIMIT 6")
    .all(part.id, Number(store.config.curve.trunkImportance || 4));
  const trunk = trunkRows.map(function (r) {
    const h = hydrate(r);
    return { id: h.id, title: h.title, kind: h.kind, importance: h.importance, retention: Number(retentionOf(r, now, store.config).toFixed(3)) };
  });
  let action = 'continue';
  let directive = '可以继续，正常召回即可。';
  if (level === 'warn') {
    action = 'consolidate';
    directive = '建议：把当前上下文压成要点再继续；只召回主干记忆（trunk），不要重复读取同一批条目。';
  } else if (level === 'block') {
    action = 'hard-stop';
    directive = '强制：停止长时间上下文推演。先写汇报文档落盘，再只依赖主干记忆继续；新任务另开分区。';
  }
  const id = uid('g');
  const source = guardSource(input.source === undefined ? 'real' : input.source);
  store.db.prepare('INSERT INTO guard_event (id, partition_id, task_id, ts, level, score, reasons, context_tokens, action, model_verdict, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(id, part.id, input.taskId || null, now, level, Number(score.toFixed(4)), JSON.stringify(reasons), estTokens, action, source);
  store.shadow.append('guard_event', store.db.prepare('SELECT * FROM guard_event WHERE id = ?').get(id));
  return {
    id: id,
    partition: part.name,
    source: source,
    level: level,
    score: Number(score.toFixed(4)),
    components: { context: Number(ctxPressure.toFixed(3)), hitRate: Number(hitRate.toFixed(3)), lowHit: Number(lowHit.toFixed(3)), redundancy: Number(redundancy.toFixed(3)), stale: Number(stale.toFixed(3)) },
    metrics: { estTokens: estTokens, events: st.events, hits: st.hits, redundantEvents: st.redundant },
    reasons: reasons,
    action: action,
    directive: directive,
    trunk: trunk,
    thresholds: { warn: Number(cfg.warnScore), block: Number(cfg.blockScore) }
  };
}

const GUARD_SOURCES = { real: 1, simulated: 1 };

export function guardSource(v) {
  const s = String(v || 'real');
  return GUARD_SOURCES[s] ? s : 'real';
}

function guardRow(r) {
  return {
    id: r.id, partition_id: r.partition_id, task_id: r.task_id, ts: r.ts,
    level: r.level, score: r.score, reasons: jsonParse(r.reasons, []),
    context_tokens: r.context_tokens, action: r.action, model_verdict: r.model_verdict,
    source: guardSource(r.source), deleted: !!r.deleted_at, deleted_at: r.deleted_at || null
  };
}

export function listGuardEvents(store, input) {
  const o = input || {};
  const where = [];
  const args = [];
  if (o.partitionId) { where.push('partition_id = ?'); args.push(Number(o.partitionId)); }
  if (o.level && o.level !== 'all') { where.push('level = ?'); args.push(String(o.level)); }
  if (o.source && o.source !== 'all') { where.push('source = ?'); args.push(guardSource(o.source)); }
  if (o.deleted) where.push('deleted_at IS NOT NULL');
  else if (!o.includeDeleted) where.push('deleted_at IS NULL');
  if (o.since) { where.push('ts >= ?'); args.push(Number(o.since)); }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const limit = clamp(Number(o.limit || 40), 1, 500);
  const offset = Math.max(0, Number(o.offset || 0));
  const totalRow = store.db.prepare('SELECT COUNT(*) AS n FROM guard_event' + clause).get.apply(store.db.prepare('SELECT COUNT(*) AS n FROM guard_event' + clause), args);
  const rows = store.db.prepare('SELECT * FROM guard_event' + clause + ' ORDER BY ts DESC LIMIT ? OFFSET ?').all.apply(store.db.prepare('SELECT * FROM guard_event' + clause + ' ORDER BY ts DESC LIMIT ? OFFSET ?'), args.concat([limit, offset]));
  const tally = store.db.prepare('SELECT source, COUNT(*) AS n FROM guard_event' + clause + ' GROUP BY source').all.apply(store.db.prepare('SELECT source, COUNT(*) AS n FROM guard_event' + clause + ' GROUP BY source'), args);
  const bySource = { simulated: 0, real: 0 };
  for (const t of tally) bySource[guardSource(t.source)] = Number(t.n);
  return { events: rows.map(guardRow), total: Number(totalRow.n), limit: limit, offset: offset, bySource: bySource };
}

function shadowDelete(store, id) {
  store.shadow.append('guard_event_delete', { id: id });
}

export function deleteGuardEvents(store, input) {
  const o = input || {};
  const ids = [];
  if (o.id) ids.push(String(o.id));
  for (const x of (Array.isArray(o.ids) ? o.ids : [])) ids.push(String(x));
  let rows = [];
  if (ids.length) {
    const ph = ids.map(function () { return '?'; }).join(',');
    const stmt = store.db.prepare('SELECT * FROM guard_event WHERE id IN (' + ph + ')');
    rows = stmt.all.apply(stmt, ids);
  } else if (o.onlySimulated) {
    rows = store.db.prepare("SELECT * FROM guard_event WHERE source = 'simulated' AND deleted_at IS NULL").all();
  } else if (o.all) {
    rows = store.db.prepare('SELECT * FROM guard_event WHERE deleted_at IS NULL').all();
  }
  if (!rows.length) return { deleted: 0, hard: !!o.hard, ids: [] };
  const now = nowMs();
  const hit = rows.map(function (r) { return r.id; });
  if (o.hard) {
    const ph = hit.map(function () { return '?'; }).join(',');
    const del = store.db.prepare('DELETE FROM guard_event WHERE id IN (' + ph + ')');
    del.run.apply(del, hit);
    for (const id of hit) shadowDelete(store, id);
  } else {
    const ph = hit.map(function () { return '?'; }).join(',');
    const upd = store.db.prepare('UPDATE guard_event SET deleted_at = ? WHERE id IN (' + ph + ')');
    upd.run.apply(upd, [now].concat(hit));
    for (const r of rows) {
      const fresh = store.db.prepare('SELECT * FROM guard_event WHERE id = ?').get(r.id);
      if (fresh) store.shadow.append('guard_event', fresh);
    }
  }
  return { deleted: hit.length, hard: !!o.hard, ids: hit, simulated: rows.filter(function (r) { return guardSource(r.source) === 'simulated'; }).length };
}

export function restoreGuardEvents(store, input) {
  const o = input || {};
  const ids = [];
  if (o.id) ids.push(String(o.id));
  for (const x of (Array.isArray(o.ids) ? o.ids : [])) ids.push(String(x));
  if (!ids.length) return { restored: 0, ids: [] };
  const ph = ids.map(function () { return '?'; }).join(',');
  const stmt = store.db.prepare('SELECT id FROM guard_event WHERE id IN (' + ph + ') AND deleted_at IS NOT NULL');
  const rows = stmt.all.apply(stmt, ids);
  const hit = rows.map(function (r) { return r.id; });
  if (hit.length) {
    const ph2 = hit.map(function () { return '?'; }).join(',');
    const upd = store.db.prepare('UPDATE guard_event SET deleted_at = NULL WHERE id IN (' + ph2 + ')');
    upd.run.apply(upd, hit);
    for (const id of hit) {
      const fresh = store.db.prepare('SELECT * FROM guard_event WHERE id = ?').get(id);
      if (fresh) store.shadow.append('guard_event', fresh);
    }
  }
  return { restored: hit.length, ids: hit };
}

export function purgeGuardEvents(store, input) {
  const o = input || {};
  const days = Number(o.olderThanDays === undefined ? 30 : o.olderThanDays);
  const cutoff = nowMs() - Math.max(0, days) * 86400000;
  const rows = store.db.prepare('SELECT id FROM guard_event WHERE deleted_at IS NOT NULL AND deleted_at <= ?').all(cutoff);
  const hit = rows.map(function (r) { return r.id; });
  if (hit.length) {
    const ph = hit.map(function () { return '?'; }).join(',');
    const del = store.db.prepare('DELETE FROM guard_event WHERE id IN (' + ph + ')');
    del.run.apply(del, hit);
    for (const id of hit) shadowDelete(store, id);
  }
  return { purged: hit.length, olderThanDays: days, cutoff: cutoff };
}

export async function modelSelfCheck(store, result) {
  const mc = (store.config.guard && store.config.guard.modelCheck) || {};
  if (!mc.enabled || !mc.endpoint) return { skipped: true, reason: 'modelCheck disabled' };
  const key = process.env[mc.apiKeyEnv || 'MEMORY_GUARD_API_KEY'];
  if (!key) return { skipped: true, reason: 'missing api key env ' + (mc.apiKeyEnv || 'MEMORY_GUARD_API_KEY') };
  const body = {
    model: mc.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You audit an AI agent memory gate. Reply with strict JSON: {"hallucinationRisk":0-1,"verdict":"ok|warn|block","note":"<=120 chars"}' },
      { role: 'user', content: JSON.stringify({ level: result.level, score: result.score, reasons: result.reasons, metrics: result.metrics }) }
    ],
    temperature: 0
  };
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, Number(mc.timeoutMs || 8000));
  try {
    const res = await fetch(mc.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    clearTimeout(timer);
    store.db.prepare('UPDATE guard_event SET model_verdict = ? WHERE id = ?').run(text.slice(0, 800), result.id);
    return { ok: res.ok, status: res.status, verdict: text.slice(0, 800) };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.message };
  }
}

export function audit(store, input) {
  const o = input || {};
  const now = nowMs();
  const hours = Number(o.hours || 24 * 7);
  const findings = [];
  const parts = o.partition
    ? store.db.prepare('SELECT * FROM partition WHERE name = ?').all(String(o.partition))
    : store.db.prepare('SELECT * FROM partition').all();
  for (const p of parts) {
    const rows = store.db.prepare("SELECT * FROM item WHERE partition_id = ? AND state != 'archived'").all(p.id);
    let stale = 0, trunk = 0;
    for (const r of rows) {
      const ret = retentionOf(r, now, store.config);
      if (r.pinned || r.importance >= Number(store.config.curve.trunkImportance || 4)) trunk += 1;
      else if (ret < Number(store.config.curve.forgetThreshold || 0.25)) stale += 1;
    }
    if (stale > 0) findings.push({ severity: 'info', partition: p.name, code: 'STALE_ITEMS', message: stale + ' 条记忆已低于遗忘阈值，可执行 sweep 让其休眠', suggestion: 'mem sweep --partition ' + p.name });
    if (rows.length > 400) findings.push({ severity: 'warn', partition: p.name, code: 'PARTITION_BLOAT', message: p.name + ' 条目数 ' + rows.length + '，检索精度会下降', suggestion: '导出归档或收敛为一个主干摘要条目' });
    const st = windowStats(store, p.id, Number(store.config.guard.hitRateWindow || 20));
    if (st.events >= 5) {
      const rate = st.hits / st.events;
      if (rate < Number(store.config.guard.hitRateFloor || 0.25)) findings.push({ severity: 'warn', partition: p.name, code: 'LOW_HIT_RATE', message: '近 ' + st.events + ' 次召回命中率 ' + (rate * 100).toFixed(0) + '%', suggestion: '细化查询词，或把高频主干设为 pinned' });
      if (st.redundant > st.events * 0.3) findings.push({ severity: 'warn', partition: p.name, code: 'REDUNDANT_READS', message: '重复读取比例偏高（' + st.redundant + '/' + st.events + '）', suggestion: '提高 recall.redundancyWindowMin 或减少同批重复召回' });
    }
    if (!trunk && rows.length > 3) findings.push({ severity: 'info', partition: p.name, code: 'NO_TRUNK', message: '没有主干记忆（pinned 或 importance>=4）', suggestion: '给关键结论标 pinned，保证遗忘后仍可召回' });
    const capMissing = store.db.prepare("SELECT COUNT(*) AS n FROM attachment a JOIN item i ON i.id = a.item_id WHERE a.partition_id = ? AND i.state != 'deleted' AND (a.caption IS NULL OR a.caption = '')").get(p.id);
    if (Number(capMissing.n) > 0) findings.push({ severity: 'info', partition: p.name, code: 'CAPTION_MISSING', message: Number(capMissing.n) + ' 个附件还没有文字描述，图片无法被召回命中', suggestion: 'mem caption --partition ' + p.name + '（或看板「批量描述」）' });
    const openOld = store.db.prepare("SELECT COUNT(*) AS n FROM task WHERE partition_id = ? AND status = 'open' AND started_at < ?").get(p.id, now - 24 * 3600000);
    if (Number(openOld.n) > 0) findings.push({ severity: 'warn', partition: p.name, code: 'OPEN_TASK_LEAK', message: Number(openOld.n) + ' 个任务开启超过 24 小时未关闭/未汇报', suggestion: 'mem task end --id <taskId> 并写汇报' });
  }
  const silent = store.db.prepare('SELECT MAX(ts) AS ts FROM recall_event').get();
  if (!silent || !silent.ts) findings.push({ severity: 'info', partition: '*', code: 'NO_RECALLS', message: '还没有任何召回记录，命中率无法评估', suggestion: '先执行一次 mem recall' });
  const lastBackup = backupAge(store);
  if (lastBackup.days > 3) findings.push({ severity: 'warn', partition: '*', code: 'BACKUP_STALE', message: '最近备份距今 ' + lastBackup.days.toFixed(0) + ' 天', suggestion: 'mem backup' });
  return { generatedAt: now, hours: hours, findings: findings, severity: findings.some(function (f) { return f.severity === 'warn'; }) ? 'warn' : 'ok' };
}

function backupAge(store) {
  const fs = require_fs();
  const dir = store.paths.backupDir;
  if (!fs.existsSync(dir)) return { days: 999, last: null };
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.db'); });
  if (!files.length) return { days: 999, last: null };
  let newest = 0, name = '';
  for (const f of files) { const st = fs.statSync(dir + '/' + f); if (st.mtimeMs > newest) { newest = st.mtimeMs; name = f; } }
  return { days: (Date.now() - newest) / 86400000, last: name };
}

import fsMod from 'node:fs';
function require_fs() { return fsMod; }
