import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { clamp, tokenize, retentionOf, ensurePartition, requirePartition, hydrate, remember, scoreRelevance } from './engine.mjs';
import { nowMs, integrity } from './db.mjs';
import * as vector from './vector.mjs';

function uid(prefix) { return prefix + '-' + crypto.randomBytes(6).toString('hex'); }
function jsonParse(text, fallback) { try { return JSON.parse(text || ''); } catch (err) { return fallback; } }
function low(s) { return String(s === undefined || s === null ? '' : s).toLowerCase(); }
// 工具层的读操作一律走 requirePartition：名字打错就报错，不偷偷建空分区
function partOf(store, input) { return requirePartition(store, { name: input.partition || input.partitionName }); }
function partOfCreate(store, input) { return ensurePartition(store, { name: input.partition || input.partitionName }); }
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function countOf(text, term) {
  if (!term) return 0;
  let n = 0;
  let at = text.indexOf(term);
  while (at >= 0) { n += 1; if (n > 50) break; at = text.indexOf(term, at + term.length); }
  return n;
}
function snippetAround(text, terms, width) {
  const src = String(text || '');
  const lowSrc = low(src);
  const wd = width || 80;
  let at = -1;
  for (const t of terms || []) { const i = lowSrc.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) at = 0;
  const start = Math.max(0, at - Math.floor(wd / 3));
  const cut = src.slice(start, start + wd);
  return (start > 0 ? '...' : '') + cut + (start + wd < src.length ? '...' : '');
}
function withRetention(store, row, now) {
  const cfg = store.config;
  const ret = retentionOf(row, now, cfg);
  return {
    id: row.id, title: row.title, kind: row.kind, tags: jsonParse(row.tags, []),
    importance: row.importance, pinned: !!row.pinned, state: row.state,
    stability: Number(Number(row.stability).toFixed(2)),
    retention: Number(ret.toFixed(4)),
    hitCount: row.hit_count, accessCount: row.access_count, redundantReads: row.redundant_reads,
    createdAt: row.created_at, updatedAt: row.updated_at, lastAccessAt: row.last_access_at,
    supersededBy: row.superseded_by || null
  };
}

/**
 * search —— 知道有这么一条、但想不起当时写的什么词时用。
 * 与 recall 的分工：recall 挑本次任务最该看的少量条目（带遗忘曲线与向量融合）；
 * search 是全量翻找 + 分页，不做衰减惩罚，方便人自己找回旧记录。
 */
export function searchItems(store, input) {
  const db = store.db;
  const part = partOf(store, input);
  const now = nowMs();
  const raw = String(input.q || input.query || '').trim();
  const terms = tokenize(raw).filter(function (t) { return t.length > 0; });
  const wantTags = (Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(','))
    .map(function (t) { return low(t).trim(); }).filter(Boolean);
  const state = String(input.state || 'all');
  const kind = String(input.kind || '');
  const limit = clamp(Number(input.limit || 20), 1, 100);
  const offset = Math.max(0, Number(input.offset || 0));
  let sql = 'SELECT * FROM item WHERE partition_id = ? AND deleted_at IS NULL';
  const params = [part.id];
  if (state && state !== 'all') { sql += ' AND state = ?'; params.push(state); }
  else { sql += " AND state != 'deleted'"; }
  if (kind) { sql += ' AND kind = ?'; params.push(kind); }
  const stmt = db.prepare(sql);
  const rows = stmt.all.apply(stmt, params);
  const scored = [];
  for (const row of rows) {
    const tags = jsonParse(row.tags, []);
    if (wantTags.length && !wantTags.every(function (t) { return tags.some(function (x) { return low(x).indexOf(t) >= 0; }); })) continue;
    const hay = low(row.title) + ' ' + low(row.body) + ' ' + low(tags.join(' '));
    let score = 0;
    for (const t of terms) { const c = countOf(hay, t); if (c) score += 1 + Math.min(3, c - 1) * 0.25; }
    if (terms.length && score <= 0) continue;
    if (!terms.length && raw && hay.indexOf(low(raw)) < 0) continue;
    const norm = terms.length ? score / terms.length : 1;
    scored.push({ row: row, score: norm });
  }
  const sort = String(input.sort || (raw ? 'score' : 'recent'));
  const retOf = function (r) { return retentionOf(r, now, store.config); };
  scored.sort(function (a, b) {
    if (sort === 'score') return b.score - a.score || b.row.updated_at - a.row.updated_at;
    if (sort === 'importance') return b.row.importance - a.row.importance || b.row.updated_at - a.row.updated_at;
    if (sort === 'retention') return retOf(b.row) - retOf(a.row);
    if (sort === 'hits') return b.row.hit_count - a.row.hit_count || b.row.updated_at - a.row.updated_at;
    if (sort === 'oldest') return a.row.updated_at - b.row.updated_at;
    return b.row.updated_at - a.row.updated_at;
  });
  const page = scored.slice(offset, offset + limit).map(function (x) {
    const o = withRetention(store, x.row, now);
    o.score = Number(x.score.toFixed(4));
    o.snippet = snippetAround(x.row.body || x.row.title, terms, 90);
    return o;
  });
  return { partition: part.name, q: raw, tags: wantTags, sort: sort, total: scored.length, offset: offset, limit: limit, items: page };
}

/** digest —— 天/周报：这段时间学到了什么、用上了什么、什么东西在冷掉。 */
export function digest(store, input) {
  const db = store.db;
  const part = partOf(store, input);
  const cfg = store.config;
  const now = nowMs();
  const days = clamp(Number(input.days || 7), 1, 365);
  const since = now - days * 86400000;
  const one = function (sql, args) { const row = db.prepare(sql).get.apply(db.prepare(sql), args); return row ? Number(Object.values(row)[0]) : 0; };
  const created = one('SELECT COUNT(*) FROM item WHERE partition_id = ? AND created_at >= ? AND deleted_at IS NULL', [part.id, since]);
  const updated = one('SELECT COUNT(*) FROM item WHERE partition_id = ? AND updated_at >= ? AND deleted_at IS NULL', [part.id, since]);
  const recalls = one('SELECT COUNT(*) FROM recall_event WHERE partition_id = ? AND ts >= ?', [part.id, since]);
  const returned = one('SELECT COALESCE(SUM(returned),0) FROM recall_event WHERE partition_id = ? AND ts >= ?', [part.id, since]);
  const judged = one('SELECT COUNT(*) FROM recall_event WHERE partition_id = ? AND ts >= ? AND used IS NOT NULL', [part.id, since]);
  const hits = one('SELECT COUNT(*) FROM recall_event WHERE partition_id = ? AND ts >= ? AND used = 1', [part.id, since]);
  const hitRate = judged ? Number((hits / judged).toFixed(4)) : null;
  const guards = {};
  for (const g of db.prepare('SELECT level, COUNT(*) AS n FROM guard_event WHERE partition_id = ? AND ts >= ? AND deleted_at IS NULL GROUP BY level').all(part.id, since)) guards[g.level] = g.n;
  const states = {};
  for (const s of db.prepare('SELECT state, COUNT(*) AS n FROM item WHERE partition_id = ? AND deleted_at IS NULL GROUP BY state').all(part.id)) states[s.state] = s.n;
  const daily = [];
  const createdByDay = db.prepare('SELECT ts, 1 AS c FROM (SELECT created_at AS ts FROM item WHERE partition_id = ? AND created_at >= ? AND deleted_at IS NULL)').all(part.id, since);
  const bucket = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const to = now - i * 86400000;
    bucket.set(dayKey(to), { day: dayKey(to), created: 0, hits: 0 });
  }
  for (const r of createdByDay) { const b = bucket.get(dayKey(r.ts)); if (b) b.created += 1; }
  for (const e of db.prepare('SELECT ts, used FROM recall_event WHERE partition_id = ? AND ts >= ?').all(part.id, since)) {
    const b = bucket.get(dayKey(e.ts));
    if (b && e.used === 1) b.hits += 1;
  }
  for (const b of bucket.values()) daily.push(b);
  const hottest = db.prepare("SELECT * FROM item WHERE partition_id = ? AND deleted_at IS NULL AND state != 'deleted' ORDER BY hit_count DESC, access_count DESC LIMIT 5").all(part.id)
    .map(function (r) { return withRetention(store, r, now); });
  const activeRows = db.prepare("SELECT * FROM item WHERE partition_id = ? AND state = 'active' AND deleted_at IS NULL AND superseded_by IS NULL").all(part.id);
  const cooling = activeRows.filter(function (r) { return Number(r.last_access_at || 0) < since && !r.pinned; })
    .map(function (r) { return withRetention(store, r, now); })
    .sort(function (a, b) { return a.retention - b.retention; }).slice(0, 5);
  const nearForget = activeRows.map(function (r) { return withRetention(store, r, now); })
    .filter(function (o) { return o.retention < Number(cfg.curve.forgetThreshold || 0.25) && !o.pinned && o.importance < Number(cfg.curve.trunkImportance || 4); });
  const tasks = db.prepare('SELECT id, title, status, started_at, ended_at, report_path FROM task WHERE partition_id = ? AND started_at >= ? ORDER BY started_at DESC').all(part.id, since);
  const reports = db.prepare('SELECT id, title, path, created_at FROM report WHERE partition_id = ? AND created_at >= ? AND deleted_at IS NULL ORDER BY created_at DESC').all(part.id, since);
  return {
    partition: part.name, days: days, from: since, to: now,
    items: { created: created, updated: updated, states: states },
    recall: { events: recalls, returned: returned, judged: judged, hits: hits, hitRate: hitRate },
    guards: guards,
    nearForget: nearForget.slice(0, 10),
    cooling: cooling,
    hottest: hottest,
    tasks: tasks,
    reports: reports,
    daily: daily
  };
}

/**
 * explain —— 这条为什么被召回 / 为什么快忘了，把打分的每一段拆开给人看。
 * 不给 query 就只解释衰减：稳定性、距上次访问多久、什么时候会掉到阈值以下。
 */
export function explain(store, input) {
  const db = store.db;
  const row = db.prepare('SELECT * FROM item WHERE id = ?').get(String(input.id || ''));
  if (!row) throw new Error('unknown item: ' + input.id);
  const cfg = store.config;
  const now = nowMs();
  const retention = retentionOf(row, now, cfg);
  const ageDays = Math.max(0, (now - Number(row.last_access_at || row.updated_at || now)) / 86400000);
  const stability = Math.max(0.0001, Number(row.stability || 0));
  const forget = Number(cfg.curve.forgetThreshold || 0.25);
  const daysToForget = retention <= forget ? 0 : Math.max(0, Math.log(retention / forget) * stability);
  const base = {
    id: row.id, title: row.title, partitionId: row.partition_id, state: row.state, kind: row.kind,
    importance: row.importance, pinned: !!row.pinned, stability: Number(stability.toFixed(3)),
    retention: Number(retention.toFixed(4)), ageDays: Number(ageDays.toFixed(2)),
    forgetThreshold: forget, daysUntilForget: Number(daysToForget.toFixed(2)),
    accessCount: row.access_count, hitCount: row.hit_count, redundantReads: row.redundant_reads
  };
  const events = db.prepare('SELECT id, ts, query, used, top_score FROM recall_event WHERE partition_id = ? AND items LIKE ? ORDER BY ts DESC LIMIT 5')
    .all(row.partition_id, '%"' + row.id + '"%');
  const res = { item: base, events: events };
  const query = String(input.query || '').trim();
  if (!query) return res;
  const cands = db.prepare("SELECT * FROM item WHERE partition_id = ? AND state = 'active' AND superseded_by IS NULL AND deleted_at IS NULL").all(row.partition_id);
  if (!cands.some(function (c) { return c.id === row.id; })) res.note = '该条目不在活跃候选范围内（休眠/归档/已被取代），recall 不会返回它';
  const df = new Map();
  const docs = cands.map(function (it) {
    const toks = new Set(tokenize(it.title + ' ' + it.body + ' ' + jsonParse(it.tags, []).join(' ')));
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
    return { item: it, toks: toks };
  });
  const N = Math.max(1, docs.length);
  const idf = new Map();
  for (const entry of df) idf.set(entry[0], Math.log(1 + N / entry[1]));
  const rel = scoreRelevance(query, docs, idf, cfg);
  const vcfg = vector.vectorCfg(store);
  const qv = vcfg.enabled ? vector.queryVector(store, query) : null;
  const idx = cands.findIndex(function (c) { return c.id === row.id; });
  const mine = idx >= 0 ? cands[idx] : row;
  let cos = 0;
  if (qv) {
    const iv = vector.itemVector(store, hydrate(mine), { readOnly: true });
    if (iv && iv.model === qv.model) cos = vector.cosine(qv.vec, iv.vec);
  }
  const relevance = idx >= 0 ? rel[idx] : 0;
  const wRel = Number(cfg.recall.weightRelevance || 1);
  const wRet = Number(cfg.recall.weightRetention || 0.65);
  const wImp = Number(cfg.recall.weightImportance || 1);
  const blended = relevance * wRel + (vcfg.enabled ? vcfg.vectorWeight * Math.max(0, cos) : 0);
  const retentionFactor = 0.35 + wRet * retention;
  const importanceFactor = 0.85 + 0.075 * (Number(mine.importance || 3) - 1) * wImp;
  const pinnedBoost = mine.pinned ? Number(cfg.recall.pinnedBoost || 0) : 0;
  const score = blended * retentionFactor * importanceFactor + pinnedBoost;
  res.query = query;
  res.components = {
    relevance: Number(relevance.toFixed(4)), weightRelevance: wRel,
    cos: Number(cos.toFixed(4)), vectorWeight: vcfg.vectorWeight, vectorFloor: vcfg.vectorFloor,
    blended: Number(blended.toFixed(4)), retentionFactor: Number(retentionFactor.toFixed(4)),
    importanceFactor: Number(importanceFactor.toFixed(4)), pinnedBoost: pinnedBoost,
    score: Number(score.toFixed(4)), minScore: cfg.recall.minScore,
    passesMinScore: score >= Number(cfg.recall.minScore || 0)
  };
  res.formula = 'score = (relevance*weightRelevance + vectorWeight*max(0,cos)) * (0.35 + weightRetention*retention) * importanceFactor + pinnedBoost';
  return res;
}

/**
 * 条目关联：把结论和它的依据接起来，召回时可以把一跳邻居一起带出来。
 * 硬规则：只允许同分区内连接。跨分区连接等于把两个隔离的记忆打通，是禁止操作。
 */
export function link(store, input) {
  const db = store.db;
  const fromId = String(input.from || input.fromId || '');
  const toId = String(input.to || input.toId || '');
  const relation = String(input.relation || 'related');
  if (!fromId || !toId) throw new Error('link 需要 from 与 to');
  if (fromId === toId) throw new Error('不能把条目连到它自己');
  const a = db.prepare('SELECT id, partition_id, title FROM item WHERE id = ?').get(fromId);
  const b = db.prepare('SELECT id, partition_id, title FROM item WHERE id = ?').get(toId);
  if (!a) throw new Error('unknown item: ' + fromId);
  if (!b) throw new Error('unknown item: ' + toId);
  if (a.partition_id !== b.partition_id) throw new Error('分区不可混用：' + fromId + ' 与 ' + toId + ' 不在同一个分区');
  const exist = db.prepare('SELECT * FROM item_link WHERE from_id = ? AND to_id = ? AND relation = ?').get(fromId, toId, relation);
  if (exist) return { link: exist, created: false };
  const row = { id: uid('l'), partition_id: a.partition_id, from_id: fromId, to_id: toId, relation: relation, created_at: nowMs() };
  db.prepare('INSERT INTO item_link (id, partition_id, from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, row.partition_id, row.from_id, row.to_id, row.relation, row.created_at);
  store.shadow.append('item_link', row);
  return { link: row, created: true };
}

export function unlink(store, input) {
  const db = store.db;
  const id = String(input.id || '');
  let n = 0;
  if (id) {
    const r = db.prepare('DELETE FROM item_link WHERE id = ?').run(id);
    n = Number(r.changes || 0);
  } else {
    const fromId = String(input.from || '');
    const toId = String(input.to || '');
    const rel = input.relation === undefined ? null : String(input.relation);
    if (!fromId || !toId) throw new Error('unlink 需要 id，或 from + to');
    const sql = 'DELETE FROM item_link WHERE from_id = ? AND to_id = ?' + (rel ? ' AND relation = ?' : '');
    const stmt = db.prepare(sql);
    const r = rel ? stmt.run(fromId, toId, rel) : stmt.run(fromId, toId);
    n = Number(r.changes || 0);
  }
  return { removed: n };
}

export function links(store, input) {
  const db = store.db;
  const id = String(input.id || '');
  const row = db.prepare('SELECT id FROM item WHERE id = ?').get(id);
  if (!row) throw new Error('unknown item: ' + id);
  const out = db.prepare('SELECT l.id, l.relation, l.created_at, i.id AS to_id, i.title, i.kind, i.state FROM item_link l JOIN item i ON i.id = l.to_id WHERE l.from_id = ? ORDER BY l.created_at DESC').all(id);
  const back = db.prepare('SELECT l.id, l.relation, l.created_at, i.id AS from_id, i.title, i.kind, i.state FROM item_link l JOIN item i ON i.id = l.from_id WHERE l.to_id = ? ORDER BY l.created_at DESC').all(id);
  return { id: id, out: out, back: back };
}

// 多跳召回：从一条记忆出发把邻居带出来（广度优先，默认 1 跳，最多 3 跳）
export function expand(store, input) {
  const db = store.db;
  const start = String(input.id || '');
  const depth = clamp(Number(input.depth || 1), 1, 3);
  const seen = new Set([start]);
  let frontier = [start];
  const hops = [];
  const now = nowMs();
  for (let d = 1; d <= depth; d += 1) {
    const next = [];
    for (const id of frontier) {
      const rows = db.prepare('SELECT l.relation, i.* FROM item_link l JOIN item i ON i.id = l.to_id WHERE l.from_id = ? AND i.deleted_at IS NULL').all(id);
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        next.push(r.id);
        const o = withRetention(store, r, now);
        o.hop = d;
        o.relation = r.relation;
        o.from = id;
        hops.push(o);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return { id: start, depth: depth, items: hops };
}

export function setPinned(store, input) {
  const db = store.db;
  const id = String(input.id || '');
  const row = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
  if (!row) throw new Error('unknown item: ' + id);
  const pinned = input.pinned === undefined ? (row.pinned ? 0 : 1) : (input.pinned ? 1 : 0);
  db.prepare('UPDATE item SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned, nowMs(), id);
  const fresh = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
  store.shadow.append('item', fresh);
  return { id: id, title: fresh.title, pinned: !!fresh.pinned, changed: Number(fresh.pinned) !== Number(row.pinned) };
}

/**
 * health —— 体检：多重保险的那几层分别还成立吗。
 * 只报告不擅自改；fix=true 只做两件安全动作：补算缺失向量、删掉悬空关联。
 */
export function health(store, input) {
  const db = store.db;
  const cfg = store.config;
  const root = store.root || process.env.MEMORY_ROOT || path.resolve(process.cwd(), 'data');
  const part = input && input.partition ? partOf(store, input) : null;
  const partWhere = part ? ' AND partition_id = ?' : '';
  const args = part ? [part.id] : [];
  const one = function (sql, extra) {
    const stmt = db.prepare(sql);
    const row = stmt.get.apply(stmt, args.concat(extra || []));
    return row ? Number(Object.values(row)[0]) : 0;
  };
  const all = function (sql, extra) {
    const stmt = db.prepare(sql);
    return stmt.all.apply(stmt, args.concat(extra || []));
  };
  const findings = [];
  let repaired = 0;
  if (input && input.fix) {
    const vcfg = vector.vectorCfg(store);
    if (vcfg.enabled) {
      const r = vector.reindex(store, { partitionId: part ? part.id : null });
      repaired += Number(r.total || 0);
      findings.push({ code: 'VECTORS_REINDEXED', severity: 'info', detail: '已重算 ' + Number(r.total || 0) + ' 条向量' });
    }
    const badLinks = db.prepare('SELECT l.id FROM item_link l WHERE NOT EXISTS (SELECT 1 FROM item i WHERE i.id = l.from_id) OR NOT EXISTS (SELECT 1 FROM item j WHERE j.id = l.to_id)').all();
    if (badLinks.length) {
      const del = db.prepare('DELETE FROM item_link WHERE id = ?');
      for (const l of badLinks) del.run(l.id);
      repaired += badLinks.length;
      findings.push({ code: 'DANGLING_LINKS_REMOVED', severity: 'info', detail: '已删除 ' + badLinks.length + ' 条悬空关联' });
    }
  }
  const items = one('SELECT COUNT(*) FROM item WHERE deleted_at IS NULL' + partWhere);
  const active = one("SELECT COUNT(*) FROM item WHERE deleted_at IS NULL AND state = 'active'" + partWhere);
  const missingVec = vector.vectorCfg(store).enabled
    ? one('SELECT COUNT(*) FROM item i WHERE i.deleted_at IS NULL AND i.state != \'deleted\'' + (part ? ' AND i.partition_id = ?' : '') + ' AND i.id NOT IN (SELECT item_id FROM item_vector)')
    : 0;
  if (missingVec > 0) findings.push({ code: 'VECTOR_MISSING', severity: missingVec > items / 2 ? 'warn' : 'info', detail: missingVec + ' 条记忆还没有向量（惰性补齐会兜住，但批量补更省事：mem reindex）' });
  const trunk = one('SELECT COUNT(*) FROM item WHERE pinned = 1 AND deleted_at IS NULL' + partWhere);
  if (trunk === 0 && active > 0) findings.push({ code: 'NO_TRUNK', severity: 'warn', detail: '没有钉住的主干记忆，长上下文里容易丢主线（mem summarize 可自动生成）' });
  const stale = one('SELECT COUNT(*) FROM item WHERE pin' + "ned = 0 AND state = 'active' AND last_access_at < ?" + partWhere, [nowMs() - 30 * 86400000]);
  if (stale > 0) findings.push({ code: 'STALE_ITEMS', severity: 'info', detail: stale + ' 条 30 天没被用过，考虑 sleep 或提高重要性' });
  const atts = all('SELECT a.id, a.path, a.caption FROM attachment a JOIN item i ON i.id = a.item_id WHERE i.deleted_at IS NULL' + (part ? ' AND a.partition_id = ?' : ''), []);
  let attMissingFile = 0;
  let attNoCaption = 0;
  for (const a of atts) {
    const abs = path.isAbsolute(a.path) ? a.path : path.join(root, a.path);
    if (!fs.existsSync(abs)) attMissingFile += 1;
    if (!String(a.caption || '').trim()) attNoCaption += 1;
  }
  if (attMissingFile) findings.push({ code: 'ATTACHMENT_FILE_MISSING', severity: 'warn', detail: attMissingFile + ' 个附件的文件不在磁盘上，召回会引用到空描述' });
  if (attNoCaption) findings.push({ code: 'CAPTION_MISSING', severity: 'info', detail: attNoCaption + ' 个附件还没有文字描述（mem caption --partition <p>）' });
  const attDir = path.join(root, String((cfg.multimodal && cfg.multimodal.attachmentsDir) || 'attachments'));
  let orphanFiles = 0;
  if (fs.existsSync(attDir)) {
    const known = new Set(db.prepare('SELECT path FROM attachment').all().map(function (r) { return path.resolve(path.isAbsolute(r.path) ? r.path : path.join(root, r.path)); }));
    const walk = function (dir) {
      let list = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) list = list.concat(walk(full));
        else if (!known.has(path.resolve(full))) list.push(full);
      }
      return list;
    };
    orphanFiles = walk(attDir).length;
  }
  if (orphanFiles) findings.push({ code: 'ATTACHMENT_ORPHAN', severity: 'info', detail: orphanFiles + ' 个附件文件没有库记录（可能是导入前的残留）' });
  const badLinks = db.prepare('SELECT COUNT(*) AS n FROM item_link l WHERE NOT EXISTS (SELECT 1 FROM item i WHERE i.id = l.from_id) OR NOT EXISTS (SELECT 1 FROM item j WHERE j.id = l.to_id)').get();
  if (Number(badLinks.n) > 0) findings.push({ code: 'DANGLING_LINKS', severity: 'warn', detail: Number(badLinks.n) + ' 条关联指向不存在的条目（mem health --fix 可清）' });
  const integ = integrity(store);
  if (!integ.ok) findings.push({ code: 'DB_INTEGRITY', severity: 'block', detail: String(integ.detail || 'quick_check 失败') });
  const shadowDir = store.shadowDir || path.join(root, 'data', 'shadow');
  let shadowFiles = 0;
  let shadowBytes = 0;
  if (fs.existsSync(shadowDir)) {
    for (const e of fs.readdirSync(shadowDir)) {
      const full = path.join(shadowDir, e);
      const st = fs.statSync(full);
      if (st.isFile()) { shadowFiles += 1; shadowBytes += st.size; }
    }
  }
  const backupDir = store.backupDir || path.join(root, 'data', 'backups');
  const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(function (f) { return f.endsWith('.db'); }) : [];
  const newest = backups.length ? Math.max.apply(null, backups.map(function (f) { return fs.statSync(path.join(backupDir, f)).mtimeMs; })) : 0;
  const backupAgeHours = newest ? Number(((nowMs() - newest) / 3600000).toFixed(1)) : null;
  if (backupAgeHours === null) findings.push({ code: 'BACKUP_MISSING', severity: 'warn', detail: '还没有任何备份（mem backup）' });
  else if (backupAgeHours > Number((cfg.backup && cfg.backup.intervalMin) || 60) / 60 * 24) findings.push({ code: 'BACKUP_STALE', severity: 'info', detail: '最近一份备份是 ' + backupAgeHours + ' 小时前' });
  const openTasks = all("SELECT COUNT(*) AS n FROM task WHERE status = 'running'" + partWhere, []);
  const openCount = openTasks.length ? Number(openTasks[0].n) : 0;
  if (openCount > 0) findings.push({ code: 'OPEN_TASK_LEAK', severity: 'info', detail: openCount + ' 个任务还没结束（mem task end 写汇报）' });
  const level = findings.some(function (f) { return f.severity === 'block'; }) ? 'block'
    : findings.some(function (f) { return f.severity === 'warn'; }) ? 'warn' : 'ok';
  return {
    partition: part ? part.name : 'all', level: level, fixed: repaired,
    counts: { items: items, active: active, trunk: trunk, attachments: atts.length, missingVector: missingVec, shadowFiles: shadowFiles, backups: backups.length },
    storage: { shadowBytes: shadowBytes, backupAgeHours: backupAgeHours },
    integrity: integ,
    findings: findings
  };
}

/**
 * dedupe —— 找重复。只给建议不动手：合并记忆是不可逆的语义判断，机器猜错代价很高。
 */
export function dedupe(store, input) {
  const db = store.db;
  const part = partOf(store, input);
  const now = nowMs();
  const threshold = clamp(Number(input.threshold || 0.92), 0.5, 1);
  const rows = db.prepare("SELECT * FROM item WHERE partition_id = ? AND deleted_at IS NULL AND state != 'deleted' ORDER BY importance DESC, updated_at DESC").all(part.id);
  const cfg = vector.vectorCfg(store);
  const toks = new Map();
  const vecs = new Map();
  for (const r of rows) {
    toks.set(r.id, new Set(tokenize(r.title + ' ' + r.body + ' ' + jsonParse(r.tags, []).join(' '))));
    if (cfg.enabled) {
      try { vecs.set(r.id, vector.itemVector(store, hydrate(r), { readOnly: true })); } catch (err) { vecs.set(r.id, null); }
    }
  }
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      const ta = toks.get(a.id);
      const tb = toks.get(b.id);
      let inter = 0;
      for (const t of ta) if (tb.has(t)) inter += 1;
      const union = ta.size + tb.size - inter;
      const jac = union ? inter / union : 0;
      let cos = 0;
      const va = vecs.get(a.id);
      const vb = vecs.get(b.id);
      if (va && vb && va.model === vb.model) cos = vector.cosine(va.vec, vb.vec);
      const sim = Math.max(jac, cos);
      if (sim < threshold) continue;
      const keep = Number(a.importance) >= Number(b.importance) ? a : b;
      const drop = keep === a ? b : a;
      pairs.push({
        similarity: Number(sim.toFixed(4)), jaccard: Number(jac.toFixed(4)), cosine: Number(cos.toFixed(4)),
        keep: { id: keep.id, title: keep.title }, drop: { id: drop.id, title: drop.title },
        suggestion: 'mem link ' + keep.id + ' --to ' + drop.id + ' --relation duplicate  然后 mem delete ' + drop.id
      });
    }
  }
  pairs.sort(function (x, y) { return y.similarity - x.similarity; });
  return { partition: part.name, threshold: threshold, scanned: rows.length, pairs: pairs.slice(0, 50), total: pairs.length };
}

/**
 * summarize —— 把一堆散记忆压成一条主干（kind='trunk' 并钉住），旧主干用 superseded_by 取代而不是删掉。
 */
export function summarize(store, input) {
  const db = store.db;
  const part = partOf(store, input);
  const limit = clamp(Number(input.limit || 12), 2, 40);
  const now = nowMs();
  const rows = db.prepare("SELECT * FROM item WHERE partition_id = ? AND deleted_at IS NULL AND state != 'deleted' AND pinned = 0 AND superseded_by IS NULL AND kind != 'trunk' ORDER BY pinned DESC, importance DESC, stability DESC, updated_at DESC LIMIT ?").all(part.id, limit);
  if (!rows.length) return { partition: part.name, created: false, reason: '没有可归纳的条目（都已被取代或已钉住）' };
  const titles = rows.map(function (r) { return '- ' + r.title; }).join('\n');
  const bodyLines = rows.map(function (r) {
    const snippet = snippetAround(r.body, [], 120);
    return '- [' + r.kind + '] ' + r.title + '：' + snippet;
  }).join('\n');
  const title = String(input.title || ('主干：' + part.name + ' 当前结论（' + dayKey(now) + '）'));
  const body = '本主干由 ' + rows.length + ' 条记忆归纳（' + dayKey(now) + '）：\n' + bodyLines + '\n\n覆盖的条目：\n' + titles;
  const supersededIds = db.prepare("SELECT id FROM item WHERE partition_id = ? AND kind = 'trunk' AND pinned = 1 AND superseded_by IS NULL").all(part.id).map(function (r) { return r.id; });
  const created = remember(store, {
    partition: part.name, kind: 'trunk', title: title, body: body,
    tags: ['trunk', 'summary'], importance: 5, pinned: true, source: 'summarize', taskId: input.taskId
  });
  const newId = created.item.id;
  for (const id of supersededIds) {
    if (id === newId) continue;
    db.prepare('UPDATE item SET superseded_by = ?, pinned = 0, updated_at = ? WHERE id = ?').run(newId, nowMs(), id);
  }
  const fresh = db.prepare('SELECT * FROM item WHERE id = ?').get(newId);
  store.shadow.append('item', fresh);
  return {
    partition: part.name, created: true, item: withRetention(store, fresh, now),
    sources: rows.map(function (r) { return { id: r.id, title: r.title, kind: r.kind, importance: r.importance }; }),
    superseded: supersededIds
  };
}
