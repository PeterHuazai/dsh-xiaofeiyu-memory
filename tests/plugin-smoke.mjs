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
ok('注册工具数 = 14', registered.size === 14, registered.size);

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

const tk = await call('xfy_memory_trunk', { partition: 'demo', maxTokens: 200 });
ok('trunk 摘要带主干与层计数', tk.items > 0 && !!tk.layerCounts && tk.tokens <= tk.budget, tk.items + ' 条/' + tk.tokens + 'tk');
const rb = await call('xfy_memory_recall', { partition: 'demo', query: '向量 融合', detail: 'full', budget: 60 });
ok('recall token 预算生效', rb.totalTokens <= 60 && Array.isArray(rb.items), rb.totalTokens);
const pl = await call('xfy_memory_guard', { partition: 'demo', plan: true });
ok('guard plan 给出可执行步骤', Array.isArray(pl.steps) && pl.steps.length === 5 && pl.requiresConfirm === true, pl.steps && pl.steps.length);
const ap = await call('xfy_memory_guard', { partition: 'demo', apply: true, steps: 'backup' });
ok('apply 不带 confirm 一律拒绝', ap.ok === false && ap.requiresConfirm === true, ap.ok);
const apl = await call('xfy_memory_guard', { partition: 'demo', apply: true, steps: 'backup', confirm: true });
ok('apply 带 confirm 才真执行', apl.ok === true && apl.applied.join(',') === 'backup', apl.applied);

// agent/pre-step 是 cordis 的 waterfall（中间件链）：监听器不调 next() 就把整条链的返回值
// 变成 undefined，DSH agent-loop 随后读 decision.kind 直接抛错。这里把当时的失败复现成断言。
// 现在插件挂两个 pre-step 监听器（守卫记账 + 第一轮注入主干），必须按链的顺序跑。
const hooks = new Map();
const ctx2 = {
  tools: { register: (spec) => { return spec; } },
  on: (name, fn) => { const arr = hooks.get(name) || []; arr.push(fn); hooks.set(name, arr); return () => {}; },
};
mod.apply(ctx2, { root: tmp, defaultPartition: 'demo' });
ok('注册了 agent/pre-step 监听器', Array.isArray(hooks.get('agent/pre-step')) && hooks.get('agent/pre-step').length >= 1, (hooks.get('agent/pre-step') || []).length);
ok('注册了 agent/turn-stopping 监听器', Array.isArray(hooks.get('agent/turn-stopping')));

const runChain = async (name, payload, terminal) => {
  const list = hooks.get(name) || [];
  const step = (i) => (i >= list.length ? terminal() : list[i](payload, () => step(i + 1)));
  return await step(0);
};

let nextCalls = 0;
const finalDecision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] };
const next = () => { nextCalls += 1; return finalDecision; };
const settled = await runChain('agent/pre-step', { messages: finalDecision.messages, turn: 1, step: 1 }, next);
ok('pre-step 链末端只被调一次 next()', nextCalls === 1, nextCalls);
ok('pre-step 把链路返回值原样传下去（不是 undefined）', settled === finalDecision, settled && settled.kind);
ok('pre-step 结果有 kind（agent-loop 会读 decision.kind）', !!(settled && settled.kind === 'enter'));
const injectedMsg = finalDecision.messages[finalDecision.messages.length - 1];
ok('第一轮注入了一条记忆快照', finalDecision.messages.length === 2 && injectedMsg.source && injectedMsg.source.kind === 'xiaofeiyu-memory' && injectedMsg.source.form === 'snapshot' && Array.isArray(injectedMsg.source.sections));
ok('注入内容是真主干（不是空字符串）', injectedMsg.content[0].text.includes('主干'), injectedMsg.content[0].text.slice(0, 20));
const afterFirst = finalDecision.messages.length;
await runChain('agent/pre-step', { messages: finalDecision.messages, turn: 2, step: 1 }, () => finalDecision);
ok('第二轮不再重复注入', finalDecision.messages.length === afterFirst, finalDecision.messages.length);

// 记忆库写失败也不能吃掉 next()：把 store 换成一个坏掉的 root，再走一遍。
hooks.clear();
const ctx3 = {
  tools: { register: (spec) => spec },
  on: (name, fn) => { const arr = hooks.get(name) || []; arr.push(fn); hooks.set(name, arr); return () => {}; },
};
mod.apply(ctx3, { root: path.join(tmp, 'not-a-dir', "bad\u0000path"), defaultPartition: 'demo' });
let nextCalls2 = 0;
const yielded = await runChain('agent/pre-step', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }], turn: 1, step: 1 }, () => { nextCalls2 += 1; return { kind: 'enter', messages: [] }; });
ok('记忆库出错时仍然 next()', nextCalls2 === 1, nextCalls2);
ok('记忆库出错时仍返回 decision', !!(yielded && yielded.kind === 'enter'));

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log((c.pass ? 'PASS ' : 'FAIL ') + c.label + (c.extra ? ' (' + c.extra + ')' : ''));
console.log('插件冒烟：通过 ' + (checks.length - failed.length) + ' / 失败 ' + failed.length + ' · 临时库 ' + tmp);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* sqlite 句柄随进程退出释放 */ }
if (failed.length) process.exitCode = 1;
