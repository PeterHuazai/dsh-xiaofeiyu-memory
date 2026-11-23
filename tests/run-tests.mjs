import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'xfy-mem-tests-' + process.pid);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { openStore, backup, integrity, rebuildFromShadow, ShadowLog } = await import('../src/db.mjs');
const engine = await import('../src/engine.mjs');
const tasks = await import('../src/tasks.mjs');
const guard = await import('../src/guard.mjs');

const store = openStore({ root: TMP });
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 300) : ''));
  console.log('FAIL ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 300) : ''));
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }

// 1 分区隔离
engine.remember(store, { partition: 'p-alpha', title: 'alpha 的私有约定', body: '只属于 alpha', importance: 4, pinned: true });
engine.remember(store, { partition: 'p-beta', title: 'beta 的私有约定', body: '只属于 beta', importance: 4, pinned: true });
const ra = engine.recall(store, { partition: 'p-alpha', query: '私有约定', detail: 'full' });
const rb = engine.recall(store, { partition: 'p-beta', query: '私有约定', detail: 'full' });
eq(ra.items.length, 1, 'alpha 召回只返回 1 条');
ok(ra.items[0].title.indexOf('alpha') === 0, 'alpha 拿到自己的条目', ra.items[0].title);
ok(rb.items[0].title.indexOf('beta') === 0, 'beta 拿到自己的条目', rb.items[0].title);

// 2 去重
const d1 = engine.remember(store, { partition: 'p-alpha', title: '重复条目', body: '同一内容' });
const d2 = engine.remember(store, { partition: 'p-alpha', title: '重复条目', body: '同一内容' });
ok(d2.deduped === true && d1.item.id === d2.item.id, '同内容去重');

// 3 索引 vs 全文
const longBody = '这是一段很长的正文内容用来验证索引模式只会返回前若干字符而全文模式会整段返回。'.repeat(6);
const li = engine.remember(store, { partition: 'p-alpha', title: '长正文档', body: longBody, importance: 4, pinned: true });
const idx = engine.recall(store, { partition: 'p-alpha', query: '长正文档', detail: 'index', includeDormant: true });
const full = engine.recall(store, { partition: 'p-alpha', query: '长正文档', detail: 'full', includeDormant: true });
ok(idx.items[0].body.length <= 120 && idx.items[0].bodyTruncated === true, 'index 模式截断正文', idx.items[0].body.length);
ok(full.items[0].body.length === longBody.length, 'full 模式返回完整正文', full.items[0].body.length);
ok(idx.items[0].body.length < full.items[0].body.length, 'index 比 full 省 token');

// 4 遗忘曲线：老化条目保留率下降
const old = engine.remember(store, { partition: 'p-alpha', title: '很久以前的事', body: '早该忘了' });
store.db.prepare('UPDATE item SET last_access_at = ?, created_at = ? WHERE id = ?').run(Date.now() - 400 * 86400000, Date.now() - 400 * 86400000, old.item.id);
const oldRow = store.db.prepare('SELECT * FROM item WHERE id = ?').get(old.item.id);
const ret = engine.retentionOf(oldRow, Date.now(), store.config);
ok(ret < 0.05, '400 天未访问保留率极低', ret);

// 5 sweep：老条目变 dormant，主干不动
store.db.prepare('UPDATE item SET last_access_at = ? WHERE pinned = 0 AND importance < 4').run(Date.now() - 400 * 86400000);
const sw = engine.sweep(store);
const oldState = store.db.prepare('SELECT state FROM item WHERE id = ?').get(old.item.id).state;
ok(oldState === 'archived' || oldState === 'dormant', '低价值老条目被休眠/归档', oldState);
const pinnedState = store.db.prepare("SELECT state FROM item WHERE title = 'alpha 的私有约定'").get().state;
eq(pinnedState, 'active', 'pinned 主干不会被休眠');
const dormantRecall = engine.recall(store, { partition: 'p-alpha', query: '早该忘了', includeDormant: false });
ok(dormantRecall.items.filter(function (x) { return x.id === old.item.id; }).length === 0, '默认召回不返回休眠条目');

// 6 反馈提升稳定度
const f1 = engine.remember(store, { partition: 'p-alpha', title: '会被反复用到的结论', body: '关键结论', importance: 3 });
const before = store.db.prepare('SELECT stability FROM item WHERE id = ?').get(f1.item.id).stability;
const rr = engine.recall(store, { partition: 'p-alpha', query: '反复用到 结论', detail: 'full', includeDormant: true });
engine.feedback(store, { eventId: rr.eventId, used: true });
const after = store.db.prepare('SELECT stability, hit_count FROM item WHERE id = ?').get(f1.item.id);
ok(after.stability > before, '命中反馈提升稳定度', { before: before, after: after.stability });
eq(after.hit_count >= 1, true, '命中次数累加');

// 7 重复读取抑制
let redundantSeen = false;
for (let i = 0; i < 5; i++) {
  const r = engine.recall(store, { partition: 'p-alpha', query: '关键结论', detail: 'full', includeDormant: true });
  if (r.items.some(function (x) { return x.redundant && x.body === ''; })) redundantSeen = true;
}
ok(redundantSeen, '同一批条目重复读取会被抑制并省略正文');

// 8 删除 / 回收站 / 恢复 / 彻底删除
const del = engine.deleteItem(store, { id: f1.item.id, reason: '测试' });
eq(del.hard, false, '默认软删除');
const recycle = engine.listRecycle(store, null);
ok(recycle.some(function (x) { return x.id === f1.item.id; }), '回收站能看到');
const afterDel = engine.recall(store, { partition: 'p-alpha', query: '关键结论', detail: 'full', includeDormant: true });
ok(afterDel.items.every(function (x) { return x.id !== f1.item.id; }), '删除后不再被召回');
engine.restoreItem(store, f1.item.id);
ok(store.db.prepare('SELECT state FROM item WHERE id = ?').get(f1.item.id).state === 'active', '恢复回 active');
engine.deleteItem(store, { id: f1.item.id, hard: true });
ok(!store.db.prepare('SELECT id FROM item WHERE id = ?').get(f1.item.id), '彻底删除后库里没有');

// 9 附件
const imgPath = path.join(TMP, 'dot.png');
fs.writeFileSync(imgPath, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex'));
const holder = engine.remember(store, { partition: 'p-alpha', title: '带图的条目', body: '看图' });
const att = engine.attachToItem(store, { itemId: holder.item.id, path: imgPath, caption: '一个像素' });
ok(fs.existsSync(att.path), '附件文件已落盘', att.path);
eq(engine.listAttachments(store, holder.item.id).length, 1, '附件挂在条目上');
engine.setCaption(store, { id: att.id, caption: '改过的说明' });
eq(engine.attachmentById(store, att.id).caption, '改过的说明', '附件说明可改');

// 10 任务 + 汇报文档
const st = tasks.startTask(store, { partition: 'p-alpha', title: '自动化测试任务', goal: '验证任务开启自动写入' });
ok(st.task.id && st.seedItem, '任务开启返回 task 与种子条目');
const rep = tasks.writeReport(store, { partition: 'p-alpha', taskId: st.task.id, title: '测试汇报', summary: '做完了', markdown: '## 结论\n- ok' });
ok(fs.existsSync(rep.path) && fs.readFileSync(rep.path, 'utf8').indexOf('测试汇报') >= 0, '汇报文件写入磁盘并可读', rep.path);
const ended = tasks.endTask(store, { taskId: st.task.id, summary: '收尾', partition: 'p-alpha', markdown: '## 收尾\n完成' });
eq(ended.task.status, 'done', '任务结束状态');
ok(!!ended.report && ended.report.path, '任务结束自动写汇报');

// 11 守卫
const gWarn = guard.checkGuard(store, { partition: 'p-alpha', contextTokens: 190000 });
ok(['warn', 'block'].indexOf(gWarn.level) >= 0, '超大上下文触发告警/拦截', gWarn.level);
const gBlock = guard.checkGuard(store, { partition: 'p-alpha', contextTokens: 400000 });
eq(gBlock.level, 'block', '极端上下文触发 block');
ok(Array.isArray(gBlock.trunk) && gBlock.trunk.length > 0, 'block 时给出主干清单');
const gOk = guard.checkGuard(store, { partition: 'p-beta', contextTokens: 1000 });
ok(gOk.score >= 0 && gOk.score <= 1.5, '守卫分数在合理区间', gOk.score);
const au = guard.audit(store, {});
ok(Array.isArray(au.findings), '审查返回 findings 数组');

// 12 导出 / 导入
const bundle = tasks.exportBundle(store, { partition: 'p-alpha', withEvents: true });
ok(bundle.items.length > 0 && bundle.format === 'xiaofeiyu-memory-bundle', '导出包含条目');
const imp = tasks.importBundle(store, bundle, { renamePartition: 'p-alpha-copy' });
ok(imp.items > 0, '导入到新分区成功', imp);
const copied = engine.listPartitions(store).find(function (p) { return p.name === 'p-alpha-copy'; });
ok(!!copied, '新分区已创建');
const copyItems = engine.itemList(store, copied.id, { limit: 100 });
ok(copyItems.length > 0, '新分区有条目');
const again = tasks.importBundle(store, bundle, { renamePartition: 'p-alpha-copy' });
eq(again.items, 0, '重复导入不产生重复条目');

// 13 配置夹紧
const cfg = tasks.updateConfig(store, { curve: { forgetThreshold: 5 }, guard: { contextBlockTokens: 10 } });
ok(cfg.curve.forgetThreshold <= 0.95 && cfg.guard.contextBlockTokens >= cfg.guard.contextWarnTokens, '越界参数被夹紧', { forget: cfg.curve.forgetThreshold, block: cfg.guard.contextBlockTokens });
ok(fs.existsSync(path.join(store.paths.dataDir, 'config.json')), '配置落盘');

// 14 备份 + 完整性 + 影子日志重建
const bk = backup(store);
ok(fs.existsSync(bk.path), '备份文件存在', bk.path);
ok(integrity(store).ok, '数据库完整性检查通过');
const shadowEntries = store.shadow.readAll().length;
ok(shadowEntries > 0, '影子日志有记录', shadowEntries);
const itemCountBefore = store.db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
store.db.exec('DELETE FROM item');
const rb2 = rebuildFromShadow(TMP);
const itemCountAfter = store.db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
ok(itemCountAfter > 0 && Math.abs(itemCountAfter - itemCountBefore) <= 2, '影子日志可重建条目', { before: itemCountBefore, after: itemCountAfter, applied: rb2.applied });

// 15 中文分词 / 相关性
const toks = engine.tokenize('记忆曲线 retention');
ok(toks.indexOf('记忆') >= 0 && toks.indexOf('retention') >= 0, '中英混合分词', toks.slice(0, 8));

// 16 附件描述参与召回（图不塞上下文，描述就能命中）
const shotItem = engine.remember(store, { partition: 'p-beta', title: '带截图的界面问题', body: '看附件', importance: 4 });
const shotAtt = engine.attachToItem(store, { itemId: shotItem.item.id, path: imgPath, caption: '报错弹窗写着 timeout 9000ms' });
const capHit = engine.recall(store, { partition: 'p-beta', query: 'timeout 9000ms', detail: 'index', includeDormant: true });
ok(capHit.items.some(function (x) { return x.id === shotItem.item.id; }), '附件的文字描述能被召回命中');
engine.setCaption(store, { id: shotAtt.id, caption: '另一段描述' });

// 17 视觉描述默认关闭时给出可操作错误
const vision = await import('../src/vision.mjs');
const vs = vision.visionStatus(store);
ok(vs.enabled === false && vs.ready === false, '视觉描述默认关闭');
let visionErr = null;
try { await vision.describeImage(store, { attachmentId: shotAtt.id }); } catch (e) { visionErr = e.message; }
ok(!!visionErr && visionErr.indexOf('multimodal.vision.enabled') >= 0, '未开启时抛可操作错误', visionErr);

// 18 反馈返回影响条数
const fev = engine.recall(store, { partition: 'p-beta', query: '界面问题', includeDormant: true });
const fbk = engine.feedback(store, { eventId: fev.eventId, used: true });
ok(fbk.affected === fev.items.length, '反馈返回受影响条目数', { affected: fbk.affected, items: fev.items.length });

// 19 向量基础：归一化与余弦
const vector = await import('../src/vector.mjs');
const v1 = vector.embedLocal('记忆曲线 遗忘', 256);
const v2 = vector.embedLocal('记忆曲线 遗忘', 256);
const norm1 = Math.sqrt(v1.reduce(function (a, b) { return a + b * b; }, 0));
ok(Math.abs(norm1 - 1) < 1e-5, '向量已 L2 归一', norm1);
ok(Math.abs(vector.cosine(v1, v2) - 1) < 1e-6, '同文本余弦为 1');
const v3 = vector.embedLocal('紫微斗数 星曜 宫位', 256);
ok(vector.cosine(v1, v3) < 0.5, '不同主题余弦明显更低', vector.cosine(v1, v3));

// 20 惰性补齐：第一次召回才写向量，第二次复用缓存
engine.remember(store, { partition: 'p-vec', title: '排盘用天文历库算节气', body: '节气按 VSOP87 近似', importance: 4, pinned: true });
engine.recall(store, { partition: 'p-vec', query: '无所谓', detail: 'index', includeDormant: true });
const vecCount1 = store.db.prepare('SELECT COUNT(*) AS n FROM item_vector').get().n;
ok(vecCount1 >= 1, '召回时惰性写入向量', vecCount1);
engine.recall(store, { partition: 'p-vec', query: '无所谓', detail: 'index', includeDormant: true });
eq(store.db.prepare('SELECT COUNT(*) AS n FROM item_vector').get().n, vecCount1, '第二次召回复用向量缓存');

// 21 语义指纹：字面不重合也能被召回（DeepSeek 指纹落库后的效果）
const vecPart = store.db.prepare("SELECT id FROM partition WHERE name = 'p-vec'").get();
const vecItem = store.db.prepare('SELECT * FROM item WHERE partition_id = ?').get(vecPart.id);
const vecHash = vector.textHash(vector.indexText(store, vecItem));
store.db.prepare('INSERT OR REPLACE INTO semantic_cache (text_hash, model, text, created_at) VALUES (?, ?, ?, ?)').run(vecHash, 'deepseek-chat', '历法 历算 天文计算 节气 排盘', Date.now());
store.db.prepare('DELETE FROM item_vector WHERE item_id = ?').run(vecItem.id);
const semHit = engine.recall(store, { partition: 'p-vec', query: '历法计算', detail: 'index', includeDormant: true });
ok(semHit.items.some(function (x) { return x.id === vecItem.id; }), '语义指纹让字面不重合的条目被召回', semHit.items.map(function (x) { return [x.title, x.cos]; }));

// 22 权重归零退回纯词面，不靠向量误召
const savedWeight = store.config.vector.vectorWeight;
store.config.vector.vectorWeight = 0;
const plainHit = engine.recall(store, { partition: 'p-vec', query: '历法计算', detail: 'index', includeDormant: true });
store.config.vector.vectorWeight = savedWeight;
ok(!plainHit.items.some(function (x) { return x.id === vecItem.id; }), 'vectorWeight=0 时纯词面不误召');

// 23 后端探测与覆盖率
const ann = vector.annBackend(store);
ok(ann.effective === 'sqlite-bruteforce' || ann.effective === 'sqlite-vec', 'ANN 后端探测有确定值', ann);
const vstat = vector.vectorStatus(store);
ok(vstat.items >= 1 && vstat.covered >= 1, '向量状态能报覆盖率', { items: vstat.items, covered: vstat.covered });
// 24 汇报文档不重复头部（不带 markdown 时只写一份）
const plainRep = tasks.writeReport(store, { partition: 'p-vec', title: '只有摘要的汇报', summary: '一句话结论' });
const repText = fs.readFileSync(plainRep.path, 'utf8');
const headingCount = repText.split('\n').filter(function (l) { return l.indexOf('# ') === 0; }).length;
eq(headingCount, 1, '汇报只有一个标题头');
ok(repText.indexOf('一句话结论') > 0, '汇报正文含摘要');
// 25 按分区 reindex 不误删其它分区的向量
engine.remember(store, { partition: 'p-keep', title: '另一个分区的条目', body: '不该被删向量', importance: 3 });
await vector.reindex(store, { partitionId: null });
const keepPart = store.db.prepare("SELECT id FROM partition WHERE name = 'p-keep'").get();
const beforeVec = store.db.prepare('SELECT COUNT(*) AS n FROM item_vector WHERE partition_id = ?').get(keepPart.id).n;
await vector.reindex(store, { partitionId: vecPart.id });
const afterVec = store.db.prepare('SELECT COUNT(*) AS n FROM item_vector WHERE partition_id = ?').get(keepPart.id).n;
ok(beforeVec >= 1 && afterVec === beforeVec, '按分区重建不影响其它分区向量', { before: beforeVec, after: afterVec });

// 26 HTTP 静态托管：/ 必须直出 HTML 而不是 JSON 包着的 Buffer
const { spawn } = await import('node:child_process');
const net = await import('node:net');
fs.mkdirSync(path.join(TMP, 'web'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'web', 'index.html'), '<!DOCTYPE html><html><body>ok-fixture</body></html>', 'utf8');
const freePort = await new Promise(function (resolve) {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', function () { const pt = srv.address().port; srv.close(function () { resolve(pt); }); });
});
const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server.mjs'), '--port', String(freePort)], { env: Object.assign({}, process.env, { MEMORY_ROOT: TMP }), stdio: 'ignore' });
let served = null, servedType = '';
for (let i = 0; i < 40; i++) {
  await new Promise(function (r) { setTimeout(r, 150); });
  try {
    const res = await fetch('http://127.0.0.1:' + freePort + '/');
    servedType = String(res.headers.get('content-type') || '');
    served = await res.text();
    break;
  } catch (e) { served = null; }
}
try { child.kill(); } catch (e) {}
ok(!!served && served.indexOf('<!DOCTYPE html>') === 0, '根路径直出 HTML', served ? served.slice(0, 40) : 'no response');
ok(servedType.indexOf('text/html') === 0, '根路径 content-type 是 text/html', servedType);
// 27 CLI config set 支持 key value 空格写法（旧写法会写坏键名）
const { execFileSync } = await import('node:child_process');
execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'cli.mjs'), 'config', 'set', 'recall.topK', '9'], { env: Object.assign({}, process.env, { MEMORY_ROOT: TMP }), stdio: 'ignore' });
const cfgAfterCli = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'config.json'), 'utf8'));
eq(cfgAfterCli.recall.topK, 9, '空格写法写入正确键');
ok(!Object.prototype.hasOwnProperty.call(cfgAfterCli, '0'), '没有写出多余的数字键');
ok(!Object.prototype.hasOwnProperty.call(cfgAfterCli.recall, 'top'), '没有截断键名');
// 28 汇报软删除 / 恢复 / 彻底清理
const repPart = engine.ensurePartition(store, { name: 'p-rep', title: '汇报测试' });
const rep1 = tasks.writeReport(store, { partition: 'p-rep', title: '可删除的汇报', summary: '内容 A' });
ok(fs.existsSync(rep1.path), '汇报文件已落盘');
const repDel = tasks.deleteReport(store, { id: rep1.report.id });
ok(!fs.existsSync(rep1.path), '删除后原文件不在原位');
ok(fs.existsSync(repDel.trashPath), '文件进了回收站目录');
ok(tasks.listReports(store, { partitionId: repPart.id }).every(function (r) { return r.id !== rep1.report.id; }), '默认列表不含已删汇报');
ok(tasks.listReports(store, { trash: true, partitionId: repPart.id }).some(function (r) { return r.id === rep1.report.id; }), '回收站列表能看到该汇报');
const repBack = tasks.restoreReport(store, { id: rep1.report.id });
ok(fs.existsSync(repBack.report.path), '恢复后文件回到原位');
tasks.deleteReport(store, { id: rep1.report.id });
const repPurge = tasks.purgeReports(store, { id: rep1.report.id });
eq(repPurge.purged, 1, '彻底清理删掉一条汇报');
ok(!store.db.prepare('SELECT id FROM report WHERE id = ?').get(rep1.report.id), '库里已没有该汇报');

// 29 批量描述：本地 mock 的 OpenAI 兼容视觉接口，验证写回与召回
const http = await import('node:http');
const mockSrv = http.createServer(function (req, res) {
  let body = '';
  req.on('data', function (c) { body += c; });
  req.on('end', function () {
    const isVision = String(req.url || '').indexOf('vision') >= 0;
    const payload = isVision
      ? { choices: [{ message: { content: '看板截图，命中率趋势面板，柱状图' } }], usage: { total_tokens: 42 } }
      : { choices: [{ message: { content: '心情记录,日记,情绪,每日小结' } }], usage: { total_tokens: 21 } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
await new Promise(function (r) { mockSrv.listen(0, '127.0.0.1', r); });
const mockBase = 'http://127.0.0.1:' + mockSrv.address().port;
process.env.MEMORY_VISION_API_KEY = 'test-key';
tasks.updateConfig(store, { multimodal: { vision: { enabled: true, endpoint: mockBase + '/vision', model: 'mock-vision' } } });
const boardImg = path.join(TMP, 'board.png');
fs.writeFileSync(boardImg, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex'));
const boardItem = engine.remember(store, { partition: 'p-alpha', title: '看板截图存档', body: '一张图，没有文字' });
const boardAtt = engine.attachToItem(store, { itemId: boardItem.item.id, path: boardImg, caption: '' });
const boardSt = vision.captionStatus(store, { partitionId: store.db.prepare("SELECT id FROM partition WHERE name = 'p-alpha'").get().id });
ok(boardSt.missing >= 1 && boardSt.captioned >= 1, '描述统计区分已描述/待描述', { missing: boardSt.missing, captioned: boardSt.captioned });
const batch1 = await vision.batchCaption(store, { limit: 5 });
ok(batch1.done >= 1 && batch1.failed === 0, '批量描述逐条成功', { done: batch1.done, failed: batch1.failed });
const boardRow = store.db.prepare('SELECT caption FROM attachment WHERE id = ?').get(boardAtt.id);
ok(String(boardRow.caption).indexOf('命中率') >= 0, '描述写回附件');
const boardRecall = engine.recall(store, { partition: 'p-alpha', query: '命中率趋势 柱状图', detail: 'full' });
ok(boardRecall.items.some(function (x) { return x.id === boardItem.item.id; }), '描述文本参与召回');
const batch2 = await vision.batchCaption(store, { limit: 5 });
eq(batch2.processed, 0, '已有描述默认不再重复处理');

// 30 DeepSeek 语义指纹：mock /chat/completions，验证「同义改写也能召回」
process.env.DEEPSEEK_API_KEY = 'test-key';
tasks.updateConfig(store, { vector: { deepseek: { enabled: true, endpoint: mockBase + '/chat', model: 'mock-ds', apiKeyEnv: 'DEEPSEEK_API_KEY', maxItemsPerRun: 2 } } });
const dsItem = engine.remember(store, { partition: 'p-ds', title: '每日记录', body: '今天心里堵' });
const en = await vector.enrichSemantics(store, { limit: 1 });
ok(en.enriched >= 1, 'DeepSeek 指纹写入一条', { enriched: en.enriched, skipped: en.skipped });
const fpRow = store.db.prepare('SELECT text FROM semantic_cache WHERE text LIKE ?').get('%心情%');
ok(!!fpRow, '指纹内容来自模型返回');
const dsRecall = engine.recall(store, { partition: 'p-ds', query: '心情 日记', detail: 'full' });
ok(dsRecall.items.some(function (x) { return x.id === dsItem.item.id; }), '指纹让字面不重合的查询也能召回');
mockSrv.close();

// 31 新增工具函数：search / digest / explain / link / expand / pin / health / dedupe / summarize
const xfy = await import('../src/tools.mjs');
const t31 = engine.ensurePartition(store, { name: 'p-tools', title: '工具函数' });
const s1 = engine.remember(store, { partition: 'p-tools', title: '向量余弦参与打分', body: '召回打分里向量余弦占 vectorWeight，词面占 weightRelevance', kind: 'decision', importance: 4, tags: 'vector,recall' }).item;
const s2 = engine.remember(store, { partition: 'p-tools', title: '看板可以微调权重', body: 'vectorWeight 与 fpWeight 都能在看板里改', kind: 'fact', importance: 3 }).item;
const s3 = engine.remember(store, { partition: 'p-tools', title: '分区隔离是硬约束', body: '跨分区查询禁止', kind: 'constraint', importance: 5 }).item;

const sr = xfy.searchItems(store, { partition: 'p-tools', q: '向量 权重' });
ok(sr.total >= 2 && sr.items.some(function (x) { return x.id === s1.id; }), 'search 命中并给出片段', { total: sr.total });
ok(sr.items.every(function (x) { return typeof x.snippet === 'string' && !('body' in x); }), 'search 返回片段而不是整段正文（省 token）');
const srPage = xfy.searchItems(store, { partition: 'p-tools', q: '向量 权重', limit: 1, offset: 1 });
eq(srPage.items.length, 1, 'search 支持分页');
const srSort = xfy.searchItems(store, { partition: 'p-tools', sort: 'importance', limit: 1 });
eq(srSort.items[0].id, s3.id, 'search 可按重要度排序');
const srTags = xfy.searchItems(store, { partition: 'p-tools', tags: 'recall' });
ok(srTags.items.length === 1 && srTags.items[0].id === s1.id, 'search 支持标签过滤');

const dg = xfy.digest(store, { partition: 'p-tools', days: 30 });
ok(dg.items.created === 3 && dg.daily.length === 30, 'digest 统计新增与每日桶', { created: dg.items.created, daily: dg.daily.length });
ok(Array.isArray(dg.nearForget) && Array.isArray(dg.cooling) && Array.isArray(dg.hottest), 'digest 给出快忘/冷掉/最热三组');

engine.recall(store, { partition: 'p-tools', query: '向量 余弦', detail: 'full' });
const ex = xfy.explain(store, { id: s1.id, query: '向量 余弦' });
ok(ex.item.retention > 0 && ex.components && ex.components.score > 0, 'explain 复算出分数', ex.components && ex.components.score);
ok(typeof ex.formula === 'string' && ex.events.length >= 1, 'explain 给出公式与最近召回');
const exNoQuery = xfy.explain(store, { id: s1.id });
ok(exNoQuery.components === undefined && exNoQuery.item.stability > 0, 'explain 不带查询时只解释衰减');

const lk = xfy.link(store, { from: s1.id, to: s2.id, relation: 'detail-of' });
ok(lk.created === true, 'link 建立关联');
eq(xfy.link(store, { from: s1.id, to: s2.id, relation: 'detail-of' }).created, false, 'link 幂等不重复插入');
const lkCross = xfy.link.bind(null, store);
let crossErr = '';
try { lkCross({ from: s1.id, to: engine.remember(store, { partition: 'p-alpha', title: '别处的条目', body: '在另一个分区' }).item.id }); } catch (e) { crossErr = e.message; }
ok(crossErr.indexOf('分区不可混用') >= 0, 'link 拒绝跨分区连接', crossErr);
const lkView = xfy.links(store, { id: s1.id });
ok(lkView.out.length === 1 && lkView.back.length === 0, 'links 区分出边与入边');
const exp = xfy.expand(store, { id: s1.id, depth: 1 });
ok(exp.items.length === 1 && exp.items[0].id === s2.id && exp.items[0].hop === 1, 'expand 带出一跳邻居');
eq(xfy.unlink(store, { from: s1.id, to: s2.id }).removed, 1, 'unlink 删除关联');
eq(xfy.expand(store, { id: s1.id, depth: 2 }).items.length, 0, 'unlink 之后没有邻居');

const pin1 = xfy.setPinned(store, { id: s2.id });
ok(pin1.pinned === true, 'pin 钉住条目');
ok(xfy.setPinned(store, { id: s2.id, pinned: false }).pinned === false, 'pin 可取消');

const sm = xfy.summarize(store, { partition: 'p-tools', limit: 5 });
ok(sm.created === true && sm.item.kind === 'trunk' && sm.item.pinned === true, 'summarize 生成钉住的主干', { created: sm.created, kind: sm.item && sm.item.kind });
const trunkRow = store.db.prepare("SELECT * FROM item WHERE id = ?").get(sm.item.id);
ok(String(trunkRow.body).indexOf(sm.sources[0].title) >= 0, '主干正文包含被归纳的标题');
const sm2 = xfy.summarize(store, { partition: 'p-tools', limit: 5 });
ok(sm2.superseded.length >= 1 && sm2.superseded.indexOf(sm.item.id) >= 0, '第二次归纳取代旧主干');

const dd = xfy.dedupe(store, { partition: 'p-alpha', threshold: 0.3 });
ok(dd.scanned > 0 && Array.isArray(dd.pairs), 'dedupe 扫描并给建议', { scanned: dd.scanned, pairs: dd.pairs.length });

const hl = xfy.health(store, { partition: 'p-tools' });
ok(hl.level !== 'block' && hl.counts.items >= 4 && hl.integrity.ok, 'health 体检通过', { level: hl.level, items: hl.counts.items });
ok(!hl.findings.some(function (x) { return x.code === 'NO_TRUNK'; }), 'summarize 之后不再报 NO_TRUNK');
store.db.prepare('INSERT INTO item_link (id, partition_id, from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('l-broken', t31.id, 'm-missing', s1.id, 'ghost', Date.now());
const hlFix = xfy.health(store, { partition: 'p-tools', fix: true });
ok(hlFix.fixed >= 1 && !hlFix.findings.some(function (x) { return x.code === 'DANGLING_LINKS'; }), 'health --fix 清掉悬空关联', hlFix.fixed);

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
// Windows 上数据库句柄未关时删不掉临时目录
if (typeof store.close === 'function') store.close();
else store.db.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.log('临时目录清理跳过: ' + e.code); }