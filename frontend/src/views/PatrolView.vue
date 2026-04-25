<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from "vant";
import { storeToRefs } from "pinia";
import { useNetworkStore } from "../stores/network";
import { loadTianditu } from "../services/tiandituLoader";
import { locateByAmapIp } from "../services/amapIpLocate";
import { deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";
import { describeGeoError, getCurrentPositionCompat } from "../utils/geolocation";

const networkStore = useNetworkStore();
const { effectiveOnline } = storeToRefs(networkStore);

const PATROL_USE_AMAP_IP_KEY = "ftb2_patrol_use_amap_ip";
/** 开启后：采样与事件定位优先走高德 IP 粗定位（顶替 GPS）；关闭则使用浏览器 GPS */
const useAmapIpForGps = ref(false);

const SAMPLE_INTERVAL_MS = 1 * 60 * 1000;
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

const filterTypes = ref(EVENT_TYPES.map((t) => t.value));
const sortMode = ref("time_desc");

const displayEvents = computed(() => {
  const set = new Set(filterTypes.value);
  const list = events.value.filter((e) => set.has(e.type));
  const sorted = [...list].sort((a, b) => {
    if (sortMode.value === "time_desc") return (b.recorded_at || 0) - (a.recorded_at || 0);
    if (sortMode.value === "time_asc") return (a.recorded_at || 0) - (b.recorded_at || 0);
    const c = String(a.type).localeCompare(String(b.type));
    if (c !== 0) return c;
    return (b.recorded_at || 0) - (a.recorded_at || 0);
  });
  return sorted;
});

/** 有效坐标、按时间排序（与地图折线/回放滑块一致） */
const orderedPoints = computed(() =>
  [...points.value].filter(isValidLngLat).sort((a, b) => (a.recorded_at || 0) - (b.recorded_at || 0))
);

const amapDivRef = ref(null);
const mapError = ref("");
let TMapCtor = null;
let mapInst = null;
let polylineInst = null;
const eventMarkers = [];
let playbackMarker = null;
let currentPosMarker = null;
let playbackTimer = null;
const mapType = ref("hybrid");
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

function resolveTiandituMapType(type) {
  if (typeof window === "undefined") return null;
  if (type === "satellite") return window.TMAP_SATELLITE_MAP || null;
  if (type === "hybrid") return window.TMAP_HYBRID_MAP || null;
  return window.TMAP_NORMAL_MAP || null;
}

function applyMapType() {
  if (!mapInst) return;
  const target = resolveTiandituMapType(mapType.value);
  if (!target) return;
  try {
    mapInst.setMapType(target);
  } catch {
    /* ignore */
  }
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
    mapInst.panTo(pos);
  }

  const selfPos = latestDeviceCoord.value;
  if (isValidLngLat(selfPos)) {
    currentPosMarker = new TMapCtor.Marker(toTLngLat(selfPos));
    currentPosMarker.setTitle(`我的当前位置（${selfPos.source === "amap_ip" ? "高德 IP 粗定位" : "GPS"}）`);
    mapInst.addOverLay(currentPosMarker);
  } else if (path.length) {
    const lastPos = path[path.length - 1];
    currentPosMarker = new TMapCtor.Marker(lastPos);
    currentPosMarker.setTitle("我的当前位置（最近轨迹点）");
    mapInst.addOverLay(currentPosMarker);
  }
}

async function initAmapIfNeeded() {
  mapError.value = "";
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
    applyMapType();
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

watch(mapType, () => {
  applyMapType();
});

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
    clearInterval(samplingTimer.value);
    samplingTimer.value = null;
  }
}

async function resolvePositionOnce() {
  if (useAmapIpForGps.value) {
    const row = await locateByAmapIp();
    latestDeviceCoord.value = { lat: Number(row.lat), lng: Number(row.lng), source: "amap_ip" };
    return {
      coords: {
        latitude: Number(row.lat),
        longitude: Number(row.lng),
        accuracy: 8000,
      },
      timestamp: Date.now(),
    };
  }
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
  try {
    const pos = await resolvePositionOnce();
    const lat = Number(pos.coords.latitude);
    const lng = Number(pos.coords.longitude);
    const acc = Number(pos.coords.accuracy || 0);
    if (!isValidLngLat({ lat, lng })) {
      showToast("定位坐标无效，轨迹点未记录");
      return;
    }
    const rec = {
      local_id: uid("ppt"),
      task_local_id: activeTask.value.local_id,
      lat,
      lng,
      accuracy: acc,
      recorded_at: Date.now(),
    };
    await putRecord(stores.patrolPoints, rec);
    points.value = [...points.value, rec].sort((a, b) => a.recorded_at - b.recorded_at);
  } catch (e) {
    if (useAmapIpForGps.value) {
      showToast("高德 IP 定位失败，轨迹点未记录");
      return;
    }
    showToast(`${describeGeoError(e, "定位失败")}，轨迹点未记录`);
  }
}

function startSamplingLoop(withImmediate) {
  clearSamplingTimer();
  if (withImmediate) void recordSamplePoint();
  samplingTimer.value = setInterval(() => void recordSamplePoint(), SAMPLE_INTERVAL_MS);
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

  gpsBusy.value = true;
  try {
    if (useAmapIpForGps.value) {
      await locateByAmapIp();
    } else {
      if (!navigator.geolocation) {
        showFailToast("当前设备不支持定位");
        return;
      }
      await resolvePositionOnce();
    }
  } catch (e) {
    if (useAmapIpForGps.value) {
      showFailToast("高德 IP 定位失败，无法开始巡护（请检查网络与高德 Key）");
      return;
    }
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
  showSuccessToast("已开始巡护，每 1 分钟自动记录轨迹点");
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
  return { lat, lng };
}

async function resolveCoordsForEvent() {
  const fromPoint = coordinatesFromLastPointOrNull();
  if (fromPoint) return fromPoint;
  const pos = await resolvePositionOnce();
  const lat = Number(pos.coords.latitude);
  const lng = Number(pos.coords.longitude);
  if (!isValidLngLat({ lat, lng })) throw new Error("bad_coord");
  return { lat, lng };
}

async function persistPatrolEvent({ lat, lng, type, note, photo, audio }) {
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
    const { lat, lng } = await resolveCoordsForEvent();
    await persistPatrolEvent({
      lat,
      lng,
      type,
      note: "一键记录异常",
      photo: null,
      audio: null,
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
    const { lat, lng } = await resolveCoordsForEvent();
    await persistPatrolEvent({
      lat,
      lng,
      type: eventType.value,
      note: (eventNote.value || "").trim(),
      photo: eventPhotoDataUrl.value || null,
      audio: eventAudioDataUrl.value || null,
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

watch(useAmapIpForGps, (v) => {
  try {
    localStorage.setItem(PATROL_USE_AMAP_IP_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
});

onMounted(async () => {
  try {
    useAmapIpForGps.value = localStorage.getItem(PATROL_USE_AMAP_IP_KEY) === "1";
  } catch {
    /* ignore */
  }
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
      <p class="hint">
        轨迹与事件保存在本机 IndexedDB。地图使用天地图 JS（需配置 TIANDITU_JS_KEY，或在已部署的 index.html 注入 meta
        forestry-tianditu-key）。
      </p>

      <div v-if="activeTask" class="status-chip">
        <span class="dot" />
        巡护进行中 · 已采 {{ points.length }} 点 · 事件 {{ events.length }} 条
      </div>
      <div v-else-if="endedTaskView" class="status-chip ended">已结束 · 已采 {{ points.length }} 点 · 事件 {{ events.length }} 条</div>
      <div v-else class="status-chip muted">未开始巡护</div>

      <div class="actions">
        <van-button v-if="!activeTask" type="primary" block :loading="gpsBusy" @click="startPatrol">
          {{ endedTaskView ? "开始新巡护" : "开始巡护" }}
        </van-button>
        <template v-if="activeTask">
          <van-button type="warning" block plain @click="openEventSheet">记录事件</van-button>
          <van-button type="primary" block plain :loading="eventSaveBusy" @click="quickRecordAnomaly">一键记录异常</van-button>
          <van-button type="danger" block plain @click="stopPatrol">结束巡护</van-button>
        </template>
      </div>

      <h3 class="section-title">地图</h3>
      <p class="hint tight">
        展示轨迹折线与事件点；下方滑块与播放用于沿轨迹回放。
        <span v-if="!effectiveOnline" class="warn">离线时瓦片可能无法加载。</span>
      </p>
      <p class="map-disclaimer">
        地图数据与底图服务由天地图提供。页面仅用于巡护辅助展示与定位记录，不涉及任何行政区划主张。
      </p>
      <div v-if="mapError" class="map-fallback">
        <p>{{ mapError }}</p>
        <p v-if="mapError.includes('超时') || mapError.includes('脚本')" class="sub">
          请检查网络、天地图控制台域名白名单与 Key 配置。
        </p>
        <p v-else class="sub">
          可在服务器 backend/.env.local 中配置 TIANDITU_JS_KEY；或在当前页 index.html 增加 meta forestry-tianditu-key
          后强刷，无需重新 npm build。
        </p>
      </div>
      <div ref="amapDivRef" class="amap-box" />
      <div class="playback-bar">
        <van-button size="small" type="primary" :disabled="orderedPoints.length < 2" @click="togglePlayback">
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

      <h3 class="section-title">事件</h3>
      <van-cell-group inset title="筛选与排序" class="block">
        <van-cell title="事件类型（多选）">
          <template #value>
            <span class="filter-hint">{{ filterTypes.length }}/{{ EVENT_TYPES.length }} 类</span>
          </template>
        </van-cell>
        <van-checkbox-group v-model="filterTypes" class="type-checks">
          <van-checkbox v-for="t in EVENT_TYPES" :key="t.value" :name="t.value" shape="square">
            {{ t.label }}
          </van-checkbox>
        </van-checkbox-group>
        <div class="sort-row">
          <span class="sort-label">排序</span>
          <van-button size="small" :type="sortMode === 'time_desc' ? 'primary' : 'default'" @click="sortMode = 'time_desc'">从新到旧</van-button>
          <van-button size="small" :type="sortMode === 'time_asc' ? 'primary' : 'default'" @click="sortMode = 'time_asc'">从旧到新</van-button>
          <van-button size="small" :type="sortMode === 'type' ? 'primary' : 'default'" @click="sortMode = 'type'">按类型</van-button>
        </div>
      </van-cell-group>

      <van-empty v-if="!displayEvents.length" description="无匹配事件，请调整筛选或先记录事件" />
      <van-swipe-cell v-for="ev in displayEvents" :key="ev.local_id">
        <van-cell
          :title="`${eventTypeLabel(ev.type)}`"
          :label="`${formatTime(ev.recorded_at)} · ${formatCoord(ev.lat)}, ${formatCoord(ev.lng)}${ev.note ? ' · ' + ev.note : ''}${ev.audio_dataurl ? ' · 含录音' : ''}`"
        />
        <template #right>
          <van-button square type="danger" text="删除" class="swipe-del" @click="deleteEvent(ev)" />
        </template>
      </van-swipe-cell>

      <van-cell-group inset title="最近轨迹点" class="block trail-block">
        <van-empty
          v-if="!points.length"
          image="search"
          description="尚无采样点（开始后立即采一点，之后每 1 分钟自动记录）"
        />
        <van-cell
          v-for="p in points.slice(-6).reverse()"
          :key="p.local_id"
          :title="`${formatCoord(p.lat)}, ${formatCoord(p.lng)}`"
          :label="`时间 ${formatTime(p.recorded_at)} · 精度约 ${Number.isFinite(Number(p.accuracy)) ? Math.round(p.accuracy) : '—'} m`"
        />
      </van-cell-group>
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
  </div>
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

.section-title {
  margin: 20px 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: #323233;
}

.section-title:first-of-type {
  margin-top: 4px;
}

.sort-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 16px 12px;
}

.sort-label {
  font-size: 14px;
  color: #323233;
  margin-right: 4px;
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

.trail-block {
  margin-top: 12px;
}

.warn {
  color: #ee0a24;
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

.type-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  padding: 8px 16px 12px;
}

.filter-hint {
  font-size: 12px;
  color: #969799;
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

.map-disclaimer {
  margin: 0 0 10px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #646566;
  background: #f7f8fa;
  border: 1px solid #ebedf0;
  border-radius: 8px;
}

.playback-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 8px;
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
