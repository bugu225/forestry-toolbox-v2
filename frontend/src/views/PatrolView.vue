<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from "vant";
import { storeToRefs } from "pinia";
import { useNetworkStore } from "../stores/network";
import PatrolEventSheet from "../components/PatrolEventSheet.vue";
import PatrolEventList from "../components/PatrolEventList.vue";
import PatrolTrackList from "../components/PatrolTrackList.vue";
import { loadTianditu } from "../services/tiandituLoader";
import { exportPatrolPdfReport } from "../services/patrolPdfExport";
import { deletePatrolPointsForTask, deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";
import { describeGeoError, getCurrentPositionCompat, getHighAccuracySnapshot, getQuickPositionForEvent } from "../utils/geolocation";

const networkStore = useNetworkStore();
const { effectiveOnline } = storeToRefs(networkStore);

/** 入库轨迹点间隔：偏短以跟紧真实路径（耗电由系统/浏览器侧承担） */
const SAMPLE_INTERVAL_MS = 2 * 1000;
/** watchPosition 实时轨迹点（内存），与已入库折线叠加显示 */
const LIVE_TRAIL_MAX = 280;
/** 仅用于质量分级展示；不再因精度差而丢弃轨迹点 */
const ACCEPTABLE_ACCURACY_M = 100;
const GOOD_ACCURACY_M = 50;
/** 仅过滤明显飞点，避免误伤真实快速移动 */
const JUMP_CHECK_WINDOW_MS = 90 * 1000;
const JUMP_DISTANCE_M = 900;
const JUMP_SPEED_MPS = 55;
const PLAYBACK_STEP_MS = 800;

const EVENT_TYPES = [
  { value: "pest", label: "病虫害", color: "#722ed1" },
  { value: "fire", label: "火情", color: "#ee0a24" },
  { value: "illegal", label: "盗伐", color: "#ed6a0c" },
  { value: "facility", label: "设施损坏", color: "#07c160" },
  { value: "wildlife", label: "野生动物", color: "#2db7f5" },
  { value: "other", label: "其他异常", color: "#1989fa" },
];

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function eventTypeLabel(value) {
  return EVENT_TYPES.find((t) => t.value === value)?.label || value;
}

function eventTypeColor(value) {
  return EVENT_TYPES.find((t) => t.value === value)?.color || "#646566";
}

function locationSourceLabel(source) {
  if (source === "track_point") return "轨迹点回填";
  if (source === "gps_live") return "实时定位";
  if (source === "gps_watch") return "持续 watch";
  if (source === "gps_sample") return "定时高精度";
  if (source === "gps_live_event") return "事件定位";
  return "未知来源";
}

function classifyAccuracyLevel(acc) {
  const v = Number(acc);
  if (!Number.isFinite(v) || v <= 0) return "unknown";
  if (v <= 20) return "A";
  if (v <= GOOD_ACCURACY_M) return "B";
  if (v <= ACCEPTABLE_ACCURACY_M) return "C";
  return "D";
}

function isValidLngLat(p) {
  const lng = Number(p?.lng);
  const lat = Number(p?.lat);
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

const activeTask = ref(null);
const endedTaskView = ref(null);
const points = ref([]);
const events = ref([]);
const samplingTimer = ref(null);
const gpsBusy = ref(false);
/** 保存事件 / 一键异常（勿与开始巡护的 gpsBusy 混用） */
const eventSaveBusy = ref(false);

const showEventSheet = ref(false);
const eventType = ref("pest");
const eventNote = ref("");
const eventPhotoDataUrl = ref("");

/** 有效坐标、按时间排序（与地图折线/回放滑块一致） */
const orderedPoints = computed(() =>
  [...points.value].filter(isValidLngLat).sort((a, b) => (a.recorded_at || 0) - (b.recorded_at || 0))
);

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const lat1 = Number(a?.lat);
  const lng1 = Number(a?.lng);
  const lat2 = Number(b?.lat);
  const lng2 = Number(b?.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return 0;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

const patrolStats = computed(() => {
  const pts = orderedPoints.value;
  if (!pts.length) {
    return {
      distanceMeters: 0,
      durationMs: 0,
      avgSpeedKmh: 0,
    };
  }
  let distanceMeters = 0;
  for (let i = 1; i < pts.length; i += 1) {
    distanceMeters += haversineMeters(pts[i - 1], pts[i]);
  }
  const startTs = Number(pts[0]?.recorded_at || 0);
  const endTs = Number(pts[pts.length - 1]?.recorded_at || 0);
  const durationMs = Math.max(0, endTs - startTs);
  const avgSpeedKmh = durationMs > 0 ? (distanceMeters / (durationMs / 1000)) * 3.6 : 0;
  return { distanceMeters, durationMs, avgSpeedKmh };
});

const patrolStatsText = computed(() => {
  const d = patrolStats.value.distanceMeters;
  const h = Math.floor(patrolStats.value.durationMs / 3600000);
  const m = Math.floor((patrolStats.value.durationMs % 3600000) / 60000);
  const durationText = `${h}小时${m}分钟`;
  const distanceText = d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${Math.round(d)} m`;
  const speedText = patrolStats.value.avgSpeedKmh > 0 ? `${patrolStats.value.avgSpeedKmh.toFixed(1)} km/h` : "—";
  return `里程 ${distanceText} · 时长 ${durationText} · 均速 ${speedText}`;
});

const amapDivRef = ref(null);
const mapError = ref("");
let TMapCtor = null;
let mapInst = null;
let polylineInst = null;
const eventMarkers = [];
let playbackMarker = null;
let currentPosMarker = null;
/** watch 实时段：折线 + 稀疏点（上限控制，兼顾「画点」与流畅） */
let livePolylineInst = null;
const liveTrailDotMarkers = [];
/** 实时轨迹上最多绘制的采样点标记数 */
const LIVE_DOT_SHOW_MAX = 36;
let playbackTimer = null;
const latestDeviceCoord = ref(null);
/** 仅由 watchPosition 写入，用于地图实时绿点 */
const liveTrailCoords = ref([]);
let liveWatchId = null;
/** 避免每次加点都 setViewport 把用户缩放打乱；新巡护会复位 */
let mapAutoViewportDone = false;
/** watch 回调合并到每帧最多重绘一次实时层 */
let liveOverlayRaf = 0;

const playbackIndex = ref(0);
const playbackPlaying = ref(false);

const quickEventSheetVisible = ref(false);
const showEventList = ref(true);
const showTrackList = ref(true);
const sampleBusy = ref(false);
const lastSampleAt = ref(0);
let lastSamplingWarnAt = 0;
const exportPdfBusy = ref(false);
const showEventDetailPopup = ref(false);
const selectedEventDetail = ref(null);
const showPdfConfigPopup = ref(false);
const pdfForm = ref({
  title: "智能巡护简报",
  patrolUser: "护林员",
  patrolDate: "",
  areaText: "",
  generateTime: "",
  keyEventIds: [],
});

function formatCoord(n) {
  const x = Number(n);
  if (n == null || Number.isNaN(x)) return "—";
  return x.toFixed(5);
}

function clampPlaybackIndex() {
  const n = orderedPoints.value.length;
  if (n <= 0) {
    playbackIndex.value = 0;
    return;
  }
  if (playbackIndex.value > n - 1) playbackIndex.value = n - 1;
}

watch(
  () => orderedPoints.value.length,
  () => {
    clampPlaybackIndex();
  }
);

function clearMapOverlays() {
  if (!mapInst) return;
  if (polylineInst) {
    mapInst.removeOverLay(polylineInst);
    polylineInst = null;
  }
  for (const m of eventMarkers.splice(0)) {
    try {
      mapInst.removeOverLay(m);
    } catch {
      /* ignore */
    }
  }
  if (livePolylineInst) {
    try {
      mapInst.removeOverLay(livePolylineInst);
    } catch {
      /* ignore */
    }
    livePolylineInst = null;
  }
  for (const m of liveTrailDotMarkers.splice(0)) {
    try {
      mapInst.removeOverLay(m);
    } catch {
      /* ignore */
    }
  }
  if (playbackMarker) {
    mapInst.removeOverLay(playbackMarker);
    playbackMarker = null;
  }
  if (currentPosMarker) {
    mapInst.removeOverLay(currentPosMarker);
    currentPosMarker = null;
  }
}

function destroyMap() {
  cancelLiveOverlayPaint();
  stopPlayback();
  clearMapOverlays();
  if (mapInst) {
    try {
      mapInst.destroy();
    } catch {
      /* ignore */
    }
    mapInst = null;
  }
  TMapCtor = null;
}

function toTLngLat(row) {
  return new TMapCtor.LngLat(Number(row.lng), Number(row.lat));
}

function dotIconDataUrl(hex) {
  const safe = String(hex || "#1989fa").replace(/"/g, "'");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="9" fill="${safe}" stroke="#ffffff" stroke-width="2"/></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function makeEventMarker(ev) {
  const lnglat = toTLngLat(ev);
  let mk = null;
  try {
    mk = new TMapCtor.Marker(lnglat);
  } catch {
    try {
      mk = new TMapCtor.Marker({ lnglat });
    } catch {
      return null;
    }
  }
  try {
    if (TMapCtor.Icon && TMapCtor.Point && typeof mk.setIcon === "function") {
      const icon = new TMapCtor.Icon({
        iconUrl: dotIconDataUrl(eventTypeColor(ev.type)),
        iconSize: new TMapCtor.Point(26, 26),
        iconAnchor: new TMapCtor.Point(13, 13),
      });
      mk.setIcon(icon);
    }
  } catch {
    /* 保留默认图钉 */
  }
  return mk;
}

function makeLiveTrailDotMarker(lat, lng) {
  const lnglat = new TMapCtor.LngLat(Number(lng), Number(lat));
  const tiny = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="4" fill="#69c0ff" stroke="#fff" stroke-width="1"/></svg>`;
  const url = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(tiny)}`;
  let m = null;
  try {
    m = new TMapCtor.Marker(lnglat);
  } catch {
    try {
      m = new TMapCtor.Marker({ lnglat });
    } catch {
      return null;
    }
  }
  try {
    if (TMapCtor.Icon && TMapCtor.Point && typeof m.setIcon === "function") {
      const icon = new TMapCtor.Icon({
        iconUrl: url,
        iconSize: new TMapCtor.Point(12, 12),
        iconAnchor: new TMapCtor.Point(6, 6),
      });
      m.setIcon(icon);
    }
  } catch {
    /* ignore */
  }
  return m;
}

/** 重绘实时 watch：折线 + 稀疏点 + 当前位置蓝点 */
function paintLiveOverlays() {
  if (!mapInst || !TMapCtor) return;
  if (livePolylineInst) {
    try {
      mapInst.removeOverLay(livePolylineInst);
    } catch {
      /* ignore */
    }
    livePolylineInst = null;
  }
  for (const m of liveTrailDotMarkers.splice(0)) {
    try {
      mapInst.removeOverLay(m);
    } catch {
      /* ignore */
    }
  }
  if (currentPosMarker) {
    try {
      mapInst.removeOverLay(currentPosMarker);
    } catch {
      /* ignore */
    }
    currentPosMarker = null;
  }
  const trail = liveTrailCoords.value.filter(isValidLngLat);
  if (trail.length >= 2) {
    const path = trail.map((p) => new TMapCtor.LngLat(Number(p.lng), Number(p.lat)));
    const lineOpts = { color: "#1890ff", weight: 4, opacity: 0.9, lineStyle: "dashed" };
    try {
      livePolylineInst = new TMapCtor.Polyline(path, lineOpts);
      mapInst.addOverLay(livePolylineInst);
    } catch {
      try {
        livePolylineInst = new TMapCtor.Polyline(path, { color: "#1890ff", weight: 4, opacity: 0.9 });
        mapInst.addOverLay(livePolylineInst);
      } catch {
        /* ignore */
      }
    }
  }
  if (trail.length >= 1) {
    const idxSet = new Set();
    const step = Math.max(1, Math.ceil(trail.length / LIVE_DOT_SHOW_MAX));
    for (let i = 0; i < trail.length; i += step) idxSet.add(i);
    idxSet.add(trail.length - 1);
    for (const i of idxSet) {
      const p = trail[i];
      if (!isValidLngLat(p)) continue;
      const dot = makeLiveTrailDotMarker(p.lat, p.lng);
      if (!dot) continue;
      try {
        dot.setTitle("实时轨迹点");
        mapInst.addOverLay(dot);
        liveTrailDotMarkers.push(dot);
      } catch {
        /* ignore */
      }
    }
  }
  const selfPos = latestDeviceCoord.value;
  const pathArr = orderedPoints.value;
  if (isValidLngLat(selfPos)) {
    currentPosMarker = makeCurrentPosMarker(selfPos);
    if (currentPosMarker) {
      currentPosMarker.setTitle("实时位置（高精度 watch）");
      mapInst.addOverLay(currentPosMarker);
    }
  } else if (pathArr.length) {
    const lastPoint = pathArr[pathArr.length - 1];
    currentPosMarker = makeCurrentPosMarker(lastPoint, { fallback: true });
    if (currentPosMarker) {
      currentPosMarker.setTitle("我的当前位置（最近轨迹点）");
      mapInst.addOverLay(currentPosMarker);
    }
  }
}

function schedulePaintLiveOverlays() {
  if (!mapInst || !TMapCtor) return;
  if (liveOverlayRaf) return;
  liveOverlayRaf = requestAnimationFrame(() => {
    liveOverlayRaf = 0;
    paintLiveOverlays();
  });
}

function cancelLiveOverlayPaint() {
  if (liveOverlayRaf) {
    cancelAnimationFrame(liveOverlayRaf);
    liveOverlayRaf = 0;
  }
}

function stopLivePositionWatch() {
  if (liveWatchId == null) return;
  try {
    navigator.geolocation.clearWatch(liveWatchId);
  } catch {
    /* ignore */
  }
  liveWatchId = null;
}

function startLivePositionWatch() {
  stopLivePositionWatch();
  if (!activeTask.value || typeof navigator === "undefined" || !navigator.geolocation) return;
  const opts = { enableHighAccuracy: true, maximumAge: 0, timeout: 900000 };
  liveWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!activeTask.value) return;
      const lat = Number(pos?.coords?.latitude);
      const lng = Number(pos?.coords?.longitude);
      if (!isValidLngLat({ lat, lng })) return;
      const accuracy = Number(pos?.coords?.accuracy || 0);
      latestDeviceCoord.value = {
        lat,
        lng,
        accuracy,
        source: "gps_watch",
        captured_at: Date.now(),
      };
      const arr = [...liveTrailCoords.value, { lat, lng }];
      liveTrailCoords.value = arr.length > LIVE_TRAIL_MAX ? arr.slice(-LIVE_TRAIL_MAX) : arr;
      schedulePaintLiveOverlays();
    },
    () => {
      /* 定时 getHighAccuracySnapshot 仍会入库兜底 */
    },
    opts
  );
}

function makeCurrentPosMarker(row, opts = {}) {
  const lnglat = toTLngLat(row);
  const color = opts.fallback ? "#969799" : "#1989fa";
  let mk = null;
  try {
    mk = new TMapCtor.Marker(lnglat);
  } catch {
    try {
      mk = new TMapCtor.Marker({ lnglat });
    } catch {
      return null;
    }
  }
  try {
    if (TMapCtor.Icon && TMapCtor.Point && typeof mk.setIcon === "function") {
      const icon = new TMapCtor.Icon({
        iconUrl: dotIconDataUrl(color),
        iconSize: new TMapCtor.Point(30, 30),
        iconAnchor: new TMapCtor.Point(15, 15),
      });
      mk.setIcon(icon);
    }
  } catch {
    /* 默认图钉 */
  }
  return mk;
}

function redrawMapLayers() {
  if (!mapInst || !TMapCtor) return;
  clearMapOverlays();
  const pathArr = orderedPoints.value;
  const path = pathArr.map((p) => toTLngLat(p));

  if (path.length >= 2) {
    polylineInst = new TMapCtor.Polyline(path, {
      color: "#07c160",
      weight: 7,
      opacity: 0.95,
      lineStyle: "solid",
    });
    mapInst.addOverLay(polylineInst);
    if (!mapAutoViewportDone && typeof mapInst.setViewport === "function") {
      mapInst.setViewport(path);
      mapAutoViewportDone = true;
    }
  } else if (path.length === 1 && !mapAutoViewportDone) {
    mapInst.centerAndZoom(path[0], 17);
  }

  for (const ev of events.value) {
    if (!isValidLngLat(ev)) continue;
    const mk = makeEventMarker(ev);
    if (!mk) continue;
    try {
      mk.setTitle(`${eventTypeLabel(ev.type)} ${ev.note || ""}`.trim());
      mapInst.addOverLay(mk);
      eventMarkers.push(mk);
    } catch {
      /* ignore */
    }
  }

  const idx = playbackIndex.value;
  if (path.length && idx >= 0 && idx < path.length) {
    const pos = path[idx];
    playbackMarker = new TMapCtor.Marker(pos);
    playbackMarker.setTitle("轨迹回放当前位置");
    mapInst.addOverLay(playbackMarker);
    if (playbackPlaying.value) mapInst.panTo(pos);
  }

  paintLiveOverlays();
}

async function initAmapIfNeeded() {
  mapError.value = "";
  if (!effectiveOnline.value) {
    mapError.value =
      mapInst && TMapCtor
        ? "当前离线：底图瓦片可能无法更新，地图实例已保留；定位与轨迹/事件记录照常。"
        : "当前离线：可继续定位并记录轨迹/事件，联网后自动加载地图。";
    return;
  }
  if (mapInst) {
    redrawMapLayers();
    return;
  }
  try {
    TMapCtor = await loadTianditu();
  } catch (e) {
    const code = e?.message || "";
    if (code === "no_tianditu_key") {
      mapError.value =
        "未配置天地图 Key：请在服务器 backend/.env.local 中设置 TIANDITU_JS_KEY，或在 index.html 的 <head> 内增加 meta forestry-tianditu-key 后刷新页面。";
    }
    else if (code === "tianditu_runtime_config_404") {
      mapError.value = "后端未提供 /api/public/client-config（疑似服务器未更新到最新代码），请先在服务器 git pull 并重启后端。";
    }
    else if (code === "tianditu_load_timeout") mapError.value = "天地图脚本加载超时，请检查网络或域名白名单配置";
    else mapError.value = "天地图加载失败";
    return;
  }
  await nextTick();
  const el = amapDivRef.value;
  if (!el) return;
  const pathArr = orderedPoints.value;
  let center = [116.397428, 39.90923];
  let zoom = 12;
  if (pathArr.length) {
    const last = pathArr[pathArr.length - 1];
    center = [Number(last.lng), Number(last.lat)];
    zoom = 15;
  }
  try {
    mapInst = new TMapCtor.Map(el);
    mapInst.centerAndZoom(new TMapCtor.LngLat(center[0], center[1]), zoom);
    try {
      const hybrid = typeof window !== "undefined" ? (window.TMAP_HYBRID_MAP || window.TMAP_SATELLITE_MAP) : null;
      if (hybrid && typeof mapInst.setMapType === "function") {
        mapInst.setMapType(hybrid);
      }
    } catch {
      /* ignore */
    }
    redrawMapLayers();
    requestAnimationFrame(() => {
      try {
        mapInst?.resize();
      } catch {
        /* ignore */
      }
    });
  } catch {
    TMapCtor = null;
    mapInst = null;
    mapError.value = "地图初始化失败：请刷新页面或检查天地图脚本是否被浏览器拦截。";
  }
}

watch([points, events, playbackIndex], () => {
  if (mapInst) redrawMapLayers();
}, { deep: true });

watch(effectiveOnline, (online) => {
  if (online) {
    void initAmapIfNeeded();
    return;
  }
  mapError.value =
    mapInst && TMapCtor
      ? "当前离线：底图可能暂停刷新，地图不销毁；恢复网络后瓦片会继续加载。"
      : "当前离线：可继续定位并记录轨迹/事件，联网后自动加载地图。";
});

function centerMapToCurrentPosition() {
  if (!mapInst || !TMapCtor) {
    showToast(effectiveOnline.value ? "地图尚未加载完成" : "当前离线，地图暂不可用");
    return;
  }
  const selfPos = latestDeviceCoord.value;
  if (isValidLngLat(selfPos)) {
    mapInst.panTo(toTLngLat(selfPos));
    showToast("已定位到当前坐标");
    return;
  }
  const path = orderedPoints.value;
  if (path.length) {
    mapInst.panTo(toTLngLat(path[path.length - 1]));
    showToast("已定位到最近轨迹点");
    return;
  }
  showToast("暂无可定位坐标");
}

function fitMapToTrack() {
  if (!mapInst || !TMapCtor) {
    showToast("地图尚未就绪");
    return;
  }
  const path = orderedPoints.value.map((p) => toTLngLat(p));
  if (!path.length) {
    showToast("暂无轨迹点");
    return;
  }
  if (path.length === 1) {
    mapInst.centerAndZoom(path[0], 17);
    return;
  }
  if (typeof mapInst.setViewport === "function") {
    mapInst.setViewport(path);
  }
}

function focusEventOnMap(ev) {
  if (!isValidLngLat(ev)) {
    showToast("该事件缺少有效坐标");
    return;
  }
  if (!mapInst || !TMapCtor) {
    showToast("地图尚未加载完成");
    return;
  }
  const pos = toTLngLat(ev);
  mapInst.panTo(pos);
  if (typeof mapInst.centerAndZoom === "function") {
    mapInst.centerAndZoom(pos, 17);
  }
  selectedEventDetail.value = ev;
  showEventDetailPopup.value = true;
}

/** 详情浮窗内「地图定位」：关浮窗后仅移动地图，避免再次弹出详情 */
function refocusSelectedEventOnMap() {
  const ev = selectedEventDetail.value;
  if (!ev || !isValidLngLat(ev)) return;
  showEventDetailPopup.value = false;
  void nextTick(() => {
    if (!mapInst || !TMapCtor) return;
    const pos = toTLngLat(ev);
    mapInst.panTo(pos);
    if (typeof mapInst.centerAndZoom === "function") {
      mapInst.centerAndZoom(pos, 17);
    }
  });
}

function stopPlayback() {
  if (playbackTimer) {
    clearInterval(playbackTimer);
    playbackTimer = null;
  }
  playbackPlaying.value = false;
}

function togglePlayback() {
  const n = orderedPoints.value.length;
  if (n < 2) {
    showToast("至少两个轨迹点才能回放");
    return;
  }
  if (playbackPlaying.value) {
    stopPlayback();
    return;
  }
  playbackPlaying.value = true;
  playbackTimer = setInterval(() => {
    const len = orderedPoints.value.length;
    if (len < 2) {
      stopPlayback();
      return;
    }
    let next = playbackIndex.value + 1;
    if (next >= len) next = 0;
    playbackIndex.value = next;
  }, PLAYBACK_STEP_MS);
}

async function loadPointsAndEvents(taskId) {
  const [allTasks, allE] = await Promise.all([
    getAllRecords(stores.patrolTasks),
    getAllRecords(stores.patrolEvents),
  ]);
  const task = allTasks.find((t) => t.local_id === taskId);
  events.value = allE
    .filter((e) => e.task_local_id === taskId)
    .sort((a, b) => b.recorded_at - a.recorded_at);

  let pts = [];
  if (task && Array.isArray(task.track_points) && task.track_points.length > 0) {
    pts = [...task.track_points];
  } else {
    const allP = await getAllRecords(stores.patrolPoints);
    pts = allP.filter((p) => p.task_local_id === taskId);
  }
  const sortPts = (arr) => [...arr].sort((a, b) => (a.recorded_at || 0) - (b.recorded_at || 0));
  if (task?.status === "active" && pts.length === 0) {
    return;
  }
  points.value = sortPts(pts);
}

function clearSamplingTimer() {
  if (samplingTimer.value) {
    clearTimeout(samplingTimer.value);
    samplingTimer.value = null;
  }
}

function notifySamplingIssue(message) {
  const now = Date.now();
  if (now - lastSamplingWarnAt < 20000) return;
  lastSamplingWarnAt = now;
  showToast(message);
}

function scheduleNextSample(delayMs) {
  if (!activeTask.value) return;
  clearSamplingTimer();
  samplingTimer.value = setTimeout(async () => {
    if (!activeTask.value) return;
    await recordSamplePoint();
    if (!activeTask.value) return;
    scheduleNextSample(SAMPLE_INTERVAL_MS);
  }, Math.max(400, Number(delayMs) || SAMPLE_INTERVAL_MS));
}

async function resolvePositionOnce() {
  const pos = await getCurrentPositionCompat();
  latestDeviceCoord.value = {
    lat: Number(pos?.coords?.latitude),
    lng: Number(pos?.coords?.longitude),
    accuracy: Number(pos?.coords?.accuracy || 0),
    source: "gps",
    captured_at: Date.now(),
  };
  return pos;
}

async function resolvePositionForSampling() {
  const pos = await getHighAccuracySnapshot();
  latestDeviceCoord.value = {
    lat: Number(pos?.coords?.latitude),
    lng: Number(pos?.coords?.longitude),
    accuracy: Number(pos?.coords?.accuracy || 0),
    source: "gps_sample",
    captured_at: Date.now(),
  };
  return pos;
}

async function recordSamplePoint() {
  if (!activeTask.value) return;
  if (sampleBusy.value) return false;
  const taskId = activeTask.value.local_id;
  sampleBusy.value = true;
  try {
    const pos = await resolvePositionForSampling();
    if (!activeTask.value || activeTask.value.local_id !== taskId) return false;
    const lat = Number(pos.coords.latitude);
    const lng = Number(pos.coords.longitude);
    const acc = Number(pos.coords.accuracy || 0);
    if (!isValidLngLat({ lat, lng })) {
      notifySamplingIssue("定位坐标无效，轨迹点未记录");
      return false;
    }
    const prev = orderedPoints.value.length ? orderedPoints.value[orderedPoints.value.length - 1] : null;
    if (prev) {
      const dt = Math.max(1, Date.now() - Number(prev.recorded_at || 0));
      const dist = haversineMeters(prev, { lat, lng });
      const speedMps = dist / (dt / 1000);
      if (dt <= JUMP_CHECK_WINDOW_MS && dist >= JUMP_DISTANCE_M && speedMps > JUMP_SPEED_MPS) {
        notifySamplingIssue("检测到疑似漂移点，已自动忽略");
        return false;
      }
    }
    const rec = {
      local_id: uid("ppt"),
      task_local_id: taskId,
      lat,
      lng,
      accuracy: acc,
      quality_level: classifyAccuracyLevel(acc),
      source: "gps_track",
      recorded_at: Date.now(),
    };
    if (!activeTask.value || activeTask.value.local_id !== taskId) return false;
    points.value = [...points.value, rec].sort((a, b) => a.recorded_at - b.recorded_at);
    lastSampleAt.value = rec.recorded_at;
    return true;
  } catch (e) {
    notifySamplingIssue(`${describeGeoError(e, "定位失败")}，轨迹点未记录`);
    return false;
  } finally {
    sampleBusy.value = false;
  }
}

function startSamplingLoop(withImmediate) {
  clearSamplingTimer();
  if (withImmediate) {
    void recordSamplePoint().finally(() => {
      if (!activeTask.value) return;
      scheduleNextSample(SAMPLE_INTERVAL_MS);
    });
    return;
  }
  scheduleNextSample(SAMPLE_INTERVAL_MS);
}

async function sampleNow() {
  if (!activeTask.value) return;
  const ok = await recordSamplePoint();
  if (!activeTask.value) return;
  scheduleNextSample(SAMPLE_INTERVAL_MS);
  if (ok) showSuccessToast("已完成一次即时采样");
}

async function startPatrol() {
  if (points.value.length || events.value.length || endedTaskView.value) {
    try {
      await showConfirmDialog({
        title: "开始新巡护",
        message: "将清空本页展示的数据（已写入手机的记录仍保留在本机）。",
      });
    } catch {
      return;
    }
  }
  endedTaskView.value = null;
  points.value = [];
  events.value = [];
  lastSampleAt.value = 0;
  liveTrailCoords.value = [];
  stopLivePositionWatch();
  mapAutoViewportDone = false;

  gpsBusy.value = true;
  try {
    if (!navigator.geolocation) {
      showFailToast("当前设备不支持定位");
      return;
    }
    await resolvePositionOnce();
  } catch (e) {
    showFailToast(describeGeoError(e, "无法开始巡护"));
    return;
  } finally {
    gpsBusy.value = false;
  }
  const task = {
    local_id: uid("ptsk"),
    started_at: Date.now(),
    ended_at: null,
    status: "active",
    title: `巡护 ${formatTime(Date.now())}`,
  };
  await putRecord(stores.patrolTasks, task);
  activeTask.value = task;
  liveTrailCoords.value = [];
  startLivePositionWatch();
  showSuccessToast("已开始巡护：定时采样在内存中累计，结束本次巡护时一次性写入整条轨迹；watch 持续对齐地图");
  startSamplingLoop(true);
}

async function stopPatrol() {
  if (!activeTask.value) return;
  try {
    await showConfirmDialog({ title: "结束巡护", message: "结束本次巡护并停止自动采样？" });
  } catch {
    return;
  }
  clearSamplingTimer();
  stopLivePositionWatch();
  liveTrailCoords.value = [];
  const taskId = activeTask.value.local_id;
  const trackSnapshot = [...orderedPoints.value];
  const ended = {
    ...activeTask.value,
    ended_at: Date.now(),
    status: "ended",
    track_points: trackSnapshot,
  };
  await putRecord(stores.patrolTasks, ended);
  await deletePatrolPointsForTask(taskId);
  endedTaskView.value = ended;
  activeTask.value = null;
  showSuccessToast("巡护已结束，整条轨迹与事件已保存在本机");
}

async function restoreActivePatrol() {
  const tasks = await getAllRecords(stores.patrolTasks);
  const active = tasks
    .filter((t) => t.status === "active")
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0];
  if (active) {
    activeTask.value = active;
    mapAutoViewportDone = false;
    await loadPointsAndEvents(active.local_id);
    const latest = [...points.value].sort((a, b) => (b.recorded_at || 0) - (a.recorded_at || 0))[0];
    lastSampleAt.value = Number(latest?.recorded_at || 0);
    startLivePositionWatch();
    startSamplingLoop(false);
    showToast("已恢复进行中的巡护（未结束前轨迹仅在本页内存，刷新会丢失）");
  }
}

/** 最近一次有效轨迹点；maxAgeMs 内可用，用于定位慢或失败时仍能记事件 */
function coordinatesFromLastPointOrNull(maxAgeMs = 25 * 60 * 1000) {
  const sorted = [...points.value].sort((a, b) => (b.recorded_at || 0) - (a.recorded_at || 0));
  const last = sorted[0];
  if (!last) return null;
  const recAt = Number(last.recorded_at || 0);
  const age = recAt > 0 ? Date.now() - recAt : Number.POSITIVE_INFINITY;
  if (age > maxAgeMs) return null;
  const lat = Number(last.lat);
  const lng = Number(last.lng);
  if (!isValidLngLat({ lat, lng })) return null;
  return {
    lat,
    lng,
    accuracy: Number(last.accuracy || 0),
    source: "track_point",
  };
}

function freshDeviceCoordForEventOrNull() {
  const w = latestDeviceCoord.value;
  if (!w || !isValidLngLat(w)) return null;
  const age = Date.now() - Number(w.captured_at || 0);
  if (age > 90000) return null;
  const src = String(w.source || "");
  const ok =
    src === "gps_watch" ||
    src === "gps_sample" ||
    src === "gps" ||
    src === "gps_live_event";
  if (!ok) return null;
  const outSource =
    src === "gps_watch" ? "gps_watch" : src === "gps_sample" ? "gps_sample" : src === "gps_live_event" ? "gps_live_event" : "gps";
  return {
    lat: Number(w.lat),
    lng: Number(w.lng),
    accuracy: Number(w.accuracy || 0),
    source: outSource,
  };
}

async function resolveCoordsForEvent() {
  const fresh = freshDeviceCoordForEventOrNull();
  if (fresh) return fresh;

  const trailTtl = activeTask.value ? 4 * 60 * 60 * 1000 : 25 * 60 * 1000;
  const fromTrailEarly = coordinatesFromLastPointOrNull(trailTtl);
  if (fromTrailEarly) return fromTrailEarly;

  try {
    const pos = await getQuickPositionForEvent(11000);
    const lat = Number(pos.coords.latitude);
    const lng = Number(pos.coords.longitude);
    const accuracy = Number(pos.coords.accuracy || 0);
    if (!isValidLngLat({ lat, lng })) throw new Error("bad_coord");
    latestDeviceCoord.value = {
      lat,
      lng,
      accuracy,
      source: "gps_live_event",
      captured_at: Date.now(),
    };
    return { lat, lng, accuracy, source: "gps_quick" };
  } catch {
    /* fall through */
  }

  try {
    const pos = await getHighAccuracySnapshot();
    const lat = Number(pos.coords.latitude);
    const lng = Number(pos.coords.longitude);
    const accuracy = Number(pos.coords.accuracy || 0);
    if (!isValidLngLat({ lat, lng })) throw new Error("bad_coord");
    latestDeviceCoord.value = {
      lat,
      lng,
      accuracy,
      source: "gps_live_event",
      captured_at: Date.now(),
    };
    return { lat, lng, accuracy, source: "gps_live" };
  } catch {
    /* fall through */
  }

  const fromTrailLoose = coordinatesFromLastPointOrNull(366 * 24 * 60 * 60 * 1000);
  if (fromTrailLoose) return fromTrailLoose;
  throw new Error("bad_coord");
}

async function persistPatrolEvent({ lat, lng, type, note, photo, accuracy, source }) {
  if (!activeTask.value) return;
  const rec = {
    local_id: uid("pevt"),
    task_local_id: activeTask.value.local_id,
    type,
    lat,
    lng,
    note: (note || "").trim(),
    photo_dataurl: photo || null,
    accuracy: Number(accuracy || 0),
    quality_level: classifyAccuracyLevel(accuracy),
    source: source || "unknown",
    recorded_at: Date.now(),
  };
  await putRecord(stores.patrolEvents, rec);
  await loadPointsAndEvents(activeTask.value.local_id);
  await nextTick();
  if (mapInst && TMapCtor) redrawMapLayers();
  return rec;
}

async function quickRecordAnomaly() {
  if (!activeTask.value) {
    showFailToast("请先开始巡护");
    return;
  }
  quickEventSheetVisible.value = true;
}

async function onQuickEventSelect(action) {
  const type = action?.value || EVENT_TYPES.find((t) => t.label === action?.name)?.value;
  if (!type) return;

  eventSaveBusy.value = true;
  try {
    const { lat, lng, accuracy, source } = await resolveCoordsForEvent();
    const rec = await persistPatrolEvent({
      lat,
      lng,
      type,
      note: "一键记录异常",
      photo: null,
      accuracy,
      source,
    });
    if (mapInst && TMapCtor && rec) {
      mapInst.panTo(toTLngLat(rec));
    }
    showSuccessToast("已保存事件");
  } catch {
    showFailToast("未取得坐标：请稍等定位或走几步再试，也可用「记录事件」");
  } finally {
    eventSaveBusy.value = false;
  }
}

function openEventSheet() {
  if (!activeTask.value) {
    showFailToast("请先开始巡护");
    return;
  }
  eventType.value = "pest";
  eventNote.value = "";
  eventPhotoDataUrl.value = "";
  showEventSheet.value = true;
}

async function saveEvent() {
  if (!activeTask.value) return;
  eventSaveBusy.value = true;
  try {
    const { lat, lng, accuracy, source } = await resolveCoordsForEvent();
    const rec = await persistPatrolEvent({
      lat,
      lng,
      type: eventType.value,
      note: (eventNote.value || "").trim(),
      photo: eventPhotoDataUrl.value || null,
      accuracy,
      source,
    });
    if (mapInst && TMapCtor && rec) {
      mapInst.panTo(toTLngLat(rec));
    }
    showEventSheet.value = false;
    showSuccessToast("事件已保存");
  } catch {
    showFailToast("无法获取有效位置，事件未保存（可稍等定位或走几步再试）");
  } finally {
    eventSaveBusy.value = false;
  }
}

async function captureMapSnapshotOrNull() {
  const el = amapDivRef.value;
  if (!el) return null;
  try {
    const { default: html2canvas } = await import("html2canvas");
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const canvas = await html2canvas(el, {
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#f7f8fa",
      scale: dpr,
      logging: false,
    });
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return null;
  }
}

function resetPdfFormDefaults() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  pdfForm.value = {
    title: "智能巡护简报",
    patrolUser: "护林员",
    patrolDate: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`,
    areaText: "",
    generateTime: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`,
    keyEventIds: events.value.slice(0, 3).map((e) => String(e.local_id)),
  };
}

function openPdfConfig() {
  if (!points.value.length && !events.value.length) {
    showToast("暂无可导出的巡护数据");
    return;
  }
  resetPdfFormDefaults();
  showPdfConfigPopup.value = true;
}

async function exportPatrolPdf() {
  exportPdfBusy.value = true;
  try {
    /** html2canvas 往往截不到天地图上的折线/Marker，有轨迹或事件时强制用画布缩略图 */
    const useCanvasMap =
      orderedPoints.value.length >= 1 || events.value.length > 0;
    const mapSnapshot = useCanvasMap ? null : await captureMapSnapshotOrNull();
    const generateTimeText = pdfForm.value.generateTime
      ? String(pdfForm.value.generateTime).replace("T", " ")
      : formatTime(Date.now());
    await exportPatrolPdfReport({
      points: orderedPoints.value,
      events: events.value,
      patrolStats: patrolStats.value,
      reportMeta: {
        title: pdfForm.value.title || "智能巡护简报",
        patrolUser: pdfForm.value.patrolUser || "护林员",
        patrolDate: pdfForm.value.patrolDate || formatTime(Date.now()).slice(0, 10),
        areaText: pdfForm.value.areaText || "未填写",
        generateTimeText,
      },
      mapDataUrlPreferred: mapSnapshot,
      keyEventIds: (pdfForm.value.keyEventIds || []).map((id) => String(id)),
      eventTypeLabel,
      eventTypeColor,
      formatTime,
    });
    showPdfConfigPopup.value = false;
    showSuccessToast("PDF 已导出");
  } catch {
    showFailToast("导出失败，请稍后重试");
  } finally {
    exportPdfBusy.value = false;
  }
}

function currentTaskId() {
  return activeTask.value?.local_id || endedTaskView.value?.local_id || null;
}

async function deleteEvent(ev) {
  const tid = currentTaskId();
  if (!tid) return;
  try {
    await showConfirmDialog({ title: "删除事件", message: "确定删除该条记录？" });
  } catch {
    return;
  }
  await deleteRecord(stores.patrolEvents, ev.local_id);
  await loadPointsAndEvents(tid);
  showSuccessToast("已删除");
}

let unbindMapVisibility = () => {};

/** 回到前台时校正地图尺寸；长时间后台则重启 watch，减轻定位「断感」 */
function setupMapVisibilityRecovery() {
  let lastHiddenAt = 0;
  const refresh = () => {
    void nextTick(() => {
      try {
        mapInst?.resize?.();
      } catch {
        /* ignore */
      }
      if (mapInst && TMapCtor) redrawMapLayers();
      const gap = lastHiddenAt ? Date.now() - lastHiddenAt : 0;
      if (gap > 45_000 && activeTask.value) startLivePositionWatch();
    });
  };
  const onVis = () => {
    if (document.visibilityState === "hidden") {
      lastHiddenAt = Date.now();
      return;
    }
    refresh();
  };
  const onPageShow = (e) => {
    if (e.persisted) refresh();
  };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pageshow", onPageShow);
  };
}

onMounted(async () => {
  unbindMapVisibility = setupMapVisibilityRecovery();
  try {
    await restoreActivePatrol();
  } catch {
    showFailToast("本地数据库打开失败，请刷新页面或检查浏览器是否禁用存储");
  }
  await nextTick();
  void initAmapIfNeeded();
});

onUnmounted(() => {
  unbindMapVisibility();
  clearSamplingTimer();
  stopPlayback();
  stopLivePositionWatch();
  destroyMap();
});
</script>

<template>
  <div class="page">
    <van-nav-bar title="巡护助手" left-arrow @click-left="$router.back()" />

    <div class="panel patrol-one">
      <div class="top-row">
        <div v-if="activeTask" class="status-chip">
          <span class="dot" />
          巡护中
        </div>
        <div v-else-if="endedTaskView" class="status-chip ended">已结束</div>
        <div v-else class="status-chip muted">未开始</div>
        <div class="net-chip">网络：{{ effectiveOnline ? "在线" : "离线" }}</div>
      </div>

      <div class="map-wrap">
        <p class="hint tight">
          事件随时写入本机；轨迹在「结束巡护」时整条写入任务记录。巡护进行中轨迹仅存本页内存，刷新会丢失。网络短暂波动不会立刻切离线地图；定位在后台较久后会自动恢复 watch。
        </p>
        <div class="stats-chip">{{ patrolStatsText }}</div>
        <div v-if="mapError" class="map-fallback">
          <p>{{ mapError }}</p>
          <p v-if="mapError.includes('离线')" class="sub">
            事件照常写入本机；轨迹仍在内存中累计，结束巡护后写入。恢复网络后可继续看地图。
          </p>
          <p v-else-if="mapError.includes('超时') || mapError.includes('脚本')" class="sub">
            请检查网络、天地图控制台域名白名单与 Key 配置。
          </p>
          <p v-else class="sub">
            可在服务器 backend/.env.local 中配置 TIANDITU_JS_KEY；或在当前页 index.html 增加 meta forestry-tianditu-key
            后强刷，无需重新 npm build。
          </p>
        </div>
        <div class="map-stage">
          <div ref="amapDivRef" class="amap-box" />
        </div>
        <div class="recenter-row">
          <van-button class="recenter-btn" size="small" round type="primary" @click="centerMapToCurrentPosition">定位到我</van-button>
        </div>
        <div class="map-tool-row">
          <van-button size="small" plain type="primary" @click="fitMapToTrack">显示轨迹</van-button>
          <van-button size="small" plain type="primary" :disabled="orderedPoints.length < 2" @click="togglePlayback">
            {{ playbackPlaying ? "暂停回放" : "播放回放" }}
          </van-button>
          <span class="play-label">位置 {{ orderedPoints.length ? playbackIndex + 1 : 0 }} / {{ orderedPoints.length }}</span>
        </div>
        <van-slider
          v-model="playbackIndex"
          :min="0"
          :max="Math.max(0, orderedPoints.length - 1)"
          :disabled="orderedPoints.length < 1"
          bar-height="4px"
          active-color="#07c160"
        />
        <div class="map-legend map-legend-lines">
          <span class="legend-title">图层</span>
          <span class="legend-item"><span class="legend-line solid" />已记录轨迹</span>
          <span class="legend-item"><span class="legend-line dash" />实时 watch</span>
          <span class="legend-item"><span class="legend-dot cyan" />实时采样点</span>
          <span class="legend-item"><span class="legend-dot blue" />当前位置</span>
        </div>
        <div class="map-legend">
          <span class="legend-title">事件</span>
          <span v-for="t in EVENT_TYPES" :key="`legend_${t.value}`" class="legend-item">
            <span class="legend-dot" :style="{ backgroundColor: t.color }" />
            {{ t.label }}
          </span>
        </div>
      </div>

      <div class="actions compact-actions">
        <van-button v-if="!activeTask" type="primary" block :loading="gpsBusy" @click="startPatrol">
          {{ endedTaskView ? "开始新巡护" : "开始巡护" }}
        </van-button>
        <van-button
          v-if="points.length || events.length || endedTaskView"
          type="success"
          block
          plain
          :loading="exportPdfBusy"
          @click="openPdfConfig"
        >
          导出PDF巡护报告
        </van-button>
        <template v-if="activeTask">
          <van-button type="danger" block plain @click="stopPatrol">结束巡护</van-button>
          <van-button type="warning" block plain @click="openEventSheet">标记事件</van-button>
          <van-button type="primary" block plain :loading="eventSaveBusy" @click="quickRecordAnomaly">一键异常</van-button>
          <van-button type="default" block plain :loading="sampleBusy" @click="sampleNow">立即采样</van-button>
        </template>
      </div>

      <div class="storage-toggle-row">
        <van-button size="small" :type="showEventList ? 'primary' : 'default'" plain @click="showEventList = !showEventList">事件</van-button>
        <van-button size="small" :type="showTrackList ? 'primary' : 'default'" plain @click="showTrackList = !showTrackList">轨迹</van-button>
      </div>

      <PatrolEventList
        :show="showEventList"
        :events="events"
        :event-type-label="eventTypeLabel"
        :format-time="formatTime"
        :format-coord="formatCoord"
        :location-source-label="locationSourceLabel"
        @focus="focusEventOnMap"
        @delete="deleteEvent"
      />

      <PatrolTrackList
        :show="showTrackList"
        :points="points"
        :format-time="formatTime"
        :format-coord="formatCoord"
      />
    </div>
  </div>
  <van-action-sheet
    v-model:show="quickEventSheetVisible"
    teleport="body"
    title="一键记录异常"
    description="优先用地图上实时位置；否则按高精度定位或最近轨迹点。"
    :actions="EVENT_TYPES.map((t) => ({ name: t.label, value: t.value, color: t.color }))"
    close-on-click-action
    cancel-text="取消"
    class="patrol-action-sheet"
    @select="onQuickEventSelect"
  />

  <PatrolEventSheet
    v-model:show="showEventSheet"
    v-model:event-type="eventType"
    v-model:event-note="eventNote"
    v-model:event-photo-data-url="eventPhotoDataUrl"
    :event-types="EVENT_TYPES"
    :saving="eventSaveBusy"
    @save="saveEvent"
  />

  <van-popup
    v-model:show="showEventDetailPopup"
    position="bottom"
    round
    teleport="body"
    class="patrol-popup-root"
    :style="{ padding: '0' }"
  >
    <div class="patrol-popup-inner">
      <h3 class="sheet-title">{{ eventTypeLabel(selectedEventDetail?.type) }}</h3>
      <div class="detail-lines">
        <p>时间：{{ formatTime(selectedEventDetail?.recorded_at) }}</p>
        <p>坐标：{{ formatCoord(selectedEventDetail?.lat) }}, {{ formatCoord(selectedEventDetail?.lng) }}</p>
        <p>定位来源：{{ locationSourceLabel(selectedEventDetail?.source) }}</p>
        <p>精度：{{ Number.isFinite(Number(selectedEventDetail?.accuracy)) && Number(selectedEventDetail?.accuracy) > 0 ? `约 ${Math.round(Number(selectedEventDetail?.accuracy))} m` : "—" }}</p>
        <p>备注：{{ selectedEventDetail?.note || "—" }}</p>
      </div>
      <img v-if="selectedEventDetail?.photo_dataurl" :src="selectedEventDetail.photo_dataurl" alt="事件照片" class="detail-photo" />
      <div class="detail-actions sheet-actions">
        <van-button block type="default" @click="showEventDetailPopup = false">关闭</van-button>
        <van-button
          v-if="selectedEventDetail && isValidLngLat(selectedEventDetail)"
          block
          type="primary"
          plain
          @click="refocusSelectedEventOnMap"
        >
          地图定位
        </van-button>
      </div>
    </div>
  </van-popup>

  <van-popup
    v-model:show="showPdfConfigPopup"
    position="bottom"
    round
    teleport="body"
    class="patrol-popup-root"
    :style="{ padding: '0' }"
  >
    <div class="patrol-popup-inner">
      <h3 class="sheet-title">导出PDF设置</h3>
      <van-field v-model="pdfForm.title" label="标题" placeholder="智能巡护简报" />
      <van-field v-model="pdfForm.patrolUser" label="巡护员" placeholder="护林员姓名" />
      <van-field v-model="pdfForm.patrolDate" label="日期" placeholder="YYYY-MM-DD" />
      <van-field v-model="pdfForm.areaText" label="区域" placeholder="如：第3责任区" />
      <div class="pdf-time-row">
        <span class="pdf-time-label">生成时间</span>
        <input v-model="pdfForm.generateTime" class="pdf-time-input" type="datetime-local" />
        <van-button size="small" plain type="primary" @click="resetPdfFormDefaults">当前时间</van-button>
      </div>
      <div class="pdf-key-events">
        <div class="pdf-key-title">重点事件（可多选）</div>
        <van-checkbox-group v-model="pdfForm.keyEventIds">
          <van-checkbox
            v-for="ev in events.slice(0, 10)"
            :key="ev.local_id"
            :name="String(ev.local_id)"
            shape="square"
            class="pdf-key-item"
          >
            {{ eventTypeLabel(ev.type) }} · {{ formatTime(ev.recorded_at) }}{{ ev.note ? ` · ${ev.note}` : "" }}
          </van-checkbox>
        </van-checkbox-group>
      </div>
      <div class="sheet-actions">
        <van-button block type="default" @click="showPdfConfigPopup = false">取消</van-button>
        <van-button block type="primary" :loading="exportPdfBusy" @click="exportPatrolPdf">生成并导出</van-button>
      </div>
    </div>
  </van-popup>

</template>

<style scoped>
.page {
  min-height: 100dvh;
  min-height: -webkit-fill-available;
  box-sizing: border-box;
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 52px);
  background: #f6f7fb;
}

.patrol-one {
  padding-bottom: 8px;
}

.panel {
  padding: 12px 12px 24px;
}

.top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.net-chip {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: #646566;
  background: #f2f3f5;
}

.map-wrap {
  margin-bottom: 12px;
}

.stats-chip {
  margin: 0 0 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: #323233;
  background: #f7f8fa;
  border: 1px solid #ebedf0;
  border-radius: 8px;
}

.hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: #646566;
  line-height: 1.55;
}

.hint.tight {
  margin-bottom: 8px;
}

.map-tool-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 10px;
}

.map-stage {
  position: relative;
}

.recenter-row {
  display: flex;
  justify-content: flex-end;
  margin: 8px 0 10px;
}

.recenter-btn {
  min-width: 72px;
  height: 34px;
  padding: 0 12px;
  font-weight: 600;
}

.compact-actions {
  margin-bottom: 10px;
}

.storage-toggle-row {
  display: flex;
  gap: 10px;
  margin: 0 0 8px;
}

.map-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin: 0 0 10px;
}

.legend-title {
  font-size: 12px;
  color: #969799;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #646566;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}

.legend-dot.blue {
  background: #1989fa;
}

.legend-dot.cyan {
  background: #69c0ff;
}

.map-legend-lines {
  margin-bottom: 6px;
}

.legend-line {
  display: inline-block;
  width: 22px;
  height: 0;
  border-top: 3px solid #07c160;
  vertical-align: middle;
  margin-right: 2px;
}

.legend-line.dash {
  border-top-style: dashed;
  border-top-color: #1890ff;
}

.legend-line.solid {
  border-top-style: solid;
}

.patrol-popup-inner {
  max-height: min(88vh, 640px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 16px;
  padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
}

.detail-actions.sheet-actions {
  margin-top: 12px;
}

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 20px;
  background: #e8f5e9;
  color: #07c160;
  font-size: 13px;
  margin-bottom: 12px;
}

.status-chip.muted {
  background: #f0f0f0;
  color: #969799;
}

.status-chip.ended {
  background: #fff7e6;
  color: #ff976a;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #07c160;
  animation: pulse 1.4s ease infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}

.amap-box {
  width: 100%;
  height: 300px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #ebedf0;
  background: #e8ecf1;
}

.map-fallback {
  padding: 12px;
  background: #fff7e6;
  border-radius: 8px;
  font-size: 13px;
  color: #646566;
  margin-bottom: 10px;
}

.map-fallback .sub {
  margin: 8px 0 0;
  font-size: 12px;
  color: #969799;
}

.play-label {
  font-size: 13px;
  color: #646566;
}

.sheet-title {
  margin: 0 0 12px;
  font-size: 16px;
  text-align: center;
}

.sheet-actions {
  display: flex;
  gap: 10px;
}

.sheet-actions .van-button {
  flex: 1;
}

.detail-lines {
  font-size: 13px;
  color: #323233;
  line-height: 1.6;
  margin-bottom: 10px;
}

.detail-lines p {
  margin: 0 0 4px;
}

.detail-photo {
  display: block;
  width: 100%;
  max-height: 220px;
  object-fit: contain;
  border-radius: 8px;
  border: 1px solid #ebedf0;
  margin-bottom: 12px;
}

.detail-actions {
  margin-top: 6px;
}

.pdf-time-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 12px;
}

.pdf-time-label {
  width: 68px;
  font-size: 14px;
  color: #323233;
  flex-shrink: 0;
}

.pdf-time-input {
  flex: 1;
  min-width: 0;
  border: 1px solid #ebedf0;
  border-radius: 8px;
  height: 34px;
  padding: 0 8px;
  background: #fff;
  color: #323233;
}

.pdf-key-events {
  margin-bottom: 12px;
  padding: 10px;
  border: 1px solid #ebedf0;
  border-radius: 8px;
  background: #fafafa;
  max-height: 180px;
  overflow: auto;
}

.pdf-key-title {
  font-size: 13px;
  color: #646566;
  margin-bottom: 8px;
}

.pdf-key-item {
  display: block;
  margin-bottom: 8px;
}

</style>
