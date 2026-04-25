/**
 * 手机 Chrome 常见问题：
 * - 冷启动首定位超时
 * - 室内弱信号仅能拿到网络定位
 * - 用户刚改权限，第一次调用仍失败
 */
function getCurrentPositionOnce(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function watchPositionOnce(options, maxMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        navigator.geolocation.clearWatch(watchId);
      } catch {
        /* ignore */
      }
      fn(arg);
    };
    const watchId = navigator.geolocation.watchPosition(
      (pos) => done(resolve, pos),
      (err) => done(reject, err),
      options
    );
    const timer = window.setTimeout(() => {
      done(reject, Object.assign(new Error("watch_timeout"), { code: 3 }));
    }, maxMs);
  });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function assertPermissionNotDenied() {
  if (!navigator.permissions?.query) return;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    if (status?.state === "denied") {
      throw Object.assign(new Error("geo_permission_denied"), { code: 1 });
    }
  } catch {
    /* ignore: 部分浏览器 permissions 行为不一致 */
  }
}

/**
 * 更贴近手机 Chrome 的说明文案。
 */
export function describeGeoError(error, fallback = "获取位置失败，请稍后重试") {
  const code = Number(error?.code || 0);
  if (code === 1) {
    return "定位权限未生效：请在 Chrome 站点设置中允许定位，并确认系统定位对 Chrome 也已开启；改完后建议彻底关闭 Chrome 再打开。";
  }
  if (code === 2) {
    return "定位不可用：请检查手机定位服务（GPS）是否开启，关闭省电模式，并到窗边或室外重试。";
  }
  if (code === 3) {
    return "定位超时：请保持网络畅通，开启高精度定位（GPS+WLAN+移动网络），等待 10-20 秒后重试。";
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "当前不是 HTTPS 安全访问，Chrome 不允许定位。请用 https 链接打开。";
  }
  return fallback;
}

/**
 * @returns {Promise<GeolocationPosition>}
 */
export async function getCurrentPositionCompat() {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw Object.assign(new Error("no_geolocation"), { code: 0 });
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    throw Object.assign(new Error("insecure_context"), { code: 0 });
  }

  await assertPermissionNotDenied();

  // 先拿可用坐标，再争取更高精度；总时长控制在移动端可接受范围。
  const quickCached = { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 12000 };
  const networkFresh = { enableHighAccuracy: false, maximumAge: 0, timeout: 18000 };
  const gpsFresh = { enableHighAccuracy: true, maximumAge: 0, timeout: 22000 };
  const watchNetwork = { enableHighAccuracy: false, maximumAge: 0, timeout: 30000 };
  const watchGps = { enableHighAccuracy: true, maximumAge: 0, timeout: 32000 };

  const attempts = [
    () => getCurrentPositionOnce(quickCached),
    () => getCurrentPositionOnce(networkFresh),
    () => getCurrentPositionOnce(gpsFresh),
    () => watchPositionOnce(watchNetwork, 18000),
    () => watchPositionOnce(watchGps, 20000),
  ];

  let lastErr = null;
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      return await attempts[i]();
    } catch (err) {
      lastErr = err;
      if (Number(err?.code || 0) === 1) throw err;
      // 给定位芯片一点恢复时间，避免连续 timeout。
      await sleep(i < 2 ? 250 : 450);
    }
  }
  throw lastErr || Object.assign(new Error("geo_failed"), { code: 0 });
}
