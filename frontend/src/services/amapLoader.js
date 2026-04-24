/**
 * 动态加载高德 JS API 2.0，使用项目环境变量中的 key 与安全码。
 * 构建时未注入时，可在线上为 dist/index.html 增加 meta（免重新 npm build）：
 * <meta name="forestry-amap-key" content="你的Web端Key" />
 * <meta name="forestry-amap-security" content="你的安全密钥" />
 * @see https://lbs.amap.com/api/javascript-api-v2/guide/abc/load
 */
const POLL_MS = 50;
const POLL_MAX = 200;

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

export function loadAmap() {
  return new Promise((resolve, reject) => {
    const key =
      String(import.meta.env.VITE_AMAP_JS_KEY || "").trim() || readMetaContent("forestry-amap-key");
    const securityJsCode =
      String(import.meta.env.VITE_AMAP_SECURITY_JS_CODE || "").trim() ||
      readMetaContent("forestry-amap-security");
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
