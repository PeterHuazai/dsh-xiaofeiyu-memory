# DSH 插件形态：装进 DeepSeek Harness 并用原生面板看记忆

这份文档讲三件事：这个包作为 DSH 插件由哪两半组成、客户端面板怎么被宿主加载、以及怎么把它装进本机的 DSH 桌面版。命令行/HTTP 的用法见 [USAGE.md](./USAGE.md) 与 [API.md](./API.md)。

## 1. 两半：host 与 client

| 半端 | 文件 | 作用 |
| --- | --- | --- |
| host | `index.js` | 注册 13 个 `xfy_memory_*` 原生工具；挂 `/xfy-memory` 下的 HTTP 路由（同一个 `src/server.mjs`）；监听 `agent/pre-step` / `agent/turn-stopping` 形成闭环 |
| client | `lib/client.js` | 往 DSH 界面里注册右侧栏面板与会话头按钮，React 原生渲染，不引入 iframe |
| 共享 | `src/*.mjs` | 记忆库本体（纯 ESM、零运行时依赖，可选 sqlite-vec） |

`package.json` 里两块声明缺一不可：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // host 半端：装插件时插进 loader
  "client": { "platform": "web", "inject": ["slots", "sidebarRightTabs", "sidebarRight"] }
},
"exports": { "./client": { "default": "./lib/client.js" } }
```

## 2. host 半端做了什么

- **工具**：`xfy_memory_recall` / `remember` / `search` / `feedback` / `guard` / `audit` / `digest` / `health` / `dedupe` / `summarize` / `link` / `explain` / `task` / `trunk`（14 个）。`inject` 写成 `['tools']`——CLI profile 没有 webServer，写成必选会把工具注册一起拖死。
- **HTTP**：`ctx.webServer.register({ kind: 'prefix', path: '/xfy-memory', handler })`，handler 里懒加载 `src/server.mjs`，用 `createRoutes(store)` + `dispatchRequest(routes, store, req, res, { webDir })` 分发，并把 `req.url` 上的 `/xfy-memory` 前缀切掉。静态页面取包内的 `web/`。v0.2 新增 `/api/guard/fix`（GET 出计划 / POST 带 `confirm: true` 才执行）、`/api/consolidate`、`/api/trunk/digest`。
- **闭环钩子**：
  - `agent/pre-step` → 中间件按 waterfall 规矩调 `next()`；取分区（`payload.partition` 或配置的 `defaultPartition`）与 token 数（`payload.tokens` / `contextTokens` / `usage.total_tokens` / 正文估算 `chars / 2.2`，取不到就跳过而不是记 0），跑一次 `checkGuard(..., { source: 'auto' })`；同一分区 5 分钟内、tokens 增长不足 2000 时不再重复写事件。第二轮起还可以往 `decision.messages` 注入主干速览（见第 11 节）。
  - `agent/turn-stopping` → **仅当配置 `autoSweep: true`** 才 `sweep`（休眠/归档是写操作，默认关）。
- **配置**：`root`（记忆库根，默认 `~/.dsh/xiaofeiyu-memory`，也可用环境变量 `XFY_MEMORY_ROOT`）、`defaultPartition`、`autoSweep`、`injectTrunk`（默认 true，第一轮注入主干速览）。

## 3. client 半端：面板怎么被加载

DSH 的客户端 bundle 不是普通 ESM，必须用宿主的 `__ModuleLoader__` 包裹（逐字，`id` 必须等于包名）：

```js
window.__ModuleLoader__.load({
  id: `dsh-xiaofeiyu-memory`,
  factory: require => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: `Module` });
    // … 这里可以直接 require('react') / require('react-dom') / require('react/jsx-runtime')
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

面板用的三个槽位：

- `sidebarRightTabs.register({ id, kind: 'xfy-memory', title, ... })` 声明一种右侧栏标签；
- `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'xfy-memory-pane' }, Panel)` 是面板正文；
- `ctx.slots.register({ name: 'conversation.session.header.actions', id: 'xfy-memory-open' }, Button)` 是会话头的打开按钮，点击走 `ctx.sidebarRight.openTab('xfy-memory')`。

客户端面板的数据来源：同一台宿主上的 `/xfy-memory/api/*`（有 host 路由时），拿不到就回落到独立服务的 `http://127.0.0.1:8788/api/*`，两边字段是同一套契约（见 `docs/API.md`）。

## 4. 装进本机 DSH 桌面版

已经安装过的插件是「`~/.dsh/profiles/desktop/node_modules/<包名>` + `profiles/desktop/cordis.patch.yml` 里的 insert 条目」这套布局，`insert.name` 必须与包名完全一致（不一致的表现是「装上了但不生效」）。

```powershell
# 开发期：把本地目录链进去（改代码不用重装）
dsh plugin --profile web add "link:G:\华仔的小肥余专属工作区\xiaofeiyu-memory"
# 或者从 GitHub 装
dsh plugin --profile web add github:PeterHuazai/dsh-xiaofeiyu-memory
# 卸载
dsh plugin --profile web remove dsh-xiaofeiyu-memory
```

`cordis.patch.yml` 就一条：

```yaml
- insert:
    - id: xiaofeiyu-memory
      name: dsh-xiaofeiyu-memory
      config:
        root: ''
        defaultPartition: ''
```

### 手动装（CLI 不在 PATH 上时）

1. 把整个包目录复制/链接到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-xiaofeiyu-memory`；
2. 备份 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，把上面那三行 insert 条目并进 `patch` 列表；
3. 重启 DSH 桌面版，会话里问一句「列出 xfy_memory 工具」，能看到 13 个即挂上；界面右侧栏出现「记忆」标签即 client 半端生效。

## 5. 验证清单

- host 工具：任意会话里调 `xfy_memory_recall`，返回带 `items` 与 `eventId`；
- HTTP：浏览器/curl 打开 `http://<宿主端口>/xfy-memory/api/health`，`{ ok: true }`；
- 面板：右侧栏「记忆」打开后概览卡有数字、曲线有折线、向量面板显示覆盖率；控制台无报错；
- 钩子：发一轮对话后 `GET /xfy-memory/api/guard/events?source=auto` 能查到刚才那条 `source: 'auto'` 记录；
- 独立服务：`node src/server.mjs` 仍可单独跑（不依赖 DSH），`http://127.0.0.1:8788/` 是同一份看板。

## 6. 没有 webServer 时怎么办

CLI profile 与老版本宿主可能没有 `webServer`：插件的 `inject` 只写 `['tools']`（这个 cordis 版本不认 `{ required, optional }` 对象写法），路由用 `ctx.inject(['webServer'], …)` 子 fiber 等它就绪；没有 webServer 时只注册工具、面板不出现，此时用独立服务看板：

```powershell
node "G:\华仔的小肥余专属工作区\xiaofeiyu-memory\src\server.mjs" --port 8788
```

## 7. 数据落在哪

插件形态下默认 `~/.dsh/xiaofeiyu-memory/data`（可用 `config.root` 或 `XFY_MEMORY_ROOT` 指到本仓库的 `data/` 共用同一份记忆）。影子日志 `data/shadow/*.jsonl`、备份 `data/backups/`、汇报 `data/reports/` 都在根目录下，`mem rebuild` 可从影子日志重建整库。

## 8. 排查：面板「请求失败」

面板的所有请求走 `'/xfy-memory/api/'`，失败才退到 `http://127.0.0.1:8788/api/`。所以「请求失败」只有两种原因：宿主路由没挂上，或独立服务没起。

先看一键自检日志（插件每次激活都会写，固定位置，不受配置影响）：

```powershell
Get-Content "$env:USERPROFILE\.dsh\xfy-memory-boot.log" -Tail 20
```

正常应有 `route registered: /xfy-memory`；如果只有 `apply ok: route=waiting-for-webServer` 而没有后一行，说明宿主的 `webServer` 服务没就绪。

### 装完 DSH 里 404 的四个真实坑（都已修，留档）

1. **`inject` 不能写成对象**：`export const inject = { required: ['tools'], optional: ['webServer'] }` 会被这个 cordis（@deepseek-ai/cordis 4.x）当成两个服务名 `required` / `optional`，插件永远停在 `pending (waiting for services: required, optional)`。必须是数组：`export const inject = ['tools']`。
2. **没 inject 的服务不能直接读**：`ctx.webServer` 会抛 `cannot get property "webServer" without inject`。用 `ctx.inject(['webServer'], (wctx) => wctx.webServer.register({...}))`。
3. **工具 `parameters` 是「参数名 → 值 schema」的映射**，不是完整 JSON Schema 对象；传 `{ type: 'object', properties }` 会得到 `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`。
4. **`.volatile()` 字段送来的是 cosmokit `Volatile` 引用**，必须 `config.root.get()` 取快照；直接读会得到 `"[object Object]"`，记忆库就会被开到一个叫 `[object Object]` 的目录里（表现为面板全 0、数据「丢了」）。`index.js` 的 `cfgGet()` 就是干这个的。

### 不改代码就能立刻恢复的兜底

```powershell
node "G:\华仔的小肥余专属工作区\xiaofeiyu-memory\src\server.mjs" --port 8788
```

服务端带 `access-control-allow-origin: *`，面板会自动退到它，不用重启 DSH。

## 9. 排查：一启用插件，这一轮对话就「Cannot read properties of undefined (reading 'kind')」

**这是 `agent/pre-step` 的 waterfall 契约，不是面板的问题。** 症状：启用插件后每一轮刚开就失败（turn/start 之后 20–50ms），会话日志里只有 `turn/start` + `inbox/spliced` + `turn/end`（`reason.kind = 'error'`），没有任何 `llm/*` 或 `step/*` 记录 —— 说明崩在模型调用之前。

机制（dsh 0.2.2-rc.3）：

- `@deepseek-ai/dsh-agent-loop` 的 `src/agent.ts:302-314` 把 `agent/pre-step` 当 **cordis waterfall** 派发：
  `const decision = await this.dispatch.waterfall('agent/pre-step', {...}, () => ({ kind: 'enter' }))`，紧接着 `if (decision.kind === 'reject')`。
- cordis 4.x 的 waterfall 是「中间件链」：**监听器必须调用 `next()`**，否则整条链的返回值就是这个监听器的返回值。
- 旧版 `index.js` 写的是 `ctx.on('agent/pre-step', (payload) => fn(payload))`，从不调用 `next` → 返回 `undefined` → 宿主读 `decision.kind` 抛 `TypeError: Cannot read properties of undefined (reading 'kind')`。

修法（现在的 `index.js`）：用 `onMiddleware(name, fn)` 包一层，`(payload, next)` 里无论记忆库成功、抛错还是 async 拒绝，都 `return next()`：

```js
const onMiddleware = (name, fn) => ctx.on(name, function (payload, next) {
  const done = typeof next === 'function' ? next : () => undefined
  const settle = () => done()
  let pending
  try { pending = fn(payload || {}) } catch (err) { return settle() }
  if (pending && typeof pending.then === 'function') return pending.then(settle, settle)
  return settle()
})
```

另外顺手修的两处：`tokensOf()` 在 pre-step 的 payload 里根本没有 token 字段（永远估成 0，守卫从不触发），改成按消息正文估算（CJK 约 1 字 1 token，拉丁约 4 字符 1 token）；守卫写入加节流（同分区增量 < 2000 tokens 且 5 分钟内不重复写），避免每轮都落一条记录。

回归测试（不需要真 DSH）：

```powershell
cd "G:\华仔的小肥余专属工作区\xiaofeiyu-memory"
npm run test:smoke    # 18 项：middleware 有没有调 next、返回值是否原样透传
npm run test:cordis   # 5 项：用真 cordis 4.1.0 复现 TypeError，再接插件验证不抛
```

`tests/cordis-waterfall.test.mjs` 会自动在 `DSH_CORDIS_PATH` → profile 的 `node_modules` → `.tmp-asar/c/...` 里找 cordis，找不到就打印「跳过」并 exit 0。

## 10. 排查：面板「网络错误：Failed to fetch」

桌面版的页面 origin 是 **`dsh-app://app/`**，插件路由由外壳 `protocol.handle` 转发到宿主同源；`window.__DSH_TRANSPORT__.streamBaseUrl` 是宿主真实 origin（跨源，插件路由不返 `Access-Control-Allow-*`）。

旧代码 `api()` 的 bases 是 `['', 'http://127.0.0.1:8788/api/', 'http://127.0.0.1:8787/api/']`，`base` 为空串时 `'state?partition=x'` 变成**相对当前文档**的 URL，打到 `dsh-app://app/state?...`（或 web 版的 `/state?...`），前缀 `/xfy-memory/api/` 直接丢了 → 404 → 回落 8788/8787 也不通 → 面板报「网络错误（已尝试 3 个入口）」。

现在 `lib/client.js` 用页面 base 解析（同 `dsh-better-sidebar` 的 hostRouteUrl 思路）：

```js
const routeUrl = (path) => {
  const base = directoryBase(pageBase())          // document.baseURI → location.href → ''
  if (!base) return API_PREFIX + path
  return new URL('xfy-memory/api/' + path.replace(/^\/+/, ''), base).toString()
}
```

- 保留反代前缀：`https://host/dataops/proxy/3080/xfy-memory/api/items`；
- 剥掉前导斜杠再拼，`new URL` 才会挂在页面目录下而不是 origin 根；
- 仍然保留 8788/8787 回落（独立服务、非桌面壳场景）；
- `tests/client-panel.test.mjs` 第 5 节用 vm 沙箱里的 `document.baseURI` 断定了三种壳（web / `dsh-app://` / 反代）的首个请求 URL。

### 另一个坑：`sidebarRightTabs` 的 `guide` 会抢默认右栏页

`contract/seed.ts` 的 `defaultSeed()`：当 `tabs.guide()` 恰好只有一条时，把**那一页**当作每个新会话的默认右栏 tab；找不到对应定义就 `throw new Error('sidebarRight: default tab kind "<kind>" is not registered')`。所以「记忆」页的 definition **不能**只登记一条 guide。现在 `TAB_DEF` 只有 `id/kind/title`，`guide` 留空，DSH 默认页不受影响。

同理：`package.json` 的 `dsh.client.inject` 写的是**包名**（`@deepseek-ai/dsh-client-ui-sidebar-right`），不是服务名；服务名写在 JS 侧 `exports.inject` 里，而且 `slots` 必须常驻、`sidebarRightTabs`/`sidebarRight` 走 `ctx.inject([...], fn)` 子 fiber 等（服务缺席时插件不该 pending）。

## 11. 第一轮自动注入「主干速览」是怎么塞进去的

目标：每个新会话第一轮就带上记忆主干（约 100~320 tokens），后面不再重复，省 token。

`agent/pre-step` 是 cordis **waterfall**，DSH 侧的调用在 `dsh-agent-loop/src/agent.ts` 的 `preStep()`：

```ts
const claimed = this.inbox.claim(...)
const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, ...position, signal, modelSelection }, () => ({ kind: 'enter', messages: claimed }))
if (decision.kind === 'reject') { ... }
```

所以插件必须：

1. **先 `await next()` 拿到 decision，再把 decision 原样返回**——`onWaterfall()` 封装了这件事，即使我们的逻辑抛错也照样返回 decision，绝不把 `undefined` 返给 agent loop（否则就是 `Cannot read properties of undefined (reading 'kind')`，见第 9 节）；
2. 只对 `decision.kind === 'enter'`、`payload.turn === 1 && payload.step === 1`、`injectTrunk !== false`、分区非空的会话动手；
3. 用 `decision.messages.push(消息)` 追加，消息形状跟 DSH 自己的 runtime-context 一致：

```js
{
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'xiaofeiyu-memory', form: 'snapshot', sections: [{ name: 'xfy-memory', text }] }
}
```

`source.kind` 是插件自己的签名（DSH 的 `MessageSource` 对未知 kind 直接放行），`form: 'snapshot'` 要求带 `sections`；正文用 `[小肥鱼记忆 · 主干速览]` 开头、附 recall/remember/task end 的引导语。每个 `partition + agentId` 只注入一次（`trunkInjected` Set）。

为什么不用 `systemPrompt.section()`：它是「每一步都拼进系统提示」的通道，`AssembleContext` 只有 `{ scope?, signal? }`，拿不到 session/分区，也没法「只在第一轮」——每步都拼会持续吃 token 和缓存。

配套：`trunkDigest()` 会过滤掉 `kind='task'` 的脚手架条目，按「先主干、再场景」排序，超 token 预算就截断尾部。


