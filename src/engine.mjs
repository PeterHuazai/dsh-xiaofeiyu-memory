import { nowMs, uid, hashOf } from './db.mjs';
import * as vector from './vector.mjs';

export const KINDS = ['fact', 'decision', 'constraint', 'preference', 'task', 'report', 'note', 'trunk', 'scene'];

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

// 读操作/只出计划的入口用这个：分区不存在就报错，绝不偷偷建一个空分区
// （历史 bug：传分区 id 当名字，会静默建出 name="1" 的垃圾分区）
export function requirePartition(store, input) {
  const name = String((input && input.name) || '').trim();
  if (!name) throw new Error('partition name required');
  const found = store.db.prepare('SELECT * FROM partition WHERE name = ?').get(name);
  if (!found) throw new Error('unknown partition: ' + name + '（先 mem partition add --name ' + name + ' --title "..." 建分区）');
  if (input.title && input.title !== found.title) {
    store.db.prepare('UPDATE partition SET title = ? WHERE id = ?').run(String(input.title), found.id);
    const row = store.db.prepare('SELECT * FROM partition WHERE id = ?').get(found.id);
    store.shadow.append('partition', row);
    return row;
  }
  return found;
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

// ---- forgetting curve（自适应 + 主干强化）----
function curveCfg(cfg) { return (cfg && cfg.curve) || {}; }

export function isTrunk(item, cfg) {
  const c = curveCfg(cfg);
  if (!item) return false;
  return !!(item.pinned || Number(item.importance || 0) >= Number(c.trunkImportance || 4));
}

// ---- 三层记忆：主干 / 场景 / 细节 ----
// 不新增列：用现有 kind + importance + pinned 推导，老库零迁移。主干永远有留存地板，场景是「一次任务的收束」，
// 细节是平时记住的零散事实 —— 遗忘顺序是细节先掉、场景后掉、主干几乎不掉。
export const LAYERS = ['trunk', 'scene', 'detail'];
const SCENE_KINDS = { report: 1, scene: 1, task: 1, trunk: 1 };

export function layerOf(item, cfg) {
  if (!item) return 'detail';
  const kind = String(item.kind || 'note');
  if (kind === 'trunk') return 'trunk';
  // 任务开启/汇报这类「一次任务的收束」默认算场景，除非被显式钉住 —— 它们是脚手架，不是结论
  if (SCENE_KINDS[kind]) return item.pinned ? 'trunk' : 'scene';
  if (item.pinned || Number(item.importance || 0) >= Number(curveCfg(cfg).trunkImportance || 4)) return 'trunk';
  return 'detail';
}

export function estimateTokens(text, cfg) {
  const ratio = Number((cfg && cfg.tokens && cfg.tokens.charsPerToken) || 1.7);
  return Math.max(0, Math.round(String(text || '').length / ratio));
}

// 紧凑主干：给「第一轮自动注入」和面板用的纯文本，硬性按 token 预算截断（超了就从尾巴丢条目，不硬塞）
export function trunkDigest(store, input) {
  const o = input || {};
  const part = requirePartition(store, { name: o.partition, title: o.partitionTitle });
  const cfg = store.config;
  const mcfg = cfg.maintain || {};
  const maxTokens = Math.max(80, Number(o.maxTokens || mcfg.digestTokens || 320));
  const cap = Math.max(1, Number(o.maxItems || mcfg.maxDigestItems || 8));
  const now = nowMs();
  const rows = store.db.prepare("SELECT * FROM item WHERE partition_id = ? AND deleted_at IS NULL AND state != 'deleted' AND superseded_by IS NULL ORDER BY (pinned = 1) DESC, importance DESC, hit_count DESC, updated_at DESC").all(part.id);
  const lines = [];
  let spent = 0;
  let truncated = false;
  // 先主干、再场景；任务开启这类脚手架不进摘要，避免把「我开了一个任务」当成结论
  const ordered = rows.filter(function (r) { return String(r.kind || '') !== 'task'; });
  const rank = { trunk: 0, scene: 1, detail: 2 };
  ordered.sort(function (a, b) {
    const la = rank[layerOf(a, cfg)]; const lb = rank[layerOf(b, cfg)];
    return la - lb || Number(b.importance || 0) - Number(a.importance || 0) || Number(b.hit_count || 0) - Number(a.hit_count || 0);
  });
  for (const r of ordered) {
    if (lines.length >= cap) { truncated = true; break; }
    const layer = layerOf(r, cfg);
    if (layer === 'detail') { truncated = true; break; }
    const head = (layer === 'trunk' ? '★ ' : '· ') + String(r.title || '').slice(0, 70);
    const cost = estimateTokens(head, cfg) + 1;
    if (spent + cost > maxTokens) { truncated = true; break; }
    spent += cost;
    lines.push(head);
  }
  const body = lines.join('\n');
  return {
    partition: part.name,
    text: body,
    items: lines.length,
    tokens: estimateTokens(body, cfg),
    budget: maxTokens,
    truncated: truncated,
    layerCounts: rows.reduce(function (acc, r) { const l = layerOf(r, cfg); acc[l] = (acc[l] || 0) + 1; return acc; }, { trunk: 0, scene: 0, detail: 0 })
  };
}

// 主干强化系数：每次成功调用/手工 reinforce 乘一把，随时间缓慢衰减回 1（不会一下归零）
export function boostOf(item, cfg) {
  const c = curveCfg(cfg);
  const max = Math.max(1, Number(c.trunkBoostMax || 4));
  const raw = Math.min(max, Math.max(1, Number((item && item.boost) || 1)));
  const decayDays = Number(c.trunkBoostDecayDays || 30);
  const at = Number((item && item.boost_at) || 0);
  if (!at || !decayDays) return raw;
  const days = Math.max(0, (nowMs() - at) / 86400000);
  const decayed = 1 + (raw - 1) * Math.exp(-days / decayDays);
  return Math.min(max, Math.max(1, decayed));
}

export function effectiveStability(item, cfg) {
  const c = curveCfg(cfg);
  const s = Math.max(0.05, Number(item.stability || c.stabilityBaseDays || 7));
  return isTrunk(item, cfg) ? s * boostOf(item, cfg) : s;
}

export function retentionOf(item, now, cfg) {
  const c = curveCfg(cfg);
  const s = effectiveStability(item, cfg);
  const last = Number(item.last_access_at || item.updated_at || item.created_at || now);
  const days = Math.max(0, (now - last) / 86400000);
  const base = Math.exp(-days / s);
  if (!isTrunk(item, cfg)) return base;
  // 主干曲线：有地板（trunkFloor），被冷落也只会降到地板附近，而不是无限趋零
  const floor = Math.min(0.95, Math.max(0, Number(c.trunkFloor === undefined ? 0.55 : c.trunkFloor)));
  return floor + (1 - floor) * base;
}

export function projectCurve(item, cfg, days) {
  const c = curveCfg(cfg);
  const span = Number(days || c.displayDays || 120);
  const s = effectiveStability(item, cfg);
  const trunk = isTrunk(item, cfg);
  const floor = trunk ? Math.min(0.95, Math.max(0, Number(c.trunkFloor === undefined ? 0.55 : c.trunkFloor))) : 0;
  const last = Number(item.last_access_at || item.updated_at || item.created_at || nowMs());
  const pts = [];
  const step = Math.max(1, Math.round(span / 60));
  for (let d = 0; d <= span; d += step) {
    const dt = (nowMs() - last) / 86400000 + d;
    const base = Math.exp(-dt / s);
    pts.push({ day: d, retention: trunk ? floor + (1 - floor) * base : base });
  }
  return { item: item.id, id: item.id, title: String(item.title || ''), stability: Number(s.toFixed(3)), baseStability: Number(Number(item.stability || 0).toFixed(3)), boost: Number(boostOf(item, cfg).toFixed(3)), trunk: trunk, floor: floor, points: pts };
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

export function hydrate(row, cfg) {
  const o = Object.assign({}, row);
  o.tags = jsonParse(row.tags, []);
  o.pinned = !!row.pinned;
  o.layer = layerOf(row, cfg);
  return o;
}

// 「任务开启：…」这类脚手架条目不算知识：不进召回候选、不进主干、不进合并（仍可用 search 翻到）
const NOT_SCAFFOLD = " AND kind NOT IN ('task')";

function candidateItems(store, partId, includeDormant, ids) {
  const base = includeDormant
    ? "SELECT * FROM item WHERE partition_id = ? AND state NOT IN ('archived','deleted') AND superseded_by IS NULL" + NOT_SCAFFOLD
    : "SELECT * FROM item WHERE partition_id = ? AND state = 'active' AND superseded_by IS NULL AND deleted_at IS NULL" + NOT_SCAFFOLD;
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
    ? "SELECT * FROM item WHERE partition_id = ? AND state NOT IN ('archived','deleted') AND superseded_by IS NULL" + NOT_SCAFFOLD
    : "SELECT * FROM item WHERE partition_id = ? AND state = 'active' AND superseded_by IS NULL AND deleted_at IS NULL" + NOT_SCAFFOLD;
  return store.db.prepare(base + ' AND id NOT IN (SELECT item_id FROM item_vector WHERE partition_id = ? AND model = ?)')
    .all(partId, partId, String(model || ''));
}

// 主干候选：钉住的 + 重要度达标的，永远绕开 ANN 预筛，保证「该记得的」不会被近似检索漏掉
function trunkItems(store, partId, includeDormant) {
  const minImp = Number((store.config.curve || {}).trunkImportance || 4);
  const base = includeDormant
    ? "SELECT * FROM item WHERE partition_id = ? AND (pinned = 1 OR importance >= ?) AND state NOT IN ('archived','deleted') AND superseded_by IS NULL" + NOT_SCAFFOLD
    : "SELECT * FROM item WHERE partition_id = ? AND (pinned = 1 OR importance >= ?) AND state = 'active' AND superseded_by IS NULL AND deleted_at IS NULL" + NOT_SCAFFOLD;
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
  const part = requirePartition(store, { name: input.partition || input.partitionName, title: input.partitionTitle });
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
  // token 预算：超了先降 detail（full→index），再超就丢分数最低的尾部条目，绝不把整批硬塞进上下文
  const budget = Math.max(0, Number(input.budget === undefined ? (cfg.recall.budgetTokens || 1200) : input.budget));
  const out = [];
  let totalTokens = 0;
  let budgetDropped = 0;
  let budgetDowngraded = 0;
  for (const x of chosen) {
    const seen = repeat.get(x.item.id) || 0;
    const redundant = seen >= Number(cfg.recall.maxRepeatReads || 3);
    const rawBody = redundant ? '' : String(x.item.body || '');
    const indexBody = rawBody.slice(0, bodyLimit) + (rawBody.length > bodyLimit ? '…' : '');
    let useFull = detail === 'full' || (detail === 'auto' && !redundant);
    let body = useFull ? rawBody : indexBody;
    let tokens = estimateTokens(String(x.item.title || '') + body, cfg);
    if (budget > 0 && totalTokens + tokens > budget) {
      const idxTokens = estimateTokens(String(x.item.title || '') + indexBody, cfg);
      if (useFull && totalTokens + idxTokens <= budget) {
        useFull = false;
        body = indexBody;
        tokens = idxTokens;
        budgetDowngraded += 1;
      } else {
        budgetDropped += 1;
        continue;
      }
    }
    if (redundant) redundantCount += 1;
    totalTokens += tokens;
    out.push({
      id: x.item.id,
      title: x.item.title,
      body: body,
      bodyTruncated: !useFull && rawBody.length > bodyLimit,
      detail: useFull ? 'full' : 'index',
      kind: x.item.kind,
      layer: layerOf(x.item, cfg),
      tags: jsonParse(x.item.tags, []),
      importance: x.item.importance,
      pinned: !!x.item.pinned,
      state: x.item.state,
      tokens: tokens,
      score: Number(x.score.toFixed(4)),
      relevance: Number(x.relevance.toFixed(4)),
      cos: Number(Number(x.cos || 0).toFixed(4)),
      retention: Number(x.retention.toFixed(4)),
      stability: Number(x.item.stability.toFixed(2)),
      redundant: redundant,
      repeatReads: seen,
      captions: String(x.item.caption_text || '').slice(0, 200)
    });
  }

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
    totalTokens: totalTokens,
    budgetTokens: budget,
    budgetDropped: budgetDropped,
    budgetDowngraded: budgetDowngraded,
    layer: 'index',
    tookMs: latency,
    redundant: redundantCount,
    candidates: items.length,
    annUsed: annUsed,
    guard: null
  };
}

// FSRS 式一遍复习：用对 → 稳定度按难度加成上升、难度下降；用错 → 稳定度跳水、难度上升；主干额外涨强化系数
export function reviewItem(item, success, cfg) {
  const c = curveCfg(cfg);
  const maxS = Number(c.maxStabilityDays || 3650);
  const dMin = Number(c.difficultyMin || 1);
  const dMax = Number(c.difficultyMax || 10);
  const now = nowMs();
  let s = Math.max(0.5, Number(item.stability || c.stabilityBaseDays || 7));
  let d = clamp(Number(item.difficulty === undefined || item.difficulty === null ? (c.difficultyInit || 5) : item.difficulty), dMin, dMax);
  let boost = Math.max(1, Number(item.boost || 1));
  let boostAt = Number(item.boost_at || 0);
  const reviews = Number(item.reviews || 0) + 1;
  let lapses = Number(item.lapses || 0);
  const step = Number(c.difficultyStep || 0.35);
  if (success) {
    const ease = 1 - (d - dMin) / Math.max(0.001, dMax - dMin);
    const lo = Number(c.successFactorMin || 1.15);
    const hi = Number(c.successFactorMax || 2.6);
    s = Math.min(maxS, s * (lo + (hi - lo) * ease));
    d = Math.max(dMin, d - step);
    if (isTrunk(item, cfg)) {
      boost = Math.min(Number(c.trunkBoostMax || 4), boost * Number(c.trunkBoostGrowth || 1.35));
      boostAt = now;
    }
  } else {
    s = Math.max(0.5, s * Number(c.lapseFactor || 0.45));
    d = Math.min(dMax, d + step);
    lapses += 1;
  }
  return { stability: s, difficulty: d, reviews: reviews, lapses: lapses, boost: boost, boost_at: boostAt || now, last_review_at: now };
}

export function feedback(store, input) {
  const db = store.db;
  const ev = db.prepare('SELECT * FROM recall_event WHERE id = ?').get(String(input.eventId || ''));
  if (!ev) throw new Error('unknown recall event: ' + input.eventId);
  const used = input.used === false || input.used === 0 ? 0 : 1;
  db.prepare('UPDATE recall_event SET used = ? WHERE id = ?').run(used, ev.id);
  store.shadow.append('recall_event', db.prepare('SELECT * FROM recall_event WHERE id = ?').get(ev.id));
  const cfg = store.config;
  const ids = jsonParse(ev.items, []);
  let affected = 0;
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
    if (!row) continue;
    const next = reviewItem(row, used === 1, cfg);
    db.prepare('UPDATE item SET hit_count = hit_count + ?, last_access_at = ?, stability = ?, difficulty = ?, reviews = ?, lapses = ?, boost = ?, boost_at = ?, last_review_at = ? WHERE id = ?')
      .run(used ? 1 : 0, nowMs(), next.stability, next.difficulty, next.reviews, next.lapses, next.boost, next.boost_at, next.last_review_at, id);
    store.shadow.append('item', db.prepare('SELECT * FROM item WHERE id = ?').get(id));
    affected += 1;
  }
  return { eventId: ev.id, used: used, items: ids.length, affected: affected };
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
  const guards = db.prepare("SELECT level, COUNT(*) AS n FROM guard_event WHERE deleted_at IS NULL GROUP BY level").all();
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
    const h = hydrate(r, store.config);
    h.retention = Number(retentionOf(r, now, store.config).toFixed(4));
    return h;
  });
}
// ---- 主干强化：手工/自动给某条记忆加一把（stability 与 boost 同时乘）----
export function reinforce(store, input) {
  const db = store.db;
  const cfg = store.config;
  const row = db.prepare('SELECT * FROM item WHERE id = ?').get(String((input && input.id) || ''));
  if (!row) throw new Error('unknown item: ' + (input && input.id));
  const c = curveCfg(cfg);
  const maxS = Number(c.maxStabilityDays || 3650);
  const maxB = Math.max(1, Number(c.trunkBoostMax || 4));
  const growth = Math.max(1, Number((input && input.strength) || c.reinforceGrowth || 1.2));
  const now = nowMs();
  const before = { stability: Number(row.stability || 0), boost: Number(row.boost || 1), difficulty: Number(row.difficulty || 0) };
  const nextS = Math.min(maxS, Math.max(0.5, before.stability || Number(c.stabilityBaseDays || 7)) * growth);
  const nextB = Math.min(maxB, Math.max(1, before.boost) * growth);
  db.prepare('UPDATE item SET stability = ?, boost = ?, boost_at = ?, last_review_at = ?, last_access_at = ?, updated_at = ? WHERE id = ?')
    .run(nextS, nextB, now, now, now, now, row.id);
  const fresh = db.prepare('SELECT * FROM item WHERE id = ?').get(row.id);
  store.shadow.append('item', fresh);
  return { item: hydrate(fresh), before: before, after: { stability: Number(nextS.toFixed(3)), boost: Number(nextB.toFixed(3)) }, growth: growth, reason: String((input && input.reason) || 'manual') };
}

// ---- 主干快照：谁能豁免衰老、强化到什么程度 ----
export function trunkSnapshot(store, partitionId) {
  const cfg = store.config;
  const c = curveCfg(cfg);
  const now = nowMs();
  const trunkMin = Number(c.trunkImportance || 4);
  const sql = 'SELECT * FROM item WHERE deleted_at IS NULL AND state != ' + "'deleted'" + ' AND (pinned = 1 OR importance >= ?)' + NOT_SCAFFOLD + (partitionId ? ' AND partition_id = ?' : '') + ' ORDER BY importance DESC, hit_count DESC, updated_at DESC';
  const stmt = store.db.prepare(sql);
  const rows = partitionId ? stmt.all(trunkMin, Number(partitionId)) : stmt.all(trunkMin);
  return rows.map(function (r) {
    return {
      id: r.id, partition_id: r.partition_id, title: r.title, kind: r.kind, importance: Number(r.importance || 0), pinned: !!r.pinned,
      stability: Number(Number(r.stability || 0).toFixed(2)), boost: Number(boostOf(r, cfg).toFixed(2)), effectiveStability: Number(effectiveStability(r, cfg).toFixed(2)),
      retention: Number(retentionOf(r, now, cfg).toFixed(4)), reviews: Number(r.reviews || 0), lapses: Number(r.lapses || 0),
      difficulty: Number(Number(r.difficulty === undefined || r.difficulty === null ? 5 : r.difficulty).toFixed(2)), last_review_at: r.last_review_at || null
    };
  });
}

// ---- 自动合并：向量相近的重复条目并成一条主干（默认只预演）----
export function mergeSimilar(store, input) {
  const o = input || {};
  const db = store.db;
  const cfg = store.config;
  const threshold = Math.min(0.999, Math.max(0.3, Number(o.threshold || 0.6)));
  const maxGroups = Math.max(1, Number(o.maxGroups || 20));
  const sql = 'SELECT * FROM item WHERE deleted_at IS NULL AND state = ' + "'active'" + NOT_SCAFFOLD + (o.partitionId ? ' AND partition_id = ?' : '');
  const stmt = db.prepare(sql);
  const rows = o.partitionId ? stmt.all(Number(o.partitionId)) : stmt.all();
  const dims = Number((cfg.vector && cfg.vector.dims) || 256);
  const vecs = rows.map(function (r) {
    try { return vector.embedLocal(String(r.title || '') + ' ' + String(r.body || '').slice(0, 400), dims); }
    catch (err) { return null; }
  });
  // 本地哈希向量对近义改写不敏感，所以再叠一层词面 Jaccard：取两者较大值
  const sets = rows.map(function (r) { return new Set(tokenize(String(r.title || '') + ' ' + String(r.body || ''))); });
  function simOf(i, j) {
    let cos = 0;
    if (vecs[i] && vecs[j]) cos = Math.max(0, vector.cosine(vecs[i], vecs[j]));
    let inter = 0;
    const a = sets[i]; const b = sets[j];
    if (a.size && b.size) { for (const t of a) if (b.has(t)) inter += 1; }
    const jac = (a.size && b.size) ? inter / (a.size + b.size - inter) : 0;
    return Math.max(cos, jac);
  }
  const used = new Array(rows.length).fill(false);
  const groups = [];
  for (let i = 0; i < rows.length; i++) {
    if (used[i] || !vecs[i]) continue;
    const cluster = [i];
    for (let j = i + 1; j < rows.length; j++) {
      if (used[j] || !vecs[j]) continue;
      if (simOf(i, j) >= threshold) cluster.push(j);
    }
    if (cluster.length < 2) continue;
    for (const idx of cluster) used[idx] = true;
    cluster.sort(function (a, b) {
      const ra = rows[a]; const rb = rows[b];
      return (Number(rb.importance || 0) - Number(ra.importance || 0)) || (Number(rb.hit_count || 0) - Number(ra.hit_count || 0)) || (Number(rb.updated_at || 0) - Number(ra.updated_at || 0));
    });
    const keeperIdx = cluster[0];
    const keeper = rows[keeperIdx];
    const members = cluster.slice(1).map(function (idx) {
      return { id: rows[idx].id, title: rows[idx].title, kind: rows[idx].kind, score: Number(simOf(keeperIdx, idx).toFixed(4)) };
    });
    groups.push({ keeper: { id: keeper.id, title: keeper.title, kind: keeper.kind, partition_id: keeper.partition_id }, members: members });
    if (groups.length >= maxGroups) break;
  }
  if (!o.apply) return { dryRun: true, threshold: threshold, candidates: rows.length, groups: groups, merged: 0 };
  const now = nowMs();
  let merged = 0;
  const touched = [];
  for (const g of groups) {
    const keeper = db.prepare('SELECT * FROM item WHERE id = ?').get(g.keeper.id);
    if (!keeper) continue;
    const lines = [];
    let importance = Number(keeper.importance || 0);
    let pinned = Number(keeper.pinned || 0);
    for (const m of g.members) {
      const row = db.prepare('SELECT * FROM item WHERE id = ?').get(m.id);
      if (!row) continue;
      const snippet = String(row.body || '').replace(/\s+/g, ' ').slice(0, 160);
      lines.push('· 合并自《' + String(row.title || '').slice(0, 60) + '》' + (snippet ? '：' + snippet : ''));
      importance = Math.max(importance, Number(row.importance || 0));
      pinned = pinned || Number(row.pinned || 0);
      db.prepare('UPDATE item SET state = ' + "'archived'" + ', superseded_by = ?, updated_at = ? WHERE id = ?').run(keeper.id, now, row.id);
      store.shadow.append('item', db.prepare('SELECT * FROM item WHERE id = ?').get(row.id));
      merged += 1;
    }
    if (!lines.length) continue;
    const body = String(keeper.body || '') + '\n\n—— 自动合并（' + new Date(now).toISOString().slice(0, 10) + '）\n' + lines.join('\n');
    db.prepare('UPDATE item SET body = ?, importance = ?, pinned = ?, updated_at = ?, boost = MIN(?, COALESCE(boost, 1) * 1.1), boost_at = ? WHERE id = ?')
      .run(body.slice(0, 12000), importance, pinned, now, Math.max(1, Number(cfg.curve.trunkBoostMax || 4)), now, keeper.id);
    store.shadow.append('item', db.prepare('SELECT * FROM item WHERE id = ?').get(keeper.id));
    touched.push(keeper.id);
  }
  return { dryRun: false, threshold: threshold, groups: groups, merged: merged, keepers: touched };
}

// ---- 任务收尾：把这次任务的结论并进分区主干，并加一把强化 ----
export function archiveTrunk(store, input) {
  const o = input || {};
  const db = store.db;
  const part = ensurePartition(store, { name: o.partition || o.partitionName, title: o.partitionTitle });
  const now = nowMs();
  const stamp = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
  const lines = ['## ' + stamp + ' · ' + String(o.title || '会话收尾')];
  if (o.summary) lines.push(String(o.summary).trim());
  const recent = db.prepare('SELECT id, title, body, kind, importance FROM item WHERE partition_id = ? AND deleted_at IS NULL AND state = ' + "'active'" + " AND kind NOT IN ('trunk','report','task','scene') AND updated_at >= ?" + ' ORDER BY importance DESC, updated_at DESC LIMIT 8')
    .all(part.id, now - 2 * 86400000);
  for (const r of recent) {
    const snippet = String(r.body || '').replace(/\s+/g, ' ').slice(0, 120);
    lines.push('· ' + String(r.title || '').slice(0, 60) + (snippet ? '：' + snippet : ''));
  }
  const section = lines.join('\n');
  const existing = db.prepare("SELECT * FROM item WHERE partition_id = ? AND kind = 'trunk' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1").get(part.id);
  let itemId = '';
  let created = false;
  if (existing) {
    const body = (String(existing.body || '') + '\n\n' + section).slice(-12000);
    db.prepare('UPDATE item SET body = ?, updated_at = ?, importance = 5, pinned = 1 WHERE id = ?').run(body, now, existing.id);
    store.shadow.append('item', db.prepare('SELECT * FROM item WHERE id = ?').get(existing.id));
    itemId = existing.id;
  } else {
    const res = remember(store, { partition: part.name, kind: 'trunk', title: '主干：' + part.name + ' 当前结论', body: section, importance: 5, pinned: true, tags: ['trunk'], source: 'trunk-archive' });
    itemId = res.item.id;
    created = true;
  }
  const boost = reinforce(store, { id: itemId, strength: Number(o.strength || store.config.curve.trunkBoostGrowth || 1.35), reason: 'task-archive' });
  return { partition: part.name, itemId: itemId, created: created, consolidated: recent.length, boost: boost.after };
}

// ---- 任务收尾的分层压缩：主干追加一节 + 一条「场景」收束（同一 task 幂等），细节条目原样留库 ----
export function consolidate(store, input) {
  const o = input || {};
  const db = store.db;
  const part = requirePartition(store, { name: o.partition, title: o.partitionTitle });
  const now = nowMs();
  const title = String(o.title || '会话收尾').slice(0, 80);
  const out = { partition: part.name, trunk: null, scene: null, layers: null };
  try {
    out.trunk = archiveTrunk(store, { partition: part.name, title: title, summary: o.summary, strength: o.strength });
  } catch (err) {
    out.trunk = { error: String((err && err.message) || err) };
  }
  if (o.scene !== false) {
    const tag = o.taskId ? 'task:' + String(o.taskId) : '';
    let existing = null;
    if (tag) {
      existing = db.prepare("SELECT * FROM item WHERE partition_id = ? AND kind = 'scene' AND deleted_at IS NULL AND tags LIKE ? ORDER BY updated_at DESC LIMIT 1")
        .get(part.id, '%' + tag + '%') || null;
    }
    const memoryIds = Array.isArray(o.itemIds) ? o.itemIds.slice(0, 12) : [];
    const lines = [String(o.summary || '').trim()].filter(Boolean);
    if (memoryIds.length) lines.push('关键条目：' + memoryIds.join('、'));
    if (o.reportPath) lines.push('汇报：' + String(o.reportPath));
    const body = lines.join('\n').slice(0, 4000);
    if (body) {
      if (existing) {
        db.prepare('UPDATE item SET body = ?, updated_at = ?, importance = MAX(importance, 3) WHERE id = ?').run(body, now, existing.id);
        store.shadow.append('item', db.prepare('SELECT * FROM item WHERE id = ?').get(existing.id));
        out.scene = { id: existing.id, created: false, tokens: estimateTokens(body, store.config) };
      } else {
        const res = remember(store, {
          partition: part.name, kind: 'scene', title: '场景：' + title, body: body,
          importance: 3, pinned: false, tags: ['scene'].concat(tag ? [tag] : []), source: 'consolidate'
        });
        out.scene = { id: res.item.id, created: true, tokens: estimateTokens(body, store.config) };
      }
    }
  }
  const rows = db.prepare("SELECT kind, pinned, importance FROM item WHERE partition_id = ? AND deleted_at IS NULL AND state != 'deleted'").all(part.id);
  out.layers = rows.reduce(function (acc, r) { const l = layerOf(r, store.config); acc[l] += 1; return acc; }, { trunk: 0, scene: 0, detail: 0 });
  return out;
}

// ---- 检索评测：用条目自己的标题当查询，比较不同权重下的命中率与 token 成本 ----
export function evalRetrieval(store, input) {
  const o = input || {};
  const db = store.db;
  const cfg = store.config;
  const part = o.partitionId ? { id: Number(o.partitionId), name: String(o.partition || '') } : requirePartition(store, { name: o.partition });
  const topK = Math.max(1, Number(o.topK || 5));
  const limit = Math.max(1, Number(o.limit || 40));
  const dims = Number((cfg.vector && cfg.vector.dims) || 256);
  const idxChars = Number((cfg.recall && cfg.recall.indexBodyChars) || 90);
  const charsPerToken = Number((cfg.tokens && cfg.tokens.charsPerToken) || 1.7);
  const rows = db.prepare('SELECT * FROM item WHERE partition_id = ? AND deleted_at IS NULL AND state != ' + "'deleted'" + ' ORDER BY importance DESC, updated_at DESC LIMIT ?').all(part.id, limit);
  const items = rows.map(function (r) {
    const text = String(r.title || '') + ' ' + String(r.body || '');
    return { row: r, tokens: tokenize(text), vec: vector.embedLocal(text.slice(0, 800), dims), ret: retentionOf(r, nowMs(), cfg), imp: Number(r.importance || 3) };
  });
  const variants = [
    { name: 'current', wRel: Number(cfg.recall.weightRelevance || 1), vw: Number((cfg.vector && cfg.vector.vectorWeight) || 0) },
    { name: 'keyword-only', wRel: Number(cfg.recall.weightRelevance || 1), vw: 0 },
    { name: 'vector-heavy', wRel: Number(cfg.recall.weightRelevance || 1), vw: Math.min(2, Number((cfg.vector && cfg.vector.vectorWeight) || 0) * 2) }
  ];
  const out = variants.map(function (v) {
    let hits = 0;
    let tokens = 0;
    let rr = 0;
    for (const self of items) {
      const q = tokenize(String(self.row.title || ''));
      const scored = items.map(function (it) {
        let overlap = 0;
        if (q.length) {
          const set = new Set(it.tokens);
          let n = 0;
          for (const t of q) if (set.has(t)) n += 1;
          overlap = n / q.length;
        }
        const cos = v.vw > 0 ? Math.max(0, vector.cosine(vector.embedLocal(String(self.row.title || ''), dims), it.vec)) : 0;
        const blended = v.wRel * overlap + v.vw * cos;
        const score = blended * (0.35 + Number(cfg.recall.weightRetention || 0.65) * it.ret) * (0.7 + it.imp / 5) + (it.row.pinned ? Number(cfg.recall.pinnedBoost || 0.15) : 0);
        return { id: it.row.id, score: score, chars: Math.min(idxChars, String(it.row.body || '').length) };
      }).sort(function (a, b) { return b.score - a.score; }).slice(0, topK);
      const rank = scored.findIndex(function (s) { return s.id === self.row.id; });
      if (rank >= 0) { hits += 1; rr += 1 / (rank + 1); }
      tokens += scored.reduce(function (n, s) { return n + s.chars; }, 0) / charsPerToken;
    }
    return { name: v.name, queries: items.length, hitRate: items.length ? Number((hits / items.length).toFixed(4)) : 0, mrr: items.length ? Number((rr / items.length).toFixed(4)) : 0, avgTokens: items.length ? Math.round(tokens / items.length) : 0 };
  });
  return { partition: part.name, topK: topK, queries: items.length, variants: out };
}
