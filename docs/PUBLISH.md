# 发布与上架（PUBLISH）

本地已经做好的事：`git init -b main` + 2 个 commit（`a4d70ec` 功能、`8d7c561` 文档）、`origin` 指向
`https://github.com/PeterHuazai/dsh-xiaofeiyu-memory.git`、README / LICENSE / package.json（含 `dsh` 字段）/ cordis.patch.yml 齐备。

## 0. 现状（实测，不是推测）

```
git ls-remote --heads origin
remote: Repository not found.
fatal: repository 'https://github.com/PeterHuazai/dsh-xiaofeiyu-memory.git/' not found
```

这台机器**没有 gh CLI**，环境里也**没有 GH_TOKEN / GITHUB_TOKEN**，所以仓库还没有在 GitHub 上存在，push 卡在建仓这一步。

## 1. 建仓 + 推送（两条路选一条）

### A. 网页建空仓库（推荐，最省事、不泄露 token）

1. 打开 <https://github.com/new>
2. Repository name 填 `dsh-xiaofeiyu-memory`，Owner 选 `PeterHuazai`
3. **不要**勾 Add a README / Add .gitignore / Choose a license（本地已经有了，勾了会冲突）
4. Public，Create repository
5. 回到终端：

```bash
cd "G:/华仔的小肥余专属工作区/xiaofeiyu-memory"
git push -u origin main   # Git Credential Manager 会弹浏览器，点同意即可
```

### B. 用 PAT 建仓（不想开浏览器时）

```bash
curl -X POST https://api.github.com/user/repos \
  -H "Authorization: Bearer <PAT>" \
  -H "Accept: application/vnd.github+json" \
  -d '{"name":"dsh-xiaofeiyu-memory","private":false,"description":"DSH 插件：分区隔离 + 遗忘曲线的本地长期记忆库"}'

git push -u origin main
```

> 用 PAT 时请只给 `repo` 权限、用完立刻吊销。

## 2.（可选）发到 npm

插件被 `dsh plugin add dsh-xiaofeiyu-memory` 安装，前提是它作为一个 npm 包存在：

```bash
cd "G:/华仔的小肥余专属工作区/xiaofeiyu-memory"
npm publish --access public   # 先 npm login
```

不想发 npm 也行 —— 别人可以 `dsh plugin --profile web add link:<克隆下来的目录>` 直接挂本地目录。

## 3. 上架插件市场（dshmarket）

事实：`dshmarket` 是市场应用本身；**插件目录来自精选列表仓库** <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 的 PR，
站点（dshbase.com / dsh-plugin.market / dshmarket.com）都从它收录，通常一天内生效。市场识别插件靠 npm `keywords` 里的 `dsh-plugin`（本包已带）。

步骤：fork 那个仓库 → 在它的 README 列表里加一行 → 提 PR。

### 建议的条目文本（直接复制）

```markdown
- [dsh-xiaofeiyu-memory](https://github.com/PeterHuazai/dsh-xiaofeiyu-memory) — 本地长期记忆库：分区硬隔离、遗忘曲线（retention = exp(-Δt/stability)）、
  命中率看板、幻觉守卫（上下文/命中率/重复读取/陈旧四维打分 + 120k/200k 硬阈值）、向量召回（本地哈希 + DeepSeek 语义指纹），
  SQLite + JSONL 影子日志多重保险，附带单文件可视化看板。
```

### PR 描述文本（直接复制）

```
新增插件：dsh-xiaofeiyu-memory

解决什么问题：长对话里记忆串味、越存越乱、上下文过长后反复读取导致命中率下降与幻觉。

特性：
- 分区隔离：所有读写按 partition 走，跨分区查询与关联在代码层直接拒绝
- 遗忘曲线：用上就变牢、不用就衰减，pinned / 高重要度条目永不休眠（保留主干）
- 守卫：score = 0.45*上下文压力 + 0.25*(1-命中率) + 0.2*重复读取 + 0.1*陈旧占比，并有 120k warn / 200k block 硬阈值
- 13 个原生工具（xfy_memory_recall / remember / search / feedback / guard / audit / digest / health / dedupe / summarize / link / explain / task）
- 单文件可视化看板：命中率趋势、每条的遗忘曲线、参数在线微调、导入导出、汇报文档
- 多重保险：SQLite 主库 + JSONL 影子日志（可从日志重建）+ 备份 + 完整性校验 + 回收站

作者：非人工智能专业的学生，拿 DeepSeek Harness 写着玩的（106 个自动化测试全绿）。欢迎指正和评价，不喜勿喷。
```

## 4. 装好后怎么用（给用户看的）

```bash
# 插件方式（发布到市场或 npm 之后）
dsh plugin --profile web add dsh-xiaofeiyu-memory

# 本地目录方式（开发/试用）
dsh plugin --profile web add link:G:/华仔的小肥余专属工作区/xiaofeiyu-memory
```

装完会话里会多出 13 个 `xfy_memory_*` 工具；记忆数据默认落在 `~/.dsh/xiaofeiyu-memory/data`，
可用插件配置 `root` 或环境变量 `XFY_MEMORY_ROOT` 改。看板单独起：`node src/server.mjs`（默认 8787）。

## 5. 手工安装（没有 dsh CLI 时）

桌面版的 `dsh` 命令不在 PATH 上时，等价操作是：

1. 把整个项目目录复制到 `C:\Users\<你>\.dsh\plugins\dsh-xiaofeiyu-memory`（或在其中 `npm install` 装好依赖）
2. 编辑 `C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`（先备份），把空数组 `[]` 换成：

```yaml
- insert:
    - id: xiaofeiyu-memory
      name: dsh-xiaofeiyu-memory
      config:
        root: ''
        defaultPartition: ''
```

3. 重启 DSH。撤掉就把这段删回去。
