/**
 * 动态加载高德 JS API 2.0。
 * Key 来源（按优先级）：Vite 环境变量 → index.html 的 meta → 同源 GET /api/public/client-config（由后端 .env 提供，免重建前端）。
 * @see https://lbs.amap.com/api/javascript-api-v2/guide/abc/load
 */
const POLL_MS = 50;
const POLL_MAX = 200;

let runtimeFetchAttempted = false;
let runtimeKey = "";
let runtimeSecurity = "";
let runtimeConfigFetchStatus = 0;

function readMetaContent(name) {
  if (typeof document === "undefined") return "";
  try {
    const el = document.querySelector(`meta[name="${name}"]`);
    const raw = el?.getAttribute("content");
    const s = raw == null ? "" : String(raw).trim();
    return s;
  } catch {
    return "";
  }
}

async function ensureRuntimeKeysFromApi() {
  if (runtimeFetchAttempted || typeof fetch === "undefined" || typeof window === "undefined") return;
  runtimeFetchAttempted = true;
  try {
    const r = await fetch("/api/public/client-config", { credentials: "same-origin" });
    runtimeConfigFetchStatus = r.status || 0;
    if (!r.ok) return;
    const j = await r.json();
    runtimeKey = String(j.amap_js_key || "").trim();
    runtimeSecurity = String(j.amap_security_js_code || "").trim();
  } catch {
    /* 离线或反代未就绪时忽略 */
  }
}

function loadScriptWithKey(key, securityJsCode) {
  return new Promise((resolve, reject) => {
    if (!key || String(key).trim() === "") {
      reject(new Error("no_amap_key"));
      return;
    }
    if (typeof window === "undefined") {
      reject(new Error("no_window"));
      return;
    }
    if (securityJsCode) {
      window._AMapSecurityConfig = { securityJsCode };
    }
    if (window.AMap) {
      resolve(window.AMap);
      return;
    }
    const id = "amap-js-sdk-v2";
    const existing = document.getElementById(id);
    if (existing) {
      let n = 0;
      const check = () => {
        if (window.AMap) {
          resolve(window.AMap);
          return;
        }
        n += 1;
        if (n >= POLL_MAX) {
          reject(new Error("amap_load_timeout"));
          return;
        }
        setTimeout(check, POLL_MS);
      };
      check();
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.onload = () => {
      if (window.AMap) resolve(window.AMap);
      else reject(new Error("amap_load_failed"));
    };
    script.onerror = () => reject(new Error("amap_script_error"));
    document.head.appendChild(script);
  });
}

export async function loadAmap() {
  await ensureRuntimeKeysFromApi();
  const key =
    String(import.meta.env.VITE_AMAP_JS_KEY || "").trim() ||
    readMetaContent("forestry-amap-key") ||
    runtimeKey;
  const securityJsCode =
    String(import.meta.env.VITE_AMAP_SECURITY_JS_CODE || "").trim() ||
    readMetaContent("forestry-amap-security") ||
    runtimeSecurity;
  if (!key && runtimeConfigFetchStatus === 404) {
    throw new Error("amap_runtime_config_404");
  }
  return loadScriptWithKey(key, securityJsCode);
}
