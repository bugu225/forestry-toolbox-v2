<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from "vant";
import { storeToRefs } from "pinia";
import { useNetworkStore } from "../stores/network";
import { useAuthStore } from "../stores/auth";
import apiClient, { API_READ_TIMEOUT_MS } from "../api/client";
import { loadAmap } from "../services/amapLoader";
import { deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";

const networkStore = useNetworkStore();
const { effectiveOnline } = storeToRefs(networkStore);
const authStore = useAuthStore();

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
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
const activeTab = ref(0);

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

const sortModeLabel = computed(() => {
  const m = { time_desc: "时间从新到旧", time_asc: "时间从旧到新", type: "按类型分组" };
  return m[sortMode.value] || "";
});

const amapDivRef = ref(null);
const mapError = ref("");
let AMapCtor = null;
let mapInst = null;
let polylineInst = null;
const eventMarkers = [];
let playbackMarker = null;
let playbackTimer = null;

const playbackIndex = ref(0);
const playbackPlaying = ref(false);

const isRecording = ref(false);
const recordingMime = ref("");
let mediaRecorder = null;
let mediaChunks = [];
let mediaStream = null;
let recordStopTimer = null;

const syncBusy = ref(false);

const sortSheetVisible = ref(false);
const SORT_SHEET_ACTIONS = [{ name: "时间从新到旧" }, { name: "时间从旧到新" }, { name: "按类型分组" }];
const SORT_SHEET_VALUES = ["time_desc", "time_asc", "type"];

const pullSheetVisible = ref(false);
const pullSheetItems = ref([]);

const pullSheetActionRows = computed(() =>
  pullSheetItems.value.map((it) => ({
    name: `${it.title || it.client_task_local_id}`,
    subname: `${formatTime(it.started_at)} · ${it.client_task_local_id}`,
  }))
);

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
    mapInst.remove(polylineInst);
    polylineInst = null;
  }
  for (const m of eventMarkers.splice(0)) {
    mapInst.remove(m);
  }
  if (playbackMarker) {
    mapInst.remove(playbackMarker);
    playbackMarker = null;
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
  AMapCtor = null;
}

function buildEventMarkerHtml(type) {
  const c = eventTypeColor(type);
  return `<div style="width:26px;height:26px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);"></div>`;
}

function redrawMapLayers() {
  if (!mapInst || !AMapCtor) return;
  clearMapOverlays();
  const pathArr = orderedPoints.value;
  const path = pathArr.map((p) => [Number(p.lng), Number(p.lat)]);

  if (path.length >= 2) {
    polylineInst = new AMapCtor.Polyline({
      path,
      strokeColor: "#07c160",
      strokeWeight: 6,
      strokeOpacity: 0.92,
      lineJoin: "round",
      lineCap: "round",
      zIndex: 50,
    });
    mapInst.add(polylineInst);
    mapInst.setFitView([polylineInst], false, [40, 40, 40, 40]);
  } else if (path.length === 1) {
    mapInst.setZoomAndCenter(16, path[0]);
  }

  for (const ev of events.value) {
    if (!isValidLngLat(ev)) continue;
    const mk = new AMapCtor.Marker({
      position: [Number(ev.lng), Number(ev.lat)],
      content: buildEventMarkerHtml(ev.type),
      offset: new AMapCtor.Pixel(-13, -13),
      title: `${eventTypeLabel(ev.type)} ${ev.note || ""}`,
      zIndex: 80,
    });
    mapInst.add(mk);
    eventMarkers.push(mk);
  }

  const idx = playbackIndex.value;
  if (path.length && idx >= 0 && idx < path.length) {
    const pos = path[idx];
    playbackMarker = new AMapCtor.Marker({
      position: pos,
      content:
        '<div style="width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #07c160;box-shadow:0 0 0 2px rgba(7,193,96,.35);"></div>',
      offset: new AMapCtor.Pixel(-7, -7),
      zIndex: 100,
    });
    mapInst.add(playbackMarker);
    mapInst.setCenter(pos);
  }
}

async function initAmapIfNeeded() {
  mapError.value = "";
  if (mapInst) {
    redrawMapLayers();
    return;
  }
  try {
    AMapCtor = await loadAmap();
  } catch (e) {
    const code = e?.message || "";
    if (code === "no_amap_key") mapError.value = "未配置 VITE_AMAP_JS_KEY";
    else if (code === "amap_load_timeout") mapError.value = "高德脚本加载超时，请检查网络或安全域名配置";
    else if (code === "amap_script_error") mapError.value = "高德脚本加载失败（网络或被拦截）";
    else if (code === "amap_load_failed") mapError.value = "高德脚本已返回但未暴露 AMap，请核对 Key 与版本";
    else mapError.value = "高德地图加载失败";
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
  mapInst = new AMapCtor.Map(el, {
    zoom,
    center,
    viewMode: "2D",
  });
  redrawMapLayers();
  requestAnimationFrame(() => {
    try {
      mapInst?.resize();
    } catch {
      /* ignore */
    }
  });
}

watch(activeTab, (tab) => {
  if (tab === 2) {
    nextTick(() => {
      void initAmapIfNeeded();
      requestAnimationFrame(() => {
        try {
          mapInst?.resize();
        } catch {
          /* ignore */
        }
      });
    });
  } else {
    stopPlayback();
  }
});

watch([points, events, playbackIndex], () => {
  if (activeTab.value === 2 && mapInst) redrawMapLayers();
}, { deep: true });

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

function getPositionOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("no_geolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0,
    });
  });
}

async function recordSamplePoint() {
  if (!activeTask.value) return;
  try {
    const pos = await getPositionOnce();
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
    const code = Number(e?.code || 0);
    if (code === 1) showToast("定位被拒绝，轨迹点未记录");
    else if (code === 3) showToast("定位超时，轨迹点未记录");
    else showToast("定位失败，轨迹点未记录");
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

  if (!navigator.geolocation) {
    showFailToast("当前设备不支持定位");
    return;
  }
  gpsBusy.value = true;
  try {
    await getPositionOnce();
  } catch {
    showFailToast("请先允许定位后再开始巡护");
    gpsBusy.value = false;
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
  showSuccessToast("已开始巡护，每 5 分钟自动记录轨迹点");
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
  showSuccessToast("巡护已结束，数据已保存在本机，可导出或同步云端");
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
  gpsBusy.value = true;
  let lat = null;
  let lng = null;
  try {
    const pos = await getPositionOnce();
    lat = Number(pos.coords.latitude);
    lng = Number(pos.coords.longitude);
  } catch {
    showFailToast("无法获取当前位置，事件未保存");
    gpsBusy.value = false;
    return;
  }
  if (!isValidLngLat({ lat, lng })) {
    showFailToast("定位坐标无效，事件未保存");
    gpsBusy.value = false;
    return;
  }
  gpsBusy.value = false;
  const photo = eventPhotoDataUrl.value || null;
  const audio = eventAudioDataUrl.value || null;
  const rec = {
    local_id: uid("pevt"),
    task_local_id: activeTask.value.local_id,
    type: eventType.value,
    lat,
    lng,
    note: (eventNote.value || "").trim(),
    photo_dataurl: photo,
    audio_dataurl: audio,
    recorded_at: Date.now(),
  };
  await putRecord(stores.patrolEvents, rec);
  await loadPointsAndEvents(activeTask.value.local_id);
  showEventSheet.value = false;
  showSuccessToast("事件已保存");
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

async function exportPatrolJson() {
  const task = activeTask.value || endedTaskView.value;
  if (!task) {
    showFailToast("暂无可导出的巡护数据");
    return;
  }
  const payload = {
    task,
    points: points.value,
    events: events.value,
    exported_at: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `patrol_${task.local_id}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showSuccessToast("已导出 JSON");
}

async function deletePointsEventsForTask(taskLocalId) {
  const [allP, allE] = await Promise.all([
    getAllRecords(stores.patrolPoints),
    getAllRecords(stores.patrolEvents),
  ]);
  for (const p of allP.filter((x) => x.task_local_id === taskLocalId)) {
    await deleteRecord(stores.patrolPoints, p.local_id);
  }
  for (const e of allE.filter((x) => x.task_local_id === taskLocalId)) {
    await deleteRecord(stores.patrolEvents, e.local_id);
  }
}

async function syncPatrolToServer() {
  const task = activeTask.value || endedTaskView.value;
  if (!task) {
    showFailToast("暂无可同步的巡护");
    return;
  }
  if (!authStore.token) {
    showFailToast("请先登录后再同步云端");
    return;
  }
  if (!effectiveOnline.value) {
    showFailToast("当前离线，无法同步");
    return;
  }
  syncBusy.value = true;
  try {
    const { data } = await apiClient.post(
      "/patrol/sync",
      {
        client_task_local_id: task.local_id,
        task,
        points: points.value,
        events: events.value,
      },
      { timeout: 120000 }
    );
    const merged = {
      ...task,
      last_server_sync_at: Date.now(),
      server_patrol_record_id: data.id,
    };
    await putRecord(stores.patrolTasks, merged);
    if (activeTask.value?.local_id === task.local_id) activeTask.value = merged;
    if (endedTaskView.value?.local_id === task.local_id) endedTaskView.value = merged;
    showSuccessToast("已同步到云端");
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e?.message || "同步失败";
    showFailToast(msg);
  } finally {
    syncBusy.value = false;
  }
}

async function mergeRemotePatrolIntoLocal(item) {
  try {
    await showConfirmDialog({
      title: "拉取巡护",
      message: `将用云端数据覆盖本机中任务 ID 为「${item.client_task_local_id}」的轨迹与事件（任务信息一并替换）。是否继续？`,
    });
  } catch {
    return;
  }
  try {
    const { data: full } = await apiClient.get(`/patrol/tasks/${item.id}`, { timeout: API_READ_TIMEOUT_MS });
    const task = full.task;
    if (!task?.local_id) {
      showFailToast("云端数据格式异常");
      return;
    }
    if ((full.client_task_local_id || "").trim() !== String(task.local_id).trim()) {
      showFailToast("云端任务 ID 不一致，已中止拉取");
      return;
    }
    const tid = task.local_id;
    await deletePointsEventsForTask(tid);
    await putRecord(stores.patrolTasks, task);
    for (const p of full.points || []) {
      if (p?.local_id) await putRecord(stores.patrolPoints, p);
    }
    for (const ev of full.events || []) {
      if (ev?.local_id) await putRecord(stores.patrolEvents, ev);
    }
    endedTaskView.value = null;
    activeTask.value = null;
    if (task.status === "active") {
      activeTask.value = task;
      clearSamplingTimer();
      startSamplingLoop(false);
    } else {
      endedTaskView.value = task;
    }
    await loadPointsAndEvents(tid);
    showSuccessToast("已从云端恢复");
    if (activeTab.value === 2) {
      destroyMap();
      await nextTick();
      void initAmapIfNeeded();
    }
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e?.message || "拉取失败";
    showFailToast(msg);
  }
}

async function pullPatrolFromServer() {
  if (!authStore.token) {
    showFailToast("请先登录后再拉取");
    return;
  }
  if (!effectiveOnline.value) {
    showFailToast("当前离线，无法拉取");
    return;
  }
  let items = [];
  try {
    const { data } = await apiClient.get("/patrol/tasks", { timeout: API_READ_TIMEOUT_MS });
    items = data.items || [];
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e?.message || "获取列表失败";
    showFailToast(msg);
    return;
  }
  if (!items.length) {
    showToast("云端暂无巡护记录");
    return;
  }
  pullSheetItems.value = items;
  pullSheetVisible.value = true;
}

function openSortSheet() {
  sortSheetVisible.value = true;
}

function onSortSheetSelect(_action, index) {
  const v = SORT_SHEET_VALUES[index];
  if (v) sortMode.value = v;
}

function onPullSheetSelect(_action, index) {
  const item = pullSheetItems.value[index];
  if (item) void mergeRemotePatrolIntoLocal(item);
}

onMounted(() => {
  void restoreActivePatrol();
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

    <van-tabs v-model:active="activeTab" class="tabs">
      <van-tab title="巡护">
        <div class="panel">
          <p class="hint">
            轨迹与事件保存在本机 IndexedDB；联网且已登录时可同步到服务端。地图页使用高德 JS（需配置
            VITE_AMAP_JS_KEY 与安全码）。
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
              <van-button type="danger" block plain @click="stopPatrol">结束巡护</van-button>
              <van-button type="default" block @click="exportPatrolJson">导出本次 JSON</van-button>
            </template>
            <van-button v-else-if="endedTaskView" type="default" block @click="exportPatrolJson">导出上次巡护 JSON</van-button>
            <van-button
              type="primary"
              plain
              block
              :loading="syncBusy"
              :disabled="!activeTask && !endedTaskView"
              @click="syncPatrolToServer"
            >
              同步当前/上次巡护到云端
            </van-button>
            <van-button type="default" plain block @click="pullPatrolFromServer">从云端拉取（覆盖同 ID）</van-button>
          </div>

          <van-cell-group inset title="最近轨迹点" class="block">
            <van-empty v-if="!points.length" image="search" description="尚无采样点（开始后立即采一点，之后每 5 分钟）" />
            <van-cell
              v-for="p in points.slice(-6).reverse()"
              :key="p.local_id"
              :title="`${formatCoord(p.lat)}, ${formatCoord(p.lng)}`"
              :label="`时间 ${formatTime(p.recorded_at)} · 精度约 ${Number.isFinite(Number(p.accuracy)) ? Math.round(p.accuracy) : '—'} m`"
            />
          </van-cell-group>
        </div>
      </van-tab>

      <van-tab title="事件">
        <div class="panel">
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
            <van-field label="排序" readonly is-link @click="openSortSheet">
              <template #input>
                <span>{{ sortModeLabel }}</span>
              </template>
            </van-field>
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
        </div>
      </van-tab>

      <van-tab title="地图">
        <div class="panel">
          <p class="hint">
            高德地图展示轨迹折线与按类型着色的事件点；下方滑块与播放用于沿轨迹回放。
            <span v-if="!effectiveOnline" class="warn">离线时瓦片可能无法加载。</span>
          </p>
          <div v-if="mapError" class="map-fallback">
            <p>{{ mapError }}</p>
            <p v-if="mapError.includes('超时') || mapError.includes('脚本')" class="sub">
              请检查网络、高德控制台域名白名单及安全码配置。
            </p>
            <p v-else class="sub">可检查 .env 中 VITE_AMAP_JS_KEY、VITE_AMAP_SECURITY_JS_CODE 后重新构建。</p>
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
        </div>
      </van-tab>
    </van-tabs>

    <van-action-sheet
      v-model:show="sortSheetVisible"
      title="排序方式"
      :actions="SORT_SHEET_ACTIONS"
      close-on-click-action
      cancel-text="取消"
      @select="onSortSheetSelect"
    />

    <van-action-sheet
      v-model:show="pullSheetVisible"
      title="选择要恢复到本机的巡护"
      :actions="pullSheetActionRows"
      close-on-click-action
      cancel-text="取消"
      @select="onPullSheetSelect"
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
        <van-button block type="primary" :loading="gpsBusy" @click="saveEvent">保存</van-button>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.page {
  min-height: 100dvh;
  padding-bottom: env(safe-area-inset-bottom, 0);
  background: #f6f7fb;
}

.tabs :deep(.van-tabs__content) {
  padding-top: 8px;
}

.panel {
  padding: 12px 12px 24px;
}

.hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: #646566;
  line-height: 1.55;
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
