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

// DSH 的会话目录名是 `--<盘符>-~XXXX~XXXX…--`：每个非 ASCII 字符编成一个 `~XXXX` 单元，
// 单元之间**不**共享波浪号。旧实现要求 `~XXXX~`（前后都有波浪号），会漏解最后一个字，
// 所以这里按「波浪号前缀」逐单元解，并把盘符前缀去掉，直接得到项目名。
export function decodeDirName(dir) {
  const raw = String(dir || '').replace(/^-+/, '').replace(/-+$/, '');
  const text = raw.replace(/~([0-9a-fA-F]{4})/g, function (_m, h) { return String.fromCharCode(parseInt(h, 16)); });
  return text.replace(/^[A-Za-z]:?[-_ ]+/, '');
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
const APPROVAL_NOTE = 'The user changed the approval policy';
const SYSTEM_WRAP = /^\s*<system-reminder>/;

// 只有用户**自己**打的字才算需求：审批策略通知、运行时上下文快照、子代理自我说明都不算。
function realUserText(source, text) {
  const kind = String((source || {}).kind || '');
  if (kind && kind !== 'user') return '';
  const t = String(text || '');
  if (!t.trim()) return '';
  if (SYSTEM_WRAP.test(t)) return '';
  if (t.indexOf(APPROVAL_NOTE) >= 0) return '';
  if (t.indexOf(SUBAGENT_NOTE) >= 0) return '';
  return t;
}

const PATH_KEY_RE = /^(file_path|path|cwd|file|filepath|target|dest|destination|source_path|output_path|folder|dir)$/i;
const CODE_KEY_RE = /^(code|command|script|query|input|cmd|content|text|body|patch)$/i;
const WRITE_TOOL_RE = /write|edit|patch|apply|create|save|attach|upload|delete|remove|move|rename/i;
const WRITE_HINT_RE = /tools\.(write|edit)\(|Set-Content|Out-File|Add-Content|New-Item|Remove-Item|Move-Item|Copy-Item|git\s+apply|writeFileSync|fs\.write/i;

function looksLikePath(s) {
  return /[\\/]/.test(s) && s.length >= 3 && !/^\s*(https?|data|dsh-[a-z]+|node|file):/i.test(s);
}

// 从一段自由文本（run_code 的 code、pwsh 的 command）里捞 Windows 盘符路径 / 绝对路径。
function extractPathsFromText(text) {
  const out = [];
  const s = String(text || '').replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  const win = s.match(/[A-Za-z]:\\[^\s"'`,;)\]}{|]{2,180}/g);
  if (win) for (const one of win) out.push(one.replace(/[\\/]+$/, ''));
  const posix = s.match(/(?:^|[\s"'(=])(\/[A-Za-z0-9_\-.@\u4e00-\u9fff]{2,120}(?:\/[A-Za-z0-9_\-.@\u4e00-\u9fff]{1,120})*)/g);
  if (posix) for (const raw of posix) out.push(raw.replace(/^[\s"'(=]+/, '').replace(/[\\/]+$/, ''));
  return out;
}

// 从工具调用的 arguments 里挖文件路径（parse 得动就走对象树，parse 不动就退回正则）。
// 返回 { paths, writes }：writes 只在调用像是写操作时才收。
function collectPaths(argsText, acc) {
  const raw = String(argsText || '');
  let args = null;
  try { args = JSON.parse(raw); } catch (err) { args = null; }
  if (args === null) {
    for (const one of extractPathsFromText(raw)) acc.paths.push(one);
    return;
  }
  const walk = function (v, key, lvl) {
    if (v === null || v === undefined || lvl > 5) return;
    if (typeof v === 'string') {
      const k = String(key || '');
      if (k && PATH_KEY_RE.test(k) && looksLikePath(v)) { acc.paths.push(v.trim()); return; }
      if (k && CODE_KEY_RE.test(k) && v.length > 12) {
        // 逐行判断：只有和写操作出现在**同一行**的路径才算“改过这个文件”，
        // 否则一个 run_code 里只要出现过 Set-Content，就会把所有引用文件都当成改过的。
        for (const line of String(v).split(/\r?\n/)) {
          const found = extractPathsFromText(line);
          const writes = WRITE_HINT_RE.test(line);
          for (const one of found) { acc.paths.push(one); if (writes) acc.writes.push(one); }
        }
      }
      return;
    }
    if (Array.isArray(v)) { for (const it of v.slice(0, 60)) walk(it, key, lvl + 1); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], k, lvl + 1); }
  };
  walk(args, '', 0);
}

function uniq(list, cap) {
  const seen = Object.create(null);
  const out = [];
  for (const one of list) {
    const s = String(one || '').trim();
    if (!s || seen[s]) continue;
    seen[s] = true;
    out.push(s);
    if (out.length >= (cap || 20)) break;
  }
  return out;
}

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
  const toolCounts = Object.create(null);
  const allPaths = [];
  const writePaths = [];
  const userTexts = [];
  let lastAssistantAt = -1;
  let lastToolAt = -1;
  for (let idx = 0; idx < evs.length; idx += 1) {
    const e = evs[idx];
    if (!e || !e.type) continue;
    if (typeof e.time === 'number' && e.time > updatedAt) updatedAt = e.time;
    if (e.type === 'session/title' && !title) title = cleanTitle((e.data || {}).title || '');
    else if (e.type === 'turn/start') turns += 1;
    else if (e.type === 'tool/call') {
      toolCalls += 1;
      lastToolAt = idx;
      const name = String((e.data || {}).name || 'tool');
      toolCounts[name] = (toolCounts[name] || 0) + 1;
      const acc = { paths: [], writes: [] };
      collectPaths((e.data || {}).arguments, acc);
      for (const one of acc.paths) allPaths.push(one);
      if (WRITE_TOOL_RE.test(name)) for (const one of acc.paths) writePaths.push(one);
      for (const one of acc.writes) { allPaths.push(one); writePaths.push(one); }
    } else if (e.type === 'user/message') {
      const data = e.data || {};
      const t = textParts(data.content);
      const real = realUserText(data.source, t);
      if (real) {
        if (userTexts.length < 6) userTexts.push(flat(real, 900));
        if (!firstUser) firstUser = real;
      }
    } else if (e.type === 'assistant/message') {
      const t = textParts(((e.data || {}).message || {}).content);
      if (t.trim()) { lastAssistant = t; lastAssistantAt = idx; }
    }
  }
  const cwd = String(head.cwd || '') || '';
  const tools = Object.keys(toolCounts).sort(function (a, b) { return toolCounts[b] - toolCounts[a]; }).slice(0, 8).map(function (k) { return k + '×' + toolCounts[k]; });
  return {
    id: String(head.id || path.basename(path.dirname(file)) || ''),
    cwd: cwd,
    origin: String(head.origin || ''),
    parentSession: head.parentSession ? String(head.parentSession) : '',
    title: title || cleanTitle(firstUser) || '(未命名会话)',
    firstUser: flat(firstUser, 700),
    userTexts: userTexts,
    files: uniq(allPaths, 14),
    filesWritten: uniq(writePaths, 10),
    tools: tools,
    toolCounts: toolCounts,
    lastAssistant: flat(lastAssistant, 700),
    endedWithTools: lastToolAt >= 0 && lastToolAt > lastAssistantAt,
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
  if (s.firstUser) lines.push('用户需求：' + s.firstUser);
  const extra = Array.isArray(s.userTexts) ? s.userTexts.slice(1, 4) : [];
  for (let i = 0; i < extra.length; i += 1) lines.push('后续要求 ' + (i + 2) + '：' + extra[i]);
  if (Array.isArray(s.filesWritten) && s.filesWritten.length) lines.push('改动过的文件：' + s.filesWritten.join('、'));
  if (Array.isArray(s.files) && s.files.length) lines.push('用到的文件：' + s.files.join('、'));
  if (Array.isArray(s.tools) && s.tools.length) lines.push('主要工具：' + s.tools.join('、'));
  if (s.lastAssistant) lines.push('最后结论：' + s.lastAssistant);
  if (s.endedWithTools) lines.push('备注：会话在工具调用中结束，没有收尾说明（“最后结论”是较早的一句）');
  lines.push('原始日志：' + s.file);
  return lines.join('\n').slice(0, 3000);
}

// 一个项目能被哪些写法匹配上：目录名（原始/解码后）、cwd、项目名、分区名。
// 面板以前只传目录名，后端只认分区名/项目名 → 永远 0 条；这里把两边都认下来。
export function projectKeys(proj) {
  const list = [proj.dir, decodeDirName(proj.dir), proj.cwd, proj.name, proj.partition];
  return uniq(list.map(function (v) { return String(v || '').trim(); }), 10);
}

export function matchesProject(proj, wanted) {
  const w = String(wanted || '').trim();
  if (!w) return true;
  const ws = slugOf(w);
  const cwd = String(proj.cwd || '').replace(/[\\/]+$/, '');
  for (const k of projectKeys(proj)) {
    if (k === w) return true;
    if (k.toLowerCase() === w.toLowerCase()) return true;
    if (ws && slugOf(k) === ws) return true;
  }
  if (cwd && (cwd.endsWith('\\' + w) || cwd.endsWith('/' + w))) return true;
  return false;
}

export function importHarness(store, input) {
  const opts = input || {};
  const base = harnessRoot(opts.root);
  const wanted = Array.isArray(opts.sessions) ? opts.sessions.map(String) : null;
  const onlyProject = opts.project ? String(opts.project) : '';
  const kind = String(opts.kind || 'scene');
  const importance = opts.importance === undefined ? 4 : Number(opts.importance);
  const force = !!opts.force;
  const scan = scanHarness(store, { root: base });
  const seen = importedIds(store);
  const plan = [];
  for (const proj of scan.projects) {
    if (onlyProject && !matchesProject(proj, onlyProject)) continue;
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
      kind: kind,
      importance: importance,
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