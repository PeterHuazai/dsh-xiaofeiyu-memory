import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const TMP = path.join(os.tmpdir(), 'xfy-mem-tests-' + process.pid);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { openStore, backup, integrity, rebuildFromShadow, ShadowLog } = await import('../src/db.mjs');
const engine = await import('../src/engine.mjs');
const tasks = await import('../src/tasks.mjs');
const guard = await import('../src/guard.mjs');
const harness = await import('../src/harness.mjs');

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
backup(store);
const hlStore = xfy.health(store, {});
ok(hlStore.counts.backups >= 1 && hlStore.storage.backupAgeHours !== null, 'health 数得到 backups（路径用 store.backupDir）', { backups: hlStore.counts.backups, age: hlStore.storage.backupAgeHours });
ok(hlStore.storage.shadowBytes > 0, 'health 数得到影子日志字节数（路径用 store.shadowDir）', hlStore.storage.shadowBytes);

// 31 守卫记录：source 区分 + 软删 / 恢复 / 清空模拟
const gPartId = engine.partitionByName(store, 'p-tools').id;
const gSim = guard.checkGuard(store, { partition: 'p-tools', contextTokens: 180000, source: 'simulated' });
const gReal = guard.checkGuard(store, { partition: 'p-tools', contextTokens: 180000 });
ok(gSim.source === 'simulated' && gReal.source === 'real', '守卫记录区分模拟与真实来源', { sim: gSim.source, real: gReal.source });
const glSim = guard.listGuardEvents(store, { partitionId: gPartId, source: 'simulated' });
ok(glSim.total === 1 && glSim.bySource.simulated === 1, 'listGuardEvents 能按来源筛选', { total: glSim.total, by: glSim.bySource });
const gClear = guard.deleteGuardEvents(store, { onlySimulated: true });
ok(gClear.deleted === 1 && gClear.simulated === 1 && gClear.hard === false, '清空模拟记录走软删', gClear);
const glAfter = guard.listGuardEvents(store, { partitionId: gPartId });
ok(!glAfter.events.some(function (e) { return e.id === gSim.id; }), '软删后默认列表不再出现该记录');
const glTrash = guard.listGuardEvents(store, { partitionId: gPartId, deleted: true });
ok(glTrash.events.some(function (e) { return e.id === gSim.id && e.deleted === true; }), '回收视图能看到软删记录');
const gBack = guard.restoreGuardEvents(store, { id: gSim.id });
ok(gBack.restored === 1, '恢复软删的守卫记录', gBack);
guard.deleteGuardEvents(store, { id: gSim.id });
const gPurge = guard.purgeGuardEvents(store, { olderThanDays: 0 });
ok(gPurge.purged >= 1, '彻底清理超期软删记录', gPurge);
const gGone = store.db.prepare('SELECT id FROM guard_event WHERE id = ?').get(gSim.id);
ok(!gGone, 'purge 之后库里没有该记录');
eq(guard.listGuardEvents(store, { partitionId: gPartId }).bySource.real >= 1, true, '真实记录不受模拟清理影响');

// 32 硬删墓碑能挡住影子日志重建
const TMP2 = path.join(os.tmpdir(), 'xfy-mem-rebuild-' + process.pid);
fs.rmSync(TMP2, { recursive: true, force: true });
fs.mkdirSync(TMP2, { recursive: true });
const store2 = openStore({ root: TMP2 });
guard.checkGuard(store2, { partition: 'rb', contextTokens: 1000 });
const keepId = guard.checkGuard(store2, { partition: 'rb', contextTokens: 2000 }).id;
const killId = guard.checkGuard(store2, { partition: 'rb', contextTokens: 3000 }).id;
guard.deleteGuardEvents(store2, { id: killId, hard: true });
store2.close();
const rbLog = rebuildFromShadow(TMP2);
const store2b = openStore({ root: TMP2 });
const left = store2b.db.prepare('SELECT id FROM guard_event ORDER BY ts ASC').all().map(function (r) { return r.id; });
ok(left.indexOf(killId) < 0 && left.indexOf(keepId) >= 0, '影子日志重建尊重硬删墓碑', { left: left, killId: killId, applied: rbLog.applied });
store2b.close();
try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (e) { }

// 33 DSH 会话多帧 zstd：扫描 + 预演 + 确认导入
const HS = path.join(TMP, 'hsess');
const hDir = path.join(HS, '--G-demo-proj--', 'session-h1');
fs.mkdirSync(hDir, { recursive: true });
const ev = [
  { type: 'session', id: 'session-h1', version: 4, cwd: 'G:\\demo\\proj', createdAt: 1700000000000 },
  { type: 'session/title', seq: 1, time: 1700000001000, data: { title: '# 任务：把鱼缸做出来' } },
  { type: 'user/message', seq: 2, time: 1700000002000, data: { content: [{ type: 'text', text: '把鱼缸做成能喂的' }] } },
  { type: 'assistant/message', seq: 3, time: 1700000003000, data: { message: { content: [{ type: 'text', text: '鱼缸做好了，5 条鱼都能喂' }] } } }
];
const line1 = JSON.stringify(ev[0]) + '\n' + JSON.stringify(ev[1]) + '\n';
const line2 = JSON.stringify(ev[2]) + '\n' + JSON.stringify(ev[3]) + '\n';
const z1 = zlib.zstdCompressSync(Buffer.from(line1, 'utf8'));
const z2 = zlib.zstdCompressSync(Buffer.from(line2, 'utf8'));
fs.writeFileSync(path.join(hDir, 'session.v4.jsonl.zstd'), Buffer.concat([z1, z2]));
const decoded = harness.decodeZstdFrames(fs.readFileSync(path.join(hDir, 'session.v4.jsonl.zstd')));
ok(decoded.indexOf('把鱼缸做成能喂的') >= 0 && decoded.indexOf('5 条鱼都能喂') >= 0, '多帧 zstd 全部解出（不止第一帧）');
const scan = harness.scanHarness(store, { root: HS });
ok(scan.totals.sessions === 1 && scan.projects[0].sessionCount === 1, '扫描出 1 个项目 1 个会话', scan.totals);
const hs0 = scan.projects[0].sessions[0];
ok(hs0.title.indexOf('鱼缸') >= 0 && hs0.events === 4, '会话标题与事件数可用', { title: hs0.title, events: hs0.events });
const dryImport = harness.importHarness(store, { root: HS, sessions: ['session-h1'] });
ok(dryImport.dryRun === true && dryImport.wouldImport === 1, '未确认时只预演不写库', dryImport);
eq(store.db.prepare("SELECT COUNT(*) AS n FROM item WHERE source = 'harness:session-h1'").get().n, 0, '预演没有写入记忆');
const realImport = harness.importHarness(store, { root: HS, sessions: ['session-h1'], confirmed: true });
ok(realImport.dryRun === false && realImport.imported === 1, '确认后写入 1 条会话记忆', realImport);
const hItem = store.db.prepare("SELECT * FROM item WHERE source = 'harness:session-h1'").get();
ok(!!hItem && String(hItem.body).indexOf('把鱼缸做成能喂的') >= 0, '会话记忆正文含首条需求', hItem && String(hItem.body).slice(0, 60));
const againImport = harness.importHarness(store, { root: HS, sessions: ['session-h1'], confirmed: true });
ok(againImport.imported === 0 && againImport.skipped === 1, '重复导入被跳过', againImport);

// 34 导出范围可选
tasks.writeReport(store, { partition: 'p-tools', title: '导出范围测试汇报', summary: '一句话结果' });
const onlyReports = tasks.exportBundle(store, { partition: 'p-tools', include: ['reports'] });
ok(onlyReports.items.length === 0 && onlyReports.reports.length >= 1, 'include 只要汇报时条目不导出', { items: onlyReports.items.length, reports: onlyReports.reports.length });
const withGuards = tasks.exportBundle(store, { partition: 'p-tools', withGuardEvents: true });
ok(Array.isArray(withGuards.guardEvents) && withGuards.guardEvents.length >= 1, 'withGuardEvents 导出守卫记录', withGuards.guardEvents.length);
ok(Array.isArray(withGuards.guardEvents[0].reasons), '守卫记录 reasons 已解析成数组');

// 35 自适应曲线：FSRS 复习 + 主干强化 + 曲线地板
const adp2 = engine.ensurePartition(store, { name: 'p-adaptive', title: '自适应曲线' });
const plain = engine.remember(store, { partition: 'p-adaptive', title: '普通条目：接口约定', body: '接口一律返回 json', importance: 2 }).item;
const trunkSeed = engine.remember(store, { partition: 'p-adaptive', title: '主干条目：架构决定', body: '存储用 sqlite + 影子日志', importance: 5, pinned: true }).item;
const rBefore = engine.retentionOf(store.db.prepare('SELECT * FROM item WHERE id = ?').get(trunkSeed.id), Date.now() + 400 * 86400000, store.config);
const rPlain = engine.retentionOf(store.db.prepare('SELECT * FROM item WHERE id = ?').get(plain.id), Date.now() + 400 * 86400000, store.config);
ok(rBefore > 0.5 && rPlain < 0.01, '主干有留存地板、普通条目纯指数衰减', { trunk: rBefore, plain: rPlain });
const rec = engine.recall(store, { partition: 'p-adaptive', query: '接口约定', detail: 'full' });
const fbUsed = engine.feedback(store, { eventId: rec.eventId, used: 1 });
ok(fbUsed.affected === 1, 'feedback 命中后影响 1 条', fbUsed);
const afterUsed = store.db.prepare('SELECT * FROM item WHERE id = ?').get(plain.id);
ok(Number(afterUsed.reviews) >= 1 && Number(afterUsed.hit_count) >= 1, '命中累加 reviews/hit_count', { reviews: afterUsed.reviews, hits: afterUsed.hit_count });
ok(Number(afterUsed.difficulty) < 5, '命中让难度下降（FSRS）', afterUsed.difficulty);
const rein = engine.reinforce(store, { id: trunkSeed.id, strength: 1.5 });
ok(rein.after.boost > 1 && rein.after.stability > rein.before.stability, '强化同时抬稳定度与强化系数', { before: rein.before, after: rein.after });
const fc = engine.projectCurve(store.db.prepare('SELECT * FROM item WHERE id = ?').get(trunkSeed.id), store.config, 90);
ok(fc.trunk === true && fc.points.length > 10 && fc.points[fc.points.length - 1].retention >= fc.floor - 0.001, '预测曲线不跌破主干地板', { last: fc.points[fc.points.length - 1], floor: fc.floor });
const trunkList = engine.trunkSnapshot(store, adp2.id);
ok(trunkList.length === 1 && trunkList[0].id === trunkSeed.id, '主干快照只列主干', trunkList.map(function (x) { return x.id; }));

// 36 相近合并：默认预演、apply 后成员归档并挂 superseded_by
engine.remember(store, { partition: 'p-adaptive', title: '合并候选：看板截图归档位置', body: '截图放 docs/screenshots', importance: 3 });
engine.remember(store, { partition: 'p-adaptive', title: '合并候选：看板截图归档位置说明', body: '截图放 docs/screenshots 目录下', importance: 3 });
const mgDry = engine.mergeSimilar(store, { partitionId: adp2.id, threshold: 0.5 });
ok(mgDry.dryRun === true && mgDry.groups.length >= 1, '默认只预演', { groups: mgDry.groups.length });
const grp = mgDry.groups[0];
ok(grp.members.length >= 1 && grp.members[0].score !== null, '组内成员带相似度分数', grp.members);
const mgApply = engine.mergeSimilar(store, { partitionId: adp2.id, threshold: 0.5, apply: true });
ok(mgApply.merged >= 1, 'apply 真的合并了成员', mgApply.merged);
const mergedRow = store.db.prepare('SELECT * FROM item WHERE id = ?').get(grp.members[0].id);
ok(mergedRow.state === 'archived' && mergedRow.superseded_by === grp.keeper.id, '被并入的条目归档并指向保留者', { state: mergedRow.state, sup: mergedRow.superseded_by });

// 37 收尾归档主干 + 检索评测 + 健康日报 + 静态站点
const archTask = tasks.startTask(store, { partition: 'p-adaptive', title: '归档主干测试' });
const ended2 = tasks.endTask(store, { id: archTask.task.id, summary: '做完一件事', markdown: '## 做了什么\n- 验证收尾闭环' });
ok(!!ended2.trunk && ended2.trunk.consolidated >= 1, 'endTask 自动归档主干', ended2.trunk);
ok(!!ended2.swept && Array.isArray(ended2.swept.changed), 'endTask 顺带 sweep', ended2.swept && ended2.swept.changed);
const trunkRow2 = store.db.prepare("SELECT * FROM item WHERE partition_id = ? AND kind = 'trunk'").get(adp2.id);
ok(!!trunkRow2 && String(trunkRow2.body).indexOf('归档主干测试') >= 0, '主干条目里写进了这次收尾', trunkRow2 && String(trunkRow2.body).slice(0, 80));
const evr = engine.evalRetrieval(store, { partitionId: adp2.id, topK: 3 });
ok(evr.variants.length === 3 && evr.variants.every(function (v) { return typeof v.mrr === 'number'; }), '评测返回三种变体与 MRR', evr.variants.map(function (v) { return v.name; }));
const daily = tasks.healthReport(store, { partition: 'p-adaptive', dir: TMP });
ok(daily.markdown.indexOf('记忆健康日报') >= 0 && daily.markdown.indexOf('## p-adaptive') >= 0, '健康日报含分区小节', daily.markdown.slice(0, 80));
ok(!!daily.path && fs.existsSync(daily.path), '健康日报落盘成 markdown 文件', daily.path);
const site = tasks.exportSite(store, { partition: 'p-adaptive', dir: path.join(TMP, 'site') });
ok(fs.existsSync(path.join(site.dir, 'index.html')) && site.files.length >= 2, '静态站点导出 index.html + 分区 md', site.files);
const siteHtml = fs.readFileSync(path.join(site.dir, 'index.html'), 'utf8');
ok(siteHtml.indexOf('<table>') >= 0 && siteHtml.indexOf('p-adaptive') >= 0, '站点 html 含分区与条目表');

// 38 v0.2 三层记忆：layerOf / trunkDigest / token 预算 / consolidate
const lp = engine.ensurePartition(store, { name: 'p-v02', title: 'v0.2 测试' });
const lTrunk = engine.remember(store, { partition: 'p-v02', title: '主干结论', body: '这个项目的主干结论', kind: 'trunk' });
const lScene = engine.remember(store, { partition: 'p-v02', title: '汇报：一次收尾', body: '这次做了什么', kind: 'report' });
const lTask = engine.remember(store, { partition: 'p-v02', title: '任务开启：写代码', body: '任务脚手架', kind: 'task' });
const lPin = engine.remember(store, { partition: 'p-v02', title: '钉住的小事', body: '虽然不重要但钉住了', importance: 2, pinned: true });
const lHi = engine.remember(store, { partition: 'p-v02', title: '高重要度', body: '重要度 5', importance: 5 });
const lDetail = engine.remember(store, { partition: 'p-v02', title: '琐碎细节', body: '一个细节', importance: 2 });
function layerByTitle(t) {
  const row = store.db.prepare("SELECT * FROM item WHERE partition_id = ? AND title = ?").get(lp.id, t);
  return engine.layerOf(row, store.config);
}
eq(layerByTitle('主干结论'), 'trunk', 'kind=trunk 归到主干层');
eq(layerByTitle('汇报：一次收尾'), 'scene', '汇报归到场景层');
eq(layerByTitle('任务开启：写代码'), 'scene', '任务脚手架归到场景层而不是主干');
eq(layerByTitle('钉住的小事'), 'trunk', 'pinned 归到主干层');
eq(layerByTitle('高重要度'), 'trunk', 'importance>=trunkImportance 归到主干层');
eq(layerByTitle('琐碎细节'), 'detail', '普通条目归到细节层');
const digest = engine.trunkDigest(store, { partition: 'p-v02', maxTokens: 400 });
ok(digest.text.indexOf('主干结论') >= 0, '主干摘要含主干条目', digest.text.slice(0, 60));
ok(digest.text.indexOf('任务开启：写代码') < 0, '主干摘要不掺任务脚手架（噪声）');
ok(digest.tokens > 0 && digest.tokens <= digest.budget, '摘要按 token 预算收口', { tokens: digest.tokens, budget: digest.budget });
ok(digest.layerCounts.trunk >= 3 && digest.layerCounts.detail >= 1, '摘要回报三层计数', digest.layerCounts);
const tight = engine.trunkDigest(store, { partition: 'p-v02', maxTokens: 80 });
ok(tight.tokens <= 80, '小预算下摘要不超标', tight);
const longOne = engine.remember(store, { partition: 'p-v02', title: '长正文条目甲', body: '这是一段用来撑爆预算的长正文。'.repeat(20), importance: 4 });
const longTwo = engine.remember(store, { partition: 'p-v02', title: '长正文条目乙', body: '另一段同样很长的正文内容。'.repeat(20), importance: 4 });
const budgetRecall = engine.recall(store, { partition: 'p-v02', query: '长正文 条目 结论 细节 重要度', detail: 'full', limit: 8, budget: 20 });
ok(budgetRecall.totalTokens <= 20, 'recall 硬预算生效', { total: budgetRecall.totalTokens, budget: budgetRecall.budgetTokens });
ok(budgetRecall.budgetDropped > 0, '超预算的条目被丢弃而不是硬塞', { dropped: budgetRecall.budgetDropped, downgraded: budgetRecall.budgetDowngraded, items: budgetRecall.items.length });
ok(budgetRecall.items.every(function (it) { return typeof it.layer === 'string' && typeof it.tokens === 'number'; }), '召回结果带回 layer 与 tokens');
const cons = engine.consolidate(store, { partition: 'p-v02', title: 'v0.2 收尾', summary: '做完了三层与预算', taskId: 't-fake-v02' });
ok(cons.trunk.consolidated >= 1, 'consolidate 把结论并进主干', cons.trunk);
const sceneRows = store.db.prepare("SELECT * FROM item WHERE partition_id = ? AND kind = 'scene'").all(lp.id);
ok(sceneRows.length === 1 && String(sceneRows[0].title).indexOf('场景：v0.2 收尾') === 0, 'consolidate 写了一条场景记忆', { rows: sceneRows.length, kind: sceneRows[0] && sceneRows[0].kind });
ok(engine.layerOf(sceneRows[0], store.config) === 'scene', '场景记忆在分层里算场景层');
engine.consolidate(store, { partition: 'p-v02', title: 'v0.2 收尾', summary: '又收一次', taskId: 't-fake-v02' });
const sceneAgain = store.db.prepare("SELECT * FROM item WHERE partition_id = ? AND kind = 'scene'").all(lp.id);
ok(sceneAgain.length === 1, '同一 taskId 的 consolidate 幂等（不重复写场景）', sceneAgain.length);

// 39 v0.2 守卫一键修复：planFix / applyFix 的两段确认
const fixPlan = guard.planFix(store, { partition: 'p-v02' });
ok(Array.isArray(fixPlan.steps) && fixPlan.steps.length === 5, '一键修复给五个步骤', fixPlan.steps && fixPlan.steps.map(function (s) { return s.id; }));
ok(fixPlan.requiresConfirm === true, '计划声明需要确认');
ok(fixPlan.steps.filter(function (s) { return s.safe; }).length === 4, '安全步骤 4 个（merge 不算）');
ok(fixPlan.trunk && typeof fixPlan.trunk.text === 'string', '计划里带主干摘要预览');
const denied = guard.applyFix(store, { partition: 'p-v02', steps: ['backup'] });
ok(denied.ok === false && denied.requiresConfirm === true, '不带 confirm 一律拒绝执行', denied);
const applied = guard.applyFix(store, { partition: 'p-v02', steps: ['backup'], confirm: true });
ok(applied.ok === true && applied.applied.length === 1 && applied.applied[0] === 'backup' && applied.results[0].ok === true, '带 confirm 且指定 steps 只执行指定步骤', applied.results);
const merged = guard.applyFix(store, { partition: 'p-v02', steps: ['merge'], confirm: true });
ok(merged.ok === true && merged.results[0].id === 'merge', 'merge 只有显式指定才跑（永不默认）', merged.results);

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
// Windows 上数据库句柄未关时删不掉临时目录
if (typeof store.close === 'function') store.close();
else store.db.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.log('临时目录清理跳过: ' + e.code); }
