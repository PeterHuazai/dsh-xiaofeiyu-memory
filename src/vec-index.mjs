import { fileURLToPath } from 'node:url';

// sqlite-vec 是可选加速层：装了就自动挂上，挂了也不许影响召回（所有调用都 try/catch 兜住）。
// 没有扩展时 engine 会退回逐条余弦，annBackend() 会如实写 sqlite-bruteforce，不假装成功。
function platformEntry() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === 'win32' && arch === 'x64') return { pkg: 'sqlite-vec-windows-x64', file: 'vec0.dll' };
  if (plat === 'linux' && arch === 'x64') return { pkg: 'sqlite-vec-linux-x64', file: 'vec0.so' };
  if (plat === 'linux' && arch === 'arm64') return { pkg: 'sqlite-vec-linux-arm64', file: 'vec0.so' };
  if (plat === 'darwin' && arch === 'x64') return { pkg: 'sqlite-vec-darwin-x64', file: 'vec0.dylib' };
  if (plat === 'darwin' && arch === 'arm64') return { pkg: 'sqlite-vec-darwin-arm64', file: 'vec0.dylib' };
  return null;
}

function fail(st, msg) { st.error = String(msg || 'unknown').slice(0, 240); return st; }

export function vecState(store) {
  if (store.__vecState) return store.__vecState;
  const st = { available: false, loaded: false, path: null, error: null, version: null, dims: null };
  store.__vecState = st;
  const entry = platformEntry();
  if (!entry) return fail(st, 'unsupported platform ' + process.platform + '-' + process.arch);
  try {
    st.path = fileURLToPath(import.meta.resolve(entry.pkg + '/' + entry.file));
  } catch (err) {
    return fail(st, 'extension package not installed: ' + entry.pkg);
  }
  try {
    store.db.loadExtension(st.path);
    st.version = String(store.db.prepare('SELECT vec_version() AS v').get().v);
    st.available = true;
    st.loaded = true;
  } catch (err) {
    fail(st, err && err.message ? err.message : err);
  }
  return st;
}

function tableDims(store) {
  try {
    const row = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'item_vec'").get();
    if (!row) return 0;
    const m = /float\[(\d+)\]/i.exec(String(row.sql || ''));
    return m ? Number(m[1]) : 0;
  } catch (err) { return 0; }
}

export function ensureIndex(store, dims) {
  const st = vecState(store);
  if (!st.available || !dims) return false;
  if (st.dims === dims) return true;
  try {
    if (tableDims(store) !== dims) {
      store.db.exec('DROP TABLE IF EXISTS item_vec');
      store.db.exec('CREATE VIRTUAL TABLE item_vec USING vec0(item_id text primary key, partition_id text partition key, embedding float[' + Number(dims) + '])');
    }
    st.dims = dims;
    return true;
  } catch (err) {
    st.available = false;
    fail(st, err && err.message ? err.message : err);
    return false;
  }
}

export function upsert(store, itemId, partitionId, vec) {
  const st = vecState(store);
  if (!st.available || !vec || !vec.length) return false;
  if (!ensureIndex(store, vec.length)) return false;
  const payload = JSON.stringify(Array.from(vec, function (x) { return Number(x) || 0; }));
  try {
    store.db.prepare('DELETE FROM item_vec WHERE item_id = ?').run(String(itemId));
    store.db.prepare('INSERT INTO item_vec (item_id, partition_id, embedding) VALUES (?, ?, ?)').run(String(itemId), String(partitionId), payload);
    return true;
  } catch (err) {
    fail(st, err && err.message ? err.message : err);
    return false;
  }
}

export function remove(store, itemId) {
  const st = vecState(store);
  if (!st.available) return false;
  try { store.db.prepare('DELETE FROM item_vec WHERE item_id = ?').run(String(itemId)); return true; } catch (err) { return false; }
}

export function clear(store, partitionId) {
  const st = vecState(store);
  if (!st.available) return false;
  try {
    if (partitionId) store.db.prepare('DELETE FROM item_vec WHERE partition_id = ?').run(String(partitionId));
    else store.db.exec('DELETE FROM item_vec');
    return true;
  } catch (err) { return false; }
}

export function knn(store, partitionId, vec, k) {
  const st = vecState(store);
  if (!st.available || !vec || !vec.length) return null;
  if (!ensureIndex(store, vec.length)) return null;
  try {
    return store.db.prepare('SELECT item_id, distance FROM item_vec WHERE embedding MATCH ? AND partition_id = ? AND k = ?')
      .all(JSON.stringify(Array.from(vec, function (x) { return Number(x) || 0; })), String(partitionId), Math.max(1, Number(k) || 64));
  } catch (err) {
    fail(st, err && err.message ? err.message : err);
    return null;
  }
}

export function indexedCount(store, partitionId) {
  const st = vecState(store);
  if (!st.available) return 0;
  try {
    const row = partitionId
      ? store.db.prepare('SELECT COUNT(*) AS n FROM item_vec WHERE partition_id = ?').get(String(partitionId))
      : store.db.prepare('SELECT COUNT(*) AS n FROM item_vec').get();
    return row ? Number(row.n) : 0;
  } catch (err) { return 0; }
}
