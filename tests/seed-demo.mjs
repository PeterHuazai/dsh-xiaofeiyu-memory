const BASE = process.env.MEM_BASE || 'http://127.0.0.1:8788';

async function api(path, body, method) {
  const res = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (err) { return { raw: text }; }
}

const seeds = {
  xiaofeiyu: [
    ['decision', '记忆曲线用指数衰减', '保留率 R(t)=exp(-Δt/S)，S 随命中增长：S*=1.6（growth 0.6）。遗忘阈值 0.25，低于则转 dormant，主干（pinned 或 importance>=4）永不丢。', ['curve', '核心'], 5, true],
    ['constraint', '分区之间严禁串味', '每条记忆必须绑定 partition_id，召回只在本分区内检索；导入时必须显式指定目标分区或重命名。', ['隔离'], 5, true],
    ['fact', '存储是 SQLite + JSONL 影子日志', '主库 data/memory.db（WAL），每次写同步追加 data/shadow/YYYY-MM-DD.jsonl，库坏可用 mem rebuild 重放。', ['存储', '保险'], 4, false],
    ['decision', '召回默认只回索引', 'detail=index 时正文截断到 90 字，先给目录再按需 mem get 取全文，省 token。', ['token'], 4, false],
    ['preference', '看板要中文、离线、可交互', '不引 CDN，手写 SVG 图表，hover 有 tooltip，点击条目看记忆曲线。', ['ui'], 3, false],
    ['note', '调试时的一条无用记录', '这里记录了一次临时排查，价值很低，用于演示遗忘曲线如何让它休眠。', ['temp'], 1, false]
  ],
  'ziwei-web': [
    ['fact', 'ziwei-web 是紫微排盘前端', '纯静态页面 + 本地 JSON 星曜表，没有后端依赖。', ['项目'], 4, false],
    ['decision', '排盘算法用农历转换库', '避免自己实现历法，直接依赖 lunar-javascript。', ['算法'], 4, true],
    ['constraint', '不支持 IE', '只用现代 CSS（grid、clamp），不写前缀。', ['兼容'], 3, false],
    ['note', '待办：星座页配色偏灰', '用户反馈整体对比度不足，需要提高主色饱和度。', ['ui', 'todo'], 2, false]
  ]
};

async function main() {
  for (const [name, items] of Object.entries(seeds)) {
    await api('/api/partitions', { name: name, title: name === 'xiaofeiyu' ? '小肥鱼记忆库' : '紫微网页项目', description: name === 'xiaofeiyu' ? '记忆工具自身的决策与约束' : 'ziwei-web 项目的长期记忆' });
    for (const it of items) {
      await api('/api/remember', { partition: name, kind: it[0], title: it[1], body: it[2], tags: it[3], importance: it[4], pinned: it[5] });
    }
  }
  const r1 = await api('/api/recall', { partition: 'xiaofeiyu', query: '遗忘 阈值 主干', limit: 4 });
  await api('/api/feedback', { eventId: r1.eventId, used: true });
  const r2 = await api('/api/recall', { partition: 'xiaofeiyu', query: 'token 节省 召回', limit: 4 });
  await api('/api/feedback', { eventId: r2.eventId, used: false });
  const r3 = await api('/api/recall', { partition: 'ziwei-web', query: '排盘 算法', limit: 3 });
  await api('/api/feedback', { eventId: r3.eventId, used: true });
  const t = await api('/api/task/start', { partition: 'xiaofeiyu', title: '记忆工具接入演示', goal: '演示任务开启自动写入 + 汇报落盘' });
  await api('/api/task/end', { taskId: t.task.id, partition: 'xiaofeiyu', title: '演示汇报', summary: '演示任务完成：写入 6 条记忆、3 次召回、1 次守卫检查。', markdown: '## 完成内容\n- 分区隔离\n- 遗忘曲线\n- 召回索引模式\n\n## 风险\n- 视觉模型自检默认关闭' });
  await api('/api/guard/check', { partition: 'xiaofeiyu', contextTokens: 168000 });
  await api('/api/guard/check', { partition: 'ziwei-web', contextTokens: 40000 });
  console.log(JSON.stringify({ recall1: r1.items.length, recall3: r3.items.length, task: t.task.id }));
}
main().catch(function (e) { console.error('seed failed: ' + e.message); process.exit(1); });
