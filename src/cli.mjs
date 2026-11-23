#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openStore, backup, rebuildFromShadow, integrity, listBackups, DEFAULT_CONFIG, deepMerge } from './db.mjs';
import * as engine from './engine.mjs';
import * as tasks from './tasks.mjs';
import { checkGuard, audit } from './guard.mjs';
import * as vision from './vision.mjs';
import * as vector from './vector.mjs';
import * as tools from './tools.mjs';

const argv = process.argv.slice(2);

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; }
      else flags[key] = true;
    } else rest.push(a);
  }
  return { flags: flags, rest: rest };
}

const { flags, rest } = parse(argv);
const asJson = !!flags.json;
const store = openStore({ root: process.env.MEMORY_ROOT || undefined });

function out(value, text) {
  if (asJson) { console.log(JSON.stringify(value, null, 2)); return; }
  console.log(text === undefined ? (typeof value === 'string' ? value : JSON.stringify(value, null, 2)) : text);
}

function need(name) {
  if (flags[name] === undefined) { console.error('missing --' + name); process.exit(2); }
  return flags[name];
}

// 允许 `mem get m-xxx` / `mem delete m-xxx` 两种位置写法：cmd [sub] <id>
function argId() {
  if (flags.id !== undefined) return String(flags.id);
  const pos = rest.filter(function (x) { return typeof x === 'string'; });
  const at = pos.length > 1 ? pos[pos.length - 1] : (pos.length === 1 && pos[0] === cmd ? undefined : pos[0]);
  if (at !== undefined) return String(at);
  console.error('missing --id');
  process.exit(2);
}

const cmd = rest[0];
const sub = rest[1];

function help() {
  return [
    '小肥鱼记忆库 CLI',
    '',
    '分区   mem partition add --name <slug> --title <标题> [--desc ..]',
    '       mem partition list',
    '写入   mem remember --partition <p> --title <标题> [--body 正文] [--kind fact|decision|constraint|preference|task|report|note]',
    '                      [--tags a,b] [--importance 1-5] [--pinned] [--task t_xxx]',
    '召回   mem recall "关键词" --partition <p> [--limit 8] [--detail index|full|auto] [--dormant] [--task t_xxx]',
  '反馈   mem feedback <eventId> [--used 1|0]   （命中率与遗忘曲线的唯一信号来源）',
  '多模态 mem attach --itemId <id> --file <图片> [--caption 说明]',
  '向量   mem vector | mem reindex [分区] [--provider 1] | mem enrich [分区] [--limit 20]',
  '        mem describe --id <attachmentId>  或  --file <图片>   （视觉模型写描述，需先开 vision）',
  '        mem vision   （看多模态配置是否就绪）',
    '详情   mem get <itemId> [--days 120]',
    '删除   mem delete <itemId> [--hard] [--reason ..]      # 默认进回收站',
    '恢复   mem restore <itemId>',
    '回收   mem recycle [--partition <p>]',
    '清空   mem purge [--days 30] [--id <itemId>]',
    '附件   mem attach <itemId> --file <路径> [--caption ..] [--mime image/png]',
    '休眠   mem sweep                     # 按遗忘曲线把低保留条目转成 dormant',
    '任务   mem task start --partition <p> --title <标题> [--goal ..]',
    '       mem task log --id <taskId> --note .. [--tokens N]',
    '       mem task end --id <taskId> [--summary ..] [--report-file <path>] [--partition <p>]',
    '汇报   mem report --partition <p> [--title ..] [--summary ..] [--file <md>] [--task <id>]',
    '       mem report list [--partition <p>] [--trash] | delete <id> | restore <id> | purge [--days 30]',
    '多模态 mem caption [--partition <p>] [--limit 20] [--all]   # 批量给图片写描述',
    '       mem caption status [--partition <p>]',
    '守卫   mem guard check --partition <p> [--tokens 150000] [--chars 240000] [--task t_xxx]',
    '审查   mem audit [--partition <p>] [--hours 168]',
    '参数   mem config get | mem config set guard.contextBlockTokens=200000',
    '导出   mem export [--partition <p>] [--out file.json]',
    '导入   mem import --file file.json [--rename-partition newname]',
    '备份   mem backup | mem backups | mem integrity | mem rebuild',
    '统计   mem stats [--partition <p>] [--hours 24]',
    '网页   mem ui [--port 8787]'
  ].join('\n');
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  const prev = cur[last];
  if (typeof prev === 'boolean') cur[last] = value === 'true' || value === '1';
  else if (typeof prev === 'number') cur[last] = Number(value);
  else if (typeof prev === 'object' && prev !== null) cur[last] = JSON.parse(value);
  else cur[last] = value;
  return obj;
}

async function main() {
  if (!cmd || cmd === 'help' || flags.help) return out(help());
  if (cmd === 'partition') {
    if (sub === 'list') {
      const rows = engine.listPartitions(store);
      return out({ partitions: rows }, rows.map(function (r) { return r.id + '  ' + r.name + '  ' + r.title; }).join('\n') || '(空)');
    }
    const p = engine.ensurePartition(store, { name: need('name'), title: flags.title, description: flags.desc });
    return out(p, '分区已就绪：' + p.name + ' · ' + p.title);
  }
  if (cmd === 'remember') {
    const r = engine.remember(store, {
      partition: need('partition'), title: flags.title, body: flags.body, kind: flags.kind,
      tags: flags.tags, importance: flags.importance, pinned: !!flags.pinned, taskId: flags.task, source: 'cli'
    });
    return out(r, (r.deduped ? '已存在，刷新时间戳：' : '已写入：') + r.item.id + '  ' + r.item.title);
  }
  if (cmd === 'recall') {
    const r = engine.recall(store, {
      partition: need('partition'), query: rest[1] || flags.query || '', limit: flags.limit,
      detail: flags.detail, includeDormant: !!flags.dormant, taskId: flags.task, sessionId: flags.session
    });
    if (asJson) return out(r);
    const lines = r.items.map(function (it, i) {
      const head = String(i + 1) + '. [' + it.score.toFixed(2) + '] ' + it.title + '  (' + it.kind + ', 保留 ' + (it.retention * 100).toFixed(0) + '%)' + (it.pinned ? ' ★' : '') + (it.redundant ? ' [已读多次，正文省略]' : '');
      return it.body ? head + '\n   ' + it.body.replace(/\n/g, ' ') : head;
    });
    const tail = 'eventId=' + r.eventId + '  候选 ' + r.candidates + ' 条，命中 ' + r.items.length + ' 条，耗时 ' + r.tookMs + 'ms';
    return out(r, lines.join('\n') + '\n' + tail);
  }
  if (cmd === 'feedback') {
    const r = engine.feedback(store, { eventId: flags.eventId || rest[1] || need('eventId'), used: flags.used === undefined ? 1 : Number(flags.used) ? 1 : 0 });
    return out(r, '已回填反馈：event ' + r.eventId + ' → ' + (r.used ? '用上了' : '没用上') + '，影响 ' + r.affected + ' 条记忆稳定度');
  }
  if (cmd === 'vector') {
    const s = vector.vectorStatus(store);
    s.backend = vector.annBackend(store);
    const line = '向量：' + (s.enabled ? '开启' : '关闭') + ' · ' + s.dims + ' 维 · 覆盖 ' + s.covered + '/' + s.items +
      ' · 权重 ' + s.vectorWeight + ' · 后端 ' + s.backend.effective +
      ' · DeepSeek 指纹 ' + (s.deepseek && s.deepseek.ready ? '就绪(' + s.deepseek.model + ')' : '未就绪');
    return out(s, line);
  }
  if (cmd === 'reindex') {
    const name = flags.partition || rest[1] || null;
    const part = name ? engine.partitionByName(store, name) : null;
    if (name && !part) throw new Error('unknown partition: ' + name);
    const r = await vector.reindex(store, { partitionId: part ? part.id : null, provider: flags.provider === '1' || flags.provider === 'true' });
    return out(r, '向量重建完成：模型 ' + r.model + '，' + (r.written === undefined ? r.items : r.written) + ' 条，维度 ' + r.dims);
  }
  if (cmd === 'enrich') {
    const name = flags.partition || rest[1] || null;
    const part = name ? engine.partitionByName(store, name) : null;
    if (name && !part) throw new Error('unknown partition: ' + name);
    const r = await vector.enrichSemantics(store, { partitionId: part ? part.id : null, limit: flags.limit });
    return out(r, 'DeepSeek 语义指纹：新增 ' + r.enriched + ' 条，跳过 ' + r.skipped + ' 条，用掉 ' + r.tokens + ' tokens');
  }
  if (cmd === 'describe') {
    const r = await vision.describeImage(store, { attachmentId: flags.id || flags.attachmentId, path: flags.file, prompt: flags.prompt });
    return out(r, '描述已写入：' + r.caption);
  }
  if (cmd === 'vision') {
    const s = vision.visionStatus(store);
    return out(s, '视觉描述：' + (s.ready ? '就绪（' + s.model + '）' : '未就绪') + (s.hint ? '  ' + s.hint : ''));
  }
  if (cmd === 'get') return out(engine.getItem(store, argId(), { days: flags.days }));
  if (cmd === 'delete') {
    const r = engine.deleteItem(store, { id: argId(), hard: !!flags.hard, reason: flags.reason });
    return out(r, r.hard ? '已彻底删除 ' + r.id : '已移入回收站 ' + r.id + '（恢复：mem restore ' + r.id + '）');
  }
  if (cmd === 'restore') { const r = engine.restoreItem(store, argId()); return out(r, '已恢复 ' + r.id + ' · ' + r.title); }
  if (cmd === 'recycle') {
    const rows = engine.listRecycle(store, flags.partition ? engine.partitionByName(store, flags.partition).id : null);
    return out({ items: rows }, rows.map(function (r) { return r.id + '  ' + r.title + '  (删除于 ' + new Date(r.deleted_at).toLocaleString() + ')' + (r.expired ? ' [已过期]' : ''); }).join('\n') || '(回收站为空)');
  }
  if (cmd === 'purge') return out(engine.purgeDeleted(store, { id: flags.id, olderThanDays: flags.days === undefined ? flags.olderThanDays : flags.days }));
  if (cmd === 'attach') {
    const r = engine.attachToItem(store, { itemId: need('itemId') || need('item'), path: need('file'), caption: flags.caption, mime: flags.mime });
    return out(r, '附件已存：' + r.id + '  ' + r.path);
  }
  if (cmd === 'sweep') {
    const r = engine.sweep(store);
    return out(r, '扫描 ' + r.scanned + ' 条，状态变化 ' + r.changed.length + ' 条');
  }
  if (cmd === 'task') {
    if (sub === 'start') {
      const r = tasks.startTask(store, { partition: need('partition'), title: need('title'), goal: flags.goal, contextTokens: flags.tokens });
      return out(r, '任务已开启：' + r.task.id + '\n' + r.directive);
    }
    if (sub === 'log') return out(tasks.taskLog(store, { taskId: argId(), note: flags.note, tokens: flags.tokens }));
    if (sub === 'end' || sub === 'stop') {
      const md = flags['report-file'] ? fs.readFileSync(String(flags['report-file']), 'utf8') : undefined;
      const r = tasks.endTask(store, { taskId: argId(), summary: flags.summary, markdown: md, partition: flags.partition, tokens: flags.tokens, abort: !!flags.abort });
      return out(r, '任务已关闭：' + r.task.id + (r.report ? '  汇报：' + r.report.path : '  (未写汇报)'));
    }
    return out(help());
  }
  if (cmd === 'report') {
    if (sub === 'list') {
      const part = flags.partition ? engine.partitionByName(store, flags.partition) : null;
      const rows = tasks.listReports(store, { trash: !!flags.trash, partitionId: part ? part.id : null, limit: Number(flags.limit || 100) });
      return out({ reports: rows }, rows.map(function (r) { return r.id + '  ' + new Date(Number(r.created_at)).toLocaleString() + '  ' + r.title + '  ' + r.path; }).join('\n') || (flags.trash ? '(汇报回收站为空)' : '(没有汇报)'));
    }
    if (sub === 'delete') {
      const r = tasks.deleteReport(store, { id: argId(), path: flags.path });
      return out(r, '汇报已移入回收站：' + r.report.title + '\n可恢复到 ' + new Date(r.restoreUntil).toLocaleDateString());
    }
    if (sub === 'restore') {
      const r = tasks.restoreReport(store, { id: argId(), path: flags.path });
      return out(r, '汇报已恢复：' + r.report.path);
    }
    if (sub === 'purge') {
      const r = tasks.purgeReports(store, { id: flags.id, path: flags.path, olderThanDays: flags.days === undefined ? flags.olderThanDays : flags.days });
      return out(r, '已彻底清理 ' + r.purged + ' 份汇报，删除文件 ' + r.filesRemoved + ' 个');
    }
    const md = flags.file ? fs.readFileSync(String(flags.file), 'utf8') : undefined;
    const r = tasks.writeReport(store, { partition: need('partition'), title: flags.title, summary: flags.summary, markdown: md, taskId: flags.task });
    return out(r, '汇报已写入：' + r.path);
  }
  if (cmd === 'caption') {
    const part = flags.partition ? engine.partitionByName(store, flags.partition) : null;
    if (sub === 'status' || flags.status) {
      const s = vision.captionStatus(store, { partitionId: part ? part.id : null });
      return out(s, '附件 ' + s.total + ' 个 · 已有描述 ' + s.captioned + ' · 待描述 ' + s.missing + (s.vision.ready ? '' : '  (' + (s.vision.hint || '视觉未就绪') + ')'));
    }
    const r = await vision.batchCaption(store, { partitionId: part ? part.id : null, limit: Number(flags.limit || 20), includeCaptioned: !!flags.all });
    return out(r, '批量描述：处理 ' + r.processed + ' · 成功 ' + r.done + ' · 失败 ' + r.failed + ' · 剩余 ' + r.remaining + (r.failed ? '（失败项重跑即重试）' : ''));
  }
  if (cmd === 'guard') {
    const r = checkGuard(store, { partition: need('partition'), contextTokens: flags.tokens, chars: flags.chars, taskId: flags.task });
    return out(r, '守卫生效等级：' + r.level + ' (score ' + r.score + ')\n' + r.reasons.join('\n') + '\n→ ' + r.directive);
  }
  if (cmd === 'audit') {
    const r = audit(store, { partition: flags.partition || null, hours: flags.hours });
    return out(r, r.findings.length ? r.findings.map(function (f) { return '[' + f.severity + '] ' + (f.partition || '*') + ' · ' + f.message + '  → ' + f.suggestion; }).join('\n') : '未发现问题');
  }
  if (cmd === 'config') {
    if (sub === 'set') {
      const patch = {};
      const pairs = rest.slice(2);
      if (!pairs.length) { console.error('usage: mem config set key=value [key=value]'); process.exit(2); }
      for (let k = 0; k < pairs.length; k++) {
        const pair = String(pairs[k]);
        const at = pair.indexOf('=');
        if (at > 0) { setPath(patch, pair.slice(0, at), pair.slice(at + 1)); continue; }
        const nextVal = pairs[k + 1];
        if (nextVal === undefined) throw new Error('参数要写成 key=value 或 key value：' + pair);
        setPath(patch, pair, String(nextVal));
        k += 1;
      }
      const next = tasks.updateConfig(store, patch);
      return out(next, '参数已更新');
    }
    return out(store.config);
  }
  if (cmd === 'export') {
    const bundle = tasks.exportBundle(store, { partition: flags.partition || null, withEvents: flags.events !== '0', withConfig: !!flags.config });
    if (flags.out) { fs.writeFileSync(String(flags.out), JSON.stringify(bundle, null, 2)); return out({ file: flags.out, items: bundle.items.length }); }
    return out(bundle);
  }
  if (cmd === 'import') {
    const file = flags.file || rest[1] || need('file');
    const bundle = JSON.parse(fs.readFileSync(String(file), 'utf8'));
    const r = tasks.importBundle(store, bundle, { renamePartition: flags['rename-partition'] || flags.rename });
    return out(r, '导入完成：分区 ' + r.partitions + '，条目 ' + r.items + '，任务 ' + r.tasks + '，跳过 ' + r.skipped);
  }
  if (cmd === 'backup') { const r = backup(store); return out(r, '已备份：' + r.path); }
  if (cmd === 'backups') { const rows = listBackups(store); return out({ backups: rows }, rows.map(function (r) { return r.name + '  ' + (r.bytes / 1024).toFixed(0) + 'KB'; }).join('\n') || '(无备份)'); }
  if (cmd === 'integrity') { const r = integrity(store); return out(r, (r.ok ? '数据库完好' : '数据库异常：') + r.detail); }
  if (cmd === 'rebuild') {
    backup(store);
    const r = rebuildFromShadow(store.root);
    return out(r, '已从影子日志重建：' + r.applied + '/' + r.entries + ' 条');
  }
  if (cmd === 'stats') {
    const pid = flags.partition ? engine.partitionByName(store, flags.partition).id : null;
    const r = { overview: engine.overview(store), hit: engine.hitStats(store, pid, Number(flags.hours || 24)) };
    return out(r);
  }
  if (cmd === 'search') {
    const r = tools.searchItems(store, {
      partition: need('partition'), q: rest[1] || flags.q || flags.query || '', tags: flags.tags, state: flags.state,
      kind: flags.kind, sort: flags.sort, limit: flags.limit, offset: flags.offset
    });
    if (asJson) return out(r);
    const lines = r.items.map(function (it, i) {
      return String(r.offset + i + 1) + '. [' + it.score.toFixed(2) + '] ' + it.title + '  (' + it.kind + ' · 保留 ' + (it.retention * 100).toFixed(0) + '% · 命中 ' + it.hitCount + ')' + '\n   ' + it.id + '  ' + it.snippet;
    });
    return out(r, lines.join('\n') + '\n共 ' + r.total + ' 条，本页 ' + r.items.length + ' 条（offset=' + r.offset + '）');
  }
  if (cmd === 'digest') {
    const r = tools.digest(store, { partition: need('partition'), days: flags.days });
    if (asJson) return out(r);
    const lines = [];
    lines.push('近 ' + r.days + ' 天 · ' + r.partition);
    lines.push('  记忆：新增 ' + r.items.created + ' · 更新 ' + r.items.updated + ' · 状态 ' + JSON.stringify(r.items.states));
    lines.push('  召回：' + r.recall.events + ' 次，返回 ' + r.recall.returned + ' 条，命中率 ' + (r.recall.hitRate === null ? '—' : (r.recall.hitRate * 100).toFixed(1) + '%'));
    lines.push('  守卫：' + (Object.keys(r.guards).length ? JSON.stringify(r.guards) : '无事件'));
    lines.push('  快忘：' + (r.nearForget.length ? r.nearForget.map(function (x) { return x.title; }).join('、') : '无'));
    lines.push('  冷掉：' + (r.cooling.length ? r.cooling.map(function (x) { return x.title + '(' + (x.retention * 100).toFixed(0) + '%)'; }).join('、') : '无'));
    lines.push('  任务：' + r.tasks.length + ' · 汇报：' + r.reports.length);
    return out(r, lines.join('\n'));
  }
  if (cmd === 'explain') {
    const r = tools.explain(store, { id: argId(), query: rest[2] && !flags.id ? undefined : (flags.query || rest[1]) });
    if (asJson) return out(r);
    const it = r.item;
    const lines = [it.title + '  (' + it.id + ')', '  保留率 ' + (it.retention * 100).toFixed(1) + '% · 稳定性 ' + it.stability + ' 天 · 已 ' + it.ageDays + ' 天没动 · 约 ' + it.daysUntilForget + ' 天后低于遗忘线 ' + it.forgetThreshold];
    if (r.components) {
      const c = r.components;
      lines.push('  打分：相关 ' + c.relevance + ' × 衰减 ' + c.retentionFactor + ' × 重要度 ' + c.importanceFactor + ' + 钉住 ' + c.pinnedBoost + ' = ' + c.score + (c.passesMinScore ? '（过线）' : '（低于 minScore ' + c.minScore + '，不会被召回）'));
      lines.push('  向量：cos ' + c.cos + '（floor ' + c.vectorFloor + '，权重 ' + c.vectorWeight + '）');
    }
    if (r.note) lines.push('  注意：' + r.note);
    if (r.events.length) lines.push('  最近召回：' + r.events.map(function (e) { return new Date(e.ts).toLocaleString() + (e.used === 1 ? ' 用上' : e.used === 0 ? ' 没用' : ' 未反馈'); }).join(' | '));
    return out(r, lines.join('\n'));
  }
  if (cmd === 'link') {
    const r = tools.link(store, { from: argId(), to: need('to'), relation: flags.relation });
    return out(r, (r.created ? '已建立关联：' : '已存在关联：') + r.link.from_id + ' -[' + r.link.relation + ']-> ' + r.link.to_id);
  }
  if (cmd === 'unlink') {
    const r = tools.unlink(store, { id: flags.id, from: flags.from, to: flags.to, relation: flags.relation });
    return out(r, '已删除关联 ' + r.removed + ' 条');
  }
  if (cmd === 'links') {
    const r = tools.links(store, { id: argId() });
    if (asJson) return out(r);
    const outLines = r.out.map(function (l) { return '  -> ' + l.to_id + '  [' + l.relation + '] ' + l.title; });
    const backLines = r.back.map(function (l) { return '  <- ' + l.from_id + '  [' + l.relation + '] ' + l.title; });
    return out(r, (outLines.concat(backLines).join('\n') || '  (没有关联)'));
  }
  if (cmd === 'expand') {
    const r = tools.expand(store, { id: argId(), depth: flags.depth });
    if (asJson) return out(r);
    return out(r, r.items.length ? r.items.map(function (x) { return '  ' + x.hop + '跳 [' + x.relation + '] ' + x.title + '  (' + x.id + ')'; }).join('\n') : '(没有邻居)');
  }
  if (cmd === 'pin') {
    const r = tools.setPinned(store, { id: argId(), pinned: flags.off || flags.unpin ? false : true });
    return out(r, (r.pinned ? '已钉住：' : '已取消钉住：') + r.title);
  }
  if (cmd === 'health') {
    const r = tools.health(store, { partition: flags.partition, fix: !!flags.fix });
    if (asJson) return out(r);
    const lines = ['体检 [' + r.partition + '] 等级 ' + r.level + (r.fixed ? ' · 已修复 ' + r.fixed + ' 项' : '')];
    lines.push('  条目 ' + r.counts.items + '（活跃 ' + r.counts.active + '，主干 ' + r.counts.trunk + '）· 附件 ' + r.counts.attachments + ' · 缺向量 ' + r.counts.missingVector + ' · 备份 ' + r.counts.backups + ' 份');
    for (const fd of r.findings) lines.push('  [' + fd.severity + '] ' + fd.code + '：' + fd.detail);
    return out(r, lines.join('\n'));
  }
  if (cmd === 'dedupe') {
    const r = tools.dedupe(store, { partition: need('partition'), threshold: flags.threshold });
    if (asJson) return out(r);
    if (!r.pairs.length) return out(r, '没有相似度超过 ' + r.threshold + ' 的条目（扫描 ' + r.scanned + ' 条）');
    const lines = r.pairs.map(function (p, i) { return String(i + 1) + '. ' + (p.similarity * 100).toFixed(1) + '%  ' + p.keep.title + '  <->  ' + p.drop.title + '\n   ' + p.suggestion; });
    return out(r, lines.join('\n'));
  }
  if (cmd === 'summarize') {
    const r = tools.summarize(store, { partition: need('partition'), limit: flags.limit, title: flags.title, taskId: flags.task });
    if (asJson) return out(r);
    if (!r.created) return out(r, '未生成主干：' + r.reason);
    return out(r, '已生成主干：' + r.item.id + '  ' + r.item.title + '\n  归纳 ' + r.sources.length + ' 条' + (r.superseded.length ? '，取代旧主干 ' + r.superseded.length + ' 条' : ''));
  }
  if (cmd === 'ui') {
    const { spawn } = await import('node:child_process');
    const port = String(flags.port || store.config.server.port || 8787);
    const child = spawn(process.execPath, [path.join(store.root, 'src', 'server.mjs'), '--port', port], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log('看板已启动：http://127.0.0.1:' + port);
    return;
  }
  return out(help());
}

main().catch(function (err) {
  console.error('错误：' + (err && err.message ? err.message : err));
  process.exit(1);
});