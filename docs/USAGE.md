# 小肥鱼记忆库 · 使用手册

一句话：给每个话题一个**隔离的分区**，把结论写进去，用遗忘曲线让它自然淡出，用守卫和审查防止上下文过长时的幻觉与重复读取，用看板随时看命中率与曲线。

## 1. 快速开始

```bash
node src/server.mjs --port 8788    # 看板 http://127.0.0.1:8788/ + HTTP API
node src/cli.mjs help              # 全部命令
npm test                           # 80 项自动化测试
```

CLI 也可以直接用 `mem.cmd`（工作区根目录的包装器）。数据都在 `data/`：`memory.db` 主库、`shadow/` 影子日志、`backups/` 备份、`reports/` 汇报、`attachments/` 附件。

## 2. 分区：记忆互不干扰

```bash
mem partition add --name xiaofeiyu --title "小肥鱼记忆库" --desc "这个工具自身的决策与约束"
mem partition list
```

每个分区有自己的条目、召回事件、守卫事件、任务与汇报。`recall` 必须带 `--partition`，服务端也不存在跨分区召回入口——隔离是硬约束，不是约定。

## 3. 一次任务的完整流程

```bash
# 1) 开任务：写进库 + 自动种一条任务记忆 + 返回主干记忆与操作指令
mem task start --partition xiaofeiyu --title "检查召回质量"

# 2) 进场召回：默认 index 模式（正文只给 90 字），看完再决定要不要全文
mem recall "召回 质量 命中率" --partition xiaofeiyu --detail index
mem get m-xxxxxxxx            # 只有确实要用的条目才取全文

# 3) 干活中写结论（同内容自动去重），并回填反馈
mem remember --partition xiaofeiyu --title "结论" --body "..." --importance 3 --tags 召回,质量
mem feedback r-xxxxxxxx --used 1      # 真的用上了；没用上就 --used 0

# 4) 结束：自动写汇报文档到 data/reports/ 并登记
mem task end t-xxxxxxxx --summary "命中率 35%" --report-file report.md
```

**没有汇报文档就不算任务结束**——`task end` 会把 markdown 落盘、写入 `report` 表、并同时落一条 `kind=report` 的记忆，下次相同话题能召回它。

## 4. 记忆曲线与遗忘

`retention = exp(-Δt / stability)`，`stability` 以天为单位，两条增长信号：

- 被召回一次：`stability *= (1 + curve.readGrowth)`（默认 ×1.12）
- 被确认有用（feedback used=1）：`stability *= (1 + curve.stabilityGrowth)`（默认 ×1.6）；used=0 时 ×0.75

`mem sweep` 按保留率改状态：低于 `forgetThreshold`(0.25) → `dormant`（默认不召回），低于 `archiveThreshold`(0.02) → `archived`。**`pinned` 或 `importance >= trunkImportance`(4) 的主干永不休眠**，这是「只忘细节、保留主干」的机制。

## 5. 守卫与审查（防幻觉的两道闸）

```bash
mem guard --partition xiaofeiyu --tokens 150000
mem audit --partition xiaofeiyu
```

守卫分数 = 0.45×上下文压力 + 0.25×命中率 + 0.2×冗余读取 + 0.1×陈旧占比，再与硬阈值取严：

- `>= contextBlockTokens`(200000) → **block**：停止继续翻文件，只按 `trunk` 主干作答，把偏差写回记忆
- `>= contextWarnTokens`(120000) 或分数 `>= warnScore`(0.5) → **warn**：先做一次召回巩固再继续
- 否则 `ok`

每次检查都会落 `guard_event`，看板里能看到历史。「模型自检」默认关闭（需 endpoint + 环境变量 key），关着时纯本地启发式，不联网。

每条记录带 `source`：`real` 是干活时真跑的检查，`simulated` 是看板「模拟检查」跑出来的演练记录。两类混在一起会污染命中率统计，所以可以单独清掉模拟记录（见第 16 节）。

`mem audit` 的 findings 覆盖：过期条目（STALE_ITEMS）、分区膨胀、命中率过低、重复读取偏高、没有主干、任务长期未关、备份过期、附件缺描述（CAPTION_MISSING）。

## 6. 多重保险

1. **影子日志**：每次写入同步追加 `data/shadow/YYYY-MM-DD.jsonl`，纯文本可读。
2. **备份**：`mem backup` 拷贝主库并只保留 `backup.keep`(7) 份；看板可一键备份。
3. **完整性**：`mem integrity` 跑 `PRAGMA quick_check`，`/api/health` 每次都带。
4. **重建**：`mem rebuild` 从影子日志重放重建整库（缺列的老日志会补 null）。
5. **回收站**：条目默认软删除，`lifecycle.recycleDays`(30) 天内可 `mem restore`。
6. **汇报回收站**：见第 9 节。

## 7. 多模态：把图片变成可召回的一句话

```bash
mem attach m-xxxxxxxx --file shot.png --caption "报错弹窗写着 timeout 9000ms"
mem vision                                    # 看配置是否就绪
mem describe --id att-xxxxxxxx                 # 单张：调视觉模型写描述
mem caption --partition xiaofeiyu --limit 20   # 批量：只处理还没有描述的附件
mem caption status                             # 统计：总数/已描述/待描述
```

视觉描述默认关闭（`multimodal.vision.enabled=false`），要开：

```bash
mem config set multimodal.vision.enabled true
mem config set multimodal.vision.endpoint https://api.openai.com/v1/chat/completions
mem config set multimodal.vision.model gpt-4o-mini
# 然后设环境变量 MEMORY_VISION_API_KEY（或改 multimodal.vision.apiKeyEnv 指向别的变量）
```

图片字节永远不进上下文，只有描述参与检索与召回输出；批量描述逐条返回成功/失败，失败的按原样留着，重跑即重试。

## 8. 向量召回（多维向量 + ANN + DeepSeek 语义指纹）

三件事各管一段：

- **本地哈希向量**（默认，256 维，零 token、微秒级）：把正文 + 语义指纹投影成向量，`vector.vectorWeight`(0.6) 与关键词分加权融合。
- **sqlite-vec ANN**：装好 `sqlite-vec` 后自动加载，召回先取近邻（k = max(64, limit×10)）再并上主干与「还没有向量的条目」，保证既不漏主干也不饿死新条目。扩展加载失败只写错误、静默回落精确检索，`/api/vector/status` 的 `effective` 会如实标注。
- **DeepSeek 语义指纹**：DeepSeek 没有 embeddings 端点，所以用它生成「同义词/上位词/可能问法」的检索指纹（≤40 字），按原文 hash 缓存只算一次，再以 `vector.fpWeight`(1.5) 混进条目向量——换来「换个说法也能召回」。

```bash
mem vector                 # 覆盖 x/y、维度、权重、后端、指纹是否就绪
mem reindex [分区]          # 重算向量（按分区不影响其它分区）
mem enrich [分区] --limit 20 # 用 DeepSeek 生成指纹（需 DEEPSEEK_API_KEY）
```

## 9. 汇报文档：写、删、恢复、彻底清理

```bash
mem report --partition xiaofeiyu --title "标题" --summary "一句话" --file body.md
mem report list [--partition p] [--trash]     # 正常列表 / 回收站
mem report delete <reportId>                  # 软删除：文件移到 data/reports/.trash/
mem report restore <reportId>                 # 恢复到原路径
mem report purge [--days 30] [--id <id>]      # 彻底清理（只清已软删除的）
```

默认是软删除：库里打 `deleted_at`，文件进 `.trash/`，`lifecycle.recycleDays`(30) 天内可恢复；`purge` 才会真正删文件与行。

## 10. 导入导出

```bash
mem export --partition xiaofeiyu --out bundle.json
mem import --file bundle.json [--rename newname]
```

导入按内容 hash 去重，汇报会重新落盘成新文件，分区可用 `--rename` 改名。

导出默认全量；只要一部分时用 `--include`（逗号清单，可选项 `items,tasks,reports,events,guardEvents`）：

```bash
mem export --partition xiaofeiyu --include items,reports --out brief.json
mem export --partition xiaofeiyu --guard 1 --out with-guard.json   # 连守卫记录一起带走
```

看板的导出面板是同一回事：勾选哪几类就只导哪几类。

## 11. 参数微调

`mem config get` 看全部，`mem config set <key> <value>` 改（按合理区间夹紧），或直接在网页的参数面板改。常用项：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| curve.stabilityBaseDays | 7 | 新记忆初始稳定度（天） |
| curve.stabilityGrowth | 0.6 | 命中反馈的稳定度增长 |
| curve.readGrowth | 0.12 | 每次被召回的稳定度增长 |
| curve.forgetThreshold | 0.25 | 低于此保留率转休眠 |
| curve.archiveThreshold | 0.02 | 低于此保留率归档 |
| curve.trunkImportance | 4 | importance ≥ 该值视为主干，永不休眠 |
| recall.detail | index | 召回默认只给正文前 90 字 |
| recall.indexBodyChars | 90 | index 模式截断长度 |
| recall.topK | 8 | 默认返回条数 |
| recall.maxRepeatReads | 3 | 窗口期内重复读取上限 |
| recall.redundancyWindowMin | 30 | 重复读取判定窗口（分钟） |
| guard.contextWarnTokens | 120000 | 告警线 |
| guard.contextBlockTokens | 200000 | 拦截线 |
| guard.hitRateFloor | 0.25 | 命中率下限 |
| guard.warnScore / blockScore | 0.5 / 0.75 | 连续分数阈值 |
| lifecycle.recycleDays | 30 | 回收站保留天数 |
| backup.keep | 7 | 备份保留份数 |
| vector.enabled | true | 是否启用向量融合召回 |
| vector.dims | 256 | 本地哈希向量维度 |
| vector.vectorWeight | 0.6 | 向量分在融合里的权重 |
| vector.vectorFloor | 0.15 | 纯向量命中的余弦地板 |
| vector.fpWeight | 1.5 | 语义指纹混入条目向量的权重 |
| vector.backend | sqlite | sqlite / sqlite-vec / qdrant |
| vector.deepseek.enabled | false | 是否用 DeepSeek 生成检索指纹 |

## 12. 目录

```
src/db.mjs       模式、配置、影子日志、备份、重建
src/engine.mjs   条目、分词、召回打分、遗忘曲线、删除、附件
src/tasks.mjs    任务、汇报（含回收站）、导入导出、改配置
src/guard.mjs    守卫与审查
src/vector.mjs   向量、语义指纹、后端探测
src/vec-index.mjs sqlite-vec ANN 扩展接线
src/vision.mjs   多模态描述（单张 + 批量）
src/harness.mjs  DSH 历史会话扫描与导入（多帧 zstd）
src/server.mjs   HTTP API + 静态托管
src/cli.mjs      命令行
web/index.html   看板（单文件、离线）
data/            memory.db / shadow / backups / reports / attachments
```

## 13. 常见问题

- **召回「候选 0 条」**：先确认分区名对了、条目不是 `dormant`（加 `--dormant` 试试），再 `mem vector` 看覆盖率。
- **图片召回不到**：附件没有描述就等于不可检索，跑 `mem caption`；视觉未就绪时先配 endpoint/model/key。
- **DeepSeek 指纹没生效**：`mem vector` 里「DeepSeek 指纹」应显示就绪，否则是没有 `DEEPSEEK_API_KEY` 或 `vector.deepseek.enabled=false`。
- **后端显示 sqlite-bruteforce**：说明 `sqlite-vec` 扩展没加载成功，功能不受影响（只是走精确检索），`/api/vector/status` 的 `backend.error` 会有原因。
- **上下文太长被 block**：按守卫给的 `directive` 收尾，只按 `trunk` 作答，并把新结论写回记忆，别继续翻文件。

## 14. 看板里有什么

`node src/server.mjs --port 8788` 后打开 <http://127.0.0.1:8788/>：顶栏（完整性 / 守卫状态 / 分区切换）· 分区概览卡 · 记忆条目表（展开看正文、附件、历史）· 记忆曲线（SVG，含遗忘阈值虚线，点图例可隐藏序列）· 命中率趋势（30 天柱状图，点柱子筛当天事件）· 守卫（含「模拟检查」）· 审查 findings · 回收站（删除/恢复/彻底清理，带二次确认）· 参数微调 · 导入/导出 · 汇报文档（抽屉渲染 markdown，可删除/回收站/恢复/彻底清理）· 向量索引（覆盖率、维度、后端、DeepSeek 就绪）· 多模态（描述统计 + 批量描述按钮）· **检索与自检**（库内检索 + 摘要 + 体检 + 查重 + 归纳主干；行内「为什么」直接拆打分）。

界面截图见 `docs/screenshots/`。所有图表都是手写 SVG，没有 CDN、没有外部请求；15 秒自动刷新，也可手动刷新。

## 15. 检索与自检（8 个新函数）

召回（`recall`）解决的是「这次该看什么」，下面这几个解决「我记不清了 / 这条为什么 / 库健不健康」。

```bash
# 1) 全量翻找：只给片段，可排序分页（想起关键词但记不清内容）
mem search --partition xiaofeiyu "向量 指纹" --sort score --limit 5

# 2) 这段时间到底学了什么、用上什么、什么在冷掉（含每日桶，给汇报用）
mem digest --partition xiaofeiyu --days 7

# 3) 这条为什么被召回 / 为什么快忘了（打分逐项拆开 + 公式 + 最近 5 次召回）
mem explain <itemId> --query "向量 融合"

# 4) 结论↔依据做关联，支持多跳扩展（同分区硬校验，跨分区直接报错）
mem link --from <结论id> --to <依据id> --relation supports
mem links <结论id>          # 出边/入边
mem expand <结论id> --depth 2   # 沿着关联走两跳
mem unlink --from <a> --to <b>

# 5) 钉住/取消钉住（钉住的条目不参与休眠，也不会被遗忘曲线带走）
mem pin <itemId>          # 取消用 --off

# 6) 库体检：完整性、缺向量、附件文件丢失、悬空关联、影子日志与备份；只读，加 --fix 才做安全修复
mem health --partition xiaofeiyu
mem health --partition xiaofeiyu --fix

# 7) 查重：够了阈值才报，只给建议不会替你合并
mem dedupe --partition xiaofeiyu --threshold 0.9

# 8) 归纳主干：把一摊散记忆压成一条钉住的主干，旧主干自动被取代（可回滚）
mem summarize --partition xiaofeiyu --limit 12 --title "向量层主干"
```

对应 HTTP 接口见 `docs/API.md` 的「检索与自检」一节；看板的「检索与自检」板块是同一套东西的图形入口。

**什么时候用哪个**：想不起原文 → `search`；要写汇报/复盘 → `digest`；怀疑召回不准 → `explain`；
结论太多太散 → `summarize`；库里是不是坏了 → `health`；重复写了好几遍 → `dedupe`；
结论和依据要串起来 → `link`/`expand`；某条绝对不能丢 → `pin`。

## 16. 守卫记录：删除 / 恢复 / 清空模拟记录

守卫记录是审计流水，删错了要能回来，所以默认**软删除**（进回收站，可恢复），要彻底消失得显式 `--hard`。

```bash
mem guard list --partition xiaofeiyu --limit 20          # 默认只看未删除
mem guard list --source simulated                        # 只看模拟检查
mem guard list --deleted                                 # 只看回收站
mem guard delete <id>                                    # 软删一条（进回收站）
mem guard delete --ids a,b,c
mem guard clear                                          # 一键清空所有模拟记录（软删）
mem guard clear --hard                                   # 彻底清掉模拟记录
mem guard restore <id>                                   # 从回收站恢复
mem guard purge --days 30                                # 清掉 30 天前已软删的记录（默认 30 天）
```

看板「守卫」面板有同一套入口：来源/等级筛选、分页、行内「删除」、顶部「清空模拟记录」、右上「回收站」视图（恢复 / 彻底清理，均二次确认）。

## 17. 导入 DSH 历史会话（一项目一分区）

别的分区、别的项目里聊过的东西也能进记忆库：扫的是 DSH 自己的会话存档（`~/.dsh/sessions`），**先出清单，你确认了才写库**。

```bash
mem harness scan                 # 按项目分组列出会话（标题、时间、轮次、首条需求），✓ = 已导入
mem harness import --project xiaofeiyu --confirm     # 导入某个项目的全部未导入会话
mem harness import --sessions s-abc,s-def --confirm  # 只导指定几条
```

规则：

- **一个项目一个分区**，分区名 = 项目目录末段（同名分区直接复用，不新建）；分区 description 记 `harness:<cwd>` 做归属标记，同名不同路径会自动加 `-<hash6>` 后缀。
- 每条会话写成一条 `kind='note'` 的摘要记忆（会话 id、项目、时间、轮次、标题、首条需求、最后结论，原文进 body 截断），按内容 hash 去重，重复导入会 skip。
- 空会话（没有 user 也没有 assistant）默认跳过；`--force` 才会连已导入的也重写。
- 不带 `--confirm` 只预演：返回 `{dryRun:true, wouldImport, skipped, plan}`，一行都不写。

看板第 14 个板块「DSH 会话」就是它的图形界面：勾选项目/会话 → 预演 → 确认导入。

## 18. 批量操作与 Ctrl+K

```bash
mem item pin --ids a,b,c        # 也支持 unpin / delete / restore
```

看板里：条目表左侧有复选框（表头全选），选中后出现批量条（钉住 / 取消钉住 / 删除 / 恢复）；任意位置按 **Ctrl+K** 打开全局检索浮层，输入即搜当前分区，↑↓ 选、Enter 打开详情、Esc 关闭。
