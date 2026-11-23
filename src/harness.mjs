import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import * as engine from './engine.mjs';

// DSH 会话日志是**多帧** zstd 拼接（每帧独立魔数 28 B5 2F FD）。
// zlib.zstdDecompressSync 只解第一帧，因此这里按魔数偏移逐帧解压后拼接。
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function harnessRoot(input) {
  return input ? path.resolve(String(input)) : path.join(os.homedir(), '.dsh', 'sessions');
}

export function decodeZstdFrames(buf) {
  const offs = [];
  let i = 0;
  while (true) {
    const p = buf.indexOf(MAGIC, i);
    if (p < 0) break;
    offs.push(p);
    i = p + 4;
  }
  if (!offs.length) return buf.toString('utf8');
  const parts = [];
  for (const o of offs) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(o)).toString('utf8')); } catch (err) { /* 半截帧：跳过 */ }
  }
  return parts.join('');
}

const CJK_MIN = 0x4e00;
const CJK_MAX = 0x9fff;

function isNameChar(ch) {
  const c = ch.codePointAt(0);
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= CJK_MIN && c <= CJK_MAX) || c === 45 || c === 95;
}

export function slugOf(name) {
  const out = [];
  for (const ch of String(name || '')) out.push(isNameChar(ch) ? ch : '-');
  return out.join('').replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '').toLowerCase();
}

export function decodeDirName(dir) {
  const raw = String(dir || '').replace(/^-+/, '').replace(/-+$/, '');
  return raw.replace(/~([0-9a-fA-F]{4})~/g, function (_m, h) { return String.fromCharCode(parseInt(h, 16)); });
}

function textParts(content) {
  const out = [];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const p of content) {
    if (!p) continue;
    if (typeof p === 'string') { out.push(p); continue; }
    if (p.type === 'text' && p.text) out.push(String(p.text));
  }
  return out.join('\n');
}

function flat(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function cleanTitle(s) {
  return flat(String(s || '').replace(/^#+\s*/, ''), 90);
}
const SUBAGENT_NOTE = 'Your parent agent id is';

export function parseSession(file) {
  const buf = fs.readFileSync(file);
  const text = decodeZstdFrames(buf);
  const evs = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { evs.push(JSON.parse(line)); } catch (err) { /* 坏行跳过 */ }
  }
  const head = evs.find(function (e) { return e && e.type === 'session'; }) || {};
  let title = '';
  let firstUser = '';
  let lastAssistant = '';
  let toolCalls = 0;
  let turns = 0;
  let updatedAt = head.createdAt || 0;
  for (const e of evs) {
    if (!e || !e.type) continue;
    if (typeof e.time === 'number' && e.time > updatedAt) updatedAt = e.time;
    if (e.type === 'session/title' && !title) title = cleanTitle((e.data || {}).title || '');
    else if (e.type === 'turn/start') turns += 1;
    else if (e.type === 'tool/call') toolCalls += 1;
    else if (e.type === 'user/message' && !firstUser) {
      const t = textParts((e.data || {}).content);
      if (t && t.indexOf(SUBAGENT_NOTE) < 0) firstUser = t;
    } else if (e.type === 'assistant/message') {
      const t = textParts(((e.data || {}).message || {}).content);
      if (t.trim()) lastAssistant = t;
    }
  }
  const cwd = String(head.cwd || '') || '';
  return {
    id: String(head.id || path.basename(path.dirname(file)) || ''),
    cwd: cwd,
    origin: String(head.origin || ''),
    parentSession: head.parentSession ? String(head.parentSession) : '',
    title: title || cleanTitle(firstUser) || '(未命名会话)',
    firstUser: flat(firstUser, 700),
    lastAssistant: flat(lastAssistant, 700),
    createdAt: Number(head.createdAt || 0),
    updatedAt: Number(updatedAt || head.createdAt || 0),
    toolCalls: toolCalls,
    turns: turns,
    empty: !firstUser && !lastAssistant,
    events: evs.length,
    bytes: buf.length,
    file: file
  };
}

function projectDirs(base) {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter(function (d) {
    try { return fs.statSync(path.join(base, d)).isDirectory(); } catch (err) { return false; }
  });
}

function sessionFiles(base, dir) {
  const out = [];
  const abs = path.join(base, dir);
  for (const kid of fs.readdirSync(abs)) {
    const p = path.join(abs, kid);
    let st = null;
    try { st = fs.statSync(p); } catch (err) { continue; }
    if (st.isFile() && kid.endsWith('.zstd')) { out.push(p); continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (f.endsWith('.jsonl.zstd') || f.endsWith('.jsonl')) out.push(path.join(p, f));
    }
  }
  return out;
}

function importedIds(store) {
  const rows = store.db.prepare("SELECT source FROM item WHERE source LIKE 'harness:%'").all();
  const set = Object.create(null);
  for (const r of rows) set[String(r.source).slice(8)] = true;
  return set;
}

export function scanHarness(store, input) {
  const opts = input || {};
  const base = harnessRoot(opts.root);
  const seen = importedIds(store);
  const projects = [];
  for (const dir of projectDirs(base)) {
    const files = sessionFiles(base, dir);
    if (!files.length) continue;
    const sessions = [];
    for (const f of files) {
      let s = null;
      try { s = parseSession(f); } catch (err) { continue; }
      s.imported = !!seen[s.id];
      sessions.push(s);
    }
    sessions.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    const cwd = (sessions[0] && sessions[0].cwd) || decodeDirName(dir);
    projects.push({
      dir: dir,
      cwd: cwd,
      name: path.basename(cwd) || decodeDirName(dir),
      partition: slugOf(path.basename(cwd) || dir),
      sessionCount: sessions.length,
      importedCount: sessions.filter(function (s) { return s.imported; }).length,
      sessions: sessions
    });
  }
  projects.sort(function (a, b) { return b.sessionCount - a.sessionCount; });
  const totalSessions = projects.reduce(function (n, p) { return n + p.sessionCount; }, 0);
  const totalImported = projects.reduce(function (n, p) { return n + p.importedCount; }, 0);
  return { root: base, exists: fs.existsSync(base), projects: projects, totals: { projects: projects.length, sessions: totalSessions, imported: totalImported } };
}

export function resolvePartition(store, cwd, projectName) {
  const db = store.db;
  const tag = 'harness:' + cwd;
  const baseName = slugOf(path.basename(cwd) || projectName || 'harness') || 'harness';
  const title = path.basename(cwd) || projectName || baseName;
  const candidates = [baseName, baseName + '-' + crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 6)];
  for (const name of candidates) {
    const row = db.prepare('SELECT * FROM partition WHERE name = ?').get(name);
    if (!row) continue;
    const desc = String(row.description || '');
    if (!desc || desc.indexOf(tag) >= 0) {
      if (!desc) {
        db.prepare('UPDATE partition SET description = ? WHERE id = ?').run(tag, row.id);
        store.shadow.append('partition', db.prepare('SELECT * FROM partition WHERE id = ?').get(row.id));
      }
      return row;
    }
  }
  return engine.ensurePartition(store, { name: candidates[0], title: title, description: tag });
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function stampOf(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function sessionBody(s, partitionName) {
  const lines = [];
  lines.push('会话 ' + s.id + '（项目 ' + (s.cwd || '-') + '）');
  lines.push('时间：' + stampOf(s.createdAt) + ' → ' + stampOf(s.updatedAt) + '，' + s.turns + ' 轮 / ' + s.toolCalls + ' 次工具调用 / ' + s.events + ' 条事件');
  if (partitionName) lines.push('分区：' + partitionName);
  lines.push('标题：' + s.title);
  if (s.firstUser) lines.push('首条需求：' + s.firstUser);
  if (s.lastAssistant) lines.push('最后结论：' + s.lastAssistant);
  lines.push('原始日志：' + s.file);
  return lines.join('\n').slice(0, 2400);
}

export function importHarness(store, input) {
  const opts = input || {};
  const base = harnessRoot(opts.root);
  const wanted = Array.isArray(opts.sessions) ? opts.sessions.map(String) : null;
  const onlyProject = opts.project ? slugOf(opts.project) : '';
  const force = !!opts.force;
  const scan = scanHarness(store, { root: base });
  const seen = importedIds(store);
  const plan = [];
  for (const proj of scan.projects) {
    if (onlyProject && proj.partition !== onlyProject && slugOf(proj.name) !== onlyProject) continue;
    for (const s of proj.sessions) {
      if (wanted && wanted.indexOf(s.id) < 0) continue;
      const already = !!seen[s.id];
      if (s.empty && !force) {
        plan.push({ sessionId: s.id, project: proj.name, partition: proj.partition, title: s.title, skip: 'empty' });
        continue;
      }
      if (already && !force) {
        plan.push({ sessionId: s.id, project: proj.name, partition: proj.partition, title: s.title, skip: 'already-imported' });
        continue;
      }
      plan.push({ sessionId: s.id, project: proj.name, partition: proj.partition, title: s.title, cwd: s.cwd, session: s, skip: '' });
    }
  }
  const todo = plan.filter(function (p) { return !p.skip; });
  if (opts.confirmed !== true && opts.dryRun !== false) {
    return { dryRun: true, wouldImport: todo.length, skipped: plan.length - todo.length, plan: plan.map(function (p) { return { sessionId: p.sessionId, project: p.project, partition: p.partition, title: p.title, skip: p.skip }; }) };
  }
  const partitions = Object.create(null);
  const items = [];
  for (const p of todo) {
    const part = resolvePartition(store, p.cwd, p.project);
    partitions[part.name] = (partitions[part.name] || 0) + 1;
    const res = engine.remember(store, {
      partition: part.name,
      title: '会话：' + p.session.title,
      body: sessionBody(p.session, part.name),
      kind: 'note',
      importance: 3,
      tags: ['harness', part.name],
      source: 'harness:' + p.sessionId
    });
    items.push({ sessionId: p.sessionId, itemId: res.item.id, partition: part.name, deduped: !!res.deduped });
  }
  return { dryRun: false, imported: items.length, skipped: plan.length - todo.length, reusedPartitions: Object.keys(partitions), partitions: partitions, items: items };
}

export function harnessStatus(store) {
  const scan = scanHarness(store, {});
  return { root: scan.root, exists: scan.exists, totals: scan.totals };
}