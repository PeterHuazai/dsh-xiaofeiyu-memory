import crypto from 'node:crypto';
import * as vecIndex from './vec-index.mjs';

// 多维向量存储：默认用本地确定性哈希向量（离线、零 token、微秒级），
// 需要真语义时可配 OpenAI 兼容 embeddings 接口，用 mem reindex 把向量换掉。
const LOCAL_MODEL = 'local-hash';

export function vectorCfg(store) {
  const v = (store.config && store.config.vector) || {};
  const p = v.provider || {};
  return {
    enabled: v.enabled === undefined ? true : !!v.enabled,
    dims: Number(v.dims || 256),
    vectorWeight: v.vectorWeight === undefined ? 0.6 : Number(v.vectorWeight),
    vectorFloor: v.vectorFloor === undefined ? 0.15 : Number(v.vectorFloor),
    fpWeight: v.fpWeight === undefined ? 1.5 : Number(v.fpWeight),
    backend: String(v.backend || 'sqlite'),
    provider: {
      enabled: !!p.enabled,
      endpoint: String(p.endpoint || ''),
      model: String(p.model || ''),
      apiKeyEnv: String(p.apiKeyEnv || 'MEMORY_EMBED_API_KEY'),
      batchSize: Number(p.batchSize || 32),
      timeoutMs: Number(p.timeoutMs || 20000)
    }
  };
}

function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function vectorTokens(text) {
  const out = [];
  const raw = String(text || '').toLowerCase();
  const latin = raw.match(/[a-z0-9_]{2,}/g) || [];
  for (const w of latin) out.push(w);
  const han = raw.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of han) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    for (let i = 0; i < run.length - 2; i++) out.push(run.slice(i, i + 3));
  }
  return out;
}

export function embedLocal(text, dims) {
  const d = Number(dims || 256);
  const vec = new Float32Array(d);
  const toks = vectorTokens(text);
  for (const t of toks) {
    const h = fnv1a(t);
    const idx = h % d;
    const sign = (h >>> 15) & 1 ? -1 : 1;
    vec[idx] += sign * (1 + Math.log(1 + t.length));
  }
  return normalize(vec);
}

export function normalize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n);
  if (!n) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / n;
  return vec;
}

export function toBlob(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function fromBlob(buf, dims) {
  const copy = Buffer.from(buf);
  const f = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  if (dims && f.length !== Number(dims)) return null;
  return f;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function itemText(item) {
  const tags = Array.isArray(item.tags) ? item.tags.join(' ') : String(item.tags || '');
  return [item.title, item.body, tags, item.caption_text || ''].join(' ');
}

// DeepSeek 语义指纹（用了它才真的算「用上 token API」：把一条记忆压成同义词/上位词/可能的问法，
// 再喂给本地向量，等于用很少的 token 换来「同义改写也能召回」。指纹按原文 hash 缓存，只算一次。
export function fingerprintFor(store, baseText) {
  const h = textHash(baseText);
  const row = store.db.prepare('SELECT text FROM semantic_cache WHERE text_hash = ?').get(h);
  return row ? String(row.text) : '';
}

export function captionTextFor(store, itemId) {
  const rows = store.db.prepare("SELECT caption FROM attachment WHERE item_id = ? AND caption != ''").all(String(itemId));
  return rows.map(function (r) { return String(r.caption); }).join(' ');
}

export function indexText(store, item) {
  const base = (itemText(item) + ' ' + captionTextFor(store, item.id)).trim();
  const fp = fingerprintFor(store, base);
  return fp ? base + ' ' + fp : base;
}

export function textHash(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

// 读条目向量：命中缓存直接用，缺失或正文变了就现算并落库（惰性补齐）。
export function itemVector(store, item, opts) {
  const o = opts || {};
  const cfg = vectorCfg(store);
  if (!cfg.enabled) return null;
  const text = indexText(store, item);
  const h = textHash(text);
  // 指纹单独成向量后加权重混入：短查询的余弦会被稀释，混权重才让「同义改写」真的起作用
  const mixVector = function () {
    const base = (itemText(item) + ' ' + captionTextFor(store, item.id)).trim();
    const fp = fingerprintFor(store, base);
    const bv = embedLocal(base, cfg.dims);
    if (!fp) return bv;
    const fv = embedLocal(fp, cfg.dims);
    const acc = new Float32Array(cfg.dims);
    for (let i = 0; i < acc.length; i++) acc[i] = bv[i] + cfg.fpWeight * fv[i];
    return normalize(acc);
  };
  const row = store.db.prepare('SELECT * FROM item_vector WHERE item_id = ?').get(item.id);
  if (row && row.text_hash === h) {
    const vec = fromBlob(row.vec, row.dims);
    if (vec) return { model: row.model, dims: row.dims, vec: vec };
  }
  if (o.readOnly) return null;
  const model = LOCAL_MODEL + '-' + cfg.dims;
  const vec = mixVector();
  store.db.prepare('INSERT OR REPLACE INTO item_vector (item_id, partition_id, model, dims, vec, text_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(item.id, item.partition_id, model, cfg.dims, toBlob(vec), h, Date.now());
  // ANN 索引是加速副本，写失败只记在 backend.status 里，绝不影响召回
  vecIndex.upsert(store, item.id, item.partition_id, vec);
  return { model: model, dims: cfg.dims, vec: vec };
}

export function queryVector(store, text, provided) {
  const cfg = vectorCfg(store);
  if (!cfg.enabled) return null;
  if (provided && provided.vec) {
    const arr = provided.vec instanceof Float32Array ? provided.vec : Float32Array.from(provided.vec);
    return { model: String(provided.model || 'provided'), dims: arr.length, vec: normalize(arr) };
  }
  const dims = cfg.dims;
  return { model: LOCAL_MODEL + '-' + dims, dims: dims, vec: embedLocal(text, dims) };
}

export function vectorStatus(store) {
  const cfg = vectorCfg(store);
  const total = store.db.prepare("SELECT COUNT(*) AS n FROM item WHERE state != 'deleted'").get().n;
  const covered = store.db.prepare('SELECT COUNT(*) AS n FROM item_vector').get().n;
  const models = store.db.prepare('SELECT model, COUNT(*) AS n FROM item_vector GROUP BY model').all();
  const key = process.env[cfg.provider.apiKeyEnv];
  return {
    enabled: cfg.enabled,
    dims: cfg.dims,
    vectorWeight: cfg.vectorWeight,
    vectorFloor: cfg.vectorFloor,
    fpWeight: cfg.fpWeight,
    items: total,
    covered: covered,
    coverage: total ? Number((covered / total).toFixed(3)) : 1,
    models: models,
    provider: {
      enabled: cfg.provider.enabled,
      endpoint: cfg.provider.endpoint || null,
      model: cfg.provider.model || null,
      apiKeyEnv: cfg.provider.apiKeyEnv,
      apiKeyPresent: !!key,
      ready: !!(cfg.provider.enabled && cfg.provider.endpoint && cfg.provider.model && key)
    },
    deepseek: (function () {
      const d = deepseekCfg(store);
      const dk = process.env[d.apiKeyEnv];
      return { enabled: d.enabled, model: d.model, apiKeyEnv: d.apiKeyEnv, apiKeyPresent: !!dk, ready: !!(d.enabled && dk) };
    })()
  };
}

export async function embedRemote(store, texts) {
  const cfg = vectorCfg(store);
  const p = cfg.provider;
  if (!p.enabled) throw new Error('远程向量未开启（vector.provider.enabled=false）');
  if (!p.endpoint) throw new Error('缺少 vector.provider.endpoint');
  if (!p.model) throw new Error('缺少 vector.provider.model');
  const key = process.env[p.apiKeyEnv];
  if (!key) throw new Error('环境变量 ' + p.apiKeyEnv + ' 里没有 API Key');

  const out = [];
  for (let i = 0; i < texts.length; i += p.batchSize) {
    const batch = texts.slice(i, i + p.batchSize);
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, p.timeoutMs);
    let payload;
    try {
      const res = await fetch(p.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        signal: ctrl.signal,
        body: JSON.stringify({ model: p.model, input: batch })
      });
      if (!res.ok) throw new Error('embeddings 返回 ' + res.status + '：' + (await res.text()).slice(0, 200));
      payload = await res.json();
    } finally { clearTimeout(timer); }
    const data = payload.data || [];
    for (let k = 0; k < batch.length; k++) out.push(Array.isArray(data[k] && data[k].embedding) ? data[k].embedding : null);
  }
  return out;
}

export async function reindex(store, input) {
  const o = input || {};
  const cfg = vectorCfg(store);
  if (!cfg.enabled) throw new Error('向量功能已关闭（vector.enabled=false）');
  const pid = o.partitionId || null;
  const sql = "SELECT * FROM item WHERE state != 'deleted'" + (pid ? ' AND partition_id = ?' : '');
  const stmt = store.db.prepare(sql);
  const items = pid ? stmt.all(pid) : stmt.all();
  const useProvider = o.provider !== undefined ? !!o.provider : cfg.provider.enabled;
  if (!useProvider) {
    // 本地重算：只清本次范围内的行，按分区调用时不能把其它分区的向量一起删掉
    if (pid) store.db.prepare('DELETE FROM item_vector WHERE partition_id = ?').run(pid);
    else store.db.exec('DELETE FROM item_vector');
    vecIndex.clear(store, pid);
    for (const it of items) itemVector(store, it);
    return { model: LOCAL_MODEL + '-' + cfg.dims, items: items.length, dims: cfg.dims };
  }
  const model = cfg.provider.model;
  const texts = items.map(function (it) { return indexText(store, it); });
  const vecs = await embedRemote(store, texts);
  let written = 0, failed = 0;
  const dims = vecs.find(function (v) { return v && v.length; });
  const dim = dims ? dims.length : 0;
  for (let i = 0; i < items.length; i++) {
    const v = vecs[i];
    if (!v || !v.length) { failed += 1; continue; }
    const f = normalize(Float32Array.from(v));
    store.db.prepare('INSERT OR REPLACE INTO item_vector (item_id, partition_id, model, dims, vec, text_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(items[i].id, items[i].partition_id, model, f.length, toBlob(f), textHash(texts[i]), Date.now());
    vecIndex.upsert(store, items[i].id, items[i].partition_id, f);
    written += 1;
  }
  return { model: model, dims: dim, items: items.length, written: written, failed: failed };
}

export function deepseekCfg(store) {
  const d = ((store.config && store.config.vector) || {}).deepseek || {};
  return {
    enabled: !!d.enabled,
    endpoint: String(d.endpoint || 'https://api.deepseek.com/chat/completions'),
    model: String(d.model || 'deepseek-chat'),
    apiKeyEnv: String(d.apiKeyEnv || 'DEEPSEEK_API_KEY'),
    timeoutMs: Number(d.timeoutMs || 30000),
    maxItemsPerRun: Number(d.maxItemsPerRun || 50)
  };
}

const ENRICH_PROMPT = '把下面这条记忆压成一段「检索指纹」：同义词、上位词、别人可能用来提问的措辞，逗号分隔，40 字以内，只输出这一行，不要解释。';

export async function enrichSemantics(store, input) {
  const o = input || {};
  const d = deepseekCfg(store);
  if (!d.enabled) throw new Error('DeepSeek 语义指纹未开启（vector.deepseek.enabled=false）。开启：mem config set vector.deepseek.enabled true');
  const key = process.env[d.apiKeyEnv];
  if (!key) throw new Error('环境变量 ' + d.apiKeyEnv + ' 里没有 API Key');
  const limit = Math.min(Number(o.limit || d.maxItemsPerRun), d.maxItemsPerRun);
  const pid = o.partitionId || null;
  const sql = "SELECT * FROM item WHERE state != 'deleted'" + (pid ? ' AND partition_id = ?' : '') + ' ORDER BY updated_at DESC';
  const stmt = store.db.prepare(sql);
  const items = pid ? stmt.all(pid) : stmt.all();
  let enriched = 0, skipped = 0, tokens = 0;
  const done = [];
  for (const it of items) {
    if (enriched >= limit) break;
    const base = itemText(it);
    const h = textHash(base);
    const has = store.db.prepare('SELECT 1 AS x FROM semantic_cache WHERE text_hash = ?').get(h);
    if (has) { skipped += 1; continue; }
    const prompt = ENRICH_PROMPT + '\n\n标题：' + it.title + '\n正文：' + String(it.body || '').slice(0, 800);
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, d.timeoutMs);
    let payload;
    try {
      const res = await fetch(d.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        signal: ctrl.signal,
        body: JSON.stringify({ model: d.model, max_tokens: 120, temperature: 0.2, messages: [{ role: 'user', content: prompt }] })
      });
      if (!res.ok) throw new Error('DeepSeek 返回 ' + res.status + '：' + (await res.text()).slice(0, 200));
      payload = await res.json();
    } finally { clearTimeout(timer); }
    const text = String(((payload.choices || [])[0] || {}).message ? payload.choices[0].message.content : '').trim();
    if (!text) { skipped += 1; continue; }
    tokens += Number((payload.usage || {}).total_tokens || 0);
    store.db.prepare('INSERT OR REPLACE INTO semantic_cache (text_hash, model, text, created_at) VALUES (?, ?, ?, ?)').run(h, d.model, text, Date.now());
    store.db.prepare('DELETE FROM item_vector WHERE item_id = ?').run(it.id);
    enriched += 1;
    done.push({ id: it.id, fingerprint: text });
  }
  return { model: d.model, scanned: items.length, enriched: enriched, skipped: skipped, tokens: tokens, items: done };
}

export function annBackend(store) {
  const cfg = vectorCfg(store);
  const st = vecIndex.vecState(store);
  const ext = !!st.available;
  let effective;
  if (!cfg.enabled) effective = 'disabled';
  else if (ext) effective = 'sqlite-vec';
  else if (cfg.backend === 'qdrant') effective = 'qdrant-bruteforce-fallback';
  else effective = 'sqlite-bruteforce';
  return {
    configured: cfg.backend,
    sqliteVecAvailable: ext,
    effective: effective,
    extensionPath: st.path,
    extensionVersion: st.version,
    indexDims: st.dims || null,
    indexed: vecIndex.indexedCount(store),
    error: st.error
  };
}

export function annDrop(store, itemId) { return vecIndex.remove(store, itemId); }

// ANN 候选：只有扩展真的在用时才返回 id 列表，否则 null 让调用方走全量精算
export function annCandidates(store, partitionId, qv, k) {
  const cfg = vectorCfg(store);
  if (!cfg.enabled || !qv) return null;
  if (!vecIndex.vecState(store).available) return null;
  const rows = vecIndex.knn(store, partitionId, qv.vec, k);
  if (!rows) return null;
  return rows.map(function (r) { return String(r.item_id); });
}
