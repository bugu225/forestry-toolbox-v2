/**
 * 动态加载高德 JS API 2.0，使用项目环境变量中的 key 与安全码。
 * @see https://lbs.amap.com/api/javascript-api-v2/guide/abc/load
 */
const POLL_MS = 50;
const POLL_MAX = 200;

export function loadAmap() {
  return new Promise((resolve, reject) => {
    const key = import.meta.env.VITE_AMAP_JS_KEY;
    const securityJsCode = import.meta.env.VITE_AMAP_SECURITY_JS_CODE || "";
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
