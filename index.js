/**
 * dsh-xiaofeiyu-memory —— host 半端
 * ============================================================================
 * 把「小肥鱼记忆库」挂成 DSH 原生工具：分区隔离 + 遗忘曲线 + 守卫审查 + 向量召回。
 * 记忆库本身在 ./src（纯 ESM、零运行时依赖，除了可选的 sqlite-vec）。
 * 数据默认落在 ~/.dsh/xiaofeiyu-memory/data，路径可以在插件设置里改（config.root）。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'xiaofeiyu-memory'
// 这个 cordis 版本的 inject 只认数组：对象写法 { required, optional } 会被当成两个服务名，
// 插件会永远停在 pending (waiting for services: required, optional)。webServer 不声明，apply 里按需等。
export const inject = ['tools']

export const Config = !z ? undefined : z.object({
  /** 记忆库根目录（其下就是 data/、web/）。留空 = ~/.dsh/xiaofeiyu-memory */
  root: z.string().default('').extra('volatile', true),
  /** 不给 partition 时用哪个分区（建议显式传，别依赖这个） */
  defaultPartition: z.string().default('').extra('volatile', true),
  /** 回合结束自动清扫休眠/归档（写操作，默认关） */
  autoSweep: z.boolean().default(false).extra('volatile', true)
})

const cache = { root: '', store: null, api: null }

// 声明成 volatile 的字段，宿主给的是 cosmokit Volatile 引用（{ get() }），必须 .get() 取值；
// 直接读会拿到 "[object Object]"，记忆库就会开到一个叫 [object Object] 的目录里。
function cfgGet(v, fallback) {
  const empty = (x) => x === undefined || x === null || x === ''
  if (v && typeof v === 'object' && typeof v.get === 'function') {
    try { const x = v.get(); return empty(x) ? fallback : x } catch (e) { return fallback }
  }
  return empty(v) ? fallback : v
}

function rootOf(config) {
  const raw = String(cfgGet(config && config.root, '') || process.env.XFY_MEMORY_ROOT || '').trim()
  return raw || join(homedir(), '.dsh', 'xiaofeiyu-memory')
}

async function load(config) {
  const root = rootOf(config)
  if (cache.store && cache.root === root) return cache.api
  const db = await import('./src/db.mjs')
  const engine = await import('./src/engine.mjs')
  const toolset = await import('./src/tools.mjs')
  const guard = await import('./src/guard.mjs')
  const tasks = await import('./src/tasks.mjs')
  const store = db.openStore({ root })
  cache.root = root
  cache.store = store
  cache.api = { root: root, store: store, db: db, engine: engine, toolset: toolset, guard: guard, tasks: tasks }
  return cache.api
}

function partOf(args, config) {
  const p = String(cfgGet(args && args.partition, '') || cfgGet(config && config.defaultPartition, '') || '').trim()
  if (!p) throw new Error('缺少 partition：一个话题/项目一个分区，分区之间记忆严格隔离，不会互相串味。')
  return p
}

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (a, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function safe(v) {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch (e) { return String(v) }
}

function slimItem(x) {
  return {
    id: x.id, title: x.title, kind: x.kind, score: x.score, cos: x.cos,
    retention: x.retention, stability: x.stability, importance: x.importance,
    pinned: x.pinned, state: x.state, body: x.body, bodyTruncated: x.bodyTruncated,
    captions: x.captions, redundant: x.redundant, tags: x.tags, updatedAt: x.updatedAt
  }
}

export function apply(ctx, config) {
  // 宿主的 parameters 形状是「参数名 -> 值 schema」的映射，不是完整 JSON Schema 对象；
  // 传 { type:'object', properties } 会被 JsonSchemaError: parameters.type must be a value schema object 拒掉。
  const paramsOf = (p) => {
    if (!p || typeof p !== 'object') return {}
    if (p.type === 'object' && p.properties && typeof p.properties === 'object') return { ...p.properties }
    return p
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: paramsOf(spec.parameters),
    output: textOutput,
    async execute(args) { return safe(await spec.execute(args || {})) }
  }))

  tool({
    name: 'xfy_memory_recall',
    description: '从某个分区的长期记忆里召回这次任务最该看的几条（词面 + 多维向量融合 + 遗忘曲线衰减 + 重要度加权）。返回 eventId，用完后必须回调 xfy_memory_feedback 回填是否用上 —— 命中率和遗忘曲线全靠这个信号。默认 detail=index 只给正文前 90 字，省 token。',
    parameters: {
      type: 'object',
      properties: {
        partition: { type: 'string', description: '分区名（一个话题/项目一个）' },
        query: { type: 'string', description: '关键词，空格分隔；项目符号不要' },
        limit: { type: 'number', description: '最多几条，默认取配置里的 topK' },
        detail: { type: 'string', enum: ['index', 'full'], description: 'index 截断正文省 token；full 给全文' },
        includeDormant: { type: 'boolean', description: '是否包含已休眠条目' }
      },
      additionalProperties: false,
      required: ['partition', 'query']
    },
    async execute(args) {
      const api = await load(config)
      const partition = partOf(args, config)
      const r = api.engine.recall(api.store, {
        partition: partition, query: String(args.query || ''), limit: args.limit,
        detail: args.detail || 'index', includeDormant: !!args.includeDormant
      })
      return {
        partition: partition, eventId: r.eventId, candidates: r.candidates, tookMs: r.tookMs,
        items: r.items.map(slimItem),
        next: '看完请回填：xfy_memory_feedback({ eventId: ' + r.eventId + ', used: true|false })'
      }
    }
  })

  tool({
    name: 'xfy_memory_remember',
    description: '把一条长期有用的结论/约束/决策写进某个分区（同分区同内容自动去重，只更新时间戳）。只写结论与约束，不要写中间过程。',
    parameters: {
      type: 'object',
      properties: {
        partition: { type: 'string' },
        title: { type: 'string', description: '一句话结论，别超过 40 字' },
        body: { type: 'string', description: '正文：为什么、边界、怎么验证' },
        kind: { type: 'string', enum: ['fact', 'decision', 'constraint', 'preference', 'task', 'report', 'note', 'trunk'] },
        importance: { type: 'number', description: '1-5，4 以上基本不会休眠' },
        pinned: { type: 'boolean', description: '钉住 = 永远不进休眠，主干用' },
        tags: { type: 'string', description: '逗号分隔' },
        taskId: { type: 'string', description: '属于哪个任务' }
      },
      additionalProperties: false,
      required: ['partition', 'title']
    },
    async execute(args) {
      const api = await load(config)
      const r = api.engine.remember(api.store, {
        partition: partOf(args, config), title: String(args.title || ''), body: String(args.body || ''),
        kind: args.kind, tags: args.tags, importance: args.importance,
        pinned: !!args.pinned, taskId: args.taskId, source: 'dsh-plugin'
      })
      return { deduped: !!r.deduped, item: slimItem(api.engine.recall ? r.item : r.item) }
    }
  })

  tool({
    name: 'xfy_memory_search',
    description: '分区内全量翻找（LIKE + 词面打分 + 分页 + 排序），用来找回「记得有这么一条但想不起关键词」的旧记录。只返回片段不返回整段正文，省 token。与 recall 的分工：recall 挑最该看的少量条目，search 是全量查找。',
    parameters: {
      type: 'object',
      properties: {
        partition: { type: 'string' },
        q: { type: 'string', description: '关键词，留空 = 按 sort 列全部' },
        tags: { type: 'string', description: '逗号分隔，多个是 AND' },
        kind: { type: 'string' },
        state: { type: 'string', enum: ['all', 'active', 'dormant', 'archived'] },
        sort: { type: 'string', enum: ['score', 'recent', 'oldest', 'importance', 'retention', 'hits'] },
        limit: { type: 'number' },
        offset: { type: 'number' }
      },
      additionalProperties: false,
      required: ['partition']
    },
    async execute(args) {
      const api = await load(config)
      const r = api.toolset.searchItems(api.store, {
        partition: partOf(args, config), q: args.q, tags: args.tags, kind: args.kind,
        state: args.state, sort: args.sort, limit: args.limit, offset: args.offset
      })
      return { partition: r.partition, q: r.q, sort: r.sort, total: r.total, offset: r.offset, limit: r.limit, items: r.items }
    }
  })

  tool({
    name: 'xfy_memory_feedback',
    description: '回填召回结果到底用上了没有：used=true 会把这条记忆的稳定度提高（更难忘），used=false 会让它衰减更快。这是命中率与遗忘曲线的唯一信号来源，不回填等于没记忆。',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'recall 返回的 eventId' },
        used: { type: 'boolean', description: 'true = 真的用上了' }
      },
      additionalProperties: false,
      required: ['eventId', 'used']
    },
    async execute(args) {
      const api = await load(config)
      return api.engine.feedback(api.store, { eventId: String(args.eventId || ''), used: args.used ? 1 : 0 })
    }
  })

  tool({
    name: 'xfy_memory_guard',
    description: '三重保险里的第二重：上下文压力 / 命中率 / 重复读取 / 陈旧占比四项打分，返回 ok | warn | block 与处置指令。context 超过 warn 线就 warn，超过 block 线直接 block（此时别再翻文件，只按 trunk 主干作答）。',
    parameters: {
      type: 'object',
      properties: {
        partition: { type: 'string' },
        tokens: { type: 'number', description: '估计当前上下文 token 数' },
        chars: { type: 'number', description: '或者给字符数，按 charsPerToken 折算' },
        taskId: { type: 'string' }
      },
      additionalProperties: false,
      required: ['partition']
    },
    async execute(args) {
      const api = await load(config)
      return api.guard.checkGuard(api.store, {
        partition: partOf(args, config), contextTokens: args.tokens, chars: args.chars, taskId: args.taskId
      })
    }
  })

  tool({
    name: 'xfy_memory_audit',
    description: '审查这一分区的记忆健康度：陈旧条目、分区膨胀、命中率过低、重复读取、没有主干、任务泄漏、备份过期、附件缺描述。返回 findings 列表，按 severity 处理。',
    parameters: {
      type: 'object',
      properties: {
        partition: { type: 'string' },
        hours: { type: 'number', description: '统计窗口小时数，默认 168' }
      },
      additionalProperties: false
    },
    async execute(args) {
      const api = await load(config)
      return api.guard.audit(api.store, { partition: args.partition ? partOf(args, config) : null, hours: args.hours })
    }
  })

  tool({
    name: 'xfy_memory_digest',
    description: '这段时间学到了什么：新增/更新条目、召回次数与命中率、守卫事件、快忘的、冷掉的、最热的、任务与汇报、以及每日桶。适合任务收尾或开新任务前看一眼。',
    parameters: {
      type: 'object',
      properties: { partition: { type: 'string' }, days: { type: 'number', description: '默认 7，最大 365' } },
      additionalProperties: false,
      required: ['partition']
    },
    async execute(args) {
      const api = await load(config)
      const r = api.toolset.digest(api.store, { partition: partOf(args, config), days: args.days })
      return {
        partition: r.partition, days: r.days, items: r.items, recall: r.recall, guards: r.guards,
        nearForget: r.nearForget, cooling: r.cooling, hottest: r.hottest,
        tasks: r.tasks.length, reports: r.reports.length, daily: r.daily
      }
    }
  })

  tool({
    name: 'xfy_memory_health',
    description: '体检：数据库完整性、缺向量、附件文件缺失/孤儿、悬空关联、主干缺失、备份新鲜度。fix=true 只做两件安全动作（补算向量、删悬空关联）。',
    parameters: {
      type: 'object',
      properties: { partition: { type: 'string' }, fix: { type: 'boolean' } },
      additionalProperties: false
    },
    async execute(args) {
      const api = await load(config)
      return api.toolset.health(api.store, { partition: args.partition, fix: !!args.fix })
    }
  })

  tool({
    name: 'xfy_memory_dedupe',
    description: '找重复条目（向量余弦与词面 Jaccard 取大者），只给建议不自动合并 —— 合并记忆是不可逆的语义判断。返回 keep/drop 与现成命令。',
    parameters: {
      type: 'object',
      properties: { partition: { type: 'string' }, threshold: { type: 'number', description: '默认 0.92，0.5~1' } },
      additionalProperties: false,
      required: ['partition']
    },
    async execute(args) {
      const api = await load(config)
      return api.toolset.dedupe(api.store, { partition: partOf(args, config), threshold: args.threshold })
    }
  })

  tool({
    name: 'xfy_memory_summarize',
    description: '把一堆散记忆归纳成一条主干（kind=trunk 并钉住），旧主干用 superseded_by 取代而不是删掉。上下文快撑不住时用它把主线固化下来。',
    parameters: {
      type: 'object',
      properties: { partition: { type: 'string' }, limit: { type: 'number', description: '归纳几条，默认 12，2~40' }, title: { type: 'string' } },
      additionalProperties: false,
      required: ['partition']
    },
    async execute(args) {
      const api = await load(config)
      const r = api.toolset.summarize(api.store, { partition: partOf(args, config), limit: args.limit, title: args.title, taskId: args.taskId })
      return r
    }
  })

  tool({
    name: 'xfy_memory_link',
    description: '把两条记忆连起来（结论连依据、任务连产出）。只能同分区；跨分区会被拒绝 —— 分区隔离是硬规则。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '起点条目 id' },
        to: { type: 'string', description: '终点条目 id' },
        relation: { type: 'string', description: '关系名，默认 related（如 detail-of / depends-on / supersedes）' }
      },
      additionalProperties: false,
      required: ['from', 'to']
    },
    async execute(args) {
      const api = await load(config)
      return api.toolset.link(api.store, { from: args.from, to: args.to, relation: args.relation })
    }
  })

  tool({
    name: 'xfy_memory_explain',
    description: '解释一条记忆为什么被召回（或为什么快被遗忘）：把打分拆成相关度、向量余弦、衰减因子、重要度、钉住加成，给出 retention/stability/还有几天掉到遗忘线。调参或怀疑召回不准时用它。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, query: { type: 'string', description: '给查询才会算打分明细' } },
      additionalProperties: false,
      required: ['id']
    },
    async execute(args) {
      const api = await load(config)
      return api.toolset.explain(api.store, { id: args.id, query: args.query })
    }
  })

  tool({
    name: 'xfy_memory_task',
    description: '任务闸门：action=start 建会话记录并返回主干记忆（先读 trunk 再动手）；action=end 收尾，必须带 summary，可带 markdown 汇报，会落一份汇报文档到 data/reports 并登记进库。没有汇报文档不算任务结束。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'end'] },
        partition: { type: 'string' },
        title: { type: 'string', description: 'start 必填：这次任务要做什么' },
        taskId: { type: 'string', description: 'end 必填' },
        summary: { type: 'string', description: 'end：一句话结果' },
        markdown: { type: 'string', description: 'end：完整汇报正文（做了什么/结论/遗留）' },
        tokens: { type: 'number', description: '当前上下文 token 数' }
      },
      additionalProperties: false,
      required: ['action']
    },
    async execute(args) {
      const api = await load(config)
      if (String(args.action) === 'start') {
        const r = api.tasks.startTask(api.store, {
          partition: partOf(args, config), title: String(args.title || ''), contextTokens: args.tokens
        })
        return r
      }
      const r = api.tasks.endTask(api.store, {
        id: String(args.taskId || ''), summary: args.summary, markdown: args.markdown,
        partition: args.partition || null, contextTokens: args.tokens
      })
      return r
    }
  })

  // ======================= Web 半端 + 闭环钩子（可选） =======================
  // 宿主给进来的 ctx 没有 .inject()/apply(root) 那一套；能用的注册面就是 tools / webServer / on。
  const disposers = []
  const keep = (fn) => {
    try { const d = fn(); if (typeof d === 'function') disposers.push(d) } catch (err) { /* 这个 profile 没有该能力，跳过 */ }
  }

  // 启动自检日志：插件到底挂上了没有，直接看 <root>/data/plugin-boot.log
  // 自检日志写到固定位置（不依赖配置里的 root，root 本身可能配错）
  const bootLog = (line) => {
    try {
      const base = process.env.DSH_HOME || join(homedir(), '.dsh')
      mkdirSync(base, { recursive: true })
      appendFileSync(join(base, 'xfy-memory-boot.log'), new Date().toISOString() + ' ' + line + '\n')
    } catch (err) {}
  }

  const xfyHandler = async (req, res) => {
    try {
      const api = await load(config)
      if (!api.web) {
        const srv = await import('./src/server.mjs')
        api.web = { routes: srv.createRoutes(api.store), dispatch: srv.dispatchRequest, webDir: join(fileURLToPath(new URL('.', import.meta.url)), 'web') }
      }
      const raw = String(req.url || '/')
      const cut = raw.indexOf('/xfy-memory')
      let rest = cut >= 0 ? raw.slice(cut + '/xfy-memory'.length) : raw
      if (!rest) rest = '/'
      if (rest.charAt(0) !== '/') rest = '/' + rest
      req.url = rest
      return await api.web.dispatch(api.web.routes, api.store, req, res, { webDir: api.web.webDir })
    } catch (err) {
      const msg = String((err && err.message) || err)
      try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: msg })) } catch (e) {}
    }
  }

  // webServer 只存在于 Web/桌面版；插件先激活（工具立刻可用），路由用子 fiber 等它就绪再挂。
  // 注意：未 inject 的服务直接读 ctx.webServer 会抛 `cannot get property "webServer" without inject`。
  let routeReady = false
  const mountRoute = (wctx) => {
    if (routeReady) return
    try {
      const ws = wctx && wctx.webServer
      if (!ws || typeof ws.register !== 'function') return
      const d = ws.register({ kind: 'prefix', path: '/xfy-memory', handler: xfyHandler })
      if (typeof d === 'function') disposers.push(d)
      routeReady = true
      bootLog('route registered: /xfy-memory')
    } catch (err) {
      bootLog('route register failed: ' + String((err && err.message) || err))
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (wctx) => mountRoute(wctx))
    else mountRoute(ctx)
  } catch (err) {
    bootLog('webServer inject failed: ' + String((err && err.message) || err))
  }
  bootLog('root=' + rootOf(config) + ' defaultPartition=' + String(cfgGet(config && config.defaultPartition, '')))
  bootLog('apply ok: route=' + (routeReady ? 'registered' : 'waiting-for-webServer'))

  keep(() => {
    if (typeof ctx.on !== 'function') return undefined
    const on = (name, fn) => {
      try {
        const off = ctx.on(name, function (payload) { try { return fn(payload || {}) } catch (err) { return undefined } })
        if (typeof off === 'function') return off
      } catch (err) {}
      return undefined
    }
    /**
     * cordis 的 waterfall 是「中间件链」：监听器必须调用 next() 把链传下去，
     * 否则整条链的返回值就是这个监听器的返回值。DSH agent-loop 的 agent/pre-step
     * 拿到 undefined 后立刻读 decision.kind，于是每一轮都在 turn/start 后 20–50ms
     * 以 "Cannot read properties of undefined (reading 'kind')" 结束（用户看到的本轮失败）。
     * 这里必须：无论记忆库那边成功、失败还是超时，都 return next()；异常绝不能逃逸。
     */
    const onMiddleware = (name, fn) => {
      try {
        const off = ctx.on(name, function (payload, next) {
          const done = typeof next === 'function' ? next : function () { return undefined }
          const settle = function () { return done() }
          let pending
          try { pending = fn(payload || {}) } catch (err) { return settle() }
          if (pending && typeof pending.then === 'function') return pending.then(settle, settle)
          return settle()
        })
        if (typeof off === 'function') return off
      } catch (err) {}
      return undefined
    }
    const offs = []
    const partitionOf = (payload) => String(cfgGet(payload && payload.partition, '') || cfgGet(config && config.defaultPartition, '') || '').trim()

    // payload 里没有 token 计数时，按消息正文估算一个（CJK 约 1 字 1 token，拉丁约 4 字符 1 token）。
    const estimateTokens = (messages) => {
      let chars = 0
      for (const m of Array.isArray(messages) ? messages : []) {
        for (const part of Array.isArray(m && m.content) ? m.content : []) {
          if (part && typeof part.text === 'string') chars += part.text.length
        }
      }
      return chars > 0 ? Math.round(chars / 2.2) : 0
    }
    const tokensOf = (payload) => {
      const c = [payload && payload.tokens, payload && payload.contextTokens, payload && payload.usage && payload.usage.total_tokens, payload && payload.context && payload.context.tokens];
      for (const v of c) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; }
      return estimateTokens(payload && payload.messages);
    };

    // 上下文压力自动记一条守卫事件（只写日志，不拦 agent；拦不拦由工具里的 guard 决定）。
    // 写完 next() 之外还要节流：每轮每步都写一条会把守卫日志灌满，也让 pre-step 变慢。
    const guardWrite = { key: '', tokens: 0, at: 0 }
    const preStep = onMiddleware('agent/pre-step', async (payload) => {
      try {
        const part = partitionOf(payload)
        const tokens = tokensOf(payload)
        if (!part || !tokens) return
        const now = Date.now()
        const sameSession = guardWrite.key === part
        if (sameSession && tokens - guardWrite.tokens < 2000 && now - guardWrite.at < 5 * 60 * 1000) return
        const api = await load(config)
        await api.guard.checkGuard(api.store, { partition: part, contextTokens: tokens, source: 'auto' })
        guardWrite.key = part
        guardWrite.tokens = tokens
        guardWrite.at = now
      } catch (err) {
        // 记忆库写不进去也不能影响这一轮对话
      }
    })
    if (preStep) offs.push(preStep)

    // 回合结束：可选自动清扫（默认关，写操作要用户点头才开）
    const turnStop = on('agent/turn-stopping', async (payload) => {
      try {
        if (!cfgGet(config && config.autoSweep, false)) return
        const part = partitionOf(payload)
        if (!part) return
        const api = await load(config)
        api.engine.sweep(api.store, { partitionId: api.engine.partitionByName(api.store, part).id })
      } catch (err) {
        // 同上：清扫失败只记不抛
      }
    })
    if (turnStop) offs.push(turnStop)

    return () => { for (const off of offs) { try { off() } catch (err) {} } }
  })

  return () => { for (const d of disposers) { try { d() } catch (err) {} } }
}
