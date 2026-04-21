const DB_NAME = "ftb2_offline_db";
const DB_VERSION = 7;

const STORE_QA_SESSIONS = "qa_sessions";
const STORE_QA_MESSAGES = "qa_messages";
const STORE_QA_KNOWLEDGE_DOCS = "qa_knowledge_docs";
const STORE_QA_PENDING_QUESTIONS = "qa_pending_questions";
const STORE_USER_KNOWLEDGE_ENTRIES = "user_knowledge_entries";
const STORE_IDENTIFY_GALLERY = "identify_gallery";
const STORE_PATROL_TASKS = "patrol_tasks";
const STORE_PATROL_POINTS = "patrol_points";
const STORE_PATROL_EVENTS = "patrol_events";

/** 旧版已移除的 object store（升级时删除） */
const LEGACY_STORES_TO_DROP = ["identify_jobs"];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      for (const name of LEGACY_STORES_TO_DROP) {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name);
        }
      }
      if (!db.objectStoreNames.contains(STORE_QA_SESSIONS)) {
        db.createObjectStore(STORE_QA_SESSIONS, { keyPath: "local_id" });
      }
      if (!db.objectStoreNames.contains(STORE_QA_MESSAGES)) {
        db.createObjectStore(STORE_QA_MESSAGES, { keyPath: "local_id" });
      }
      if (!db.objectStoreNames.contains(STORE_QA_KNOWLEDGE_DOCS)) {
        db.createObjectStore(STORE_QA_KNOWLEDGE_DOCS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_QA_PENDING_QUESTIONS)) {
        db.createObjectStore(STORE_QA_PENDING_QUESTIONS, { keyPath: "local_id" });
      }
      if (!db.objectStoreNames.contains(STORE_USER_KNOWLEDGE_ENTRIES)) {
        db.createObjectStore(STORE_USER_KNOWLEDGE_ENTRIES, { keyPath: "local_id" });
      }
      if (!db.objectStoreNames.contains(STORE_IDENTIFY_GALLERY)) {
        db.createObjectStore(STORE_IDENTIFY_GALLERY, { keyPath: "local_id" });
      }
      if (!db.objectStoreNames.contains(STORE_PATROL_TASKS)) {
        db.createObjectStore(STORE_PATROL_TASKS, { keyPath: "local_id" });
      }
      if (!db.objectStoreNames.contains(STORE_PATROL_POINTS)) {
        db.createObjectStore(STORE_PATROL_POINTS, { keyPath: "local_id" });
      }
      if (!db.objectStoreNames.contains(STORE_PATROL_EVENTS)) {
        db.createObjectStore(STORE_PATROL_EVENTS, { keyPath: "local_id" });
      }
      const upgradeTx = event.target.transaction;
      if (db.objectStoreNames.contains(STORE_PATROL_POINTS)) {
        const ps = upgradeTx.objectStore(STORE_PATROL_POINTS);
        if (!ps.indexNames.contains("by_task")) {
          ps.createIndex("by_task", "task_local_id", { unique: false });
        }
      }
      if (db.objectStoreNames.contains(STORE_PATROL_EVENTS)) {
        const es = upgradeTx.objectStore(STORE_PATROL_EVENTS);
        if (!es.indexNames.contains("by_task")) {
          es.createIndex("by_task", "task_local_id", { unique: false });
        }
      }
    };
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putRecord(storeName, record) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(record);
  await txPromise(tx);
}

export async function getAllRecords(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readonly");
  const req = tx.objectStore(storeName).getAll();
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await txPromise(tx);
  return result;
}

export async function getRecord(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readonly");
  const req = tx.objectStore(storeName).get(key);
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  await txPromise(tx);
  return result;
}

export async function clearStore(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).clear();
  await txPromise(tx);
}

export async function deleteRecord(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(key);
  await txPromise(tx);
}

function indexCount(index, keyRange) {
  return new Promise((resolve, reject) => {
    const req = index.count(keyRange);
    req.onsuccess = () => resolve(Number(req.result) || 0);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 轨迹点：按 by_task 只读取「末尾 maxRows 条」（主键序≈时间序），避免数万点一次性进内存导致页面卡死。
 */
async function readPatrolPointsTail(index, keyRange, maxRows) {
  const total = await indexCount(index, keyRange);
  if (total === 0) return { rows: [], total: 0 };
  const skip = Math.max(0, total - maxRows);
  const rows = [];
  await new Promise((resolve, reject) => {
    const req = index.openCursor(keyRange);
    let needAdvance = skip > 0;
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (needAdvance) {
        needAdvance = false;
        if (!cur) {
          resolve();
          return;
        }
        cur.advance(skip);
        return;
      }
      if (!cur) {
        resolve();
        return;
      }
      rows.push(cur.value);
      if (rows.length >= Math.min(maxRows, total)) {
        resolve();
        return;
      }
      cur.continue();
    };
  });
  rows.sort((a, b) => new Date(a.captured_at || 0).getTime() - new Date(b.captured_at || 0).getTime());
  return { rows, total };
}

/**
 * 事件：按 by_task 用 prev 游标只读「最新 maxRows 条」，O(maxRows) 不扫全表。
 */
async function readPatrolEventsNewest(index, keyRange, maxRows) {
  const total = await indexCount(index, keyRange);
  if (total === 0) return { rows: [], total: 0 };
  const take = Math.min(maxRows, total);
  const rows = [];
  await new Promise((resolve, reject) => {
    const req = index.openCursor(keyRange, "prev");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || rows.length >= take) {
        resolve();
        return;
      }
      rows.push(cur.value);
      cur.continue();
    };
  });
  rows.sort((a, b) => new Date(b.captured_at || 0).getTime() - new Date(a.captured_at || 0).getTime());
  return { rows, total };
}

/** 全量读取（导出用）；大表时分片让出主线程，减轻「无响应」 */
async function readAllFromCursorYielding(index, keyRange, yieldEvery = 400) {
  return new Promise((resolve, reject) => {
    const acc = [];
    let n = 0;
    const req = index.openCursor(keyRange);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve(acc);
        return;
      }
      acc.push(cur.value);
      n += 1;
      if (n % yieldEvery === 0) {
        setTimeout(() => cur.continue(), 0);
      } else {
        cur.continue();
      }
    };
  });
}

/** 当前任务轨迹点总数（仅 count，不全量读） */
export async function countPatrolPointsForTask(taskLocalId) {
  if (!taskLocalId) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE_PATROL_POINTS, "readonly");
  const store = tx.objectStore(STORE_PATROL_POINTS);
  if (!store.indexNames.contains("by_task")) {
    const req = store.getAll();
    const rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    await txPromise(tx);
    return rows.filter((x) => x.task_local_id === taskLocalId).length;
  }
  const n = await indexCount(store.index("by_task"), IDBKeyRange.only(taskLocalId));
  await txPromise(tx);
  return n;
}

/** 当前任务事件总数（仅 count） */
export async function countPatrolEventsForTask(taskLocalId) {
  if (!taskLocalId) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE_PATROL_EVENTS, "readonly");
  const store = tx.objectStore(STORE_PATROL_EVENTS);
  if (!store.indexNames.contains("by_task")) {
    const req = store.getAll();
    const rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    await txPromise(tx);
    return rows.filter((x) => x.task_local_id === taskLocalId).length;
  }
  const n = await indexCount(store.index("by_task"), IDBKeyRange.only(taskLocalId));
  await txPromise(tx);
  return n;
}

/**
 * 按任务读取巡护轨迹点（有 by_task 索引时只读末尾 maxRows 条，不全表加载）。
 */
export async function getPatrolPointsForTask(taskLocalId, { maxRows = 2500 } = {}) {
  if (!taskLocalId) return { rows: [], total: 0 };
  const db = await openDb();
  const tx = db.transaction(STORE_PATROL_POINTS, "readonly");
  const store = tx.objectStore(STORE_PATROL_POINTS);
  const keyRange = IDBKeyRange.only(taskLocalId);
  if (store.indexNames.contains("by_task")) {
    const idx = store.index("by_task");
    const res = await readPatrolPointsTail(idx, keyRange, maxRows);
    await txPromise(tx);
    return res;
  }
  const req = store.getAll();
  let rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await txPromise(tx);
  rows = rows.filter((x) => x.task_local_id === taskLocalId);
  rows.sort((a, b) => new Date(a.captured_at || 0).getTime() - new Date(b.captured_at || 0).getTime());
  const total = rows.length;
  return { rows: rows.slice(-maxRows), total };
}

/**
 * 按任务读取巡护事件（截断用于列表/地图；导出全量请用 getPatrolEventsForTaskAll）。
 */
export async function getPatrolEventsForTask(taskLocalId, { maxRows = 800 } = {}) {
  if (!taskLocalId) return { rows: [], total: 0 };
  const db = await openDb();
  const tx = db.transaction(STORE_PATROL_EVENTS, "readonly");
  const store = tx.objectStore(STORE_PATROL_EVENTS);
  const keyRange = IDBKeyRange.only(taskLocalId);
  if (store.indexNames.contains("by_task")) {
    const idx = store.index("by_task");
    const res = await readPatrolEventsNewest(idx, keyRange, maxRows);
    await txPromise(tx);
    return res;
  }
  const req = store.getAll();
  let rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await txPromise(tx);
  rows = rows.filter((x) => x.task_local_id === taskLocalId);
  rows.sort((a, b) => new Date(b.captured_at || 0).getTime() - new Date(a.captured_at || 0).getTime());
  const total = rows.length;
  return { rows: rows.slice(0, maxRows), total };
}

export async function getPatrolEventsForTaskAll(taskLocalId) {
  if (!taskLocalId) return [];
  const db = await openDb();
  const tx = db.transaction(STORE_PATROL_EVENTS, "readonly");
  const store = tx.objectStore(STORE_PATROL_EVENTS);
  const keyRange = IDBKeyRange.only(taskLocalId);
  let rows;
  if (store.indexNames.contains("by_task")) {
    rows = await readAllFromCursorYielding(store.index("by_task"), keyRange, 400);
  } else {
    const req = store.getAll();
    rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    rows = rows.filter((x) => x.task_local_id === taskLocalId);
  }
  await txPromise(tx);
  rows.sort((a, b) => new Date(b.captured_at || 0).getTime() - new Date(a.captured_at || 0).getTime());
  return rows;
}

export const stores = {
  qaSessions: STORE_QA_SESSIONS,
  qaMessages: STORE_QA_MESSAGES,
  qaKnowledgeDocs: STORE_QA_KNOWLEDGE_DOCS,
  qaPendingQuestions: STORE_QA_PENDING_QUESTIONS,
  userKnowledgeEntries: STORE_USER_KNOWLEDGE_ENTRIES,
  identifyGallery: STORE_IDENTIFY_GALLERY,
  patrolTasks: STORE_PATROL_TASKS,
  patrolPoints: STORE_PATROL_POINTS,
  patrolEvents: STORE_PATROL_EVENTS,
};
