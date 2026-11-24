/**
 * 用**真 cordis**（DSH 自带的 @deepseek-ai/cordis 4.1.0）验证 agent/pre-step 的中间件契约。
 *
 * 这条链是 waterfall：监听器不调 next() 就否决整条链，`ctx.waterfall()` 的返回值变成
 * 该监听器的返回值。DSH agent-loop 拿到它后立刻读 `decision.kind`，所以监听器返回
 * undefined 就是「Cannot read properties of undefined (reading 'kind')」——用户遇到的崩溃。
 *
 *   node tests/cordis-waterfall.test.mjs
 *   DSH_CORDIS_PATH=<cordis/lib/index.js> node tests/cordis-waterfall.test.mjs
 *
 * 找不到 cordis 时跳过（不算失败）：包在 DSH 的 app.asar 里，需要先解出来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  process.env.DSH_CORDIS_PATH,
  'C:/Users/63127/.dsh/profiles/desktop/node_modules/@deepseek-ai/cordis/lib/index.js',
  path.resolve(process.cwd(), '.tmp-asar/c/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'),
  'G:/华仔的小肥余专属工作区/.tmp-asar/c/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
].filter(Boolean);

const found = CANDIDATES.find(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!found) {
  console.log('跳过：没找到 @deepseek-ai/cordis（设 DSH_CORDIS_PATH 指向 cordis/lib/index.js）');
  process.exit(0);
}

const { Context } = await import(pathToFileURL(found).href);

const checks = [];
const ok = (label, cond, extra) => checks.push({ label, pass: !!cond, extra: extra === undefined ? '' : String(extra) });
const section = (name) => console.log('\n[' + name + ']');

// ---------------------------------------------------------------------------
section('1 · 复现：监听器不调 next() → 返回值 undefined → decision.kind 崩');
{
  const ctx = new Context();
  ctx.on('agent/pre-step', async function () {
    return undefined; // 老代码的样子：包了一层 async，永远不调 next()
  });
  const decision = await ctx.waterfall('agent/pre-step', { messages: [] }, function () {
    return { kind: 'enter' };
  });
  ok('不调 next() 时返回值是 undefined', decision === undefined, typeof decision);
  let crash = null;
  try {
    const kind = decision.kind; // DSH agent-loop 就写了这一行
    void kind;
  } catch (e) {
    crash = e;
  }
  ok('于是 decision.kind 抛出 TypeError（就是用户看到的报错）', !!crash && /reading 'kind'/.test(String(crash.message)), crash && crash.message);
}

// ---------------------------------------------------------------------------
section('2 · 修复后：插件中间件必须把 decision 原样传下去');
{
  const mod = await import('../index.js');
  const ctx = new Context();
  const registered = new Map();
  const fake = {
    ctx: ctx,
    tools: { register: function (spec) { registered.set(spec.name, spec); return spec; } },
    on: ctx.on.bind(ctx),
    inject: function (names, fn) { return fn(fake); },
    effect: function (fn) { return fn(); },
  };
  ctx.tools = fake.tools;
  // 用插件的 apply() 真注册一遍（走 onMiddleware，而不是裸 on）；库指到临时目录，别碰真库
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xfy-cordis-'));
  mod.apply(fake, { root: tmpRoot, defaultPartition: 'xiaofeiyu' });
  const decision = await ctx.waterfall('agent/pre-step', { messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }, function () {
    return { kind: 'enter' };
  });
  ok('插件中间件返回的不是 undefined', decision !== undefined, typeof decision);
  ok('返回的是 decision（kind=enter）', !!(decision && decision.kind === 'enter'), decision && decision.kind);
  let crash = null;
  try {
    if (decision.kind === 'reject') crash = new Error('reject');
  } catch (e) {
    crash = e;
  }
  ok('decision.kind 不再抛错', crash === null, crash && crash.message);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* sqlite 句柄随进程退出 */ }
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log((c.pass ? 'PASS ' : 'FAIL ') + c.label + (c.extra ? ' (' + c.extra + ')' : ''));
console.log('cordis waterfall 契约：通过 ' + (checks.length - failed.length) + ' / 失败 ' + failed.length + ' · cordis=' + found);
if (failed.length) process.exitCode = 1;
