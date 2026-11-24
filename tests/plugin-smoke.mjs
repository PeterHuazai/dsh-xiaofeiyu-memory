import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xfy-plugin-'));
const registered = new Map();
const ctx = { tools: { register: (spec) => { registered.set(spec.name, spec); return spec; } } };
mod.apply(ctx, { root: tmp, defaultPartition: 'demo' });

const checks = [];
const ok = (label, cond, extra) => checks.push({ label, pass: !!cond, extra: extra === undefined ? '' : String(extra) });
ok('插件名', mod.name === 'xiaofeiyu-memory', mod.name);
ok('注册工具数 = 13', registered.size === 13, registered.size);

const call = async (name, args) => registered.get(name).execute(args);
const rem = await call('xfy_memory_remember', { partition: 'demo', title: '向量与词面融合召回', body: 'score = 相关度*权重 + 余弦*vectorWeight，再乘衰减与重要度', kind: 'decision', importance: 4, tags: 'vector,recall' });
ok('remember 返回条目', rem && rem.item && rem.item.id, rem.item && rem.item.id);

const rec = await call('xfy_memory_recall', { partition: 'demo', query: '向量 融合', detail: 'index' });
ok('recall 命中', rec.items.length === 1 && rec.items[0].score > 0, rec.items[0] && rec.items[0].score);

const fb = await call('xfy_memory_feedback', { eventId: rec.eventId, used: true });
ok('feedback affected = 1', fb.affected === 1, fb.affected);

const g = await call('xfy_memory_guard', { partition: 'demo', tokens: 210000 });
ok('guard 硬阈值 block', g.level === 'block' && g.action === 'hard-stop', g.level);

const dg = await call('xfy_memory_digest', { partition: 'demo', days: 7 });
ok('digest 统计', dg.items.created === 1 && dg.daily.length === 7, dg.items.created);

const hl = await call('xfy_memory_health', { partition: 'demo' });
ok('health 报出发现', hl.findings.length > 0, hl.findings.map((f) => f.code).join(','));

const sr = await call('xfy_memory_search', { partition: 'demo', q: '融合' });
ok('search 有片段', sr.total === 1 && sr.items[0].snippet.length > 0, sr.total);

const st = await call('xfy_memory_task', { action: 'start', partition: 'demo', title: '插件冒烟' });
ok('task start', st.task && st.task.id, st.task && st.task.id);
const en = await call('xfy_memory_task', { action: 'end', taskId: st.task.id, summary: '冒烟通过', markdown: '## 做了什么\n- 导入插件并逐个调工具\n' });
ok('task end 写汇报', en.task && en.task.status === 'done' && !!en.report, en.task && en.task.status);

// agent/pre-step 是 cordis 的 waterfall（中间件链）：监听器不调 next() 就把整条链的返回值
// 变成 undefined，DSH agent-loop 随后读 decision.kind 直接抛错。这里把当时的失败复现成断言。
const hooks = new Map();
const ctx2 = {
  tools: { register: (spec) => { return spec; } },
  on: (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name); },
};
mod.apply(ctx2, { root: tmp, defaultPartition: 'demo' });
ok('注册了 agent/pre-step 监听器', typeof hooks.get('agent/pre-step') === 'function');
ok('注册了 agent/turn-stopping 监听器', typeof hooks.get('agent/turn-stopping') === 'function');

const preStep = hooks.get('agent/pre-step');
let nextCalls = 0;
const finalDecision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] };
const next = () => { nextCalls += 1; return finalDecision; };
const settled = await preStep({ messages: finalDecision.messages, turn: 1, step: 1 }, next);
ok('pre-step 调了 next()', nextCalls === 1, nextCalls);
ok('pre-step 把链路返回值原样传下去（不是 undefined）', settled === finalDecision, settled && settled.kind);
ok('pre-step 结果有 kind（agent-loop 会读 decision.kind）', !!(settled && settled.kind === 'enter'));

// 记忆库写失败也不能吃掉 next()：把 store 换成一个坏掉的 root，再走一遍。
hooks.clear();
const ctx3 = {
  tools: { register: (spec) => spec },
  on: (name, fn) => { hooks.set(name, fn); return () => {} },
};
mod.apply(ctx3, { root: path.join(tmp, 'not-a-dir', "bad\u0000path"), defaultPartition: 'demo' });
let nextCalls2 = 0;
const yielded = await hooks.get('agent/pre-step')({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }], turn: 1, step: 1 }, () => { nextCalls2 += 1; return { kind: 'enter', messages: [] }; });
ok('记忆库出错时仍然 next()', nextCalls2 === 1, nextCalls2);
ok('记忆库出错时仍返回 decision', !!(yielded && yielded.kind === 'enter'));

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log((c.pass ? 'PASS ' : 'FAIL ') + c.label + (c.extra ? ' (' + c.extra + ')' : ''));
console.log('插件冒烟：通过 ' + (checks.length - failed.length) + ' / 失败 ' + failed.length + ' · 临时库 ' + tmp);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* sqlite 句柄随进程退出释放 */ }
if (failed.length) process.exitCode = 1;
