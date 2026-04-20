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

async function readAllFromCursor(index, keyRange) {
  return new Promise((resolve, reject) => {
    const acc = [];
    const req = index.openCursor(keyRange);
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        acc.push(cur.value);
        cur.continue();
      } else {
        resolve(acc);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 按任务读取巡护轨迹点（有 by_task 索引时只扫该任务；按时间排序后截断，避免上万点拖慢界面）。
 */
export async function getPatrolPointsForTask(taskLocalId, { maxRows = 2500 } = {}) {
  if (!taskLocalId) return { rows: [], total: 0 };
  const db = await openDb();
  const tx = db.transaction(STORE_PATROL_POINTS, "readonly");
  const store = tx.objectStore(STORE_PATROL_POINTS);
  let rows;
  if (store.indexNames.contains("by_task")) {
    rows = await readAllFromCursor(store.index("by_task"), IDBKeyRange.only(taskLocalId));
  } else {
    const req = store.getAll();
    rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    rows = rows.filter((x) => x.task_local_id === taskLocalId);
  }
  await txPromise(tx);
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
  let rows;
  if (store.indexNames.contains("by_task")) {
    rows = await readAllFromCursor(store.index("by_task"), IDBKeyRange.only(taskLocalId));
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
  const total = rows.length;
  return { rows: rows.slice(0, maxRows), total };
}

export async function getPatrolEventsForTaskAll(taskLocalId) {
  if (!taskLocalId) return [];
  const db = await openDb();
  const tx = db.transaction(STORE_PATROL_EVENTS, "readonly");
  const store = tx.objectStore(STORE_PATROL_EVENTS);
  let rows;
  if (store.indexNames.contains("by_task")) {
    rows = await readAllFromCursor(store.index("by_task"), IDBKeyRange.only(taskLocalId));
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
