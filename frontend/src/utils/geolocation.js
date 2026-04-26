/**
 * 手机 Chrome 常见问题：
 * - 冷启动首定位超时
 * - 室内弱信号仅能拿到网络定位
 * - 用户刚改权限，第一次调用仍失败
 * - 在线时优先走融合定位（GPS + Wi-Fi + 基站）
 * - 离线时退化为 GPS 优先
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

function withTimeout(promise, ms, code = 3, reason = "geo_overall_timeout") {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(Object.assign(new Error(reason), { code }));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      }
    );
  });
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
    return "定位不可用：请确认系统已开启定位服务（含卫星/GPS），并到窗边或室外重试。";
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
 * 巡护定时入库用：仅高精度链路，单次超时偏长以尽量拿到收敛坐标。
 * @returns {Promise<GeolocationPosition>}
 */
export async function getHighAccuracySnapshot() {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw Object.assign(new Error("no_geolocation"), { code: 0 });
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    throw Object.assign(new Error("insecure_context"), { code: 0 });
  }
  await assertPermissionNotDenied();
  const online = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  /** 一律 maximumAge:0、高精度优先，拉长单次超时以尽量拿到 GPS 收敛解 */
  const hi = { enableHighAccuracy: true, maximumAge: 0, timeout: 24000 };
  const hiB = { enableHighAccuracy: true, maximumAge: 0, timeout: 18000 };
  const attempts = online
    ? [
        () => getCurrentPositionOnce(hi),
        () => getCurrentPositionOnce(hiB),
        () => watchPositionOnce(hi, 16000),
      ]
    : [() => getCurrentPositionOnce(hi), () => watchPositionOnce(hi, 18000)];
  let lastErr = null;
  for (const fn of attempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (Number(err?.code || 0) === 1) throw err;
      await sleep(120);
    }
  }
  throw lastErr || Object.assign(new Error("geo_failed"), { code: 0 });
}

/**
 * 记录事件用：单次短超时定位，避免与巡护采样的长链路抢时间。
 * 允许略陈旧坐标（maximumAge）以改善室内/弱信号下的首响。
 */
export async function getQuickPositionForEvent(timeoutMs = 10000) {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw Object.assign(new Error("no_geolocation"), { code: 0 });
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    throw Object.assign(new Error("insecure_context"), { code: 0 });
  }
  await assertPermissionNotDenied();
  const opts = { enableHighAccuracy: true, maximumAge: 12000, timeout: timeoutMs };
  return getCurrentPositionOnce(opts);
}

export async function getCurrentPositionCompat() {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw Object.assign(new Error("no_geolocation"), { code: 0 });
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    throw Object.assign(new Error("insecure_context"), { code: 0 });
  }

  await assertPermissionNotDenied();

  // 总时长放宽，优先等 GPS/融合收敛，不用缓存位置凑数。
  return withTimeout(
    (async () => {
      const online = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
      const fusedHigh = { enableHighAccuracy: true, maximumAge: 0, timeout: 24000 };
      const fusedHighB = { enableHighAccuracy: true, maximumAge: 0, timeout: 18000 };
      const fusedBalanced = { enableHighAccuracy: false, maximumAge: 0, timeout: 18000 };
      const gpsStrict = { enableHighAccuracy: true, maximumAge: 0, timeout: 24000 };
      const watchFusedHigh = { enableHighAccuracy: true, maximumAge: 0, timeout: 24000 };

      const attempts = online
        ? [
            () => getCurrentPositionOnce(fusedHigh),
            () => getCurrentPositionOnce(fusedHighB),
            () => getCurrentPositionOnce(fusedBalanced),
            () => watchPositionOnce(watchFusedHigh, 16000),
          ]
        : [() => getCurrentPositionOnce(gpsStrict), () => watchPositionOnce(gpsStrict, 18000)];

      let lastErr = null;
      for (let i = 0; i < attempts.length; i += 1) {
        try {
          return await attempts[i]();
        } catch (err) {
          lastErr = err;
          if (Number(err?.code || 0) === 1) throw err;
          await sleep(250);
        }
      }
      throw lastErr || Object.assign(new Error("geo_failed"), { code: 0 });
    })(),
    36000
  );
}
