import { loadAmap } from "./amapLoader";

/**
 * 高德 IP 定位（城市级，精度较粗）。
 * 仅作为 GPS 定位失败时的后备手段。
 */
export async function locateByAmapIp() {
  const AMap = await loadAmap();
  return new Promise((resolve, reject) => {
    AMap.plugin("AMap.CitySearch", () => {
      try {
        const citySearch = new AMap.CitySearch();
        citySearch.getLocalCity((status, result) => {
          if (status !== "complete" || !result) {
            reject(new Error("amap_ip_failed"));
            return;
          }
          const rectangle = String(result.rectangle || "");
          const city = String(result.city || result.province || "未知城市");
          // rectangle 形如 "lng1,lat1;lng2,lat2"，取中心点。
          const parts = rectangle.split(";");
          if (parts.length !== 2) {
            reject(new Error("amap_ip_no_rectangle"));
            return;
          }
          const [lng1, lat1] = parts[0].split(",").map(Number);
          const [lng2, lat2] = parts[1].split(",").map(Number);
          if (![lng1, lat1, lng2, lat2].every(Number.isFinite)) {
            reject(new Error("amap_ip_bad_coord"));
            return;
          }
          resolve({
            lng: (lng1 + lng2) / 2,
            lat: (lat1 + lat2) / 2,
            city,
            level: String(result.level || ""),
          });
        });
      } catch {
        reject(new Error("amap_ip_exception"));
      }
    });
  });
}
