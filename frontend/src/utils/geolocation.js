/**
 * 室内与第三方浏览器下，高精度 GPS 常超时；先尝试网络/低精度定位，再回退高精度。
 * @returns {Promise<GeolocationPosition>}
 */
export function getCurrentPositionCompat() {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(Object.assign(new Error("no_geolocation"), { code: 0 }));
      return;
    }
    const quick = { enableHighAccuracy: false, maximumAge: 120000, timeout: 32000 };
    const fine = { enableHighAccuracy: true, maximumAge: 0, timeout: 28000 };

    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => {
        const code = Number(err?.code ?? 0);
        if (code === 1) {
          reject(err);
          return;
        }
        if (code === 2 || code === 3) {
          navigator.geolocation.getCurrentPosition(resolve, reject, fine);
          return;
        }
        reject(err);
      },
      quick
    );
  });
}
