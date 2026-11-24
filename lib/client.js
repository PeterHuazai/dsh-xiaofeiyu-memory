/**
 * 小肥鱼记忆 · DSH 客户端 bundle（手写，无构建）
 * ---------------------------------------------------------------------------
 * 这是给 DSH Web 用的客户端产物：单文件、手写、无打包、无 JSX、无 TS、无 import。
 * 平台基座只保证 require('react') 与 require('react-dom')，其余全部用 React.createElement。
 * 结构分节：
 *   01 常量与工具   02 HTTP（/xfy-memory/api 优先，127.0.0.1 兜底）
 *   03 数据钩子与上下文   04 基础组件 + 手写 SVG 图表
 *   05 十六个板块        06 面板外壳（导航 / 状态栏 / Ctrl+K 检索）
 *   07 apply() 注册
 */
window.__ModuleLoader__.load({id:`dsh-xiaofeiyu-memory`,factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:`Module`});
const React = require('react');
const ReactDOM = require('react-dom');

const h = React.createElement;
const useState = React.useState;
const useEffect = React.useEffect;
const useMemo = React.useMemo;
const useCallback = React.useCallback;
const useContext = React.useContext;

// ===========================================================================
// 01 · 常量与工具
// ===========================================================================
const API_PREFIX = '/xfy-memory/api/';
// 相对前缀（DSH 宿主转发）失败时按顺序兜底；只打 127.0.0.1，不出网
const FALLBACK_PREFIXES = ['http://127.0.0.1:8788/api/', 'http://127.0.0.1:8787/api/'];
const TIMEOUT_MS = 5000;
const PAGE_LIMIT = 20;

const COLORS = {
  bg: 'var(--dsw-alias-bg-l1, #0f1417)',
  bg2: 'var(--dsw-alias-bg-l2, #151c21)',
  bg3: 'var(--dsw-alias-bg-l3, #1b242a)',
  line: 'var(--dsw-alias-border-l1, #2a353d)',
  text: 'var(--dsw-alias-text-l1, #e8eef3)',
  dim: 'var(--dsw-alias-text-l2, #97a6b1)',
  mute: 'var(--dsw-alias-text-l3, #6d7d88)',
  accent: 'var(--dsw-alias-brand-primary, #4fd1c5)'
};
// 状态色一律用十六进制：Chip/Dot 会拼透明度后缀（var() 拼不了）
const TONE = { ok: '#43c59e', warn: '#e3b341', bad: '#f06a62', block: '#f06a62', info: '#6ea8ff', mute: '#7b8794', violet: '#b18cff' };

const S = {
  pane: { display: 'flex', height: '100%', minHeight: 0, background: COLORS.bg, color: COLORS.text, font: '12px/1.55 ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' },
  nav: { flex: '0 0 92px', width: 92, borderRight: '1px solid ' + COLORS.line, overflowY: 'auto', padding: '6px 4px', boxSizing: 'border-box', background: COLORS.bg2 },
  body: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
  content: { flex: '1 1 auto', overflow: 'auto', padding: '10px 10px 28px', minHeight: 0 },
  muted: { color: COLORS.mute, fontSize: 10 },
  dim: { color: COLORS.dim },
  h2: { fontSize: 12, margin: '0 0 6px', fontWeight: 600 },
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  mono: { font: '10px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace' }
};

function warn(where, err) {
  try {
    if (typeof console !== 'undefined' && console.warn) console.warn('[xfy-memory] ' + where + '：' + String(err && err.message ? err.message : err));
  } catch (e) { /* 日志本身不能再抛 */ }
}
function num(v, fallback) { const n = Number(v); return isFinite(n) ? n : (fallback === undefined ? 0 : fallback); }
function clamp(n, lo, hi) { const v = Number(n); if (!isFinite(v)) return lo; return Math.min(hi, Math.max(lo, v)); }
function fixed(v, digits) { const n = Number(v); return isFinite(n) ? n.toFixed(digits === undefined ? 2 : digits) : '—'; }
function pct(v, digits) { const n = Number(v); return isFinite(n) ? (n * 100).toFixed(digits === undefined ? 0 : digits) + '%' : '—'; }
function arr(v) { return Array.isArray(v) ? v : []; }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function enc(v) { return encodeURIComponent(String(v === null || v === undefined ? '' : v)); }
function clip(s, n) {
  const t = String(s === null || s === undefined ? '' : s).replace(/[\r\n\t]+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function bytes(v) {
  const n = Number(v) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function pad2(x) { return x < 10 ? '0' + x : String(x); }
function ts(v) {
  const n = Number(v);
  if (!n) return '—';
  const d = new Date(n);
  if (isNaN(d.getTime())) return String(v);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function ago(v) {
  const n = Number(v);
  if (!n) return '—';
  const diff = Date.now() - n;
  if (diff < 60000) return '刚刚';
  const m = Math.round(diff / 60000);
  if (m < 60) return m + ' 分钟前';
  const hrs = Math.round(m / 60);
  if (hrs < 24) return hrs + ' 小时前';
  return Math.round(hrs / 24) + ' 天前';
}
function buildQuery(params) {
  const p = obj(params);
  const out = [];
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (v === null || v === undefined || v === '') continue;
    out.push(enc(k) + '=' + enc(v));
  }
  return out.length ? '?' + out.join('&') : '';
}
/** 给任意 /api 路径补上 partition 与额外查询参数 */
function withP(path, partition, extra) {
  return path + buildQuery(Object.assign({ partition: partition }, extra || {}));
}
function summarize(data) {
  if (data === null || data === undefined) return '完成';
  if (typeof data !== 'object') return clip(data, 160);
  const bits = [];
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v === null || typeof v === 'object') continue;
    bits.push(k + '=' + String(v));
    if (bits.length >= 6) break;
  }
  return bits.length ? bits.join(' · ') : '完成';
}

// ===========================================================================
// 02 · HTTP：api(path) / 下载链接
// ===========================================================================
const net = { ms: 0, path: '', ok: null, error: null, base: '', listeners: [] };

function netEmit() {
  for (const fn of net.listeners) { try { fn(net); } catch (e) { /* 监听器自己的问题 */ } }
}
function subscribeNet(fn) {
  net.listeners.push(fn);
  return function () { net.listeners = net.listeners.filter(function (f) { return f !== fn; }); };
}
/** 下载/跳转用：baseIndex 0 = 宿主相对前缀，1..n = 对应兜底入口 */
function linkFor(pathWithQuery, baseIndex) {
  const base = baseIndex ? FALLBACK_PREFIXES[baseIndex - 1] : API_PREFIX;
  return base + String(pathWithQuery || '');
}

async function requestOnce(url, options) {
  const o = options || {};
  const method = String(o.method || 'GET').toUpperCase();
  const hasBody = o.body !== undefined && o.body !== null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let aborted = false;
  const timer = setTimeout(function () {
    aborted = true;
    if (ctrl) { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }
  }, TIMEOUT_MS);
  const init = { method: method, headers: { 'content-type': 'application/json' }, cache: 'no-store' };
  if (ctrl) init.signal = ctrl.signal;
  if (hasBody) init.body = JSON.stringify(o.body);
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = data && typeof data === 'object' && data.error
        ? String(data.error)
        : (typeof data === 'string' && data.trim() ? clip(data.trim(), 200) : 'HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      // 404/405/501 或返回的不是 JSON（宿主没转发）=> 换下一个入口再试
      err.nextBase = res.status === 404 || res.status === 405 || res.status === 501 || !data || typeof data !== 'object';
      throw err;
    }
    return data;
  } catch (err) {
    if (err && err.status) throw err;
    const e2 = new Error(aborted ? '请求超时（' + TIMEOUT_MS + 'ms）：' + url : '网络错误：' + String(err && err.message ? err.message : err));
    e2.nextBase = true;
    throw e2;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * api('state?partition=work', { method:'POST', body:{...} })
 * 先打宿主相对前缀；失败且原因像"没转发"时，退到 127.0.0.1:8788 / 8787。
 * 服务端明确报错（400/500 带 {error}）时不换入口，错误文案原样上抛。
 */
async function api(path, options) {
  const o = options || {};
  const bases = [];
  if (o.base !== undefined && o.base !== null) bases.push(String(o.base));
  if (net.base) bases.push(net.base);
  bases.push('');
  for (const b of FALLBACK_PREFIXES) bases.push(b);
  const tried = [];
  let last = null;
  for (const base of bases) {
    if (tried.indexOf(base) >= 0) continue;
    tried.push(base);
    const url = base + String(path || '');
    const started = Date.now();
    try {
      const data = await requestOnce(url, o);
      net.base = base;
      net.ms = Date.now() - started;
      net.path = String(path || '');
      net.ok = true;
      net.error = null;
      netEmit();
      return data;
    } catch (err) {
      net.ms = Date.now() - started;
      net.path = String(path || '');
      net.ok = false;
      net.error = String(err && err.message ? err.message : err);
      netEmit();
      last = err;
      if (!err || !err.nextBase) throw err;
    }
  }
  const e = new Error((last ? last.message : '请求失败') + '（已尝试 ' + tried.length + ' 个入口）');
  e.tried = tried;
  throw e;
}

// ===========================================================================
// 03 · 数据钩子与上下文
// ===========================================================================
const BootContext = React.createContext(null);
const DEFAULT_SHELL = { data: null, error: null, loading: false, reload: function () {} };
const DEFAULT_PANEL = { partition: '', setPartition: function () {}, refresh: function () {}, refreshToken: 0, notify: function () {}, shell: DEFAULT_SHELL };
const PanelContext = React.createContext(DEFAULT_PANEL);

function usePanel() { return useContext(PanelContext); }

function useNetSnapshot() {
  const [snap, setSnap] = useState({ ms: 0, path: '', ok: null, error: null });
  useEffect(function () {
    return subscribeNet(function (n) { setSnap({ ms: n.ms, path: n.path, ok: n.ok, error: n.error }); });
  }, []);
  return snap;
}

/**
 * 每个板块自己拉自己的数据：一个板块挂了不影响别的板块。
 * path 为 null 时锁定（例如还没选分区）；bootKey 用于预览壳/SSR 注入夹具。
 */
function useFetch(path, options) {
  const panel = usePanel();
  const boot = useContext(BootContext);
  const o = options || {};
  const bootKey = o.bootKey;
  const hasBoot = !!(boot && bootKey && Object.prototype.hasOwnProperty.call(boot, bootKey));
  const [state, setState] = useState(function () {
    if (hasBoot) return { data: boot[bootKey], error: null, loading: false, ms: 0 };
    return { data: null, error: null, loading: !!path, ms: 0 };
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(function () { setTick(function (t) { return t + 1; }); }, []);
  useEffect(function () {
    if (!path) {
      setState({ data: null, error: null, loading: false, ms: 0 });
      return undefined;
    }
    let alive = true;
    setState(function (prev) { return { data: prev.data, error: null, loading: true, ms: prev.ms }; });
    api(path).then(function (data) {
      if (alive) setState({ data: data, error: null, loading: false, ms: net.ms });
    }).catch(function (err) {
      if (alive) setState({ data: null, error: String(err && err.message ? err.message : err), loading: false, ms: net.ms });
    });
    return function () { alive = false; };
  }, [path, panel.refreshToken, tick]);
  return { data: state.data, error: state.error, loading: state.loading, ms: state.ms, reload: reload };
}

/** 写操作：POST/PUT 的统一状态（busy + 结果文案），错误原样显示 */
function useAction() {
  const panel = usePanel();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const run = useCallback(async function (path, body, method) {
    setBusy(true);
    setResult(null);
    try {
      const data = await api(path, { method: method || 'POST', body: body });
      const text = summarize(data);
      setResult({ ok: true, text: text, data: data });
      if (panel.notify) panel.notify('已提交 · ' + text);
      return data;
    } catch (err) {
      const text = String(err && err.message ? err.message : err);
      setResult({ ok: false, text: text });
      if (panel.notify) panel.notify('失败 · ' + text);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy: busy, result: result, run: run };
}

// ===========================================================================
// 04 · 基础组件
// ===========================================================================
function Btn(props) {
  const p = props || {};
  const style = Object.assign({
    background: p.primary ? 'rgba(79,209,197,0.14)' : 'transparent',
    border: '1px solid ' + (p.primary ? 'rgba(79,209,197,0.45)' : COLORS.line),
    color: p.primary ? COLORS.accent : COLORS.text,
    borderRadius: 6,
    padding: '3px 8px',
    fontSize: 11,
    lineHeight: 1.5,
    cursor: p.disabled ? 'not-allowed' : 'pointer',
    opacity: p.disabled ? 0.45 : 1,
    whiteSpace: 'nowrap'
  }, p.style || {});
  return h('button', { type: 'button', title: p.title || undefined, disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onClick, style: style }, p.children);
}

function Chip(props) {
  const tone = TONE[props.tone] || COLORS.mute;
  return h('span', {
    style: {
      display: 'inline-block', padding: '0 5px', marginRight: 4, borderRadius: 4, fontSize: 10, lineHeight: '16px',
      color: tone, border: '1px solid ' + tone + '55', background: tone + '18', whiteSpace: 'nowrap'
    }
  }, props.children);
}

function Dot(props) {
  const tone = TONE[props.tone] || COLORS.mute;
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 6 } },
    h('i', { style: { width: 7, height: 7, borderRadius: '50%', background: tone, boxShadow: '0 0 0 2px ' + tone + '22', display: 'inline-block' } }),
    h('span', { style: { color: COLORS.dim, fontSize: 10 } }, props.label));
}

function Card(props) {
  const p = props || {};
  const head = (p.title || p.right)
    ? h('header', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 } },
      h('strong', { style: { fontSize: 12, color: COLORS.text, fontWeight: 600 } }, p.title || ''),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, p.right || null))
    : null;
  return h('section', { style: Object.assign({ background: COLORS.bg2, border: '1px solid ' + COLORS.line, borderRadius: 8, padding: '8px 10px', marginBottom: 10 }, p.style || {}) }, head, p.children);
}

function Stat(props) {
  const tone = props.tone ? TONE[props.tone] : COLORS.text;
  return h('div', { style: { minWidth: 0 } },
    h('div', { style: { fontSize: 10, color: COLORS.mute, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, props.label),
    h('div', { style: { fontSize: 15, fontWeight: 600, color: tone, lineHeight: 1.3 } }, props.value),
    props.hint ? h('div', { style: { fontSize: 10, color: COLORS.mute } }, props.hint) : null);
}

function Stats(props) {
  const items = arr(props.items);
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(' + num(props.cols, 2) + ', minmax(0, 1fr))', gap: 8, marginBottom: 8 } },
    items.map(function (it, i) { return h(Stat, { key: i, label: it.label, value: it.value, hint: it.hint, tone: it.tone }); }));
}

function KV(props) {
  const rows = arr(props.rows);
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '2px 8px', fontSize: 11 } },
    rows.map(function (r, i) {
      return [
        h('div', { key: 'k' + i, style: { color: COLORS.mute, whiteSpace: 'nowrap' } }, r[0]),
        h('div', { key: 'v' + i, style: { color: r[2] ? (TONE[r[2]] || COLORS.text) : COLORS.text, wordBreak: 'break-word' } }, r[1] === null || r[1] === undefined || r[1] === '' ? '—' : r[1])
      ];
    }));
}

function Table(props) {
  const cols = arr(props.cols);
  const rows = arr(props.rows);
  const head = h('thead', null, h('tr', null, cols.map(function (c, i) {
    return h('th', { key: i, style: { textAlign: c.align || 'left', padding: '4px 6px', borderBottom: '1px solid ' + COLORS.line, color: COLORS.mute, fontWeight: 500, whiteSpace: 'nowrap', background: COLORS.bg3, position: 'sticky', top: 0 } }, c.label);
  })));
  const body = h('tbody', null, rows.length
    ? rows.map(function (r, ri) {
      return h('tr', {
        key: ri,
        onClick: props.onRow ? function () { props.onRow(r, ri); } : undefined,
        style: { cursor: props.onRow ? 'pointer' : 'default', background: props.activeRow && props.activeRow(r) ? 'rgba(79,209,197,0.08)' : 'transparent' }
      }, cols.map(function (c, ci) {
        return h('td', {
          key: ci,
          style: { textAlign: c.align || 'left', padding: '4px 6px', borderBottom: '1px solid ' + COLORS.line + '66', verticalAlign: 'top', color: COLORS.text, maxWidth: c.max || 230, whiteSpace: c.wrap ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', wordBreak: c.wrap ? 'break-word' : 'normal' }
        }, c.render ? c.render(r, ri) : (r[c.key] === null || r[c.key] === undefined ? '—' : r[c.key]));
      }));
    })
    : h('tr', null, h('td', { colSpan: Math.max(1, cols.length), style: { padding: '10px', color: COLORS.mute, textAlign: 'center', fontSize: 11 } }, props.empty || '没有数据')));
  return h('div', { style: { overflowX: 'auto', border: '1px solid ' + COLORS.line, borderRadius: 6 } },
    h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 11 } }, head, body));
}

const INPUT_STYLE = {
  background: COLORS.bg, border: '1px solid ' + COLORS.line, borderRadius: 6, color: COLORS.text,
  padding: '3px 6px', fontSize: 11, outline: 'none', boxSizing: 'border-box'
};

function Input(props) {
  const p = props || {};
  return h('input', {
    type: p.type || 'text',
    value: p.value === undefined || p.value === null ? '' : p.value,
    placeholder: p.placeholder || '',
    disabled: !!p.disabled,
    onChange: function (e) { if (p.onChange) p.onChange(e.target.value); },
    onKeyDown: p.onKeyDown,
    style: Object.assign({}, INPUT_STYLE, p.wide ? { width: '100%' } : {}, p.style || {})
  });
}

function Select(props) {
  const p = props || {};
  const options = arr(p.options);
  return h('select', {
    value: p.value === undefined || p.value === null ? '' : p.value,
    disabled: !!p.disabled,
    onChange: function (e) { if (p.onChange) p.onChange(e.target.value); },
    style: Object.assign({}, INPUT_STYLE, { padding: '2px 4px' }, p.style || {})
  }, options.map(function (o, i) { return h('option', { key: i, value: o.value }, o.label); }));
}

function Check(props) {
  const p = props || {};
  return h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: COLORS.dim, cursor: 'pointer', marginRight: 8 } },
    h('input', { type: 'checkbox', checked: !!p.checked, onChange: function (e) { if (p.onChange) p.onChange(e.target.checked); }, style: { accentColor: '#4fd1c5' } }),
    p.children);
}

function Meter(props) {
  const v = clamp(props.value, 0, 1);
  const tone = props.tone || (v >= 0.6 ? TONE.ok : v >= 0.3 ? TONE.warn : TONE.bad);
  return h('div', { style: { height: 5, minWidth: 36, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }, title: pct(v, 1) },
    h('div', { style: { width: (v * 100).toFixed(1) + '%', height: '100%', background: tone } }));
}

function Loading(props) {
  return h('div', { style: { color: COLORS.mute, fontSize: 11, padding: '10px 0' } }, props && props.text ? props.text : '加载中…');
}

function Empty(props) {
  return h('div', { style: { color: COLORS.mute, fontSize: 11, padding: '10px 0', textAlign: 'center' } }, props && props.text ? props.text : '没有数据');
}

function Err(props) {
  return h('div', { style: { border: '1px solid ' + TONE.bad + '66', background: TONE.bad + '12', borderRadius: 6, padding: '6px 8px', marginBottom: 8, fontSize: 11 } },
    h('div', { style: { color: '#ffd9d5', wordBreak: 'break-word' } }, '请求失败：' + (props.error || '未知错误')),
    props.onRetry ? h(Btn, { onClick: props.onRetry, style: { marginTop: 6 } }, '重试') : null);
}

function Notice(props) {
  const tone = TONE[props.tone] || TONE.info;
  return h('div', { style: { border: '1px solid ' + tone + '55', background: tone + '14', color: COLORS.text, borderRadius: 6, padding: '5px 8px', fontSize: 11, marginBottom: 8, wordBreak: 'break-word' } }, props.children);
}

// ---- 手写 SVG 图表（不引图表库）----
let chartSeq = 0;

function LineChart(props) {
  const pts = arr(props.points);
  const gid = useMemo(function () { chartSeq += 1; return 'xfy-curve-' + chartSeq; }, []);
  if (!pts.length) return h(Empty, { text: '没有曲线数据' });
  const W = 320;
  const H = num(props.height, 132);
  const pad = { l: 28, r: 8, t: 10, b: 18 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const maxDay = Math.max(1, num(pts[pts.length - 1].day, 1));
  const xOf = function (d) { return pad.l + (clamp(d, 0, maxDay) / maxDay) * iw; };
  const yOf = function (v) { return pad.t + (1 - clamp(v, 0, 1)) * ih; };
  const line = pts.map(function (p, i) { return (i ? 'L' : 'M') + xOf(p.day).toFixed(1) + ' ' + yOf(p.retention).toFixed(1); }).join(' ');
  const area = line + ' L' + xOf(maxDay).toFixed(1) + ' ' + (pad.t + ih).toFixed(1) + ' L' + pad.l + ' ' + (pad.t + ih).toFixed(1) + ' Z';
  const floor = num(props.floor, 0);
  const accent = props.color || '#4fd1c5';
  const grids = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = [0, Math.round(maxDay / 2), maxDay];
  return h('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, role: 'img', 'aria-label': props.label || '记忆曲线' },
    h('defs', null, h('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' },
      h('stop', { offset: '0%', stopColor: accent, stopOpacity: '0.34' }),
      h('stop', { offset: '100%', stopColor: accent, stopOpacity: '0.02' }))),
    grids.map(function (g, i) {
      return h('g', { key: 'g' + i },
        h('line', { x1: pad.l, y1: yOf(g), x2: pad.l + iw, y2: yOf(g), stroke: '#ffffff', strokeOpacity: g === 0 ? '0.22' : '0.07', strokeWidth: '1' }),
        h('text', { x: pad.l - 4, y: yOf(g) + 3, fill: COLORS.mute, fontSize: '8', textAnchor: 'end' }, String(Math.round(g * 100))));
    }),
    h('path', { d: area, fill: 'url(#' + gid + ')' }),
    h('path', { d: line, fill: 'none', stroke: accent, strokeWidth: '1.8', strokeLinejoin: 'round' }),
    floor > 0 ? h('line', { x1: pad.l, y1: yOf(floor), x2: pad.l + iw, y2: yOf(floor), stroke: '#e3b341', strokeWidth: '1', strokeDasharray: '4 3' }) : null,
    floor > 0 ? h('text', { x: pad.l + iw, y: yOf(floor) - 3, fill: '#e3b341', fontSize: '8', textAnchor: 'end' }, '地板 ' + pct(floor)) : null,
    xTicks.map(function (d, i) {
      return h('text', { key: 'x' + i, x: xOf(d), y: H - 5, fill: COLORS.mute, fontSize: '8', textAnchor: i === 0 ? 'start' : (i === xTicks.length - 1 ? 'end' : 'middle') }, d + 'd');
    }));
}

function BarChart(props) {
  const pts = arr(props.points);
  if (!pts.length) return h(Empty, { text: '还没有时间线数据' });
  const W = 320;
  const H = num(props.height, 124);
  const pad = { l: 24, r: 6, t: 8, b: 16 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  let max = 1;
  for (const p of pts) max = Math.max(max, num(p.recalls, 0), num(p.hits, 0));
  const bw = iw / Math.max(1, pts.length);
  const xOf = function (i) { return pad.l + i * bw; };
  const hOf = function (v) { return (Math.max(0, num(v, 0)) / max) * ih; };
  const rateLine = pts.map(function (p, i) {
    const r = num(p.recalls, 0) ? clamp(num(p.hits, 0) / num(p.recalls, 1), 0, 1) : 0;
    return (i ? 'L' : 'M') + (xOf(i) + bw / 2).toFixed(1) + ' ' + (pad.t + (1 - r) * ih).toFixed(1);
  }).join(' ');
  return h('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, role: 'img', 'aria-label': props.label || '命中率趋势' },
    [0, 0.5, 1].map(function (g, i) {
      const y = pad.t + (1 - g) * ih;
      return h('line', { key: 'g' + i, x1: pad.l, y1: y, x2: pad.l + iw, y2: y, stroke: '#ffffff', strokeOpacity: g === 0 ? '0.2' : '0.07', strokeWidth: '1' });
    }),
    h('text', { x: pad.l - 4, y: pad.t + 4, fill: COLORS.mute, fontSize: '8', textAnchor: 'end' }, String(max)),
    pts.map(function (p, i) {
      const x = xOf(i);
      const rc = hOf(p.recalls);
      const hi = hOf(p.hits);
      return h('g', { key: 'b' + i },
        h('title', null, String(p.day || '') + ' · 召回 ' + num(p.recalls, 0) + ' · 命中 ' + num(p.hits, 0)),
        h('rect', { x: (x + bw * 0.15).toFixed(1), y: (pad.t + ih - rc).toFixed(1), width: (bw * 0.7).toFixed(1), height: Math.max(rc, 0.6).toFixed(1), fill: '#6ea8ff', fillOpacity: '0.35', rx: '1' }),
        h('rect', { x: (x + bw * 0.3).toFixed(1), y: (pad.t + ih - hi).toFixed(1), width: (bw * 0.4).toFixed(1), height: Math.max(hi, 0.6).toFixed(1), fill: '#4fd1c5', rx: '1' }));
    }),
    h('path', { d: rateLine, fill: 'none', stroke: '#e3b341', strokeWidth: '1.2', strokeDasharray: '3 2' }),
    h('text', { x: pad.l, y: H - 4, fill: COLORS.mute, fontSize: '8' }, String(pts[0].day || '')),
    h('text', { x: pad.l + iw, y: H - 4, fill: COLORS.mute, fontSize: '8', textAnchor: 'end' }, String(pts[pts.length - 1].day || '')));
}

function Legend(props) {
  const items = arr(props.items);
  return h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, color: COLORS.mute, marginTop: 4 } },
    items.map(function (it, i) {
      return h('span', { key: i, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('i', { style: { width: 8, height: 8, borderRadius: 2, background: it.color, display: 'inline-block' } }),
        it.label);
    }));
}

// ===========================================================================
// 05 · 十六个板块（左侧导航一项一个组件，各自取数、各自报错）
// ===========================================================================
/** 从守卫生成一句人话 + 一个状态点（概览与状态栏共用） */
function guardSummary(events) {
  const list = arr(events);
  const out = { info: 0, ok: 0, warn: 0, block: 0, tone: 'ok', label: '正常', count: list.length };
  for (const e of list) {
    const lv = String((e && e.level) || 'info');
    if (out[lv] === undefined) out[lv] = 0;
    out[lv] += 1;
  }
  if (out.block) { out.tone = 'bad'; out.label = '有阻断'; }
  else if (out.warn) { out.tone = 'warn'; out.label = '有警告'; }
  return out;
}

// ---- 1 概览 --------------------------------------------------------------
function POverview() {
  const panel = usePanel();
  const shell = panel.shell || DEFAULT_SHELL;
  if (shell.error) return h(Err, { error: shell.error, onRetry: shell.reload });
  if (!shell.data) return h(Loading, null);
  const st = shell.data;
  const ov = obj(st.overview);
  const totals = obj(st.totals && Object.keys(obj(st.totals)).length ? st.totals : ov.totals);
  const parts = arr(ov.partitions);
  const integrity = obj(st.integrity);
  const storage = obj(ov.storage);
  const guard = guardSummary(st.guardEvents);
  return h('div', null,
    h(Card, { title: '完整性', right: h(Chip, { tone: integrity.ok ? 'ok' : 'bad' }, integrity.ok ? '正常' : '异常') },
      h(KV, { rows: [
        ['数据库', storage.dbBytes !== undefined ? bytes(storage.dbBytes) : '—'],
        ['影子日志', storage.shadow !== undefined ? bytes(storage.shadow) : '—'],
        ['备份', arr(st.backups).length + ' 份'],
        ['校验', integrity.detail ? clip(integrity.detail, 120) : '未报错'],
        ['生成于', ts(ov.generatedAt)]
      ] })),
    h(Card, { title: '分区', right: h('span', { style: S.muted }, parts.length + ' 个') },
      parts.length ? parts.map(function (p, i) {
        const items = obj(p.items);
        const hit = obj(p.hit24h);
        const active = panel.partition === p.name;
        return h('div', {
          key: i,
          onClick: function () { if (panel.setPartition) panel.setPartition(p.name); },
          style: { border: '1px solid ' + (active ? 'rgba(79,209,197,0.45)' : COLORS.line), background: active ? 'rgba(79,209,197,0.06)' : COLORS.bg3, borderRadius: 6, padding: '6px 8px', marginBottom: 6, cursor: 'pointer' }
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' } },
            h('strong', { style: { fontSize: 12 } }, p.title || p.name),
            h('span', { style: Object.assign({}, S.mono, { color: COLORS.mute }) }, p.name)),
          h('div', { style: { margin: '4px 0 3px', display: 'flex', gap: 4, flexWrap: 'wrap' } },
            h(Chip, { tone: 'ok' }, '活跃 ' + num(items.active, 0)),
            h(Chip, { tone: 'mute' }, '休眠 ' + num(items.dormant, 0)),
            h(Chip, { tone: 'mute' }, '归档 ' + num(items.archived, 0)),
            num(p.pinned, 0) ? h(Chip, { tone: 'violet' }, '钉住 ' + num(p.pinned, 0)) : null),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: S.muted }, '平均保留'),
            h(Meter, { value: p.avgRetention }),
            h('span', { style: { fontSize: 10 } }, pct(p.avgRetention, 1))),
          h('div', { style: Object.assign({}, S.muted, { marginTop: 2 }) },
            '24h 召回 ' + num(hit.recalls, 0) + ' · 命中 ' + num(hit.hits, 0) + '（' + pct(hit.hitRate, 0) + '）'
            + (num(p.openTasks, 0) ? ' · 未收尾任务 ' + num(p.openTasks, 0) : '')
            + (p.lastRecall && p.lastRecall.ts ? ' · 上次 ' + ago(p.lastRecall.ts) : '')));
      }) : h(Empty, { text: '还没有分区' })),
    h(Card, { title: '全局', right: h(Dot, { tone: guard.tone, label: '守卫 ' + guard.count }) },
      h(Stats, { cols: 3, items: [
        { label: '活跃条目', value: num(totals.active, 0) },
        { label: '休眠', value: num(totals.dormant, 0) },
        { label: '分区', value: num(totals.partitions, parts.length) },
        { label: '召回总数', value: num(totals.recalls, 0) },
        { label: '24h 命中率', value: pct(obj(ov.hit24h).hitRate, 1) },
        { label: '守卫事件', value: guard.count, tone: guard.tone === 'ok' ? undefined : guard.tone }
      ] }),
      h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
        h(Chip, { tone: 'info' }, 'info ' + guard.info),
        h(Chip, { tone: 'ok' }, 'ok ' + guard.ok),
        h(Chip, { tone: 'warn' }, 'warn ' + guard.warn),
        h(Chip, { tone: guard.block ? 'bad' : 'mute' }, 'block ' + guard.block))));
}

// ---- 2 条目 --------------------------------------------------------------
function PItems() {
  const panel = usePanel();
  const p = panel.partition;
  const [text, setText] = useState('');
  const [applied, setApplied] = useState('');
  const [openId, setOpenId] = useState('');
  const list = useFetch(p ? withP('items', p, { limit: 400 }) : null, { bootKey: 'items' });
  const search = useFetch(p && applied ? withP('search', p, { q: applied, limit: 8 }) : null);
  const detail = useFetch(openId ? 'item?id=' + enc(openId) : null);
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  if (list.error) return h(Err, { error: list.error, onRetry: list.reload });
  if (!list.data) return h(Loading, null);
  const all = arr(list.data.items);
  const usingSearch = !!(applied && search.data);
  const rows = usingSearch ? arr(search.data.items) : all;
  const cols = [
    { label: '标题', render: function (r) { return h('span', { title: r.title || r.id }, clip(r.title, 28)); } },
    { label: '类型', render: function (r) { return h(Chip, { tone: r.kind === 'trunk' ? 'violet' : 'mute' }, r.kind || 'fact'); } },
    { label: '状态', render: function (r) { return h('span', { style: { color: r.state === 'active' ? TONE.ok : TONE.mute } }, r.state || '—'); } },
    { label: '重要', align: 'right', render: function (r) { return String(num(r.importance, 0)); } },
    { label: '保留', render: function (r) { return h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, h(Meter, { value: r.retention }), h('span', { style: { fontSize: 10 } }, pct(r.retention, 0))); } },
    { label: '更新', render: function (r) { return h('span', { style: S.muted }, ago(r.updated_at)); } }
  ];
  return h('div', null,
    h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
      h(Input, {
        value: text, placeholder: '检索标题/正文，回车（/api/search）', wide: true,
        onChange: setText,
        onKeyDown: function (e) {
          if (e.key === 'Enter') setApplied(text.trim());
          if (e.key === 'Escape') { setText(''); setApplied(''); }
        }
      }),
      h(Btn, { onClick: function () { setApplied(text.trim()); }, primary: true }, '检索'),
      applied ? h(Btn, { onClick: function () { setText(''); setApplied(''); } }, '清除') : null),
    usingSearch
      ? h(Notice, { tone: 'info' }, '检索「' + applied + '」命中 ' + num(obj(search.data).total, rows.length) + ' 条（最多显示 8 条）')
      : h('div', { style: Object.assign({}, S.muted, { marginBottom: 6 }) }, '共 ' + all.length + ' 条（/api/items，最多 400 条）'),
    search.error ? h(Err, { error: search.error, onRetry: search.reload }) : null,
    h(Table, {
      cols: cols, rows: rows, empty: '这个分区还没有条目',
      onRow: function (r) { setOpenId(openId === r.id ? '' : r.id); },
      activeRow: function (r) { return r.id === openId; }
    }),
    openId ? h(Card, { style: { marginTop: 8 }, title: '详情', right: h(Btn, { onClick: function () { setOpenId(''); } }, '收起') },
      detail.error ? h(Err, { error: detail.error, onRetry: detail.reload })
        : !detail.data ? h(Loading, null)
          : h('div', null,
            h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4, wordBreak: 'break-word' } }, detail.data.title),
            h(KV, { rows: [
              ['id', h('span', { style: S.mono }, detail.data.id)],
              ['分区', obj(detail.data.partition).name || '—'],
              ['状态', (detail.data.state || '') + (detail.data.pinned ? ' · 钉住' : '')],
              ['保留率', pct(detail.data.retention, 1) + ' · 稳定度 ' + fixed(detail.data.stability, 2) + ' 天'],
              ['访问', num(detail.data.access_count, 0) + ' 次 · 命中 ' + num(detail.data.hit_count, 0) + ' 次'],
              ['更新', ts(detail.data.updated_at) + '（' + ago(detail.data.updated_at) + '）'],
              ['标签', arr(detail.data.tags).join(' / ') || '—'],
              ['附件', arr(detail.data.attachments).length + ' 个']
            ] }),
            h('pre', { style: { margin: '6px 0 0', padding: 6, background: COLORS.bg, borderRadius: 6, maxHeight: 190, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', font: '11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace' } }, clip(detail.data.body, 1600) || '（空正文）')))
      : null);
}

// ---- 3 记忆曲线 ----------------------------------------------------------
function PCurve() {
  const panel = usePanel();
  const p = panel.partition;
  const [id, setId] = useState('');
  const [days, setDays] = useState(120);
  const [forecastOn, setForecastOn] = useState(false);
  const list = useFetch(p ? withP('items', p, { limit: 200 }) : null, { bootKey: 'items' });
  const items = list.data ? arr(list.data.items) : [];
  const activeId = id || (items.length ? items[0].id : '');
  const curve = useFetch(activeId ? 'curve?id=' + enc(activeId) + '&days=' + enc(days) : null, { bootKey: 'curve' });
  const forecast = useFetch(activeId && forecastOn ? 'curve/forecast?id=' + enc(activeId) + '&days=' + enc(days) : null);
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const cd = obj(curve.data);
  const fd = obj(forecast.data);
  const points = arr(cd.points);
  return h('div', null,
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
      h(Select, {
        value: activeId, style: { maxWidth: 168 },
        options: items.length ? items.map(function (it) { return { value: it.id, label: clip(it.title, 24) }; }) : [{ value: '', label: '（无条目）' }],
        onChange: setId
      }),
      h('span', { style: S.muted }, '天数'),
      h(Input, { value: String(days), style: { width: 58 }, onChange: function (v) { setDays(clamp(Number(v) || 0, 7, 3650)); } }),
      h(Check, { checked: forecastOn, onChange: setForecastOn }, '单条预测'),
      h(Btn, { onClick: function () { curve.reload(); if (forecastOn) forecast.reload(); } }, '刷新')),
    curve.error ? h(Err, { error: curve.error, onRetry: curve.reload }) : null,
    list.error && !activeId ? h(Err, { error: list.error, onRetry: list.reload }) : null,
    !activeId ? h(Empty, { text: '先选一条记忆' })
      : !cd.points ? h(Loading, null)
        : h('div', null,
          h(Card, { title: '保留率曲线', right: h('span', { style: S.muted }, cd.item ? String(cd.item) : '') },
            h(LineChart, { points: points, floor: num(cd.floor, 0), label: '记忆曲线' }),
            h(Legend, { items: [
              { color: '#4fd1c5', label: '保留率' },
              { color: '#e3b341', label: '主干地板 ' + pct(cd.floor, 0) }
            ] })),
          h(Card, { title: '参数' },
            h(Stats, { cols: 3, items: [
              { label: '有效稳定度', value: fixed(cd.stability, 2) + ' 天' },
              { label: '基础稳定度', value: fixed(cd.baseStability, 2) + ' 天' },
              { label: '强化系数', value: '×' + fixed(cd.boost, 2), tone: num(cd.boost, 1) > 1 ? 'ok' : undefined },
              { label: '主干', value: cd.trunk ? '是' : '否', tone: cd.trunk ? 'violet' : undefined },
              { label: '地板', value: pct(cd.floor, 0) },
              { label: '当前保留', value: points.length ? pct(points[0].retention, 1) : '—' }
            ] })),
          forecastOn ? h(Card, { title: '单条预测（/api/curve/forecast）', right: h(Btn, { onClick: forecast.reload }, '重算') },
            forecast.error ? h(Err, { error: forecast.error, onRetry: forecast.reload })
              : !fd.points ? h(Loading, null)
                : h('div', null,
                  h(KV, { rows: [
                    ['预测条目', String(fd.item || activeId)],
                    ['有效稳定度', fixed(fd.stability, 2) + ' 天'],
                    ['基础稳定度', fixed(fd.baseStability, 2) + ' 天'],
                    ['强化系数', '×' + fixed(fd.boost, 2)],
                    ['主干/地板', (fd.trunk ? '主干' : '普通') + ' · ' + pct(fd.floor, 0)]
                  ] }),
                  h('div', { style: Object.assign({}, S.muted, { marginTop: 4 }) }, '预测点数 ' + arr(fd.points).length + ' · 末点保留 ' + pct(arr(fd.points).length ? arr(fd.points)[arr(fd.points).length - 1].retention : 0, 1))))
            : null));
}

// ---- 4 命中率趋势 --------------------------------------------------------
function PTrend() {
  const panel = usePanel();
  const p = panel.partition;
  const [days, setDays] = useState(30);
  const tl = useFetch(p ? withP('timeline', p, { days: days }) : null, { bootKey: 'timeline' });
  const digest = useFetch(p ? withP('digest', p, { days: days }) : null, { bootKey: 'digest' });
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const points = tl.data ? arr(tl.data.points) : [];
  const dg = obj(digest.data);
  const rc = obj(dg.recall);
  let recalls = 0;
  let hits = 0;
  for (const x of points) { recalls += num(x.recalls, 0); hits += num(x.hits, 0); }
  const rate = recalls ? hits / recalls : 0;
  return h('div', null,
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 } },
      h('span', { style: S.muted }, '窗口'),
      [7, 30, 90].map(function (d) { return h(Btn, { key: d, primary: days === d, onClick: function () { setDays(d); } }, d + ' 天'); }),
      h('span', { style: { flex: '1 1 auto' } }),
      h(Btn, { onClick: function () { tl.reload(); digest.reload(); } }, '刷新')),
    tl.error ? h(Err, { error: tl.error, onRetry: tl.reload }) : null,
    digest.error ? h(Notice, { tone: 'warn' }, 'digest 接口报错（图表不受影响）：' + digest.error) : null,
    h(Card, { title: '召回 / 命中' },
      !tl.data ? h(Loading, null) : h('div', null,
        h(BarChart, { points: points, label: '命中率趋势' }),
        h(Legend, { items: [
          { color: '#6ea8ff', label: '召回次数' },
          { color: '#4fd1c5', label: '命中次数' },
          { color: '#e3b341', label: '命中率（虚线）' }
        ] }))),
    h(Card, { title: '窗口汇总' },
      h(Stats, { cols: 3, items: [
        { label: '召回', value: recalls },
        { label: '命中', value: hits },
        { label: '命中率', value: pct(rate, 1), tone: rate >= 0.3 ? 'ok' : 'warn' },
        { label: 'digest 事件', value: num(rc.events, 0) },
        { label: '近遗忘', value: arr(dg.nearForget).length, tone: arr(dg.nearForget).length ? 'warn' : undefined },
        { label: '冷却中', value: arr(dg.cooling).length }
      ] })),
    h(Card, { title: '最近 7 天' },
      h(Table, {
        cols: [
          { label: '日期', render: function (r) { return String(r.day || ''); } },
          { label: '召回', align: 'right', render: function (r) { return String(num(r.recalls, 0)); } },
          { label: '命中', align: 'right', render: function (r) { return String(num(r.hits, 0)); } },
          { label: '命中率', align: 'right', render: function (r) { return pct(num(r.recalls, 0) ? num(r.hits, 0) / num(r.recalls, 1) : 0, 0); } }
        ],
        rows: points.slice(-7).reverse(),
        empty: '窗口内没有召回记录'
      })));
}

// ---- 共用：两步确认按钮（破坏性操作第一次点击只上膛）-------------------
function ConfirmBtn(props) {
  const p = props || {};
  const [armed, setArmed] = useState(false);
  useEffect(function () {
    if (!armed) return undefined;
    const t = setTimeout(function () { setArmed(false); }, 4000);
    return function () { clearTimeout(t); };
  }, [armed]);
  return h(Btn, {
    primary: p.primary, disabled: p.disabled, title: armed ? '再点一次确认' : (p.title || ''),
    style: armed ? { borderColor: TONE.bad + 'aa', color: TONE.bad } : undefined,
    onClick: function () {
      if (armed) { setArmed(false); if (p.onClick) p.onClick(); return; }
      setArmed(true);
    }
  }, armed ? (p.confirmLabel || '确认执行？') : (p.label || '执行'));
}

/** 写操作结果条（useAction 的 result 原样显示） */
function ActionResult(props) {
  const r = props.result;
  if (!r) return null;
  return h(Notice, { tone: r.ok ? 'ok' : 'bad' }, (r.ok ? '成功：' : '失败：') + r.text);
}

// ---- 5 守卫 --------------------------------------------------------------
function PGuard() {
  const panel = usePanel();
  const p = panel.partition;
  const [level, setLevel] = useState('all');
  const [source, setSource] = useState('all');
  const [deleted, setDeleted] = useState(false);
  const [limit, setLimit] = useState(40);
  const [offset, setOffset] = useState(0);
  const [tokens, setTokens] = useState('120000');
  const events = useFetch(p ? withP('guard/events', p, { level: level, source: source, deleted: deleted ? 1 : 0, limit: limit, offset: offset }) : null, { bootKey: 'guard' });
  const act = useAction();
  const check = useAction();
  const [checkResult, setCheckResult] = useState(null);
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const data = obj(events.data);
  const rows = arr(data.events);
  const total = num(data.total, rows.length);
  const bySource = obj(data.bySource);
  function reloadAll() { events.reload(); if (panel.refresh) panel.refresh(); }
  function doDelete(ev) {
    act.run('guard/delete', { id: ev.id, hard: false }).then(reloadAll);
  }
  function doRestore(ev) {
    act.run('guard/restore', { id: ev.id }).then(reloadAll);
  }
  function runCheck() {
    check.run('guard/check', { partition: p, contextTokens: num(tokens, 0), source: 'simulated' }).then(function (res) {
      if (res) setCheckResult(res);
    });
  }
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h('span', { style: S.muted }, '级别'),
      h(Select, { value: level, onChange: function (v) { setLevel(v); setOffset(0); }, options: ['all', 'info', 'ok', 'warn', 'block'].map(function (x) { return { value: x, label: x }; }) }),
      h('span', { style: S.muted }, '来源'),
      h(Select, { value: source, onChange: function (v) { setSource(v); setOffset(0); }, options: ['all', 'real', 'simulated'].map(function (x) { return { value: x, label: x }; }) }),
      h(Check, { checked: deleted, onChange: function (v) { setDeleted(v); setOffset(0); } }, '含已删除'),
      h('span', { style: S.muted }, '条数'),
      h(Input, { value: String(limit), style: { width: 52 }, onChange: function (v) { setLimit(clamp(Number(v) || 20, 5, 200)); setOffset(0); } }),
      h(Btn, { onClick: reloadAll }, '刷新')),
    events.error ? h(Err, { error: events.error, onRetry: events.reload }) : null,
    h(Card, { title: '守卫事件', right: h('span', { style: S.muted }, '共 ' + total + ' 条 · 真实 ' + num(bySource.real, 0) + ' / 模拟 ' + num(bySource.simulated, 0)) },
      !events.data ? h(Loading, null) : h(Table, {
        cols: [
          { label: '时间', render: function (r) { return h('span', { style: S.muted, title: ts(r.ts) }, ago(r.ts)); } },
          { label: '级别', render: function (r) { return h(Chip, { tone: r.level === 'block' ? 'bad' : r.level === 'warn' ? 'warn' : r.level === 'ok' ? 'ok' : 'info' }, String(r.level || '—')); } },
          { label: '分数', align: 'right', render: function (r) { return fixed(r.score, 2); } },
          { label: '来源', render: function (r) { return h('span', { style: S.muted }, String(r.source || '—')); } },
          { label: 'tokens', align: 'right', render: function (r) { return String(num(r.context_tokens, 0)); } },
          { label: '原因', render: function (r) { return h('span', { title: arr(r.reasons).join('；') }, clip(arr(r.reasons).join('；'), 42) || '—'); } },
          {
            label: '操作', render: function (r) {
              return h('span', { style: { display: 'inline-flex', gap: 4 } },
                r.deleted
                  ? h(Btn, { onClick: function () { doRestore(r); } }, '恢复')
                  : h(ConfirmBtn, { label: '删除', confirmLabel: '确认删除？', onClick: function () { doDelete(r); } }),
                h('span', { style: Object.assign({}, S.mono, { color: COLORS.mute }) }, String(r.id)));
            }
          }
        ],
        rows: rows, empty: '没有符合条件的守卫事件'
      }),
      h('div', { style: Object.assign({}, S.row, { marginTop: 6 }) },
        h(Btn, { disabled: offset <= 0, onClick: function () { setOffset(Math.max(0, offset - limit)); } }, '上一页'),
        h('span', { style: S.muted }, '第 ' + (Math.floor(offset / limit) + 1) + ' 页'),
        h(Btn, { disabled: offset + limit >= total, onClick: function () { setOffset(offset + limit); } }, '下一页'))),
    h(Card, { title: '维护' },
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        h(ConfirmBtn, { label: '清空模拟事件', confirmLabel: '确认清空模拟？', onClick: function () { act.run('guard/delete', { onlySimulated: true }).then(reloadAll); } }),
        h(ConfirmBtn, { label: '彻底清理 30 天前', confirmLabel: '确认彻底清理？', onClick: function () { act.run('guard/purge', { olderThanDays: 30 }).then(reloadAll); } })),
      act.result ? h('div', { style: { marginTop: 6 } }, h(ActionResult, { result: act.result })) : null),
    h(Card, { title: '模拟检查（写一条 simulated 事件）' },
      h('div', { style: Object.assign({}, S.row, { marginBottom: 6 }) },
        h('span', { style: S.muted }, '上下文 tokens'),
        h(Input, { value: tokens, style: { width: 90 }, onChange: setTokens }),
        h(Btn, { primary: true, onClick: runCheck, disabled: check.busy }, check.busy ? '检查中…' : '发起检查')),
      check.result ? h(ActionResult, { result: check.result }) : null,
      checkResult ? h('div', null,
        h(KV, { rows: [
          ['级别', h(Chip, { tone: checkResult.level === 'block' ? 'bad' : checkResult.level === 'warn' ? 'warn' : 'ok' }, String(checkResult.level)) ],
          ['分数', fixed(checkResult.score, 3) + '（warn ' + fixed(obj(checkResult.thresholds).warn, 2) + ' / block ' + fixed(obj(checkResult.thresholds).block, 2) + '）'],
          ['动作', String(checkResult.action || '—')],
          ['原因', arr(checkResult.reasons).join('；') || '—'],
          ['估算 tokens', num(obj(checkResult.metrics).estTokens, 0) + ' · 事件 ' + num(obj(checkResult.metrics).events, 0) + ' · 命中 ' + num(obj(checkResult.metrics).hits, 0)]
        ] }),
        checkResult.directive ? h('pre', { style: { margin: '4px 0 0', padding: 6, background: COLORS.bg, borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, String(checkResult.directive)) : null,
        arr(checkResult.trunk).length ? h('div', { style: Object.assign({}, S.muted, { marginTop: 4 }) }, '主干条目 ' + arr(checkResult.trunk).length + ' 条') : null)
        : null));
}

// ---- 6 审查 --------------------------------------------------------------
function PAudit() {
  const panel = usePanel();
  const p = panel.partition;
  const [hours, setHours] = useState(168);
  const audit = useFetch(p ? withP('audit', p, { hours: hours }) : null, { bootKey: 'audit' });
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const d = obj(audit.data);
  const findings = arr(d.findings);
  const warn = findings.filter(function (f) { return f.severity === 'warn'; }).length;
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h('span', { style: S.muted }, '窗口'),
      [24, 168, 720].map(function (hr) { return h(Btn, { key: hr, primary: hours === hr, onClick: function () { setHours(hr); } }, hr + 'h'); }),
      h(Btn, { onClick: audit.reload }, '刷新')),
    audit.error ? h(Err, { error: audit.error, onRetry: audit.reload }) : null,
    h(Card, { title: '审查结论', right: h(Chip, { tone: d.severity === 'warn' ? 'warn' : 'ok' }, String(d.severity || '—')) },
      h(Stats, { cols: 3, items: [
        { label: '发现', value: findings.length },
        { label: '需关注', value: warn, tone: warn ? 'warn' : undefined },
        { label: '生成于', value: d.generatedAt ? ago(d.generatedAt) : '—' }
      ] })),
    h(Card, { title: '发现列表' },
      !audit.data ? h(Loading, null) : h(Table, {
        cols: [
          { label: '级别', render: function (r) { return h(Chip, { tone: r.severity === 'warn' ? 'warn' : 'info' }, String(r.severity || 'info')); } },
          { label: '代码', render: function (r) { return h('span', { style: S.mono }, String(r.code || '—')); } },
          { label: '分区', render: function (r) { return h('span', { style: S.muted }, String(r.partition || '—')); } },
          { label: '说明', render: function (r) { return h('span', { title: String(r.message || '') }, clip(r.message, 60)); } },
          { label: '建议', render: function (r) { return h('span', { style: S.muted, title: String(r.suggestion || '') }, clip(r.suggestion, 40) || '—'); } }
        ],
        rows: findings, empty: '这个窗口内没有问题'
      })));
}

// ---- 7 回收站 ------------------------------------------------------------
function PRecycle() {
  const panel = usePanel();
  const p = panel.partition;
  const rec = useFetch(p ? withP('recycle', p) : null, { bootKey: 'recycle' });
  const act = useAction();
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const rows = rec.data ? arr(rec.data.items) : [];
  const expired = rows.filter(function (r) { return r.expired; }).length;
  function after() { rec.reload(); }
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h(Btn, { onClick: rec.reload }, '刷新'),
      h(ConfirmBtn, { label: '清理所有过期项', confirmLabel: '确认清理？', onClick: function () { act.run('purge', { olderThanDays: 30 }).then(after); } }),
      h('span', { style: S.muted }, '过期 ' + expired + ' 条')),
    rec.error ? h(Err, { error: rec.error, onRetry: rec.reload }) : null,
    act.result ? h(ActionResult, { result: act.result }) : null,
    h(Card, { title: '回收站', right: h('span', { style: S.muted }, rows.length + ' 条') },
      !rec.data ? h(Loading, null) : h(Table, {
        cols: [
          { label: '标题', render: function (r) { return h('span', { title: String(r.title || '') }, clip(r.title, 34) || String(r.id)); } },
          { label: '删除于', render: function (r) { return h('span', { style: S.muted }, ago(r.deleted_at)); } },
          { label: '原因', render: function (r) { return h('span', { style: S.muted }, clip(r.delete_reason, 20) || '—'); } },
          { label: '过期', render: function (r) { return h(Chip, { tone: r.expired ? 'bad' : 'mute' }, r.expired ? '已过期' : (r.expiresAt ? ago(r.expiresAt) : '—')); } },
          {
            label: '操作', render: function (r) {
              return h('span', { style: { display: 'inline-flex', gap: 4 } },
                h(Btn, { primary: true, onClick: function () { act.run('restore', { id: r.id }).then(after); } }, '恢复'),
                h(ConfirmBtn, { label: '彻底', confirmLabel: '不可恢复，确认？', onClick: function () { act.run('purge', { id: r.id }).then(after); } }));
            }
          }
        ],
        rows: rows, empty: '回收站是空的'
      })));
}

// ---- 8 主干 --------------------------------------------------------------
function PTrunk() {
  const panel = usePanel();
  const p = panel.partition;
  const trunk = useFetch(p ? withP('trunk', p) : null, { bootKey: 'trunk' });
  const act = useAction();
  const arch = useAction();
  const [strength, setStrength] = useState('1.2');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const rows = trunk.data ? arr(trunk.data.items) : [];
  function after() { trunk.reload(); if (panel.refresh) panel.refresh(); }
  function reinforce(r) {
    act.run('reinforce', { id: r.id, strength: num(strength, 1.2), reason: 'panel' }).then(after);
  }
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h(Btn, { onClick: trunk.reload }, '刷新'),
      h('span', { style: S.muted }, '强化系数'),
      h(Input, { value: strength, style: { width: 56 }, onChange: setStrength }),
      h('span', { style: S.muted }, '共 ' + rows.length + ' 条主干')),
    trunk.error ? h(Err, { error: trunk.error, onRetry: trunk.reload }) : null,
    act.result ? h(ActionResult, { result: act.result }) : null,
    h(Card, { title: '主干条目（钉住或重要度 ≥ 阈值）' },
      !trunk.data ? h(Loading, null) : h(Table, {
        cols: [
          { label: '标题', render: function (r) { return h('span', { title: String(r.title || '') }, clip(r.title, 26) || String(r.id)); } },
          { label: '重要性', align: 'right', render: function (r) { return String(num(r.importance, 0)); } },
          { label: '稳定度', align: 'right', render: function (r) { return fixed(r.stability, 1); } },
          { label: '强化', align: 'right', render: function (r) { return '×' + fixed(r.boost, 2); } },
          { label: '有效', align: 'right', render: function (r) { return fixed(r.effectiveStability, 1); } },
          { label: '保留', render: function (r) { return h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, h(Meter, { value: r.retention }), h('span', { style: { fontSize: 10 } }, pct(r.retention, 0))); } },
          { label: '复习/遗忘', align: 'right', render: function (r) { return num(r.reviews, 0) + ' / ' + num(r.lapses, 0); } },
          { label: '操作', render: function (r) { return h(Btn, { primary: true, disabled: act.busy, onClick: function () { reinforce(r); } }, '强化'); } }
        ],
        rows: rows, empty: '还没有主干条目'
      })),
    h(Card, { title: '收尾归档（把一段收尾写进主干）' },
      h('div', { style: Object.assign({}, S.row, { marginBottom: 6 }) },
        h(Input, { value: title, placeholder: '标题（例如：本周记忆库收尾）', wide: true, onChange: setTitle })),
      h('textarea', {
        value: summary, placeholder: '摘要正文…', rows: 3,
        onChange: function (e) { setSummary(e.target.value); },
        style: { width: '100%', boxSizing: 'border-box', background: COLORS.bg, color: COLORS.text, border: '1px solid ' + COLORS.line, borderRadius: 6, padding: '4px 6px', fontSize: 11, fontFamily: 'inherit', resize: 'vertical' }
      }),
      h('div', { style: Object.assign({}, S.row, { marginTop: 6 }) },
        h(ConfirmBtn, { label: '写入主干', confirmLabel: '确认归档？', disabled: arch.busy || !title.trim(), onClick: function () { arch.run('trunk/archive', { partition: p, title: title.trim(), summary: summary, strength: num(strength, 1.2) }).then(after); } }),
        h('span', { style: S.muted }, '空标题不可提交')),
      arch.result ? h('div', { style: { marginTop: 6 } }, h(ActionResult, { result: arch.result })) : null));
}

// ---- 9 合并 --------------------------------------------------------------
function PMerge() {
  const panel = usePanel();
  const p = panel.partition;
  const [threshold, setThreshold] = useState('0.6');
  const merge = useFetch(p ? withP('merge', p, { threshold: num(threshold, 0.6) }) : null, { bootKey: 'merge' });
  const act = useAction();
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const d = obj(merge.data);
  const groups = arr(d.groups);
  function after() { merge.reload(); if (panel.refresh) panel.refresh(); }
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h('span', { style: S.muted }, '相似阈值'),
      h(Input, { value: threshold, style: { width: 56 }, onChange: setThreshold }),
      h(Btn, { onClick: merge.reload }, '重新预演'),
      h(ConfirmBtn, {
        label: '应用合并', confirmLabel: '确认合并 ' + groups.length + ' 组？', primary: true, disabled: act.busy || !groups.length,
        onClick: function () { act.run('merge', { partition: p, apply: true, threshold: num(threshold, 0.6) }).then(after); }
      })),
    merge.error ? h(Err, { error: merge.error, onRetry: merge.reload }) : null,
    act.result ? h(ActionResult, { result: act.result }) : null,
    h(Card, { title: '预演（dry-run）', right: h('span', { style: S.muted }, groups.length + ' 组 · 阈值 ' + fixed(d.threshold, 2) + (d.candidates !== undefined ? ' · 候选 ' + num(d.candidates, 0) : '')) },
      !merge.data ? h(Loading, null) : !groups.length ? h(Empty, { text: '没有达到阈值的相似组' })
        : h('div', null, groups.map(function (g, i) {
          const keeper = obj(g.keeper);
          return h('div', { key: i, style: { border: '1px solid ' + COLORS.line, borderRadius: 6, padding: '6px 8px', marginBottom: 6, background: COLORS.bg3 } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' } },
              h('strong', { style: { fontSize: 11 } }, '保留：' + (clip(keeper.title, 30) || keeper.id)),
              h('span', { style: S.muted }, '并入 ' + arr(g.members).length + ' 条')),
            arr(g.members).map(function (m, j) {
              return h('div', { key: j, style: { display: 'flex', gap: 6, alignItems: 'baseline', marginTop: 3 } },
                h(Chip, { tone: 'mute' }, '×' + fixed(m.score, 2)),
                h('span', { style: { fontSize: 11, color: COLORS.dim } }, clip(m.title, 36) || String(m.id)));
            }));
        })))
    ,
    h('div', { style: Object.assign({}, S.muted, { marginTop: -4 }) }, '合并会把成员的正文并入保留条目，并入的条目进回收站（可恢复）。'));
}

// ---- 10 评测 -------------------------------------------------------------
function PEval() {
  const panel = usePanel();
  const p = panel.partition;
  const [topK, setTopK] = useState('5');
  const ev = useFetch(p ? withP('eval', p, { topK: num(topK, 5) }) : null, { bootKey: 'eval' });
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const d = obj(ev.data);
  const variants = arr(d.variants);
  let best = -1;
  for (const v of variants) best = Math.max(best, num(v.hitRate, 0));
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h('span', { style: S.muted }, 'topK'),
      h(Input, { value: topK, style: { width: 52 }, onChange: setTopK }),
      h(Btn, { onClick: ev.reload }, '重跑评测'),
      h('span', { style: S.muted }, '查询 ' + num(d.queries, 0) + ' 条')),
    ev.error ? h(Err, { error: ev.error, onRetry: ev.reload }) : null,
    h(Card, { title: '三种权重变体对比' },
      !ev.data ? h(Loading, null) : h(Table, {
        cols: [
          { label: '变体', render: function (r) { return h(Chip, { tone: num(r.hitRate, 0) === best && best > 0 ? 'ok' : 'mute' }, String(r.name || '—')); } },
          { label: '查询数', align: 'right', render: function (r) { return String(num(r.queries, 0)); } },
          { label: '命中率', align: 'right', render: function (r) { return pct(r.hitRate, 1); } },
          { label: 'MRR', align: 'right', render: function (r) { return fixed(r.mrr, 3); } },
          { label: '平均 tokens', align: 'right', render: function (r) { return fixed(r.avgTokens, 0); } },
          {
            label: '命中率', render: function (r) {
              return h(Meter, { value: r.hitRate, tone: num(r.hitRate, 0) === best && best > 0 ? TONE.ok : undefined });
            }
          }
        ],
        rows: variants, empty: '没有评测结果'
      })),
    h('div', { style: S.muted }, '变体由后端按 recall.weightRelevance / weightRetention / vector.vectorWeight 组合跑出；命中率最高的变体会被标绿。'));
}

// ---- 11 参数 -------------------------------------------------------------
const CONFIG_FIELDS = [
  { path: 'curve.stabilityBaseDays', label: '初始稳定度（天）', kind: 'number' },
  { path: 'curve.stabilityGrowth', label: '稳定度增长', kind: 'number' },
  { path: 'curve.readGrowth', label: '每次读取增长', kind: 'number' },
  { path: 'curve.forgetThreshold', label: '遗忘阈值', kind: 'number' },
  { path: 'curve.archiveThreshold', label: '归档阈值', kind: 'number' },
  { path: 'curve.trunkImportance', label: '主干重要度阈值', kind: 'number' },
  { path: 'curve.trunkFloor', label: '主干地板保留率', kind: 'number' },
  { path: 'curve.trunkBoostGrowth', label: '主干强化增长', kind: 'number' },
  { path: 'curve.trunkBoostMax', label: '强化系数上限', kind: 'number' },
  { path: 'curve.reinforceGrowth', label: '手动强化倍数', kind: 'number' },
  { path: 'curve.displayDays', label: '曲线默认天数', kind: 'number' },
  { path: 'recall.topK', label: '召回条数', kind: 'number' },
  { path: 'recall.minScore', label: '最低分', kind: 'number' },
  { path: 'recall.weightRetention', label: '权重·保留', kind: 'number' },
  { path: 'recall.weightImportance', label: '权重·重要度', kind: 'number' },
  { path: 'recall.pinnedBoost', label: '钉住加成', kind: 'number' },
  { path: 'guard.contextWarnTokens', label: '上下文警告 tokens', kind: 'number' },
  { path: 'guard.contextBlockTokens', label: '上下文阻断 tokens', kind: 'number' },
  { path: 'guard.hitRateFloor', label: '命中率下限', kind: 'number' },
  { path: 'guard.warnScore', label: '警告分', kind: 'number' },
  { path: 'guard.blockScore', label: '阻断分', kind: 'number' },
  { path: 'vector.enabled', label: '启用向量', kind: 'boolean' },
  { path: 'vector.vectorWeight', label: '向量权重', kind: 'number' },
  { path: 'vector.vectorFloor', label: '向量地板', kind: 'number' },
  { path: 'lifecycle.recycleDays', label: '回收站保留天数', kind: 'number' },
  { path: 'backup.keep', label: '备份保留份数', kind: 'number' }
];

function dig(src, path) {
  const parts = String(path).split('.');
  let cur = src;
  for (const k of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function bury(target, path, value) {
  const parts = String(path).split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return target;
}

function PConfig() {
  const cfg = useFetch('config', { bootKey: 'config' });
  const act = useAction();
  const [draft, setDraft] = useState({});
  useEffect(function () {
    setDraft({});
  }, [cfg.data]);
  const data = obj(cfg.data);
  function valueOf(field) {
    if (Object.prototype.hasOwnProperty.call(draft, field.path)) return draft[field.path];
    const v = dig(data, field.path);
    return v === undefined ? '' : String(v);
  }
  function dirtyList() { return Object.keys(draft); }
  function submit() {
    const patch = {};
    for (const key of Object.keys(draft)) {
      const field = CONFIG_FIELDS.filter(function (f) { return f.path === key; })[0];
      const raw = draft[key];
      let v = raw;
      if (field && field.kind === 'number') v = Number(raw);
      if (field && field.kind === 'boolean') v = raw === true || raw === 'true';
      bury(patch, key, v);
    }
    act.run('config', patch, 'PUT').then(function (res) { if (res) cfg.reload(); });
  }
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h(Btn, { onClick: cfg.reload }, '重新读取'),
      h(Btn, { primary: true, disabled: act.busy || !dirtyList().length, onClick: submit }, act.busy ? '保存中…' : '保存改动（' + dirtyList().length + '）'),
      h(Btn, { disabled: !dirtyList().length, onClick: function () { setDraft({}); } }, '撤销改动')),
    cfg.error ? h(Err, { error: cfg.error, onRetry: cfg.reload }) : null,
    act.result ? h(ActionResult, { result: act.result }) : null,
    h(Card, { title: '关键参数（PUT /api/config 深合并）' },
      !cfg.data ? h(Loading, null) : h('div', null, CONFIG_FIELDS.map(function (f) {
        const dirty = Object.prototype.hasOwnProperty.call(draft, f.path);
        return h('div', { key: f.path, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', borderBottom: '1px solid ' + COLORS.line } },
          h('span', { style: { flex: '1 1 auto', fontSize: 11, color: dirty ? COLORS.accent : COLORS.dim }, title: f.path }, f.label),
          h('span', { style: Object.assign({}, S.mono, { color: COLORS.mute, width: 148, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, f.path),
          f.kind === 'boolean'
            ? h(Check, { checked: valueOf(f) === 'true', onChange: function (v) { setDraft(Object.assign({}, draft, { [f.path]: v ? 'true' : 'false' })); } }, '')
            : h(Input, {
              value: valueOf(f), style: { width: 92 },
              onChange: function (v) { setDraft(Object.assign({}, draft, { [f.path]: v })); }
            }));
      }))));
}

// ---- 12 导入导出 ---------------------------------------------------------
const EXPORT_KEYS = [
  { key: 'items', label: '条目' },
  { key: 'tasks', label: '任务' },
  { key: 'reports', label: '汇报' },
  { key: 'events', label: '召回事件' },
  { key: 'guardEvents', label: '守卫事件' }
];

function PExport() {
  const panel = usePanel();
  const p = panel.partition;
  const [picked, setPicked] = useState({ items: true, tasks: true, reports: true, events: false, guardEvents: false });
  const [withConfig, setWithConfig] = useState(false);
  const include = EXPORT_KEYS.filter(function (k) { return picked[k.key]; }).map(function (k) { return k.key; });
  const query = {
    include: include.join(','),
    withEvents: picked.events ? 1 : 0,
    withGuardEvents: picked.guardEvents ? 1 : 0,
    withConfig: withConfig ? 1 : 0
  };
  const path = p ? withP('export', p, query) : null;
  const prev = useFetch(path, { bootKey: 'export' });
  const d = obj(prev.data);
  function toggle(key) {
    const next = Object.assign({}, picked);
    next[key] = !next[key];
    setPicked(next);
  }
  return h('div', null,
    h(Card, { title: '导出范围' },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
        EXPORT_KEYS.map(function (k) {
          return h(Check, { key: k.key, checked: !!picked[k.key], onChange: function () { toggle(k.key); } }, k.label);
        }),
        h(Check, { checked: withConfig, onChange: setWithConfig }, '配置')),
      !p ? h(Empty, { text: '先在顶部选一个分区' }) : null),
    prev.error ? h(Err, { error: prev.error, onRetry: prev.reload }) : null,
    h(Card, { title: '导出预览', right: p && include.length ? h('a', { href: linkFor(path, 0), download: 'xfy-memory-' + p + '.json', style: { color: COLORS.accent, fontSize: 11 } }, '下载 JSON') : null },
      !p ? h(Empty, { text: '未选分区' })
        : !include.length ? h(Empty, { text: '至少选一项' })
          : !prev.data ? h(Loading, null)
            : h('div', null,
              h(KV, { rows: [
                ['格式', String(d.format || '—') + ' v' + String(d.version || '—')],
                ['导出时间', ts(d.exportedAt)],
                ['分区', arr(d.partitions).length + ' 个'],
                ['条目', arr(d.items).length + ' 条'],
                ['任务', arr(d.tasks).length + ' 条'],
                ['汇报', arr(d.reports).length + ' 篇'],
                ['召回事件', arr(d.events).length + ' 条'],
                ['守卫事件', arr(d.guardEvents).length + ' 条'],
                ['含配置', d.config ? '是' : '否']
              ] }),
              h('div', { style: Object.assign({}, S.muted, { marginTop: 4 }) }, '下载链接优先走 /xfy-memory/api/，失败时可由独立服务 http://127.0.0.1:8788/api/ 提供。'))));
}

// ---- 迷你 markdown 渲染（只认标题/列表/引用/代码块/加粗/行内代码）------
const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const INLINE_RE = new RegExp('(\\*\\*[^*]+\\*\\*|' + BT + '[^' + BT + ']+' + BT + ')');

function inlineNodes(text, keyPrefix) {
  const src = String(text === null || text === undefined ? '' : text);
  const out = [];
  const parts = src.split(INLINE_RE);
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (!seg) continue;
    const key = keyPrefix + '-' + i;
    if (seg.length > 4 && seg.slice(0, 2) === '**' && seg.slice(-2) === '**') {
      out.push(h('strong', { key: key, style: { color: COLORS.text } }, seg.slice(2, -2)));
    } else if (seg.length > 2 && seg.charAt(0) === BT && seg.charAt(seg.length - 1) === BT) {
      out.push(h('code', { key: key, style: { background: COLORS.bg, padding: '0 3px', borderRadius: 3, font: '10px/1.5 ui-monospace, Consolas, monospace' } }, seg.slice(1, -1)));
    } else {
      out.push(h('span', { key: key }, seg));
    }
  }
  return out;
}

function renderMarkdown(text) {
  const lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
  const blocks = [];
  let list = [];
  let code = null;
  let para = [];
  function flushList() {
    if (!list.length) return;
    blocks.push(h('ul', { key: 'u' + blocks.length, style: { margin: '2px 0 6px', paddingLeft: 16 } },
      list.map(function (t, i) { return h('li', { key: i, style: { marginBottom: 1 } }, inlineNodes(t, 'li' + i)); })));
    list = [];
  }
  function flushPara() {
    if (!para.length) return;
    const body = para.join(' ');
    blocks.push(h('p', { key: 'p' + blocks.length, style: { margin: '0 0 6px', color: COLORS.dim } }, inlineNodes(body, 'p' + blocks.length)));
    para = [];
  }
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (code !== null) {
      if (line.trim() === FENCE) {
        blocks.push(h('pre', { key: 'c' + blocks.length, style: { background: COLORS.bg, border: '1px solid ' + COLORS.line, borderRadius: 6, padding: 6, overflowX: 'auto', font: '10px/1.5 ui-monospace, Consolas, monospace', margin: '0 0 6px' } }, code.join('\n')));
        code = null;
      } else code.push(raw);
      continue;
    }
    if (line.trim().slice(0, 3) === FENCE) { flushList(); flushPara(); code = []; continue; }
    if (!line.trim()) { flushList(); flushPara(); continue; }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      flushList(); flushPara();
      const lv = head[1].length;
      blocks.push(h('div', { key: 'h' + blocks.length, style: { fontSize: lv <= 2 ? 13 : 12, fontWeight: 600, margin: '6px 0 4px', color: COLORS.text } }, inlineNodes(head[2], 'h' + blocks.length)));
      continue;
    }
    const li = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (li) { flushPara(); list.push(li[1]); continue; }
    if (line.charAt(0) === '>') {
      flushList(); flushPara();
      blocks.push(h('div', { key: 'q' + blocks.length, style: { borderLeft: '2px solid ' + COLORS.accent, paddingLeft: 6, color: COLORS.mute, margin: '0 0 6px' } }, inlineNodes(line.slice(1).trim(), 'q' + blocks.length)));
      continue;
    }
    para.push(line);
  }
  if (code !== null) blocks.push(h('pre', { key: 'c' + blocks.length, style: { background: COLORS.bg, borderRadius: 6, padding: 6, overflowX: 'auto', font: '10px/1.5 ui-monospace, Consolas, monospace' } }, code.join('\n')));
  flushList();
  flushPara();
  return h('div', { style: { fontSize: 11, lineHeight: 1.6 } }, blocks);
}

// ---- 13 汇报 -------------------------------------------------------------
function PReports() {
  const panel = usePanel();
  const p = panel.partition;
  const [trash, setTrash] = useState(false);
  const [openPath, setOpenPath] = useState('');
  const list = useFetch(p ? withP('reports', p, { trash: trash ? 1 : 0 }) : null, { bootKey: 'reports' });
  const doc = useFetch(openPath ? 'report?path=' + enc(openPath) : null, { bootKey: 'report' });
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const rows = list.data ? arr(list.data.reports) : [];
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h(Btn, { onClick: list.reload }, '刷新'),
      h(Check, { checked: trash, onChange: setTrash }, '看回收站里的汇报'),
      h('span', { style: S.muted }, rows.length + ' 篇')),
    list.error ? h(Err, { error: list.error, onRetry: list.reload }) : null,
    h(Card, { title: '汇报列表' },
      !list.data ? h(Loading, null) : h(Table, {
        cols: [
          { label: '标题', render: function (r) { return h('span', { title: String(r.title || '') }, clip(r.title, 30) || String(r.path)); } },
          { label: '摘要', render: function (r) { return h('span', { style: S.muted, title: String(r.summary || '') }, clip(r.summary, 40) || '—'); } },
          { label: 'tokens', align: 'right', render: function (r) { return String(num(r.tokens, 0)); } },
          { label: '时间', render: function (r) { return h('span', { style: S.muted }, ago(r.created_at)); } },
          { label: '操作', render: function (r) { return h(Btn, { onClick: function () { setOpenPath(openPath === r.path ? '' : r.path); } }, openPath === r.path ? '收起' : '打开'); } }
        ],
        rows: rows, empty: trash ? '回收站里没有汇报' : '还没有汇报',
        onRow: function (r) { setOpenPath(r.path); },
        activeRow: function (r) { return r.path === openPath; }
      })),
    openPath ? h(Card, { title: 'Markdown', right: h(Btn, { onClick: function () { setOpenPath(''); } }, '关闭') },
      doc.error ? h(Err, { error: doc.error, onRetry: doc.reload })
        : !doc.data ? h(Loading, null)
          : h('div', null,
            h('div', { style: Object.assign({}, S.mono, { color: COLORS.mute, marginBottom: 4 }) }, String(obj(doc.data).path || openPath)),
            h('div', { style: { maxHeight: 340, overflow: 'auto', background: COLORS.bg3, border: '1px solid ' + COLORS.line, borderRadius: 6, padding: '6px 8px' } }, renderMarkdown(obj(doc.data).markdown))))
      : null);
}

// ---- 14 向量 -------------------------------------------------------------
function PVector() {
  const st = useFetch('vector/status', { bootKey: 'vector' });
  const act = useAction();
  const d = obj(st.data);
  const backend = obj(d.backend);
  const provider = obj(d.provider);
  const deepseek = obj(d.deepseek);
  const covered = num(d.covered, 0);
  const items = num(d.items, 0);
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h(Btn, { onClick: st.reload }, '刷新状态'),
      h(ConfirmBtn, { label: '重建索引', confirmLabel: '确认重建？', disabled: act.busy, onClick: function () { act.run('vector/reindex', {}).then(st.reload); } }),
      h(ConfirmBtn, { label: '补齐向量', confirmLabel: '确认补齐？', disabled: act.busy, onClick: function () { act.run('vector/enrich', {}).then(st.reload); } })),
    st.error ? h(Err, { error: st.error, onRetry: st.reload }) : null,
    act.result ? h(ActionResult, { result: act.result }) : null,
    h(Card, { title: '覆盖率', right: h(Chip, { tone: d.enabled ? 'ok' : 'mute' }, d.enabled ? '已启用' : '未启用') },
      !st.data ? h(Loading, null) : h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h(Meter, { value: items ? covered / items : 0 }),
          h('span', { style: { fontSize: 11 } }, covered + ' / ' + items),
          h('span', { style: S.muted }, items ? pct(covered / items, 1) : '—')),
        h(Stats, { cols: 3, items: [
          { label: '维度', value: num(d.dims, 0) },
          { label: '模型', value: String(d.model || '—') },
          { label: '向量权重', value: fixed(d.vectorWeight, 2) },
          { label: '地板', value: fixed(d.vectorFloor, 2) },
          { label: 'fp 权重', value: fixed(d.fpWeight, 2) },
          { label: '后端', value: String(backend.effective || backend.configured || '—') }
        ] }))),
    h(Card, { title: '后端' },
      !st.data ? h(Loading, null) : h(KV, { rows: [
        ['配置后端', String(backend.configured || '—')],
        ['生效后端', String(backend.effective || '—')],
        ['sqlite-vec 可用', backend.sqliteVecAvailable ? '是' : '否'],
        ['扩展版本', String(backend.extensionVersion || '—')],
        ['索引维度', num(backend.indexDims, 0) + ' · 已索引 ' + num(backend.indexed, 0)],
        ['错误', backend.error ? String(backend.error) : '无']
      ] })),
    h(Card, { title: '向量模型服务' },
      !st.data ? h(Loading, null) : h(KV, { rows: [
        ['provider 启用', provider.enabled ? '是' : '否'],
        ['provider 端点', String(provider.endpoint || '—')],
        ['provider 模型', String(provider.model || '—')],
        ['DeepSeek 启用', deepseek.enabled ? '是' : '否'],
        ['DeepSeek 模型', String(deepseek.model || '—')],
        ['DeepSeek Key', deepseek.apiKeyPresent ? '已配置' : '缺失'],
        ['DeepSeek 就绪', deepseek.ready ? '是' : '否']
      ] })));
}

// ---- 15 DSH 会话 ---------------------------------------------------------
function PHarness() {
  const scan = useFetch('harness/scan', { bootKey: 'harness' });
  const act = useAction();
  const [pick, setPick] = useState('');
  const [plan, setPlan] = useState(null);
  const d = obj(scan.data);
  const projects = arr(d.projects);
  const current = projects.filter(function (x) { return x.dir === pick; })[0] || null;
  const totals = obj(d.totals);
  function dryRun(proj) {
    act.run('harness/import', { project: proj, confirmed: false }).then(function (res) { if (res) setPlan(res); });
  }
  function doImport(proj) {
    act.run('harness/import', { project: proj, confirmed: true }).then(function (res) {
      if (res) { setPlan(res); scan.reload(); }
    });
  }
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      h(Btn, { onClick: scan.reload }, '重新扫描'),
      h('span', { style: S.muted }, '根目录 ' + String(d.root || '—')),
      h('span', { style: S.muted }, '项目 ' + num(totals.projects, projects.length) + ' · 会话 ' + num(totals.sessions, 0) + ' · 已导入 ' + num(totals.imported, 0))),
    scan.error ? h(Err, { error: scan.error, onRetry: scan.reload }) : null,
    d.exists === false ? h(Notice, { tone: 'warn' }, '扫描根目录不存在：' + String(d.root || '')) : null,
    h(Card, { title: '项目' },
      !scan.data ? h(Loading, null) : h(Table, {
        cols: [
          { label: '项目', render: function (r) { return h('span', { title: String(r.dir || '') }, clip(r.name || r.dir, 24)); } },
          { label: '分区', render: function (r) { return h(Chip, { tone: 'mute' }, String(r.partition || '—')); } },
          { label: '会话', align: 'right', render: function (r) { return num(r.sessionCount, 0) + ' / 导入 ' + num(r.importedCount, 0); } },
          { label: '操作', render: function (r) { return h('span', { style: { display: 'inline-flex', gap: 4 } },
            h(Btn, { onClick: function () { setPick(r.dir); dryRun(r.dir); } }, '预演'),
            h(Btn, { primary: true, onClick: function () { setPick(r.dir); } }, '看会话')); } }
        ],
        rows: projects, empty: '没有找到 DSH 项目',
        onRow: function (r) { setPick(r.dir); },
        activeRow: function (r) { return r.dir === pick; }
      })),
    act.result ? h(ActionResult, { result: act.result }) : null,
    current ? h(Card, { title: '会话清单 · ' + (current.name || current.dir), right: h(ConfirmBtn, { label: '确认导入整个项目', confirmLabel: '确认写入？', disabled: act.busy, onClick: function () { doImport(current.dir); } }) },
      h(Table, {
        cols: [
          { label: '会话', render: function (r) { return h('span', { title: String(r.title || r.id) }, clip(r.title || r.firstUser, 26) || String(r.id)); } },
          { label: '轮次', align: 'right', render: function (r) { return String(num(r.turns, 0)); } },
          { label: '工具', align: 'right', render: function (r) { return String(num(r.toolCalls, 0)); } },
          { label: '大小', align: 'right', render: function (r) { return bytes(r.bytes); } },
          { label: '更新', render: function (r) { return h('span', { style: S.muted }, ago(r.updatedAt)); } },
          { label: '状态', render: function (r) { return h(Chip, { tone: r.imported ? 'ok' : r.empty ? 'mute' : 'info' }, r.imported ? '已导入' : r.empty ? '空' : '待导入'); } }
        ],
        rows: arr(current.sessions), empty: '这个项目没有会话'
      })) : null,
    plan ? h(Card, { title: plan.dryRun ? '导入预演（未写入）' : '导入结果', right: h(Btn, { onClick: function () { setPlan(null); } }, '关闭') },
      plan.dryRun
        ? h('div', null,
          h(KV, { rows: [
            ['将导入', num(plan.wouldImport, 0) + ' 条'],
            ['跳过', num(plan.skipped, 0) + ' 条']
          ] }),
          h(Table, {
            cols: [
              { label: '会话', render: function (r) { return clip(r.title || r.sessionId, 30); } },
              { label: '分区', render: function (r) { return String(r.partition || '—'); } },
              { label: '跳过原因', render: function (r) { return h('span', { style: S.muted }, String(r.skip || '—')); } }
            ],
            rows: arr(plan.plan), empty: '没有可导入的会话'
          }),
          h('div', { style: { marginTop: 6 } }, h(ConfirmBtn, { label: '确认导入', confirmLabel: '确认写入数据库？', primary: true, disabled: act.busy, onClick: function () { if (pick) doImport(pick); } })))
        : h(KV, { rows: [
          ['导入', num(plan.imported, 0) + ' 条'],
          ['跳过', num(plan.skipped, 0) + ' 条'],
          ['分区', arr(plan.partitions).join(' / ') || '—'],
          ['新建条目', arr(plan.items).length + ' 条']
        ] }))
      : null);
}

// ---- 16 健康日报 ---------------------------------------------------------
function PHealth() {
  const panel = usePanel();
  const p = panel.partition;
  const [days, setDays] = useState(7);
  const rep = useFetch(p ? withP('health/report', p, { days: days }) : null, { bootKey: 'health' });
  if (!p) return h(Empty, { text: '先在顶部选一个分区' });
  const d = obj(rep.data);
  return h('div', null,
    h('div', { style: Object.assign({}, S.row, { marginBottom: 8 }) },
      [3, 7, 30].map(function (dd) { return h(Btn, { key: dd, primary: days === dd, onClick: function () { setDays(dd); } }, dd + ' 天'); }),
      h(Btn, { onClick: rep.reload }, '重新生成'),
      d.path ? h('span', { style: Object.assign({}, S.mono, { color: COLORS.mute }) }, String(d.path)) : null),
    rep.error ? h(Err, { error: rep.error, onRetry: rep.reload }) : null,
    h(Card, { title: '健康日报' },
      !rep.data ? h(Loading, null)
        : d.markdown
          ? h('div', { style: { maxHeight: 460, overflow: 'auto', background: COLORS.bg3, border: '1px solid ' + COLORS.line, borderRadius: 6, padding: '6px 8px' } }, renderMarkdown(d.markdown))
          : h(Empty, { text: '后端没有返回 markdown' })));
}

// ===========================================================================
// 06 · 面板外壳（导航 / 状态栏 / Ctrl+K 检索浮层）
// ===========================================================================
const PANES = [
  { id: 'overview', label: '概览', Comp: POverview },
  { id: 'items', label: '条目', Comp: PItems },
  { id: 'curve', label: '曲线', Comp: PCurve },
  { id: 'trend', label: '趋势', Comp: PTrend },
  { id: 'guard', label: '守卫', Comp: PGuard },
  { id: 'audit', label: '审查', Comp: PAudit },
  { id: 'recycle', label: '回收站', Comp: PRecycle },
  { id: 'trunk', label: '主干', Comp: PTrunk },
  { id: 'merge', label: '合并', Comp: PMerge },
  { id: 'eval', label: '评测', Comp: PEval },
  { id: 'config', label: '参数', Comp: PConfig },
  { id: 'export', label: '导入导出', Comp: PExport },
  { id: 'reports', label: '汇报', Comp: PReports },
  { id: 'vector', label: '向量', Comp: PVector },
  { id: 'harness', label: 'DSH 会话', Comp: PHarness },
  { id: 'health', label: '健康日报', Comp: PHealth }
];

function paneById(id) {
  return PANES.filter(function (x) { return x.id === id; })[0] || PANES[0];
}

// ---- 错误边界：一个板块炸了只影响它自己 -----------------------------------
class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }
  static getDerivedStateFromError(err) {
    return { error: String(err && err.message ? err.message : err) };
  }
  componentDidCatch(err) {
    warn('pane', err);
  }
  reset() {
    this.setState({ error: null });
  }
  render() {
    if (this.state.error) return h(Err, { error: this.state.error, onRetry: this.reset });
    return this.props.children;
  }
}

// ---- 导航 ----------------------------------------------------------------
function Nav(props) {
  const active = props.active;
  return h('nav', { style: S.nav },
    h('div', { style: { padding: '2px 4px 6px', fontSize: 10, color: COLORS.mute, letterSpacing: 0.5 } }, '小肥鱼记忆'),
    PANES.map(function (item) {
      const on = item.id === active;
      return h('button', {
        key: item.id, type: 'button', title: item.label,
        onClick: function () { props.onPick(item.id); },
        style: {
          display: 'block', width: '100%', textAlign: 'left', marginBottom: 2, padding: '4px 6px',
          fontSize: 11, borderRadius: 5, cursor: 'pointer',
          background: on ? 'rgba(79,209,197,0.14)' : 'transparent',
          border: '1px solid ' + (on ? 'rgba(79,209,197,0.4)' : 'transparent'),
          color: on ? COLORS.accent : COLORS.dim
        }
      }, item.label);
    }),
    h('div', { style: { marginTop: 6, padding: '4px 2px 0', borderTop: '1px solid ' + COLORS.line } },
      h(Btn, { onClick: props.onSearch, style: { width: '100%' } }, '检索 Ctrl+K')));
}

// ---- 状态栏 --------------------------------------------------------------
function StatusBar() {
  const panel = usePanel();
  const snap = useNetSnapshot();
  const shell = panel.shell || DEFAULT_SHELL;
  const st = obj(shell.data);
  const ov = obj(st.overview);
  const parts = arr(ov.partitions);
  const integrity = obj(st.integrity);
  const guard = guardSummary(st.guardEvents);
  const options = parts.length
    ? parts.map(function (p) { return { value: p.name, label: (p.title || p.name) }; })
    : [{ value: panel.partition || '', label: panel.partition || '（无分区）' }];
  const msText = snap && snap.path ? (snap.ok === false ? '失败' : String(num(snap.ms, 0)) + 'ms') : (shell.loading ? '加载中…' : '—');
  return h('div', {
    style: {
      flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      padding: '5px 8px', borderBottom: '1px solid ' + COLORS.line, background: COLORS.bg2
    }
  },
    h('strong', { style: { fontSize: 11, color: COLORS.text } }, '小肥鱼记忆'),
    h(Select, { value: panel.partition || '', style: { maxWidth: 128 }, options: options, onChange: function (v) { if (panel.setPartition) panel.setPartition(v); } }),
    h(Btn, { onClick: panel.refresh, title: '重新拉取当前板块数据' }, '刷新'),
    h(Dot, { tone: integrity.ok === false ? 'bad' : 'ok', label: '完整性 ' + (integrity.ok === false ? '异常' : '正常') }),
    h(Dot, { tone: guard.tone, label: '守卫 ' + guard.label }),
    h('span', { style: { flex: '1 1 auto' } }),
    h('span', { style: Object.assign({}, S.muted, { fontFamily: 'ui-monospace, Consolas, monospace' }) }, msText),
    h(Chip, { tone: snap && snap.ok === false ? 'bad' : 'mute' }, snap && snap.path ? clip(snap.path, 22) : '未请求'));
}

// ---- Ctrl+K 检索浮层 -----------------------------------------------------
function SearchOverlay(props) {
  const p = props.partition;
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const res = useFetch(p && term ? withP('search', p, { q: term, limit: 10 }) : null);
  const rows = res.data ? arr(res.data.items) : [];
  return h('div', {
    style: {
      position: 'absolute', inset: 0, background: 'rgba(5,8,10,0.72)', display: 'flex',
      alignItems: 'flex-start', justifyContent: 'center', paddingTop: 40, zIndex: 20
    },
    onClick: function (e) { if (e.target === e.currentTarget) props.onClose(); }
  },
    h('div', { style: { width: '86%', maxWidth: 420, background: COLORS.bg2, border: '1px solid ' + COLORS.line, borderRadius: 8, padding: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.45)' } },
      h('div', { style: Object.assign({}, S.row, { marginBottom: 6 }) },
        h('span', { style: { fontSize: 11, color: COLORS.accent } }, '检索'),
        h(Input, {
          value: text, wide: true, autoFocus: true, placeholder: '标题 / 正文关键词，回车检索',
          onChange: setText,
          onKeyDown: function (e) { if (e.key === 'Enter') setTerm(text.trim()); if (e.key === 'Escape') props.onClose(); }
        })),
      !p ? h(Notice, { tone: 'warn' }, '还没选分区') : null,
      res.error ? h(Err, { error: res.error, onRetry: res.reload }) : null,
      res.loading ? h(Loading, { text: '检索中…' }) : null,
      res.data && !rows.length ? h(Empty, { text: '没有命中' }) : null,
      rows.map(function (r, i) {
        return h('div', { key: i, style: { borderTop: i ? '1px solid ' + COLORS.line : 'none', padding: '5px 0' } },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
            h(Chip, { tone: r.kind === 'trunk' ? 'violet' : 'mute' }, String(r.kind || 'fact')),
            h('strong', { style: { fontSize: 11 } }, clip(r.title, 32)),
            h('span', { style: { flex: '1 1 auto' } }),
            h('span', { style: S.muted }, pct(r.retention, 0))),
          h('div', { style: Object.assign({}, S.muted, { marginTop: 1 }) }, clip(r.snippet, 84) || '—'));
      }),
      h('div', { style: Object.assign({}, S.muted, { marginTop: 8, textAlign: 'right' }) }, 'Esc 关闭')));
}

// ---- 面板主体 ------------------------------------------------------------
function MemoryShell(props) {
  const p = props || {};
  const [pane, setPane] = useState(p.previewPane || 'overview');
  const [partition, setPartition] = useState(p.previewPartition || '');
  const [refreshToken, setRefreshToken] = useState(0);
  const [notice, setNotice] = useState('');
  const [searchOpen, setSearchOpen] = useState(!!p.previewSearch);
  const shell = useFetch(withP('state', partition), { bootKey: 'state' });
  const ov = obj(obj(shell.data).overview);
  const parts = arr(ov.partitions);
  const refresh = useCallback(function () { setRefreshToken(function (t) { return t + 1; }); }, []);
  useEffect(function () {
    if (partition || !parts.length) return;
    setPartition(String(parts[0].name || ''));
  }, [partition, shell.data]);
  useEffect(function () {
    if (!notice) return undefined;
    const t = setTimeout(function () { setNotice(''); }, 3500);
    return function () { clearTimeout(t); };
  }, [notice]);
  useEffect(function () {
    function onKey(e) {
      if (!e) return;
      const key = String(e.key || '');
      if ((e.ctrlKey || e.metaKey) && (key === 'k' || key === 'K')) {
        if (e.preventDefault) e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (key === 'Escape') setSearchOpen(false);
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }
    return undefined;
  }, []);
  const ctxValue = useMemo(function () {
    return { partition: partition, setPartition: setPartition, refresh: refresh, refreshToken: refreshToken, notify: setNotice, shell: shell };
  }, [partition, refreshToken, shell.data, shell.error, shell.loading]);
  const active = paneById(pane);
  const Comp = active.Comp;
  return h(PanelContext.Provider, { value: ctxValue },
    h('div', { style: Object.assign({}, S.pane, { position: 'relative' }) },
      h(Nav, { active: pane, onPick: setPane, onSearch: function () { setSearchOpen(true); } }),
      h('div', { style: S.body },
        h(StatusBar, null),
        notice ? h('div', { style: { flex: '0 0 auto', padding: '4px 8px 0' } }, h(Notice, { tone: 'info' }, notice)) : null,
        h('div', { style: S.content },
          h(Boundary, { key: pane }, h(Comp, null))),
        searchOpen ? h(SearchOverlay, { partition: partition, onClose: function () { setSearchOpen(false); } }) : null)));
}

/** 面板入口：只负责挂 BootContext（预览/SSR 夹具），内核在 MemoryShell 里，才能读到夹具 */
function MemoryPanel(props) {
  const p = props || {};
  return h(BootContext.Provider, { value: p.previewBoot || null }, h(MemoryShell, p));
}

/** 会话头部按钮：点一下打开右侧「小肥鱼记忆」面板 */
function makeOpenButton(sidebarRight) {
  return function XfyMemoryOpenButton() {
    return h(Btn, {
      title: '打开小肥鱼记忆面板',
      onClick: function () {
        try {
          if (sidebarRight && sidebarRight.openTab) sidebarRight.openTab('xfy-memory');
        } catch (e) {
          warn('openTab', e);
        }
      }
    }, '小肥鱼记忆');
  };
}

// ===========================================================================
// 07 · apply()：所有注册各自 try/catch，任何一步失败都不让 bundle 抛错
// ===========================================================================
const TAB_DEF = {
  id: 'xfy-memory-pane',
  kind: 'xfy-memory',
  title: function () { return '小肥鱼记忆'; },
  guide: [{ id: 'memory', kind: 'xfy-memory', title: '小肥鱼记忆', description: '长期记忆、曲线、守卫与汇报' }]
};

const PANE_SLOT = 'sidebar.right.pane.tab';
const HEADER_SLOT = 'conversation.session.header.actions';

const registered = { tabs: false, pane: false, header: false, errors: [] };

function tryStep(name, fn) {
  try {
    fn();
    return true;
  } catch (e) {
    warn(name, e);
    registered.errors.push(name + ': ' + String(e && e.message ? e.message : e));
    return false;
  }
}

function apply(ctx) {
  if (!ctx) return;
  tryStep('sidebarRightTabs.register', function () {
    if (!ctx.sidebarRightTabs || !ctx.sidebarRightTabs.register) return;
    const disposeTab = ctx.sidebarRightTabs.register(TAB_DEF);
    registered.tabs = true;
    if (typeof disposeTab === 'function' && ctx.effect) {
      tryStep('effect.tab', function () { ctx.effect(function () { return disposeTab; }); });
    }
  });
  tryStep('slots.pane', function () {
    if (!ctx.slots || !ctx.slots.inject || !ctx.slots.register) return;
    const disposePane = ctx.slots.inject(PANE_SLOT, function () {
      return ctx.slots.register({ name: PANE_SLOT, key: TAB_DEF.id }, MemoryPanel);
    });
    registered.pane = true;
    if (typeof disposePane === 'function' && ctx.effect) {
      tryStep('effect.pane', function () { ctx.effect(function () { return disposePane; }); });
    }
  });
  tryStep('slots.header', function () {
    if (!ctx.slots || !ctx.slots.inject || !ctx.slots.register) return;
    const OpenButton = makeOpenButton(ctx.sidebarRight);
    const disposeHeader = ctx.slots.inject(HEADER_SLOT, function () {
      return ctx.slots.register({ name: HEADER_SLOT, id: 'xfy-memory-open', order: 30 }, OpenButton);
    });
    registered.header = true;
    if (typeof disposeHeader === 'function' && ctx.effect) {
      tryStep('effect.header', function () { ctx.effect(function () { return disposeHeader; }); });
    }
  });
}

function openPanel(ctx) {
  try {
    if (ctx && ctx.sidebarRight && ctx.sidebarRight.openTab) return ctx.sidebarRight.openTab('xfy-memory');
  } catch (e) {
    warn('openPanel', e);
  }
  return false;
}

exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
exports.apply = apply;
// 附带导出：方便预览壳、自测和宿主按需直接渲染
exports.MemoryPanel = MemoryPanel;
exports.PANES = PANES;
exports.api = api;
exports.openPanel = openPanel;
exports.registered = registered;
exports.version = '1.0.0';
return module.exports}});
