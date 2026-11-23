import { nowMs, uid, hashOf } from './db.mjs';
import * as vector from './vector.mjs';

export const KINDS = ['fact', 'decision', 'constraint', 'preference', 'task', 'report', 'note', 'trunk'];

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map(function (t) { return String(t).trim(); }).filter(Boolean);
  if (!raw) return [];
  return String(raw).split(/[,，;；\s]+/).map(function (t) { return t.trim(); }).filter(Boolean);
}

function jsonParse(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try { return JSON.parse(text); } catch (err) { return fallback; }
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function ensurePartition(store, input) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('partition name required');
  const db = store.db;
  const found = db.prepare('SELECT * FROM partition WHERE name = ?').get(name);
  if (found) {
    if (input.title && input.title !== found.title) {
      db.prepare('UPDATE partition SET title = ? WHERE id = ?').run(String(input.title), found.id);
      const row = db.prepare('SELECT * FROM partition WHERE id = ?').get(found.id);
      store.shadow.append('partition', row);
      return row;
    }
    return found;
  }
  const now = nowMs();
  const info = db.prepare('INSERT INTO partition (name, title, description, created_at, archived) VALUES (?, ?, ?, ?, 0)')
    .run(name, String(input.title || name), String(input.description || ''), now);
  const row = db.prepare('SELECT * FROM partition WHERE id = ?').get(info.lastInsertRowid);
  store.shadow.append('partition', row);
  return row;
}

export function listPartitions(store) {
  return store.db.prepare('SELECT * FROM partition ORDER BY archived ASC, id ASC').all();
}

export function partitionByName(store, name) {
  const row = store.db.prepare('SELECT * FROM partition WHERE name = ?').get(String(name || ''));
  if (!row) throw new Error('unknown partition: ' + name);
  return row;
}

// ---- tokenization: latin words + CJK bigrams (works offline, no deps) ----
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const latin = s.match(/[a-z0-9_\-\.]{2,}/g);
  if (latin) for (const w of latin) out.push(w);
  const cjkRuns = s.match(/[\u4e00-\u9fff]+/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      if (run.length === 1) { out.push(run); continue; }
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

export function etaMs(chars, cfg) {
  const ratio = Number((cfg && cfg.tokens && cfg.tokens.charsPerToken) || 1.7);
  return Math.round(Number(chars || 0) / ratio);
}

// ---- forgetting curve ----
export function retentionOf(item, now, cfg) {
  const c = (cfg && cfg.curve) || {};
  const s = Math.max(0.05, Number(item.stability || c.stabilityBaseDays || 7));
  const last = Number(item.last_access_at || item.updated_at || item.created_at || now);
  const days = Math.max(0, (now - last) / 86400000);
  return Math.exp(-days / s);
}

export function projectCurve(item, cfg, days) {
  const c = (cfg && cfg.curve) || {};
  const span = Number(days || c.displayDays || 120);
  const s = Math.max(0.05, Number(item.stability || c.stabilityBaseDays || 7));
  const last = Number(item.last_access_at || item.updated_at || item.created_at || nowMs());
  const pts = [];
  for (let d = 0; d <= span; d += Math.max(1, Math.round(span / 60))) {
    const dt = (nowMs() - last) / 86400000 + d;
    pts.push({ day: d, retention: Math.exp(-dt / s) });
  }
  return { item: item.id, stability: s, points: pts };
}

export function remember(store, input) {
  const db = store.db;
  const part = ensurePartition(store, { name: input.partition || input.partitionName, title: input.partitionTitle });
  const title = String(input.title || input.body || '').split('\n')[0].slice(0, 120);
  if (!title) throw new Error('title or body required');
  const body = String(input.body || '');
  const hash = hashOf(title + '\u0000' + body);
  const dup = db.prepare('SELECT * FROM item WHERE partition_id = ? AND content_hash = ?').get(part.id, hash);
  if (dup) {
    db.prepare('UPDATE item SET updated_at = ?, access_count = access_count + 1, last_access_at = ? WHERE id = ?')
      .run(nowMs(), nowMs(), dup.id);
    const row = db.prepare('SELECT * FROM item WHERE id = ?').get(dup.id);
    store.shadow.append('item', row);
    return { item: hydrate(row), deduped: true };
  }
  const cfg = store.config;
  const id = uid('m');
  const now = nowMs();
  const importance = clamp(Number(input.importance || 3), 1, 5);
  const pinned = input.pinned ? 1 : 0;
  const kind = KINDS.indexOf(String(input.kind || 'fact')) >= 0 ? String(input.kind || 'fact') : 'fact';
  const tags = JSON.stringify(parseTags(input.tags));
  const stability = Number(cfg.curve.stabilityBaseDays || 7) * (1 + (importance - 3) * 0.15);
  db.prepare('INSERT INTO item (id, partition_id, kind, title, body, tags, importance, pinned, state, stability, created_at, updated_at, last_access_at, access_count, hit_count, redundant_reads, content_hash, source, task_id, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, NULL)')
    .run(id, part.id, kind, title, body, tags, importance, pinned, 'active', stability, now, now, now, hash, String(input.source || ''), input.taskId || null);
  const row = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
  store.shadow.append('item', row);
  const fresh = hydrate(row);
  // 写入即建向量：ANN 预筛不会漏掉刚记下的条目（失败不影响写入）
  try { vector.itemVector(store, fresh); } catch (err) { /* 向量层是缓存，允许失败 */ }
  return { item: fresh, deduped: false };
}

export function hydrate(row) {
  const o = Object.assign({}, row);
  o.tags = jsonParse(row.tags, []);
  o.pinned = !!row.pinned;
  return o;
}

function candidateItems(store, partId, includeDormant, ids) {
  const base = includeDormant
    ? "SELECT * FROM item WHERE partition_id = ? AND state NOT IN ('archived','deleted') AND superseded_by IS NULL"
    : "SELECT * FROM item WHERE partition_id = ? AND state = 'active' AND superseded_by IS NULL AND deleted_at IS NULL";
  if (ids && ids.length) {
    const list = ids.slice(0, 500);
    const holes = list.map(function () { return '?'; }).join(',');
    return store.db.prepare(base + ' AND id IN (' + holes + ')').all(partId, ...list);
  }
  return store.db.prepare(base).all(partId);
}

// 没有当前模型向量的条目：绕过 ANN 直接进候选，避免新条目/换模型后条目被近似检索饿死
function unindexedItems(store, partId, includeDormant, model) {
  const base = includeDormant
    ? "SELECT * FROM item WHERE partition_id = ? AND state NOT IN ('archived','deleted') AND superseded_by IS NULL"
    : "SELECT * FROM item WHERE partition_id = ? AND state = 'active' AND superseded_by IS NULL AND deleted_at IS NULL";
  return store.db.prepare(base + ' AND id NOT IN (SELECT item_id FROM item_vector WHERE partition_id = ? AND model = ?)')
    .all(partId, partId, String(model || ''));
}

// 主干候选：钉住的 + 重要度达标的，永远绕开 ANN 预筛，保证「该记得的」不会被近似检索漏掉
function trunkItems(store, partId, includeDormant) {
  const minImp = Number((store.config.curve || {}).trunkImportance || 4);
  const base = includeDormant
    ? "SELECT * FROM item WHERE partition_id = ? AND (pinned = 1 OR importance >= ?) AND state NOT IN ('archived','deleted') AND superseded_by IS NULL"
    : "SELECT * FROM item WHERE partition_id = ? AND (pinned = 1 OR importance >= ?) AND state = 'active' AND superseded_by IS NULL AND deleted_at IS NULL";
  return store.db.prepare(base).all(partId, minImp);
}

// 附件的文字描述一起参与检索：图片不必真的塞进上下文，描述就够命中了（省 token）
function attachCaptionText(store, partId, items) {
  if (!items.length) return;
  const rows = store.db.prepare("SELECT item_id, caption FROM attachment WHERE partition_id = ? AND caption != ''").all(partId);
  if (!rows.length) return;
  const map = new Map();
  for (const r of rows) map.set(r.item_id, (map.get(r.item_id) || '') + ' ' + r.caption);
  for (const it of items) it.caption_text = String(map.get(it.id) || '').trim();
}

function idfMap(items) {
  const N = Math.max(1, items.length);
  const df = new Map();
  const docs = items.map(function (it) {
    const toks = new Set(tokenize(it.title + ' ' + it.body + ' ' + (jsonParse(it.tags, []).join(' ')) + ' ' + String(it.caption_text || '')));
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
    return { item: it, toks: toks };
  });
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + N / d));
  return { docs: docs, idf: idf };
}

export function scoreRelevance(query, docs, idf, cfg) {
  const qToks = tokenize(query);
  if (!qToks.length) return docs.map(function () { return 0; });
  const qSet = new Set(qToks);
  let qWeight = 0;
  for (const t of qSet) qWeight += idf.get(t) || Math.log(2);
  if (qWeight <= 0) qWeight = 1;
  return docs.map(function (d) {
    let hit = 0;
    for (const t of qSet) if (d.toks.has(t)) hit += idf.get(t) || Math.log(2);
    return hit / qWeight;
  });
}

function importanceFactor(importance, cfg) {
  const w = Number((cfg.recall && cfg.recall.weightImportance) || 1);
  return 0.85 + 0.075 * (Number(importance || 3) - 1) * w;
}

export function recall(store, input) {
  const started = nowMs();
  const db = store.db;
  const part = ensurePartition(store, { name: input.partition || input.partitionName, title: input.partitionTitle });
  const cfg = store.config;
  const includeDormant = input.includeDormant === undefined ? !!cfg.recall.includeDormant : !!input.includeDormant;
  const query = String(input.query || '').trim();
  const limit = clamp(Number(input.limit || cfg.recall.topK || 8), 1, 50);
  const vcfg = vector.vectorCfg(store);
  const qv = (query && vcfg.enabled) ? vector.queryVector(store, query, input.queryVector) : null;
  let annUsed = null;
  let items = candidateItems(store, part.id, includeDormant);
  if (qv) {
    // sqlite-vec 在用时先用 ANN 取候选，再并上主干：省掉全表精算，但主干不允许被近似检索漏掉
    const annIds = vector.annCandidates(store, part.id, qv, Math.max(64, limit * 10));
    if (annIds && annIds.length) {
      const near = candidateItems(store, part.id, includeDormant, annIds);
      const trunk = trunkItems(store, part.id, includeDormant);
      const seen = new Set();
      items = [];
      for (const it of near.concat(trunk)) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
      for (const it of unindexedItems(store, part.id, includeDormant, qv.model)) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
      annUsed = annIds.length;
      if (!items.length) { items = candidateItems(store, part.id, includeDormant); annUsed = null; }
    }
  }
  attachCaptionText(store, part.id, items);
  const now = nowMs();
  let ranked = [];
  if (!query) {
    ranked = items.map(function (it) {
      const r = retentionOf(it, now, cfg);
      return { item: it, relevance: 1, retention: r, score: 0.5 * r + (it.pinned ? 0.3 : 0) + Number(it.importance) * 0.02 };
    });
  } else {
    const idx = idfMap(items);
    const rel = scoreRelevance(query, idx.docs, idx.idf, cfg);
    ranked = idx.docs.map(function (d, i) {
      const r = retentionOf(d.item, now, cfg);
      let cos = 0;
      if (qv) {
        const iv = vector.itemVector(store, d.item, { readOnly: !!input.noVectorWrite });
        if (iv && iv.model === qv.model) cos = vector.cosine(qv.vec, iv.vec);
      }
      const kw = rel[i] * Number(cfg.recall.weightRelevance || 1);
      const blended = kw + (vcfg.enabled ? vcfg.vectorWeight * Math.max(0, cos) : 0);
      const score = blended *
        (0.35 + Number(cfg.recall.weightRetention || 0.65) * r) *
        importanceFactor(d.item.importance, cfg) + (d.item.pinned ? Number(cfg.recall.pinnedBoost || 0) : 0);
      return { item: d.item, relevance: rel[i], retention: r, score: score, cos: cos, vectorModel: qv ? qv.model : null };
    }).filter(function (x) {
      if (x.relevance > 0) return true;
      return vector.vectorCfg(store).vectorWeight > 0 && x.cos >= vector.vectorCfg(store).vectorFloor;
    });
  }
  ranked.sort(function (a, b) { return b.score - a.score; });
  const chosen = ranked.filter(function (x) { return x.score >= Number(cfg.recall.minScore || 0); }).slice(0, limit);

  // redundancy guard: same item recalled too often inside the window
  const windowStart = now - Number(cfg.recall.redundancyWindowMin || 30) * 60000;
  const recent = db.prepare('SELECT items FROM recall_event WHERE partition_id = ? AND ts >= ? ORDER BY ts DESC').all(part.id, windowStart);
  const repeat = new Map();
  for (const ev of recent) for (const id of jsonParse(ev.items, [])) repeat.set(id, (repeat.get(id) || 0) + 1);
  let redundantCount = 0;
  const detail = String(input.detail || cfg.recall.detail || 'index');
  const bodyLimit = Number(cfg.recall.indexBodyChars || 90);
  const out = chosen.map(function (x) {
    const seen = repeat.get(x.item.id) || 0;
    const redundant = seen >= Number(cfg.recall.maxRepeatReads || 3);
    if (redundant) redundantCount += 1;
    const useFull = detail === 'full' || (detail === 'auto' && !redundant);
    const rawBody = redundant ? '' : String(x.item.body || '');
    const body = useFull ? rawBody : rawBody.slice(0, bodyLimit) + (rawBody.length > bodyLimit ? '…' : '');
    return {
      id: x.item.id,
      title: x.item.title,
      body: body,
      bodyTruncated: !useFull && rawBody.length > bodyLimit,
      detail: useFull ? 'full' : 'index',
      kind: x.item.kind,
      tags: jsonParse(x.item.tags, []),
      importance: x.item.importance,
      pinned: !!x.item.pinned,
      state: x.item.state,
      score: Number(x.score.toFixed(4)),
      relevance: Number(x.relevance.toFixed(4)),
      cos: Number(Number(x.cos || 0).toFixed(4)),
      retention: Number(x.retention.toFixed(4)),
      stability: Number(x.item.stability.toFixed(2)),
      redundant: redundant,
      repeatReads: seen,
      captions: String(x.item.caption_text || '').slice(0, 200)
    };
  });

  const eventId = uid('r');
  const latency = nowMs() - started;
  const topScore = out.length ? out[0].score : 0;
  db.prepare('INSERT INTO recall_event (id, partition_id, task_id, session_id, query, ts, returned, used, top_score, items, redundant, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)')
    .run(eventId, part.id, input.taskId || null, input.sessionId || null, query, now, out.length, topScore, JSON.stringify(out.map(function (o) { return o.id; })), redundantCount > 0 ? 1 : 0, latency);
  const evRow = db.prepare('SELECT * FROM recall_event WHERE id = ?').get(eventId);
  store.shadow.append('recall_event', evRow);

  // touches: reading refreshes stability a little, even without feedback
  const touch = db.prepare('UPDATE item SET access_count = access_count + 1, last_access_at = ?, stability = MIN(?, stability * (1 + ?)), redundant_reads = redundant_reads + ? WHERE id = ?');
  const maxS = Number(cfg.curve.maxStabilityDays || 3650);
  for (const o of out) {
    const grow = Number(cfg.curve.readGrowth || 0.12) * (o.redundant ? 0 : 1);
    touch.run(now, maxS, grow, o.redundant ? 1 : 0, o.id);
    const row = db.prepare('SELECT * FROM item WHERE id = ?').get(o.id);
    store.shadow.append('item', row);
  }

  return {
    eventId: eventId,
    partition: part.name,
    query: query,
    detail: detail,
    items: out,
    tookMs: latency,
    redundant: redundantCount,
    candidates: items.length,
    annUsed: annUsed,
    guard: null
  };
}

export function feedback(store, input) {
  const db = store.db;
  const ev = db.prepare('SELECT * FROM recall_event WHERE id = ?').get(String(input.eventId || ''));
  if (!ev) throw new Error('unknown recall event: ' + input.eventId);
  const used = input.used === false || input.used === 0 ? 0 : 1;
  db.prepare('UPDATE recall_event SET used = ? WHERE id = ?').run(used, ev.id);
  store.shadow.append('recall_event', db.prepare('SELECT * FROM recall_event WHERE id = ?').get(ev.id));
  const cfg = store.config;
  const maxS = Number(cfg.curve.maxStabilityDays || 3650);
  const ids = jsonParse(ev.items, []);
  for (const id of ids) {
    if (used) {
      db.prepare('UPDATE item SET hit_count = hit_count + 1, last_access_at = ?, stability = MIN(?, stability * (1 + ?)) WHERE id = ?')
        .run(nowMs(), maxS, Number(cfg.curve.stabilityGrowth || 0.6), id);
    } else {
      db.prepare('UPDATE item SET stability = MAX(0.5, stability * 0.75) WHERE id = ?').run(id);
    }
    store.shadow.append('item', db.prepare('SELECT * FROM item WHERE id = ?').get(id));
  }
  return { eventId: ev.id, used: used, items: ids.length, affected: ids.length };
}

export function sweep(store, opts) {
  const cfg = store.config;
  const now = nowMs();
  const rows = store.db.prepare("SELECT * FROM item WHERE state != 'archived'").all();
  const trunk = Number(cfg.curve.trunkImportance || 4);
  const fTh = Number(cfg.curve.forgetThreshold || 0.25);
  const aTh = Number(cfg.curve.archiveThreshold || 0.02);
  const changed = [];
  for (const it of rows) {
    const r = retentionOf(it, now, cfg);
    if (it.pinned || Number(it.importance) >= trunk) continue;
    let next = it.state;
    if (r < aTh) next = 'archived';
    else if (r < fTh) next = 'dormant';
    else next = 'active';
    if (next !== it.state) {
      store.db.prepare('UPDATE item SET state = ? WHERE id = ?').run(next, it.id);
      const row = store.db.prepare('SELECT * FROM item WHERE id = ?').get(it.id);
      store.shadow.append('item', row);
      changed.push({ id: it.id, title: it.title, from: it.state, to: next, retention: Number(r.toFixed(3)) });
    }
  }
  return { scanned: rows.length, changed: changed };
}

export function hitStats(store, partId, hours) {
  const db = store.db;
  const since = nowMs() - Number(hours || 24) * 3600000;
  const where = partId ? 'WHERE partition_id = ? AND ts >= ?' : 'WHERE ts >= ?';
  const args = partId ? [partId, since] : [since];
  const stmt = db.prepare('SELECT COUNT(*) AS recalls, SUM(COALESCE(used, 0)) AS hits, SUM(returned) AS returned, SUM(redundant) AS redundant FROM recall_event ' + where);
  const row = stmt.get.apply(stmt, args);
  const recalls = Number(row.recalls || 0);
  const hits = Number(row.hits || 0);
  return { windowHours: Number(hours || 24), recalls: recalls, hits: hits, returned: Number(row.returned || 0), redundant: Number(row.redundant || 0), hitRate: recalls ? Number((hits / recalls).toFixed(4)) : 0 };
}

export function overview(store) {
  const db = store.db;
  const cfg = store.config;
  const now = nowMs();
  const parts = listPartitions(store);
  const out = parts.map(function (p) {
    const counts = db.prepare('SELECT state, COUNT(*) AS n FROM item WHERE partition_id = ? GROUP BY state').all(p.id);
    const byState = { active: 0, dormant: 0, archived: 0 };
    for (const c of counts) byState[c.state] = Number(c.n);
    const rows = db.prepare('SELECT * FROM item WHERE partition_id = ? AND state != ' + "'archived'").all(p.id);
    let retSum = 0;
    for (const r of rows) retSum += retentionOf(r, now, cfg);
    const pinned = db.prepare('SELECT COUNT(*) AS n FROM item WHERE partition_id = ? AND pinned = 1').get(p.id);
    return {
      id: p.id,
      name: p.name,
      title: p.title,
      description: p.description,
      archived: !!p.archived,
      items: byState,
      total: byState.active + byState.dormant + byState.archived,
      pinned: Number(pinned.n || 0),
      avgRetention: rows.length ? Number((retSum / rows.length).toFixed(4)) : 0,
      hit24h: hitStats(store, p.id, 24),
      hit7d: hitStats(store, p.id, 24 * 7),
      lastRecall: db.prepare('SELECT ts, query FROM recall_event WHERE partition_id = ? ORDER BY ts DESC LIMIT 1').get(p.id) || null,
      openTasks: Number((db.prepare("SELECT COUNT(*) AS n FROM task WHERE partition_id = ? AND status = 'open'").get(p.id)).n || 0)
    };
  });
  const totals = db.prepare("SELECT COUNT(*) AS n FROM item WHERE state = 'active'").get();
  const dormant = db.prepare("SELECT COUNT(*) AS n FROM item WHERE state = 'dormant'").get();
  const ev = db.prepare('SELECT COUNT(*) AS n FROM recall_event').get();
  const guards = db.prepare("SELECT level, COUNT(*) AS n FROM guard_event GROUP BY level").all();
  const guardMap = { info: 0, warn: 0, block: 0 };
  for (const g of guards) guardMap[g.level] = Number(g.n);
  const shadow = store.shadow.size();
  let dbBytes = 0;
  try { dbBytes = (require_fs()).statSync(store.paths.dbPath).size; } catch (err) { dbBytes = 0; }
  return {
    generatedAt: now,
    config: cfg,
    partitions: out,
    totals: {
      active: Number(totals.n || 0),
      dormant: Number(dormant.n || 0),
      partitions: parts.length,
      recalls: Number(ev.n || 0),
      guard: guardMap
    },
    hit24h: hitStats(store, null, 24),
    storage: { dbBytes: dbBytes, shadow: shadow, backups: 0 },
    curve: projectCurve({ id: 'baseline', stability: Number(cfg.curve.stabilityBaseDays || 7), last_access_at: now }, cfg, Number(cfg.curve.displayDays || 120))
  };
}

export function timeline(store, partId, days) {
  const span = Number(days || 14);
  const now = nowMs();
  const out = [];
  for (let i = span - 1; i >= 0; i--) {
    const start = now - i * 86400000;
    const d = new Date(start);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const row = store.db.prepare('SELECT COUNT(*) AS n, SUM(COALESCE(used,0)) AS hits FROM recall_event WHERE ts >= ? AND ts < ? AND (? IS NULL OR partition_id = ?)')
      .get(start - 86400000, start, partId || null, partId || null);
    out.push({ day: key, ts: start, recalls: Number(row.n || 0), hits: Number(row.hits || 0) });
  }
  return out;
}


// ---------- 单条读取 / 删除 / 回收站 ----------
export function getItem(store, id, opts) {
  const o = opts || {};
  const row = store.db.prepare('SELECT * FROM item WHERE id = ?').get(String(id || ''));
  if (!row) throw new Error('unknown item: ' + id);
  const out = hydrate(row);
  out.retention = Number(retentionOf(row, nowMs(), store.config).toFixed(4));
  out.attachments = listAttachments(store, row.id);
  out.curve = projectCurve(row, store.config, Number(o.days || store.config.curve.displayDays || 120));
  out.partition = store.db.prepare('SELECT name, title FROM partition WHERE id = ?').get(row.partition_id) || null;
  out.events = store.db.prepare('SELECT id, ts, query, used FROM recall_event WHERE items LIKE ? ORDER BY ts DESC LIMIT 20').all('%' + row.id + '%');
  return out;
}

export function deleteItem(store, input) {
  const db = store.db;
  const row = db.prepare('SELECT * FROM item WHERE id = ?').get(String(input.id || ''));
  if (!row) throw new Error('unknown item: ' + input.id);
  const now = nowMs();
  if (input.hard) {
    db.prepare('DELETE FROM item WHERE id = ?').run(row.id);
    vector.annDrop(store, row.id);
    store.shadow.append('item_delete', { id: row.id, hard: true, ts: now, reason: String(input.reason || '') });
    return { id: row.id, hard: true, deleted: true };
  }
  db.prepare("UPDATE item SET state = 'deleted', deleted_at = ?, delete_reason = ?, updated_at = ? WHERE id = ?")
    .run(now, String(input.reason || ''), now, row.id);
  const next = db.prepare('SELECT * FROM item WHERE id = ?').get(row.id);
  store.shadow.append('item', next);
  return { id: row.id, hard: false, state: next.state, deletedAt: now, recycleUntil: now + Number(store.config.lifecycle.recycleDays || 30) * 86400000 };
}

export function restoreItem(store, id) {
  const db = store.db;
  const row = db.prepare('SELECT * FROM item WHERE id = ?').get(String(id || ''));
  if (!row) throw new Error('unknown item: ' + id);
  db.prepare("UPDATE item SET state = 'active', deleted_at = NULL, delete_reason = NULL, last_access_at = ?, updated_at = ? WHERE id = ?")
    .run(nowMs(), nowMs(), row.id);
  const next = db.prepare('SELECT * FROM item WHERE id = ?').get(row.id);
  store.shadow.append('item', next);
  return hydrate(next);
}

export function listRecycle(store, partId) {
  const rows = partId
    ? store.db.prepare("SELECT * FROM item WHERE state = 'deleted' AND partition_id = ? ORDER BY deleted_at DESC").all(partId)
    : store.db.prepare("SELECT * FROM item WHERE state = 'deleted' ORDER BY deleted_at DESC").all();
  const days = Number(store.config.lifecycle.recycleDays || 30);
  return rows.map(function (r) {
    const h = hydrate(r);
    h.expiresAt = Number(r.deleted_at || 0) + days * 86400000;
    h.expired = h.expiresAt < nowMs();
    return h;
  });
}

export function purgeDeleted(store, input) {
  const o = input || {};
  const db = store.db;
  const days = Number(o.olderThanDays === undefined ? store.config.lifecycle.recycleDays || 30 : o.olderThanDays);
  const cutoff = nowMs() - days * 86400000;
  const rows = o.id
    ? db.prepare('SELECT id FROM item WHERE id = ? AND state = ' + "'deleted'").all(String(o.id))
    : db.prepare("SELECT id FROM item WHERE state = 'deleted' AND deleted_at <= ?").all(cutoff);
  let n = 0;
  for (const r of rows) {
    db.prepare('DELETE FROM item WHERE id = ?').run(r.id);
    vector.annDrop(store, r.id);
    store.shadow.append('item_delete', { id: r.id, hard: true, ts: nowMs(), reason: 'purge' });
    n += 1;
  }
  return { purged: n, olderThanDays: days };
}

// ---------- 多模态附件 ----------
export function listAttachments(store, itemId) {
  const rows = store.db.prepare('SELECT * FROM attachment WHERE item_id = ? ORDER BY created_at ASC').all(String(itemId || ''));
  const fs = require_fs();
  return rows.map(function (r) {
    const o = Object.assign({}, r);
    o.exists = fs.existsSync(r.path);
    o.url = '/api/attachment?id=' + encodeURIComponent(r.id);
    return o;
  });
}

export function attachToItem(store, input) {
  const fs = require_fs();
  const db = store.db;
  const item = db.prepare('SELECT * FROM item WHERE id = ?').get(String(input.itemId || ''));
  if (!item) throw new Error('unknown item: ' + input.itemId);
  if (!input.path) throw new Error('path required');
  if (!fs.existsSync(input.path)) throw new Error('file not found: ' + input.path);
  const buf = fs.readFileSync(input.path);
  const crypto = require_crypto();
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const part = db.prepare('SELECT name FROM partition WHERE id = ?').get(item.partition_id);
  const dir = require_path().join(store.paths.dataDir, 'attachments', part ? part.name : 'misc');
  fs.mkdirSync(dir, { recursive: true });
  const ext = require_path().extname(input.path) || '.png';
  const dest = require_path().join(dir, sha.slice(0, 16) + ext);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  const id = uid('att');
  db.prepare('INSERT INTO attachment (id, item_id, partition_id, path, mime, bytes, sha256, caption, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, item.id, item.partition_id, dest, String(input.mime || 'image/png'), buf.length, sha, String(input.caption || ''), Number(input.width || 0), Number(input.height || 0), nowMs());
  const row = db.prepare('SELECT * FROM attachment WHERE id = ?').get(id);
  store.shadow.append('attachment', row);
  return row;
}

export function setCaption(store, input) {
  const db = store.db;
  const row = db.prepare('SELECT * FROM attachment WHERE id = ?').get(String(input.id || ''));
  if (!row) throw new Error('unknown attachment: ' + input.id);
  db.prepare('UPDATE attachment SET caption = ? WHERE id = ?').run(String(input.caption || ''), row.id);
  const next = db.prepare('SELECT * FROM attachment WHERE id = ?').get(row.id);
  store.shadow.append('attachment', next);
  return next;
}

export function deleteAttachment(store, id, hard) {
  const fs = require_fs();
  const db = store.db;
  const row = db.prepare('SELECT * FROM attachment WHERE id = ?').get(String(id || ''));
  if (!row) throw new Error('unknown attachment: ' + id);
  db.prepare('DELETE FROM attachment WHERE id = ?').run(row.id);
  store.shadow.append('attachment_delete', { id: row.id, path: row.path, ts: nowMs() });
  if (hard) { try { fs.unlinkSync(row.path); } catch (err) {} }
  return { id: row.id, removed: true, fileDeleted: !!hard };
}

export function attachmentById(store, id) {
  return store.db.prepare('SELECT * FROM attachment WHERE id = ?').get(String(id || ''));
}

import fsMod from 'node:fs';
import cryptoMod from 'node:crypto';
import pathMod from 'node:path';
function require_fs() { return fsMod; }
function require_crypto() { return cryptoMod; }
function require_path() { return pathMod; }

export function itemList(store, partId, opts) {
  const o = opts || {};
  const now = nowMs();
  const rows = store.db.prepare('SELECT * FROM item WHERE partition_id = ? AND state != ' + "'deleted'" + ' AND (? = 1 OR state != ' + "'archived'" + ') ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?')
    .all(partId, o.includeArchived ? 1 : 0, Number(o.limit || 500));
  return rows.map(function (r) {
    const h = hydrate(r);
    h.retention = Number(retentionOf(r, now, store.config).toFixed(4));
    return h;
  });
}
