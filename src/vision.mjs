import fs from 'node:fs';
import path from 'node:path';

// 多模态接入层：只负责「把图变成可检索的一句话」。
// 默认关闭——没配 endpoint / 没有 key 时直接给出可操作的错误，绝不偷偷联网。
export function visionConfig(store) {
  const mm = (store.config && store.config.multimodal) || {};
  const v = mm.vision || {};
  return {
    enabled: !!v.enabled,
    endpoint: String(v.endpoint || ''),
    model: String(v.model || ''),
    apiKeyEnv: String(v.apiKeyEnv || 'MEMORY_VISION_API_KEY'),
    timeoutMs: Number(v.timeoutMs || 15000),
    prompt: String(v.prompt || '用一句中文描述这张图片里与工作相关的内容：界面元素、报错文字、图表趋势。不要客套。')
  };
}

function apiKey(v) {
  const env = process.env[v.apiKeyEnv];
  return env ? String(env) : '';
}

function sniffMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

export function visionStatus(store) {
  const v = visionConfig(store);
  return {
    enabled: v.enabled,
    endpoint: v.endpoint || null,
    model: v.model || null,
    apiKeyEnv: v.apiKeyEnv,
    apiKeyPresent: !!apiKey(v),
    ready: !!(v.enabled && v.endpoint && v.model && apiKey(v)),
    hint: !v.enabled ? '视觉描述默认关闭：mem config set multimodal.vision.enabled true' : ''
  };
}

export async function describeImage(store, input) {
  const v = visionConfig(store);
  if (!v.enabled) throw new Error('视觉描述已关闭（multimodal.vision.enabled=false）。开启：mem config set multimodal.vision.enabled true，并配置 endpoint / model / 环境变量 ' + v.apiKeyEnv);
  if (!v.endpoint) throw new Error('缺少 multimodal.vision.endpoint（OpenAI 兼容的 /v1/chat/completions 地址）');
  if (!v.model) throw new Error('缺少 multimodal.vision.model');
  const key = apiKey(v);
  if (!key) throw new Error('环境变量 ' + v.apiKeyEnv + ' 里没有 API Key');

  let file = input.path || '';
  let mime = String(input.mime || '');
  if (!file && input.attachmentId) {
    const row = store.db.prepare('SELECT * FROM attachment WHERE id = ?').get(String(input.attachmentId));
    if (!row) throw new Error('unknown attachment: ' + input.attachmentId);
    file = row.path;
    mime = row.mime || mime;
  }
  if (!file) throw new Error('需要 path 或 attachmentId');
  if (!fs.existsSync(file)) throw new Error('文件不存在：' + file);
  mime = mime || sniffMime(file);

  const b64 = fs.readFileSync(file).toString('base64');
  const prompt = String(input.prompt || v.prompt);
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, v.timeoutMs);
  let payload;
  try {
    const res = await fetch(v.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: v.model,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } }
          ]
        }]
      })
    });
    if (!res.ok) throw new Error('视觉模型返回 ' + res.status + '：' + (await res.text()).slice(0, 300));
    payload = await res.json();
  } finally { clearTimeout(timer); }

  const choice = (payload.choices && payload.choices[0]) || {};
  const content = choice.message && choice.message.content;
  const caption = String(Array.isArray(content) ? content.map(function (c) { return c.text || ''; }).join(' ') : (content || '')).trim();
  if (!caption) throw new Error('视觉模型没有返回可用描述');

  const out = { caption: caption, model: v.model, tokens: payload.usage && payload.usage.total_tokens };
  if (input.attachmentId) {
    const row = store.db.prepare('SELECT * FROM attachment WHERE id = ?').get(String(input.attachmentId));
    store.db.prepare('UPDATE attachment SET caption = ? WHERE id = ?').run(caption, row.id);
    store.shadow.append('attachment', store.db.prepare('SELECT * FROM attachment WHERE id = ?').get(row.id));
    out.attachmentId = row.id;
  }
  return out;
}

// 批量描述：只处理还没有 caption 的附件（失败的不写库，重跑即重试）；逐条返回成败，绝不整体失败
export function captionStatus(store, opts) {
  const o = opts || {};
  const v = visionStatus(store);
  const rows = o.partitionId
    ? store.db.prepare("SELECT a.id, a.item_id, a.partition_id, a.caption, a.path, i.title FROM attachment a JOIN item i ON i.id = a.item_id WHERE a.partition_id = ? AND i.state != 'deleted'").all(String(o.partitionId))
    : store.db.prepare("SELECT a.id, a.item_id, a.partition_id, a.caption, a.path, i.title FROM attachment a JOIN item i ON i.id = a.item_id WHERE i.state != 'deleted'").all();
  let captioned = 0;
  const missing = [];
  for (const r of rows) {
    if (String(r.caption || '').trim()) captioned += 1;
    else missing.push({ attachmentId: r.id, itemId: r.item_id, title: r.title });
  }
  return { vision: v, total: rows.length, captioned: captioned, missing: missing.length, pending: missing.slice(0, 50) };
}

export async function batchCaption(store, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(200, Number(o.limit || 20)));
  const includeCaptioned = !!o.includeCaptioned;
  const sql = o.partitionId
    ? "SELECT a.id, a.item_id, a.caption FROM attachment a JOIN item i ON i.id = a.item_id WHERE a.partition_id = ? AND i.state != 'deleted'" + (includeCaptioned ? '' : " AND (a.caption IS NULL OR a.caption = '')") + ' ORDER BY a.created_at ASC'
    : "SELECT a.id, a.item_id, a.caption FROM attachment a JOIN item i ON i.id = a.item_id WHERE i.state != 'deleted'" + (includeCaptioned ? '' : " AND (a.caption IS NULL OR a.caption = '')") + ' ORDER BY a.created_at ASC';
  const stmt = store.db.prepare(sql);
  const rows = o.partitionId ? stmt.all(String(o.partitionId)) : stmt.all();
  const batch = rows.slice(0, limit);
  const results = [];
  let done = 0;
  let failed = 0;
  for (const r of batch) {
    try {
      const res = await describeImage(store, { attachmentId: r.id, prompt: o.prompt });
      // caption 进了索引文本：丢掉旧向量，下次召回按带描述的内容重建
      store.db.prepare('DELETE FROM item_vector WHERE item_id = ?').run(r.item_id);
      done += 1;
      results.push({ attachmentId: r.id, itemId: r.item_id, ok: true, caption: res.caption, tokens: res.tokens });
    } catch (err) {
      failed += 1;
      results.push({ attachmentId: r.id, itemId: r.item_id, ok: false, error: String((err && err.message) || err) });
    }
  }
  return { total: rows.length, processed: batch.length, done: done, failed: failed, remaining: Math.max(0, rows.length - batch.length), results: results };
}
