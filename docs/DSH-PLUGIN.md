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

- **工具**：`xfy_memory_recall` / `remember` / `search` / `feedback` / `guard` / `audit` / `digest` / `health` / `dedupe` / `summarize` / `link` / `explain` / `task`。`inject` 写成 `{ required: ['tools'], optional: ['webServer'] }`——CLI profile 没有 webServer，写成必选会把工具注册一起拖死。
- **HTTP**：`ctx.webServer.register({ kind: 'prefix', path: '/xfy-memory', handler })`，handler 里懒加载 `src/server.mjs`，用 `createRoutes(store)` + `dispatchRequest(routes, store, req, res, { webDir })` 分发，并把 `req.url` 上的 `/xfy-memory` 前缀切掉。静态页面取包内的 `web/`。
- **闭环钩子**：
  - `agent/pre-step` → 从 payload 里取分区（`payload.partition` 或配置的 `defaultPartition`）与 token 数（`payload.tokens` / `contextTokens` / `usage.total_tokens` / `context.tokens`），跑一次 `checkGuard(..., { source: 'auto' })`，落库供看板与面板统计。
  - `agent/turn-stopping` → **仅当配置 `autoSweep: true`** 才 `sweep`（休眠/归档是写操作，默认关）。
- **配置**：`root`（记忆库根，默认 `~/.dsh/xiaofeiyu-memory`，也可用环境变量 `XFY_MEMORY_ROOT`）、`defaultPartition`、`autoSweep`。

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

CLI profile 与老版本宿主可能没有 `webServer`：插件会**只**注册工具（`inject.optional` 就是为此），面板不出现；此时用独立服务看板：

```powershell
node "G:\华仔的小肥余专属工作区\xiaofeiyu-memory\src\server.mjs" --port 8788
```

## 7. 数据落在哪

插件形态下默认 `~/.dsh/xiaofeiyu-memory/data`（可用 `config.root` 或 `XFY_MEMORY_ROOT` 指到本仓库的 `data/` 共用同一份记忆）。影子日志 `data/shadow/*.jsonl`、备份 `data/backups/`、汇报 `data/reports/` 都在根目录下，`mem rebuild` 可从影子日志重建整库。
