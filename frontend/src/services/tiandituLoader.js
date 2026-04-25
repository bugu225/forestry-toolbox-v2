/**
 * 动态加载天地图 JS API 4.0。
 * Key 来源（按优先级）：Vite 变量 → index.html meta → /api/public/client-config。
 */
const POLL_MS = 60;
const POLL_MAX = 240;

let runtimeFetched = false;
let runtimeKey = "";
let runtimeConfigStatus = 0;

function readMetaContent(name) {
  if (typeof document === "undefined") return "";
  try {
    const el = document.querySelector(`meta[name="${name}"]`);
    return String(el?.getAttribute("content") || "").trim();
  } catch {
    return "";
  }
}

async function ensureRuntimeConfig() {
  if (runtimeFetched || typeof fetch === "undefined") return;
  runtimeFetched = true;
  try {
    const res = await fetch("/api/public/client-config", { credentials: "same-origin" });
    runtimeConfigStatus = res.status || 0;
    if (!res.ok) return;
    const data = await res.json();
    runtimeKey = String(data.tianditu_js_key || "").trim();
  } catch {
    /* ignore */
  }
}

function waitTiandituReady() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const check = () => {
      if (typeof window !== "undefined" && window.T && window.T.Map) {
        resolve(window.T);
        return;
      }
      n += 1;
      if (n >= POLL_MAX) {
        reject(new Error("tianditu_load_timeout"));
        return;
      }
      setTimeout(check, POLL_MS);
    };
    check();
  });
}

export async function loadTianditu() {
  await ensureRuntimeConfig();
  const tk =
    String(import.meta.env.VITE_TIANDITU_JS_KEY || "").trim() ||
    readMetaContent("forestry-tianditu-key") ||
    runtimeKey;
  if (!tk) {
    if (runtimeConfigStatus === 404) throw new Error("tianditu_runtime_config_404");
    throw new Error("no_tianditu_key");
  }
  if (typeof window === "undefined") throw new Error("no_window");
  if (window.T?.Map) return window.T;

  const id = "tianditu-js-sdk-v4";
  if (document.getElementById(id)) {
    return waitTiandituReady();
  }
  const script = document.createElement("script");
  script.id = id;
  script.async = true;
  script.src = `https://api.tianditu.gov.cn/api?v=4.0&tk=${encodeURIComponent(tk)}`;
  document.head.appendChild(script);
  return waitTiandituReady();
}
