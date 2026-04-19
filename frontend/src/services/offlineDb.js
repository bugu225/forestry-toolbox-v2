const DB_NAME = "ftb2_offline_db";
const DB_VERSION = 5;

const STORE_QA_SESSIONS = "qa_sessions";
const STORE_QA_MESSAGES = "qa_messages";
const STORE_QA_KNOWLEDGE_DOCS = "qa_knowledge_docs";
const STORE_QA_PENDING_QUESTIONS = "qa_pending_questions";
const STORE_USER_KNOWLEDGE_ENTRIES = "user_knowledge_entries";
const STORE_IDENTIFY_GALLERY = "identify_gallery";

/** 旧版已移除的 object store（升级时删除） */
const LEGACY_STORES_TO_DROP = [
  "patrol_tasks",
  "patrol_points",
  "patrol_events",
  "identify_jobs",
];

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

export const stores = {
  qaSessions: STORE_QA_SESSIONS,
  qaMessages: STORE_QA_MESSAGES,
  qaKnowledgeDocs: STORE_QA_KNOWLEDGE_DOCS,
  qaPendingQuestions: STORE_QA_PENDING_QUESTIONS,
  userKnowledgeEntries: STORE_USER_KNOWLEDGE_ENTRIES,
  identifyGallery: STORE_IDENTIFY_GALLERY,
};
