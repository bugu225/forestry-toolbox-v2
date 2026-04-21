let amapLoadPromise = null;

const LOAD_TIMEOUT_MS = 45000;

export function loadAmapSdk() {
  if (window.AMap) {
    return Promise.resolve(window.AMap);
  }
  if (amapLoadPromise) {
    return amapLoadPromise;
  }

  const key = import.meta.env.VITE_AMAP_JS_KEY;
  const securityCode = import.meta.env.VITE_AMAP_SECURITY_JS_CODE;
  if (!key || !securityCode) {
    return Promise.reject(new Error("高德地图 Key 未配置"));
  }

  window._AMapSecurityConfig = {
    securityJsCode: securityCode,
  };

  amapLoadPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      amapLoadPromise = null;
      reject(new Error("高德地图加载超时，请检查公网与域名白名单后重试"));
    }, LOAD_TIMEOUT_MS);

    const finish = (err, AMap) => {
      clearTimeout(timer);
      if (err) {
        amapLoadPromise = null;
        reject(err);
        return;
      }
      resolve(AMap);
    };

    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      if (window.AMap) {
        finish(null, window.AMap);
      } else {
        finish(new Error("高德地图加载失败"));
      }
    };
    script.onerror = () => {
      finish(new Error("高德地图脚本加载失败（请检查网络与域名白名单）"));
    };
    document.head.appendChild(script);
  });

  return amapLoadPromise;
}
