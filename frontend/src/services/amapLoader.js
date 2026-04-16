let amapLoadPromise = null;

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
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.async = true;
    script.onload = () => {
      if (window.AMap) {
        resolve(window.AMap);
      } else {
        reject(new Error("高德地图加载失败"));
      }
    };
    script.onerror = () => reject(new Error("高德地图脚本加载失败"));
    document.head.appendChild(script);
  });

  return amapLoadPromise;
}
