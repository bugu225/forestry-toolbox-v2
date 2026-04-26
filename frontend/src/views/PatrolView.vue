<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from "vant";
import { storeToRefs } from "pinia";
import { useNetworkStore } from "../stores/network";
import { loadTianditu } from "../services/tiandituLoader";
import { deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";
import { describeGeoError, getCurrentPositionCompat } from "../utils/geolocation";

const networkStore = useNetworkStore();
const { effectiveOnline } = storeToRefs(networkStore);

const SAMPLE_INTERVAL_MOVING_MS = 15 * 1000;
const SAMPLE_INTERVAL_STATIC_MS = 60 * 1000;
const ACCEPTABLE_ACCURACY_M = 100;
const GOOD_ACCURACY_M = 50;
const STATIONARY_DISTANCE_M = 10;
const JUMP_CHECK_WINDOW_MS = 60 * 1000;
const JUMP_DISTANCE_M = 200;
const JUMP_SPEED_MPS = 12;
const MAX_AUDIO_MS = 120000;
const PLAYBACK_STEP_MS = 800;

const EVENT_TYPES = [
  { value: "pest", label: "病虫害", color: "#722ed1" },
  { value: "fire", label: "火情", color: "#ee0a24" },
  { value: "illegal", label: "盗伐", color: "#ed6a0c" },
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
const eventAudioDataUrl = ref("");
const photoInputRef = ref(null);

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
let playbackTimer = null;
const latestDeviceCoord = ref(null);

const playbackIndex = ref(0);
const playbackPlaying = ref(false);

const isRecording = ref(false);
const recordingMime = ref("");
let mediaRecorder = null;
let mediaChunks = [];
let mediaStream = null;
let recordStopTimer = null;

const quickEventSheetVisible = ref(false);
const showEventList = ref(true);
const showTrackList = ref(true);
const sampleBusy = ref(false);
const lastSampleAt = ref(0);
let lastSamplingWarnAt = 0;

const sampleHintText = computed(() => {
  if (!activeTask.value) return "未开始采样";
  const base = orderedPoints.value.length >= 2
    ? (nextSamplingIntervalMs() <= SAMPLE_INTERVAL_MOVING_MS ? "采样频率：移动优先" : "采样频率：静止省电")
    : "采样频率：初始化中";
  if (!lastSampleAt.value) return `${base} · 暂无成功采样`;
  return `${base} · 最近采样 ${formatTime(lastSampleAt.value)}`;
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
    mapInst.removeOverLay(m);
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
  try {
    if (TMapCtor.Icon && TMapCtor.Point) {
      const icon = new TMapCtor.Icon({
        iconUrl: dotIconDataUrl(eventTypeColor(ev.type)),
        iconSize: new TMapCtor.Point(26, 26),
        iconAnchor: new TMapCtor.Point(13, 13),
      });
      return new TMapCtor.Marker(lnglat, { icon });
    }
  } catch {
    /* fall through */
  }
  return new TMapCtor.Marker(lnglat);
}

function makeCurrentPosMarker(row, opts = {}) {
  const lnglat = toTLngLat(row);
  const color = opts.fallback ? "#969799" : "#1989fa";
  try {
    if (TMapCtor.Icon && TMapCtor.Point) {
      const icon = new TMapCtor.Icon({
        iconUrl: dotIconDataUrl(color),
        iconSize: new TMapCtor.Point(30, 30),
        iconAnchor: new TMapCtor.Point(15, 15),
      });
      return new TMapCtor.Marker(lnglat, { icon });
    }
  } catch {
    /* fall through */
  }
  return new TMapCtor.Marker(lnglat);
}

function redrawMapLayers() {
  if (!mapInst || !TMapCtor) return;
  clearMapOverlays();
  const pathArr = orderedPoints.value;
  const path = pathArr.map((p) => toTLngLat(p));

  if (path.length >= 2) {
    polylineInst = new TMapCtor.Polyline(path, {
      color: "#07c160",
      weight: 6,
      opacity: 0.92,
      lineStyle: "solid",
    });
    mapInst.addOverLay(polylineInst);
    if (typeof mapInst.setViewport === "function") {
      mapInst.setViewport(path);
    }
  } else if (path.length === 1) {
    mapInst.centerAndZoom(path[0], 16);
  }

  for (const ev of events.value) {
    if (!isValidLngLat(ev)) continue;
    const mk = makeEventMarker(ev);
    mk.setTitle(`${eventTypeLabel(ev.type)} ${ev.note || ""}`.trim());
    mapInst.addOverLay(mk);
    eventMarkers.push(mk);
  }

  const idx = playbackIndex.value;
  if (path.length && idx >= 0 && idx < path.length) {
    const pos = path[idx];
    playbackMarker = new TMapCtor.Marker(pos);
    playbackMarker.setTitle("轨迹回放当前位置");
    mapInst.addOverLay(playbackMarker);
    if (playbackPlaying.value) mapInst.panTo(pos);
  }

  const selfPos = latestDeviceCoord.value;
  if (isValidLngLat(selfPos)) {
    currentPosMarker = makeCurrentPosMarker(selfPos);
    currentPosMarker.setTitle("我的当前位置（GPS）");
    mapInst.addOverLay(currentPosMarker);
  } else if (path.length) {
    const lastPoint = pathArr[pathArr.length - 1];
    currentPosMarker = makeCurrentPosMarker(lastPoint, { fallback: true });
    currentPosMarker.setTitle("我的当前位置（最近轨迹点）");
    mapInst.addOverLay(currentPosMarker);
  }
}

async function initAmapIfNeeded() {
  mapError.value = "";
  if (!effectiveOnline.value) {
    mapError.value = "当前离线：可继续定位并记录轨迹/事件，联网后自动恢复地图显示。";
    destroyMap();
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
  mapError.value = "当前离线：可继续定位并记录轨迹/事件，联网后自动恢复地图显示。";
  destroyMap();
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
  if (!mapInst || !TMapCtor) return;
  const path = orderedPoints.value.map((p) => toTLngLat(p));
  if (!path.length) {
    showToast("暂无轨迹点");
    return;
  }
  if (path.length === 1) {
    mapInst.centerAndZoom(path[0], 16);
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
  if (!mapInst) {
    showToast("地图尚未加载完成");
    return;
  }
  const pos = toTLngLat(ev);
  mapInst.panTo(pos);
  if (typeof mapInst.centerAndZoom === "function") {
    mapInst.centerAndZoom(pos, 16);
  }
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
  const [allP, allE] = await Promise.all([
    getAllRecords(stores.patrolPoints),
    getAllRecords(stores.patrolEvents),
  ]);
  points.value = allP.filter((p) => p.task_local_id === taskId).sort((a, b) => a.recorded_at - b.recorded_at);
  events.value = allE.filter((e) => e.task_local_id === taskId).sort((a, b) => b.recorded_at - a.recorded_at);
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

function nextSamplingIntervalMs() {
  const pts = orderedPoints.value;
  if (pts.length < 2) return SAMPLE_INTERVAL_MOVING_MS;
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const dist = haversineMeters(last, prev);
  return dist <= STATIONARY_DISTANCE_M ? SAMPLE_INTERVAL_STATIC_MS : SAMPLE_INTERVAL_MOVING_MS;
}

function scheduleNextSample(delayMs) {
  if (!activeTask.value) return;
  clearSamplingTimer();
  samplingTimer.value = setTimeout(async () => {
    if (!activeTask.value) return;
    await recordSamplePoint();
    if (!activeTask.value) return;
    scheduleNextSample(nextSamplingIntervalMs());
  }, Math.max(1000, Number(delayMs) || SAMPLE_INTERVAL_MOVING_MS));
}

async function resolvePositionOnce() {
  const pos = await getCurrentPositionCompat();
  latestDeviceCoord.value = {
    lat: Number(pos?.coords?.latitude),
    lng: Number(pos?.coords?.longitude),
    source: "gps",
  };
  return pos;
}

async function recordSamplePoint() {
  if (!activeTask.value) return;
  if (sampleBusy.value) return false;
  const taskId = activeTask.value.local_id;
  sampleBusy.value = true;
  try {
    const pos = await resolvePositionOnce();
    if (!activeTask.value || activeTask.value.local_id !== taskId) return false;
    const lat = Number(pos.coords.latitude);
    const lng = Number(pos.coords.longitude);
    const acc = Number(pos.coords.accuracy || 0);
    if (!isValidLngLat({ lat, lng })) {
      notifySamplingIssue("定位坐标无效，轨迹点未记录");
      return false;
    }
    if (Number.isFinite(acc) && acc > ACCEPTABLE_ACCURACY_M) {
      notifySamplingIssue("当前定位精度较差，已跳过本次采样");
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
    await putRecord(stores.patrolPoints, rec);
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
      scheduleNextSample(nextSamplingIntervalMs());
    });
    return;
  }
  scheduleNextSample(nextSamplingIntervalMs());
}

async function sampleNow() {
  if (!activeTask.value) return;
  const ok = await recordSamplePoint();
  if (!activeTask.value) return;
  scheduleNextSample(nextSamplingIntervalMs());
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
  showSuccessToast("已开始巡护：移动时高频采样，静止时低频省电");
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
  const ended = {
    ...activeTask.value,
    ended_at: Date.now(),
    status: "ended",
  };
  await putRecord(stores.patrolTasks, ended);
  endedTaskView.value = ended;
  activeTask.value = null;
  showSuccessToast("巡护已结束，数据已保存在本机");
}

async function restoreActivePatrol() {
  const tasks = await getAllRecords(stores.patrolTasks);
  const active = tasks
    .filter((t) => t.status === "active")
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0];
  if (active) {
    activeTask.value = active;
    await loadPointsAndEvents(active.local_id);
    const latest = [...points.value].sort((a, b) => (b.recorded_at || 0) - (a.recorded_at || 0))[0];
    lastSampleAt.value = Number(latest?.recorded_at || 0);
    startSamplingLoop(false);
    showToast("已恢复进行中的巡护");
  }
}

function pickRecordingMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function stopRecordingInternal() {
  if (recordStopTimer) {
    clearTimeout(recordStopTimer);
    recordStopTimer = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch {
      /* ignore */
    }
  }
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) t.stop();
    mediaStream = null;
  }
  mediaRecorder = null;
  isRecording.value = false;
}

async function toggleEventRecording() {
  if (isRecording.value) {
    stopRecordingInternal();
    return;
  }
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    showFailToast("当前环境不支持录音");
    return;
  }
  const mime = pickRecordingMime();
  if (!mime) {
    showFailToast("本机不支持可用的录音格式");
    return;
  }
  recordingMime.value = mime;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showFailToast("无法访问麦克风");
    return;
  }
  mediaChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size) mediaChunks.push(ev.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(mediaChunks, { type: mime });
    mediaChunks = [];
    const reader = new FileReader();
    reader.onload = () => {
      eventAudioDataUrl.value = typeof reader.result === "string" ? reader.result : "";
    };
    reader.readAsDataURL(blob);
    if (mediaStream) {
      for (const t of mediaStream.getTracks()) t.stop();
      mediaStream = null;
    }
  };
  mediaRecorder.start(200);
  isRecording.value = true;
  recordStopTimer = setTimeout(() => {
    showToast("已达最长录音时间，已自动停止");
    stopRecordingInternal();
  }, MAX_AUDIO_MS);
}

/** 25 分钟内最近一次有效轨迹点，用于定位失败时仍能记事件 */
function coordinatesFromLastPointOrNull() {
  const sorted = [...points.value].sort((a, b) => (b.recorded_at || 0) - (a.recorded_at || 0));
  const last = sorted[0];
  if (!last) return null;
  const age = Date.now() - (last.recorded_at || 0);
  if (age > 25 * 60 * 1000) return null;
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

async function resolveCoordsForEvent() {
  const fromPoint = coordinatesFromLastPointOrNull();
  if (fromPoint) return fromPoint;
  const pos = await resolvePositionOnce();
  const lat = Number(pos.coords.latitude);
  const lng = Number(pos.coords.longitude);
  const accuracy = Number(pos.coords.accuracy || 0);
  if (!isValidLngLat({ lat, lng })) throw new Error("bad_coord");
  return { lat, lng, accuracy, source: "gps_live" };
}

async function persistPatrolEvent({ lat, lng, type, note, photo, audio, accuracy, source }) {
  if (!activeTask.value) return;
  const rec = {
    local_id: uid("pevt"),
    task_local_id: activeTask.value.local_id,
    type,
    lat,
    lng,
    note: (note || "").trim(),
    photo_dataurl: photo || null,
    audio_dataurl: audio || null,
    accuracy: Number(accuracy || 0),
    quality_level: classifyAccuracyLevel(accuracy),
    source: source || "unknown",
    recorded_at: Date.now(),
  };
  await putRecord(stores.patrolEvents, rec);
  await loadPointsAndEvents(activeTask.value.local_id);
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
    await persistPatrolEvent({
      lat,
      lng,
      type,
      note: "一键记录异常",
      photo: null,
      audio: null,
      accuracy,
      source,
    });
    showSuccessToast("已保存事件");
  } catch {
    showFailToast("未取得坐标：请等待轨迹采样后重试，或使用「记录事件」");
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
  eventAudioDataUrl.value = "";
  recordingMime.value = "";
  stopRecordingInternal();
  showEventSheet.value = true;
}

watch(showEventSheet, (open) => {
  if (!open) stopRecordingInternal();
});

function triggerPhotoPick() {
  photoInputRef.value?.click();
}

function onPhotoPick(ev) {
  const f = ev.target?.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    eventPhotoDataUrl.value = typeof reader.result === "string" ? reader.result : "";
  };
  reader.readAsDataURL(f);
  ev.target.value = "";
}

async function saveEvent() {
  if (!activeTask.value) return;
  stopRecordingInternal();
  eventSaveBusy.value = true;
  try {
    const { lat, lng, accuracy, source } = await resolveCoordsForEvent();
    await persistPatrolEvent({
      lat,
      lng,
      type: eventType.value,
      note: (eventNote.value || "").trim(),
      photo: eventPhotoDataUrl.value || null,
      audio: eventAudioDataUrl.value || null,
      accuracy,
      source,
    });
    showEventSheet.value = false;
    showSuccessToast("事件已保存");
  } catch {
    showFailToast("无法获取有效位置，事件未保存（可先走几步产生轨迹点再试）");
  } finally {
    eventSaveBusy.value = false;
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

onMounted(async () => {
  try {
    await restoreActivePatrol();
  } catch {
    showFailToast("本地数据库打开失败，请刷新页面或检查浏览器是否禁用存储");
  }
  await nextTick();
  void initAmapIfNeeded();
});

onUnmounted(() => {
  clearSamplingTimer();
  stopPlayback();
  stopRecordingInternal();
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
          轨迹与事件坐标均保存在本机；离线可持续记录，联网后自动加载地图查看事件点与轨迹。
        </p>
        <p class="hint tight sample-hint">{{ sampleHintText }}</p>
        <div class="stats-chip">{{ patrolStatsText }}</div>
        <div v-if="mapError" class="map-fallback">
          <p>{{ mapError }}</p>
          <p v-if="mapError.includes('离线')" class="sub">
            巡护采样与事件记录不受影响，数据先保存在本机，恢复网络后可继续地图浏览。
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
        <div class="map-legend">
          <span class="legend-title">图例</span>
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

      <van-cell-group v-if="showEventList" inset title="事件列表（本机存放）" class="block">
        <van-empty v-if="!events.length" description="暂无事件" />
        <van-swipe-cell v-for="ev in events" :key="ev.local_id">
          <van-cell
            :title="`${eventTypeLabel(ev.type)}`"
            :label="`${formatTime(ev.recorded_at)} · ${formatCoord(ev.lat)}, ${formatCoord(ev.lng)} · ${locationSourceLabel(ev.source)}${Number.isFinite(Number(ev.accuracy)) && Number(ev.accuracy) > 0 ? ' · 精度约 ' + Math.round(Number(ev.accuracy)) + ' m' : ''}${ev.note ? ' · ' + ev.note : ''}${ev.audio_dataurl ? ' · 含录音' : ''}`"
            is-link
            @click="focusEventOnMap(ev)"
          />
          <template #right>
            <van-button square type="danger" text="删除" class="swipe-del" @click="deleteEvent(ev)" />
          </template>
        </van-swipe-cell>
      </van-cell-group>

      <van-cell-group v-if="showTrackList" inset title="轨迹点（本机存放）" class="block trail-block">
        <van-empty
          v-if="!points.length"
          image="search"
          description="尚无采样点（开始后立即采样，后续按移动状态自动调整频率）"
        />
        <van-cell
          v-for="p in points.slice(-6).reverse()"
          :key="p.local_id"
          :title="`${formatCoord(p.lat)}, ${formatCoord(p.lng)}`"
          :label="`时间 ${formatTime(p.recorded_at)} · 精度约 ${Number.isFinite(Number(p.accuracy)) ? Math.round(p.accuracy) : '—'} m · 质量 ${p.quality_level || 'unknown'}`"
        />
      </van-cell-group>
    </div>
  </div>
  <van-action-sheet
      v-model:show="quickEventSheetVisible"
      title="一键记录异常"
      description="优先使用最近轨迹点坐标；若无轨迹点则尝试实时定位。"
      :actions="EVENT_TYPES.map((t) => ({ name: t.label, value: t.value, color: t.color }))"
      close-on-click-action
      cancel-text="取消"
      @select="onQuickEventSelect"
    />

  <van-popup v-model:show="showEventSheet" position="bottom" round :style="{ padding: '16px' }">
      <h3 class="sheet-title">记录事件</h3>
      <van-radio-group v-model="eventType" direction="horizontal" class="type-row">
        <van-radio v-for="t in EVENT_TYPES" :key="t.value" :name="t.value">{{ t.label }}</van-radio>
      </van-radio-group>
      <van-field v-model="eventNote" rows="2" autosize type="textarea" maxlength="500" show-word-limit label="备注" placeholder="现场情况描述" />
      <div class="uploader-wrap">
        <span class="ul-label">现场照片（可选）</span>
        <input ref="photoInputRef" type="file" accept="image/*" class="hidden-file" @change="onPhotoPick" />
        <van-button size="small" type="primary" plain @click="triggerPhotoPick">选择照片</van-button>
        <img v-if="eventPhotoDataUrl" :src="eventPhotoDataUrl" alt="预览" class="photo-preview" />
      </div>
      <div class="rec-row">
        <span class="ul-label">现场录音（可选，最长约 {{ MAX_AUDIO_MS / 1000 }} 秒）</span>
        <van-button size="small" :type="isRecording ? 'danger' : 'primary'" plain @click="toggleEventRecording">
          {{ isRecording ? "停止录音" : "开始录音" }}
        </van-button>
        <span v-if="recordingMime" class="mime-hint">{{ recordingMime }}</span>
        <span v-if="eventAudioDataUrl" class="ok-hint">已录制，保存事件时将一并存储</span>
      </div>
      <div class="sheet-actions">
        <van-button block type="default" @click="showEventSheet = false">取消</van-button>
        <van-button block type="primary" :loading="eventSaveBusy" @click="saveEvent">保存</van-button>
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

.hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: #646566;
  line-height: 1.55;
}

.hint.tight {
  margin-bottom: 8px;
}

.sample-hint {
  color: #1989fa;
}

.trail-block {
  margin-top: 12px;
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

.hidden-file {
  display: none;
}

.photo-preview {
  display: block;
  max-width: 100%;
  max-height: 160px;
  margin-top: 10px;
  border-radius: 8px;
  object-fit: contain;
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

.block {
  margin-top: 8px;
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

.type-row {
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 8px;
}

.uploader-wrap {
  margin: 12px 0;
}

.rec-row {
  margin: 12px 0 16px;
}

.ul-label {
  display: block;
  font-size: 14px;
  color: #323233;
  margin-bottom: 8px;
}

.mime-hint,
.ok-hint {
  display: block;
  font-size: 12px;
  color: #969799;
  margin-top: 6px;
}

.ok-hint {
  color: #07c160;
}

.sheet-actions {
  display: flex;
  gap: 10px;
}

.sheet-actions .van-button {
  flex: 1;
}

.swipe-del {
  height: 100%;
}
</style>
