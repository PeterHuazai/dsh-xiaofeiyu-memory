/**
 * lib/client.js 自测（ds - 直接 node 跑，无测试框架）
 *   node tests/client-panel.test.mjs
 * 覆盖：语法检查 / 静态约束 / 假 __ModuleLoader__ 装载 / 假 ctx 注册断言 /
 *       16 个板块 renderToStaticMarkup / api() 相对前缀失败后退到 127.0.0.1 /
 *       服务端 400 不换入口原样上抛。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const React = require('react');
const ReactDOM = require('react-dom');
const ReactDOMServer = require('react-dom/server');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUNDLE = path.join(ROOT, 'lib', 'client.js');
const BT = String.fromCharCode(96);

let passed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed += 1; return true; }
  failures.push(label + (extra ? ' :: ' + extra : ''));
  console.error('  ✗ ' + label + (extra ? ' :: ' + extra : ''));
  return false;
}
function eq(actual, expected, label) {
  return ok(actual === expected, label, 'expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
}
function section(name) { console.log('\n[' + name + ']'); }

const src = fs.readFileSync(BUNDLE, 'utf8');

// ---------------------------------------------------------------------------
section('1 · 语法与静态约束');
try {
  execFileSync(process.execPath, ['--check', BUNDLE], { stdio: 'pipe' });
  ok(true, 'node --check lib/client.js');
  console.log('  ✓ node --check 通过，' + src.split('\n').length + ' 行 / ' + Buffer.byteLength(src, 'utf8') + ' 字节');
} catch (e) {
  const detail = (e.stderr ? e.stderr.toString() : '') + (e.stdout ? e.stdout.toString() : '');
  ok(false, 'node --check lib/client.js', detail.slice(0, 600));
}
ok(/window\.__ModuleLoader__\.load\(\{id:[^,]*dsh-xiaofeiyu-memory[^,]*,\s*factory:require=>\{/.test(src), 'id 与 factory 形状正确');
ok(/return module\.exports\}\}\);/.test(src), 'wrapper 以 return module.exports}}); 收尾');
ok(!/^\s*import\s/m.test(src), '没有 import 语句');
ok(!/\bexport\s+(default|const|function|class)\b/.test(src), '没有 ESM export 语句');
ok(!/require\(\s*['"]@deepseek-ai/.test(src), '没有 require @deepseek-ai/*');
const externals = (src.match(/https?:\/\/[^\s'"\x60)]+/g) || []).filter(function (u) { return u.indexOf('127.0.0.1') < 0 && u.indexOf('localhost') < 0; });
ok(externals.length === 0, 'bundle 里没有出网的外部 http(s) 地址', externals.join(', '));
console.log('  外部地址扫描：' + (externals.length ? externals.join(', ') : '无（只有 127.0.0.1 兜底）'));
// 导入必须传「分区名」：面板以前传的是会话目录名（--G-~6BD5…--），后端只认分区名 → 永远导入 0 条。
ok(src.indexOf('dryRun(keyOf(r))') >= 0, '面板「预演」传分区名而不是目录名');
ok(src.indexOf('doImport(keyOf(current))') >= 0, '面板「确认导入」同样传分区名');

// ---------------------------------------------------------------------------
section('2 · 用假 __ModuleLoader__ 装载 bundle');
let loadedDef = null;
const fetchCalls = [];
let fetchImpl = async function (url) {
  fetchCalls.push(String(url));
  return { ok: true, status: 200, text: async function () { return JSON.stringify({ ok: true, url: String(url) }); } };
};
const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  AbortController: AbortController,
  URL: URL,
  TextEncoder: TextEncoder,
  TextDecoder: TextDecoder,
  fetch: function (url, init) { return fetchImpl(url, init); },
  window: {}
};
sandbox.window.__ModuleLoader__ = {
  load: function (def) { loadedDef = def; }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'lib/client.js' });
ok(!!loadedDef, '__ModuleLoader__.load 被调用');
eq(loadedDef && loadedDef.id, 'dsh-xiaofeiyu-memory', 'bundle id');
ok(typeof (loadedDef && loadedDef.factory) === 'function', 'factory 是函数');
const bundle = loadedDef.factory(function (name) {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  if (name === 'react-dom/server') return ReactDOMServer;
  throw new Error('unexpected require: ' + name);
});
ok(!!bundle, 'factory 返回 module.exports');
console.log('  ✓ 装载成功，version=' + String(bundle.version) + '，导出键：' + Object.keys(bundle).join(', '));

// ---------------------------------------------------------------------------
section('3 · 假 ctx 注册断言');
function makeCtx() {
  const self = {
    effects: 0,
    // 子 fiber：sidebarRightTabs / sidebarRight 到位后才回调（这里直接当已就绪）
    inject: function (names, fn) { self.injectedServices.push(names.join('+')); return fn(self); },
    injectedServices: [],
    slots: {
      injected: [],
      registered: [],
      inject: function (name, fn) { this.injected.push(name); return fn(); },
      register: function (def, Comp) { this.registered.push({ def: def, Comp: Comp }); return function () {}; }
    },
    sidebarRightTabs: { tab: null, register: function (d) { this.tab = d; return function () {}; } },
    sidebarRight: { opened: [], openTab: function (kind) { this.opened.push(kind); return true; } },
    effect: function (fn) { this.effects += 1; return fn; }
  };
  return self;
}
const ctx = makeCtx();
let applyThrew = null;
try { bundle.apply(ctx); } catch (e) { applyThrew = e; }
ok(!applyThrew, 'apply() 不抛错', applyThrew && applyThrew.message);
ok(JSON.stringify(bundle.inject) === JSON.stringify(['slots']), 'exports.inject 只等 slots（sidebar 服务放进子 fiber）', JSON.stringify(bundle.inject));
ok(ctx.injectedServices.indexOf('sidebarRightTabs+sidebarRight') >= 0, '用子 fiber 等 sidebarRightTabs + sidebarRight');
ok(ctx.slots.injected.indexOf('sidebar.right.pane.tab') >= 0, "注册了 slot 'sidebar.right.pane.tab'");
ok(ctx.slots.injected.indexOf('conversation.session.header.actions') >= 0, "注册了 slot 'conversation.session.header.actions'");
eq(ctx.sidebarRightTabs.tab && ctx.sidebarRightTabs.tab.kind, 'xfy-memory', 'tab 类型 kind === xfy-memory');
eq(ctx.sidebarRightTabs.tab && ctx.sidebarRightTabs.tab.id, 'xfy-memory-pane', 'tab id');
eq(typeof (ctx.sidebarRightTabs.tab && ctx.sidebarRightTabs.tab.title), 'function', 'tab title 是函数');
// 单条 guide 会被 defaultSeed 当成默认页，把每个新会话的右栏抢成记忆面板 —— 必须没有
ok(!ctx.sidebarRightTabs.tab || !ctx.sidebarRightTabs.tab.guide || ctx.sidebarRightTabs.tab.guide.length === 0, 'tab 不抢默认页（guide 为空）');
const paneReg = ctx.slots.registered.filter(function (r) { return r.def && r.def.name === 'sidebar.right.pane.tab'; })[0];
ok(!!paneReg, 'slot.register 收到 pane 定义');
eq(paneReg && paneReg.def.key, 'xfy-memory-pane', 'pane key === xfy-memory-pane');
eq(typeof (paneReg && paneReg.Comp), 'function', 'pane 组件是函数组件');
const headReg = ctx.slots.registered.filter(function (r) { return r.def && r.def.name === 'conversation.session.header.actions'; })[0];
ok(!!headReg, 'slot.register 收到 header 定义');
eq(headReg && headReg.def.id, 'xfy-memory-open', 'header id');
eq(headReg && headReg.def.order, 30, 'header order');
ok(JSON.stringify(bundle.registered.errors) === '[]', 'apply 期间没有捕获到错误', JSON.stringify(bundle.registered.errors));
ok(bundle.registered.tabs && bundle.registered.pane && bundle.registered.header, '三处注册都成功');
// 空 ctx / 残缺 ctx 不抛
let brokenThrew = null;
try { bundle.apply(undefined); bundle.apply({}); bundle.apply({ slots: null, sidebarRightTabs: { register: function () { throw new Error('boom'); } } }); } catch (e) { brokenThrew = e; }
ok(!brokenThrew, 'apply() 对残缺 ctx 也不抛错', brokenThrew && brokenThrew.message);
// 右栏服务永远没到位（比如 side-bar 插件没加载）：面板本体照样挂上，tab 不注册、不抛
const dormant = {
  slotNames: [],
  slots: {
    inject: function (name, fn) { dormant.slotNames.push(name); return fn(); },
    register: function () { return function () {}; }
  },
  inject: function () { return null; }
};
let dormantThrew = null;
try { bundle.apply(dormant); } catch (e) { dormantThrew = e; }
ok(!dormantThrew, '右栏服务缺席时 apply() 不抛错', dormantThrew && dormantThrew.message);
ok(dormant.slotNames.indexOf('sidebar.right.pane.tab') >= 0, '右栏服务缺席时仍注册面板 slot');
ok(dormant.slotNames.indexOf('conversation.session.header.actions') < 0, '右栏服务缺席时不注册头部按钮');
console.log('  ✓ slot=' + ctx.slots.injected.join(' + ') + '，kind=' + ctx.sidebarRightTabs.tab.kind + '，header.id=' + headReg.def.id);

// ---------------------------------------------------------------------------
section('4 · 夹具与 16 个板块渲染');
const NOW = 1770000000000;
function mkItem(i) {
  return {
    id: 'it-' + i, partition_id: 'p1', kind: i === 1 ? 'trunk' : 'fact',
    title: '记忆条目 ' + i, body: '正文内容 ' + i + ' '.repeat(6) + '细节说明。'.repeat(3),
    tags: ['tag' + i, 'demo'], importance: 3 + i, pinned: i === 2, state: 'active',
    stability: 12.5 + i, created_at: NOW - i * 86400000, updated_at: NOW - i * 3600000,
    last_access_at: NOW - i * 60000, access_count: i, hit_count: i, redundant_reads: 0,
    source: 'test', retention: 0.92 - i * 0.05
  };
}
const curvePoints = [];
for (let d = 0; d < 60; d += 1) curvePoints.push({ day: d, retention: 0.55 + 0.42 * Math.exp(-d / 14) });
const timelinePoints = [];
for (let d = 29; d >= 0; d -= 1) timelinePoints.push({ day: '2026-10-' + String(30 - d).padStart(2, '0'), ts: NOW - d * 86400000, recalls: 3 + (d % 4), hits: 1 + (d % 3) });
const FIX = {
  state: {
    overview: {
      generatedAt: NOW,
      partitions: [{
        id: 'p1', name: 'p1', title: '工作', description: '工作记忆', archived: 0,
        items: { active: 4, dormant: 1, archived: 0 }, total: 5, pinned: 1, avgRetention: 0.72,
        hit24h: { windowHours: 24, recalls: 12, hits: 7, returned: 20, redundant: 1, hitRate: 0.58 },
        hit7d: { windowHours: 168, recalls: 40, hits: 18, returned: 90, redundant: 3, hitRate: 0.45 },
        lastRecall: { ts: NOW - 3600000, query: '部署流程' }, openTasks: 2
      }],
      totals: { active: 4, dormant: 1, partitions: 1, recalls: 42, guard: { info: 1, warn: 1, block: 0 } },
      hit24h: { windowHours: 24, recalls: 12, hits: 7, hitRate: 0.58 },
      storage: { dbBytes: 1234567, shadow: 2048, backups: 3 },
      curve: {}
    },
    activePartition: 'p1',
    items: [mkItem(1), mkItem(2), mkItem(3)],
    timeline: timelinePoints.slice(-30),
    recallEvents: [],
    guardEvents: [{ id: 11, level: 'warn', score: 0.61, ts: NOW - 1000, source: 'simulated', context_tokens: 130000, reasons: ['命中率低于地板'], deleted: 0, action: 'warn' }],
    recycle: { items: [] },
    reports: { reports: [] },
    tasks: [],
    audit: { findings: [] },
    backups: [{ path: 'data/backups/a.db' }, { path: 'data/backups/b.db' }],
    integrity: { ok: true, detail: 'ok' },
    now: NOW
  },
  items: { items: [mkItem(1), mkItem(2), mkItem(3), mkItem(4)] },
  curve: { item: 'it-1', stability: 14.2, baseStability: 10, boost: 1.42, trunk: true, floor: 0.55, points: curvePoints },
  timeline: { points: timelinePoints },
  digest: {
    days: 30, partition: 'p1',
    items: { created: 3, updated: 9, states: { active: 4 } },
    recall: { events: 40, returned: 80, judged: 30, hits: 18, hitRate: 0.45 },
    guards: 2, tasks: 1, reports: 1,
    nearForget: [{ id: 'it-3' }], cooling: [{ id: 'it-2' }], hottest: [], daily: []
  },
  guardFix: {
    partition: 'p1', generatedAt: NOW, level: 'warn', codes: ['STALE_ITEMS', 'NO_TRUNK'],
    requiresConfirm: true, confirmHint: '加 confirm=true 才执行',
    steps: [
      { id: 'sweep', title: '休眠/归档低留存条目', safe: true, reversible: true, detail: '按遗忘曲线降级', count: 3, preview: [{ id: 'it-3', title: '旧结论', retention: 0.11 }] },
      { id: 'trunk', title: '补一条主干草稿', safe: true, reversible: true, detail: '按高重要度条目拼', count: 8, preview: ['主干记忆一'] },
      { id: 'backup', title: '立刻备份数据库', safe: true, reversible: false, detail: '生成 .db 快照', count: 1, preview: [] },
      { id: 'cleanup', title: '清理统计窗口', safe: true, reversible: false, detail: '只删超期统计', count: 12, preview: [] },
      { id: 'merge', title: '合并近似条目', safe: false, reversible: true, detail: '被并条目归档', count: 2, preview: ['记忆条目 1 ← 1 条'] }
    ],
    trunk: { items: 6, tokens: 102, budget: 320, text: '★ 主干记忆一\n· 场景：插件收尾' }
  },
  guard: {
    events: [
      { id: 11, partition_id: 'p1', ts: NOW - 1000, level: 'warn', score: 0.61, reasons: ['命中率低于地板', '陈旧占比 0.52'], context_tokens: 130000, action: 'warn', source: 'simulated', deleted: 0 },
      { id: 12, partition_id: 'p1', ts: NOW - 90000, level: 'ok', score: 0.2, reasons: [], context_tokens: 40000, action: 'pass', source: 'real', deleted: 0 },
      { id: 13, partition_id: 'p1', ts: NOW - 190000, level: 'block', score: 0.83, reasons: ['超出阻断阈值'], context_tokens: 240000, action: 'block', source: 'real', deleted: 1 }
    ],
    total: 3, limit: 40, offset: 0, bySource: { real: 2, simulated: 1 }
  },
  audit: {
    generatedAt: NOW, hours: 168, severity: 'warn',
    findings: [
      { severity: 'warn', partition: 'p1', code: 'stale_share', message: '陈旧条目占比过高', suggestion: '跑一次合并或归档' },
      { severity: 'info', partition: 'p1', code: 'backup_ok', message: '备份正常', suggestion: '' }
    ]
  },
  recycle: { items: [{ id: 'r1', title: '旧记忆', deleted_at: NOW - 86400000, delete_reason: 'manual', expiresAt: NOW + 86400000, expired: false }] },
  trunk: {
    partition: 'p1', partitionId: 'p1',
    items: [{ id: 'it-1', partition_id: 'p1', title: '主干记忆一', kind: 'trunk', importance: 5, pinned: 1, stability: 20, boost: 1.4, effectiveStability: 28, retention: 0.92, reviews: 6, lapses: 1, difficulty: 4, last_review_at: NOW - 7200000 }]
  },
  merge: {
    dryRun: true, threshold: 0.6, candidates: 4,
    groups: [{ keeper: { id: 'it-1', title: '记忆条目 1', partition_id: 'p1' }, members: [{ id: 'it-2', title: '记忆条目 2', score: 0.82 }] }]
  },
  eval: {
    partition: 'p1', topK: 5, queries: 12,
    variants: [
      { name: 'current', queries: 12, hitRate: 0.66, mrr: 0.51, avgTokens: 180 },
      { name: 'keyword-only', queries: 12, hitRate: 0.5, mrr: 0.4, avgTokens: 120 },
      { name: 'vector-heavy', queries: 12, hitRate: 0.75, mrr: 0.6, avgTokens: 220 }
    ]
  },
  config: {
    curve: { stabilityBaseDays: 7, stabilityGrowth: 0.6, readGrowth: 0.12, forgetThreshold: 0.25, archiveThreshold: 0.02, trunkImportance: 4, trunkFloor: 0.55, trunkBoostGrowth: 1.35, trunkBoostMax: 4, reinforceGrowth: 1.2, displayDays: 120 },
    recall: { topK: 8, minScore: 0.12, weightRetention: 0.65, weightImportance: 1, pinnedBoost: 0.15 },
    guard: { contextWarnTokens: 120000, contextBlockTokens: 200000, hitRateFloor: 0.25, warnScore: 0.5, blockScore: 0.75 },
    vector: { enabled: true, vectorWeight: 0.6, vectorFloor: 0.15 },
    lifecycle: { recycleDays: 30 },
    backup: { keep: 7 }
  },
  export: { format: 'xiaofeiyu-memory-bundle', version: 1, exportedAt: NOW, partitions: [{ id: 'p1' }], items: [mkItem(1)], tasks: [], reports: [], events: [], guardEvents: [] },
  reports: { reports: [{ id: 1, title: '周报', summary: '本周记忆健康', path: 'data/reports/w.md', tokens: 1200, created_at: NOW - 7200000 }] },
  report: { path: 'data/reports/w.md', markdown: '# 周报\n\n- **命中率** 0.58\n- 守卫 2 条\n\n' + BT + BT + BT + 'js\nconst a = 1;\n' + BT + BT + BT + '\n' },
  vector: {
    enabled: true, dims: 256, model: 'hash-256', items: 60, covered: 54, vectorWeight: 0.6, vectorFloor: 0.15, fpWeight: 1.5,
    backend: { configured: 'sqlite', sqliteVecAvailable: true, effective: 'sqlite-vec', indexDims: 256, indexed: 54, extensionVersion: '0.1.6', error: null },
    provider: { enabled: false, endpoint: '', model: '' },
    deepseek: { enabled: false, model: 'deepseek-chat', apiKeyPresent: false, ready: false }
  },
  harness: {
    root: 'D:/dsh/sessions', exists: true,
    projects: [{
      dir: '/proj/a', cwd: '/proj/a', name: 'proj-a', partition: 'dsh-proj-a', sessionCount: 3, importedCount: 1,
      sessions: [{ id: 's1', title: '会话一', createdAt: NOW - 86400000, updatedAt: NOW - 3600000, firstUser: '你好', lastAssistant: '好的', turns: 6, toolCalls: 12, bytes: 20480, empty: false, imported: true, file: 's1.jsonl', cwd: '/proj/a' }]
    }],
    totals: { projects: 1, sessions: 3, imported: 1 }
  },
  health: { markdown: '# 健康日报\n\n- 条目 5\n- 命中率 58%\n', path: 'data/reports/health-2026-11-24.md' }
};

const EXPECT = {
  overview: '分区', items: '记忆条目', curve: '记忆曲线', trend: '召回', guard: '守卫事件', audit: '发现列表',
  recycle: '回收站', trunk: '主干条目', merge: '预演', eval: '变体', config: '关键参数', export: '导出预览',
  reports: '汇报列表', vector: '覆盖率', harness: '根目录', health: '健康日报'
};

ok(Array.isArray(bundle.PANES) && bundle.PANES.length === 16, 'PANES 有 16 个板块', String(bundle.PANES && bundle.PANES.length));
const sizes = {};
for (const item of bundle.PANES) {
  let markup = null;
  try {
    markup = ReactDOMServer.renderToStaticMarkup(React.createElement(bundle.MemoryPanel, { previewBoot: FIX, previewPartition: 'p1', previewPane: item.id }));
  } catch (e) {
    ok(false, '板块 ' + item.id + ' 渲染抛错', (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  }
  if (markup === null) continue;
  sizes[item.id] = Buffer.byteLength(markup, 'utf8');
  ok(markup.length > 400, '板块 ' + item.id + ' 有实际内容', String(markup.length));
  const marker = EXPECT[item.id];
  ok(!marker || markup.indexOf(marker) >= 0, '板块 ' + item.id + ' 含关键文案「' + marker + '」');
  console.log('  ' + item.label.padEnd(6, '　') + ' ' + item.id.padEnd(9) + Buffer.byteLength(markup, 'utf8') + ' 字节');
}

// 概览同时包含三个关键标题
let overviewMarkup = '';
try {
  overviewMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(bundle.MemoryPanel, { previewBoot: FIX, previewPartition: 'p1', previewPane: 'overview' }));
} catch (e) { /* 上面已记失败 */ }
for (const word of ['分区', '守卫', '评测']) ok(overviewMarkup.indexOf(word) >= 0, '概览输出含「' + word + '」');

// 守卫板块的「一键修复」卡片：计划步骤全部渲染出来，且默认只勾安全步骤
let guardMarkup = '';
try {
  guardMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(bundle.MemoryPanel, { previewBoot: FIX, previewPartition: 'p1', previewPane: 'guard' }));
} catch (e) { ok(false, '守卫板块渲染抛错', String(e)); }
ok(guardMarkup.indexOf('一键修复') >= 0, '守卫板块含「一键修复」卡片');
ok(guardMarkup.indexOf('主干摘要') >= 0 && guardMarkup.indexOf('102') >= 0, '一键修复卡显示主干摘要与 token 成本');
for (const t of ['休眠/归档低留存条目', '补一条主干草稿', '立刻备份数据库', '清理统计窗口', '合并近似条目']) {
  ok(guardMarkup.indexOf(t) >= 0, '计划里有步骤「' + t + '」');
}
ok(guardMarkup.indexOf('执行选中') >= 0, '有「执行选中」按钮（带二次确认）');
ok(guardMarkup.indexOf('★ 主干') >= 0 || guardMarkup.indexOf('层') >= 0, '条目表格带层级列');

// Ctrl+K 检索浮层（预览可直达，SSR 下不应抛错）
let overlayMarkup = '';
try {
  overlayMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(bundle.MemoryPanel, { previewBoot: FIX, previewPartition: 'p1', previewPane: 'overview', previewSearch: true }));
} catch (e) { ok(false, '检索浮层渲染抛错', String(e)); }
ok(overlayMarkup.indexOf('检索') >= 0, 'Ctrl+K 检索浮层渲染出「检索」');

// 无预览夹具（走真实取数路径的第一帧）也不该抛错
for (const item of bundle.PANES) {
  try {
    ReactDOMServer.renderToStaticMarkup(React.createElement(bundle.MemoryPanel, { previewPartition: '', previewPane: item.id }));
    ok(true, '板块 ' + item.id + ' 无夹具首帧不抛错');
  } catch (e) {
    ok(false, '板块 ' + item.id + ' 无夹具首帧抛错', String(e && e.message));
  }
}

// 页面 base 解析：这是「一打开面板就网络错误」的原始 bug —— url 必须带上 /xfy-memory/api/
// 前缀，并且挂在页面自己的 origin 上（桌面壳是 dsh-app，不能打宿主真实端口）。
const pageDoc = function (baseURI) { sandbox.document = { baseURI: baseURI }; };
pageDoc('http://127.0.0.1:65174/');
fetchCalls.length = 0;
fetchImpl = async function (url) {
  fetchCalls.push(String(url));
  return { ok: true, status: 200, text: async function () { return JSON.stringify({ ok: true }); } };
};
let pageData = null;
try { pageData = await bundle.api('state?partition=p1'); } catch (e) { /* 下面断言会看见 */ }
eq(fetchCalls[0], 'http://127.0.0.1:65174/xfy-memory/api/state?partition=p1', '页面 base 解析出带前缀的宿主路由');
ok(!!pageData && pageData.ok === true, '200 数据直接返回');
eq(fetchCalls.length, 1, '成功之后不再试兜底入口');

// 桌面壳：dsh-app://app/ 页面 → 同源转发路径，不能落到 127.0.0.1:8788
pageDoc('dsh-app://app/');
fetchCalls.length = 0;
try { await bundle.api('partition/p1'); } catch (e) { /* 只为看 URL */ }
eq(fetchCalls[0], 'dsh-app://app/xfy-memory/api/partition/p1', '桌面壳里走页面同源（dsh-app）入口');

// 反代目录前缀必须保留
pageDoc('https://example.com/dataops/proxy/3080/');
fetchCalls.length = 0;
try { await bundle.api('items?partition=p1'); } catch (e) { /* 同上 */ }
eq(fetchCalls[0], 'https://example.com/dataops/proxy/3080/xfy-memory/api/items?partition=p1', '反代前缀不被吃掉');
delete sandbox.document;

// ---------------------------------------------------------------------------
section('6 · api() 入口回退与服务端错误');
fetchCalls.length = 0;
fetchImpl = async function (url) {
  fetchCalls.push(String(url));
  const u = String(url);
  if (u.indexOf('/xfy-memory/api/') === 0) throw new TypeError('fetch failed');
  if (u.indexOf('http://127.0.0.1:8788/api/') === 0) {
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ via: '8788', items: [] }); } };
  }
  return { ok: false, status: 404, text: async function () { return '<html>not found</html>'; } };
};
let firstData = null;
let firstErr = null;
try { firstData = await bundle.api('items?partition=p1'); } catch (e) { firstErr = e; }
ok(!firstErr, '相对前缀失败后仍取到数据', firstErr && firstErr.message);
eq(firstData && firstData.via, '8788', '数据来自 127.0.0.1:8788 兜底');
ok(fetchCalls.length >= 2, '至少尝试了两次（相对前缀 + 兜底）', fetchCalls.join(' | '));
console.log('  调用序列：' + fetchCalls.join(' → '));

fetchCalls.length = 0;
fetchImpl = async function (url) {
  fetchCalls.push(String(url));
  return { ok: false, status: 400, text: async function () { return JSON.stringify({ error: 'partition 不存在' }); } };
};
let serverErr = null;
try { await bundle.api('items?partition=nope'); } catch (e) { serverErr = e; }
ok(!!serverErr, '服务端 400 会抛出');
eq(serverErr && serverErr.message, 'partition 不存在', '服务端错误原样上抛（不换入口）');
eq(fetchCalls.length, 1, '400 之后没有再试别的入口');

fetchCalls.length = 0;
fetchImpl = async function (url) {
  fetchCalls.push(String(url));
  return { ok: false, status: 404, text: async function () { return '<html>404</html>'; } };
};
let allFailed = null;
try { await bundle.api('items?partition=p1'); } catch (e) { allFailed = e; }
ok(!!allFailed, '全部入口失败会抛错');
ok(/已尝试 \d+ 个入口/.test(String(allFailed && allFailed.message)), '错误里写明尝试的入口数', String(allFailed && allFailed.message));
console.log('  最终错误：' + String(allFailed && allFailed.message));

// ---------------------------------------------------------------------------
console.log('\n================ 结果 ================');
console.log('通过断言：' + passed + '，失败：' + failures.length);
console.log('lib/client.js：' + src.split('\n').length + ' 行 / ' + Buffer.byteLength(src, 'utf8') + ' 字节');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('全绿 ✅');
}
