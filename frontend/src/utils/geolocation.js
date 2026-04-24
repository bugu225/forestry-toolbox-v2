/**
 * 室内与第三方浏览器下，高精度 GPS 常超时；组合多种策略提高成功率。
 * 部分浏览器在「拒绝」后用户改设置，需刷新页面；若仍失败可尝试 watchPosition。
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

/**
 * @returns {Promise<GeolocationPosition>}
 */
export async function getCurrentPositionCompat() {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw Object.assign(new Error("no_geolocation"), { code: 0 });
  }

  const quick = { enableHighAccuracy: false, maximumAge: 300000, timeout: 45000 };
  const fine = { enableHighAccuracy: true, maximumAge: 0, timeout: 32000 };
  const watchQuick = { enableHighAccuracy: false, maximumAge: 0, timeout: 60000 };
  const watchFine = { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 };

  try {
    return await getCurrentPositionOnce(quick);
  } catch (e1) {
    const c1 = Number(e1?.code ?? 0);
    if (c1 === 1) throw e1;
    try {
      return await getCurrentPositionOnce(fine);
    } catch (e2) {
      const c2 = Number(e2?.code ?? 0);
      if (c2 === 1) throw e2;
      try {
        return await watchPositionOnce(watchQuick, 22000);
      } catch {
        return await watchPositionOnce(watchFine, 24000);
      }
    }
  }
}
