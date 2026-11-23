# 小肥鱼记忆库 · HTTP API（v1，冻结）

Base: http://127.0.0.1:8787   全部返回 JSON（除静态文件与附件二进制）。

## 读

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | {ok, service, version, root, integrity:{ok,detail}, shadow:{files,bytes}, now} |
| GET | /api/state?partition=<slug> | 看板一次性拉取：见下 state 结构 |
| GET | /api/overview | {generatedAt, config, partitions[], totals, hit24h, storage, curve} |
| GET | /api/config | 完整配置对象 |
| GET | /api/partitions | {partitions:[{id,name,title,description,created_at,archived}]} |
| GET | /api/items?partition=&limit=&includeArchived= | {items:[item]} |
| GET | /api/item?id=&days= | item + retention + attachments + curve + events |
| GET | /api/curve?id=&days= | {item, stability, points:[{day,retention}]} |
| GET | /api/timeline?partition=&days=30 | {points:[{day,ts,recalls,hits}]} |
| GET | /api/events?partition=&limit= | {events:[recall_event]} |
| GET | /api/guard/events?partition=&level=&source=&deleted=1&includeDeleted=1&limit=40&offset=0 | {events:[guard_event], total, limit, offset, bySource:{simulated,real}}；默认只列未删除；`deleted=1` 只看回收站 |
| GET | /api/audit?partition=&hours= | {generatedAt, findings:[{severity,partition,code,message,suggestion}], severity} |
| GET | /api/recycle?partition= | {items:[item + expiresAt/expired]} |
| GET | /api/reports?partition=&trash=1 | {reports:[...]}；`trash=1` 只返回回收站里的汇报（带 inTrash/expiresAt/expired） |
| GET | /api/caption/status?partition= | {vision:{enabled,ready,hint,model,apiKeyEnv,apiKeyPresent}, total, captioned, missing, pending[]} |
| GET | /api/report?path= | {path, markdown} (仅允许 data/reports 下文件) |
| GET | /api/attachment?id= | 原始图片字节 |
| GET | /api/export?partition=&withEvents=1&withGuardEvents=0&withConfig=0&include=items,tasks,reports,events,guardEvents | bundle JSON（`include` 逗号清单控制范围，空数组表示未导出） |
| GET | /api/harness/scan?root= | {root, exists, projects:[{dir,cwd,name,partition,sessionCount,importedCount,sessions[{id,title,createdAt,updatedAt,firstUser,lastAssistant,turns,toolCalls,bytes,empty,imported,file}]}], totals:{projects,sessions,imported}} |
| GET | /api/vector/status | {enabled,dims,model,items,covered,vectorWeight,vectorFloor,fpWeight,backend:{configured,sqliteVecAvailable,effective,extensionPath,extensionVersion,indexDims,indexed,error},provider{...},deepseek{enabled,model,apiKeyPresent,ready}} |

### state 结构（看板主数据源）
```
{ overview, activePartition, items[], timeline[], recallEvents[], guardEvents[],
  recycle[], reports[], tasks[], audit, backups[], integrity, now }
```

### item 字段
id, partition_id, kind, title, body, tags[], importance, pinned, state(active|dormant|archived|deleted),
stability, created_at, updated_at, last_access_at, access_count, hit_count, redundant_reads,
content_hash, source, task_id, superseded_by, deleted_at, delete_reason, retention

### recall_event
id, partition_id, task_id, session_id, query, ts, returned, used(null|0|1), top_score, items(JSON 字符串), redundant, latency_ms

### guard_event
id, partition_id, task_id, ts, level(info|ok|warn|block), score, reasons(JSON 字符串数组), context_tokens, action, model_verdict, source(real|simulated), deleted_at(空=未删)

## 写

| 方法 | 路径 | body |
| --- | --- | --- |
| POST | /api/remember | {partition, title, body, kind, tags, importance, pinned, taskId} |
| POST | /api/recall | {partition, query, limit, detail:'index'|'full'|'auto', includeDormant, taskId} |
| POST | /api/feedback | {eventId, used:true|false} |
| POST | /api/delete | {id, hard:false, reason} |
| POST | /api/restore | {id} |
| POST | /api/purge | {olderThanDays?, id?} |
| POST | /api/attach | {itemId, path, caption, mime, width, height} |
| POST | /api/attach/caption | {id, caption} |
| GET | /api/vision | 视觉描述是否就绪（enabled / endpoint / model / apiKeyPresent / ready） |
| POST | /api/report/delete | {id\|path} → {report, trashPath, fileMoved, restoreUntil}（文件移到 data/reports/.trash/，可恢复） |
| POST | /api/report/restore | {id\|path} → {report, fileRestored, fileExists} |
| POST | /api/report/purge | {id\|path\|olderThanDays} → {purged, filesRemoved, olderThanDays} |
| POST | /api/caption/batch | {partition?,limit?,includeCaptioned?} → {total,processed,done,failed,remaining,results:[{attachmentId,itemId,ok,caption?,error?}]}；只处理没有描述的附件，失败项重跑即重试 |
| POST | /api/attach/describe | {attachmentId} 或 {path} → {caption, model, tokens}；未开启时 500 + 可操作错误文案 |
| POST | /api/attach/delete | {id, hard} |
| POST | /api/vector/reindex | {partition?, provider?} → {model, items, dims, partitionId} |
| POST | /api/vector/enrich | {partition?, limit?} → {model, scanned, enriched, skipped, tokens, items[]}；未开启返回 500 + 可操作错误 |
| POST | /api/sweep | {} → {scanned, changed[]} |
| POST | /api/backup | {} |
| POST | /api/guard/check | {partition, contextTokens|chars, taskId} → 见下 |
| POST | /api/guard/model-check | {id} |
| POST | /api/guard/delete | {id} \| {ids:[]} \| {onlySimulated:true} \| {all:true}，可加 {hard:true} → {deleted,hard,ids,simulated}（默认软删，可 restore） |
| POST | /api/guard/restore | {id} \| {ids:[]} → {restored,ids} |
| POST | /api/guard/purge | {olderThanDays:30} → {purged,olderThanDays,cutoff} |
| POST | /api/harness/import | {project} \| {sessions:[id..]}，`confirmed:true` 才写库；不带时只返回 {dryRun:true, wouldImport, skipped, plan} |
| POST | /api/item/pin | {id, pinned} → item |
| POST | /api/item/batch | {action:'pin'\|'unpin'\|'delete'\|'restore', ids:[]} → {action,total,ok,results:[{id,ok,error?}]} |
| POST | /api/task/start | {partition, title, goal, contextTokens} |
| POST | /api/task/log | {taskId, note, tokens} |
| POST | /api/task/end | {taskId, summary, markdown, partition} |
| POST | /api/task/report | {partition, taskId, title, summary, markdown} |
| POST | /api/import | {bundle:{format:'xiaofeiyu-memory-bundle',...}} |
| PUT | /api/config | 部分配置对象（深合并，越界自动夹紧） |

### guard/check 返回
```
{ id, partition, source:'real'|'simulated', level:'ok'|'warn'|'block', score, components:{context,hitRate,lowHit,redundancy,stale},
  metrics:{estTokens,events,hits,redundantEvents}, reasons[], action:'continue'|'consolidate'|'hard-stop',
  directive, trunk:[{id,title,kind,importance,retention}], thresholds:{warn,block} }
```

## 检索与自检（src/tools.mjs）

| 方法 | 路径 | 参数 | 返回要点 |
| --- | --- | --- | --- |
| GET | /api/search | partition, q, tags, state, kind, sort, limit, offset | {partition,q,tags,sort,total,offset,limit,items[{id,title,snippet,kind,importance,state,retention,tags,updated_at}]}；sort ∈ score|recent|oldest|importance|retention|hits |
| GET | /api/digest | partition, days | {days, partition, items:{created,updated,states}, recall:{events,returned,judged,hits,hitRate}, guards, tasks, reports, nearForget[], cooling[], hottest[], daily[{day,created,recalls,hits}]} |
| GET | /api/explain | id, query? | {item, retention, stability, ageDays, daysUntilForget, components:{relevance,cos,blended,retentionFactor,importanceFactor,pinnedBoost,score,passesMinScore}, formula, events[]} |
| GET | /api/links | id | {out:[{id,relation,item}], back:[{id,relation,item}]} |
| GET | /api/expand | id, depth? (≤3) | {root, nodes[], edges[]} 多跳扩展 |
| GET | /api/dedupe | partition, threshold? (默认 0.92) | {threshold, groups[{items[],why,similarity}]}，只给建议不自动合并 |
| GET | /api/selfcheck | partition?, fix? | {level, findings[{code,severity,detail,hint}], fixes?, integrity, shadow, backups}；fix=1 只做补向量与删悬空关联 |
| POST | /api/link | {from, to, relation?} | {created:boolean, link}；跨分区直接 500「分区不可混用」 |
| POST | /api/unlink | {from, to, relation?} | {removed:n} |
| POST | /api/pin | {id, pinned:true|false} | {id, pinned, state} |
| POST | /api/summarize | {partition, limit?, title?, taskId?} | {created:boolean, item(kind='trunk', pinned=1), sources:n}；旧主干被 superseded_by 取代 |

## 配置键（可微调，网页里要能改）
curve.stabilityBaseDays / stabilityGrowth / readGrowth / forgetThreshold / archiveThreshold / trunkImportance / displayDays
recall.detail(index|full|auto) / indexBodyChars / topK / minScore / redundancyWindowMin / maxRepeatReads
guard.contextWarnTokens / contextBlockTokens / hitRateFloor / hitRateWindow / staleShareCeiling / warnScore / blockScore / weights.{context,hitRate,redundancy,stale}
lifecycle.recycleDays
vector.enabled / dims / vectorWeight / vectorFloor / fpWeight / backend(sqlite|sqlite-vec|qdrant)
vector.provider.{enabled,endpoint,model,apiKeyEnv,batchSize,timeoutMs} / vector.deepseek.{enabled,endpoint,model,apiKeyEnv,timeoutMs,maxItemsPerRun}
server.port
