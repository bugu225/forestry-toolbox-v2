<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { showFailToast, showSuccessToast } from "vant";
import { useAuthStore } from "../stores/auth";
import apiClient from "../api/client";
import { postWithSyncRetry } from "../utils/syncRetry";
import { clearStore, deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";
import { loadAmapSdk } from "../services/amapLoader";
import { getSyncMeta, setSyncMeta } from "../services/syncMeta";

const authStore = useAuthStore();
const router = useRouter();
const online = ref(navigator.onLine);
const syncing = ref(false);
const loadingServer = ref(false);
const locating = ref(false);
const autoTracking = ref(false);
const autoTrackIntervalSec = ref(15);
const currentPosition = ref({ latitude: "", longitude: "", accuracy: "" });
const localPoints = ref([]);
const localEvents = ref([]);
const serverEvents = ref([]);
const mapEnabled = ref(Boolean(import.meta.env.VITE_AMAP_JS_KEY && import.meta.env.VITE_AMAP_SECURITY_JS_CODE));
const mapReady = ref(false);
const mapError = ref("");
const mapContainer = ref(null);
const syncMeta = ref(getSyncMeta("patrol"));
const autoSyncHintShown = ref(false);
const geoSecureSupported = ref(window.isSecureContext || ["localhost", "127.0.0.1"].includes(window.location.hostname));
let autoTrackTimer = null;
let amapInstance = null;
let amapMarkers = [];
let amapPolyline = null;

function withSyncSuggestion(message) {
  const base = message || "同步失败";
  return `${base}。请检查网络、登录状态和定位权限后重试。`;
}

function getInitialMapCenter() {
  if (currentPosition.value.latitude && currentPosition.value.longitude) {
    return [Number(currentPosition.value.longitude), Number(currentPosition.value.latitude)];
  }
  const point = localPoints.value.find((item) => item.longitude != null && item.latitude != null);
  if (point) {
    return [Number(point.longitude), Number(point.latitude)];
  }
  const event = localEvents.value.find((item) => item.longitude != null && item.latitude != null);
  if (event) {
    return [Number(event.longitude), Number(event.latitude)];
  }
  // Neutral country-level fallback (instead of fixed Tiananmen).
  return [104.114129, 37.550339];
}

async function getAmapIpCenter(AMap) {
  return new Promise((resolve) => {
    AMap.plugin("AMap.CitySearch", () => {
      const citySearch = new AMap.CitySearch();
      citySearch.getLocalCity((status, result) => {
        if (status === "complete" && result?.bounds) {
          const center = result.bounds.getCenter();
          resolve([center.lng, center.lat]);
          return;
        }
        resolve(null);
      });
    });
  });
}

const tasks = ref([]);
const serverTasks = ref([]);
const activeTaskLocalId = ref("");

const pointForm = reactive({ latitude: "", longitude: "", note: "" });
const eventForm = reactive({ description: "", latitude: "", longitude: "", event_type: "abnormal", photo_base64: "" });
const eventPhotoInput = ref(null);
const activeEventPreview = ref(null);

const hasActiveTask = computed(() =>
  tasks.value.some((item) => item.local_id === activeTaskLocalId.value && item.status === "in_progress")
);

function eventTypeText(type) {
  if (type === "disease") return "病害";
  if (type === "pest") return "虫害";
  if (type === "fire") return "火情";
  if (type === "illegal_logging") return "盗伐";
  if (type === "ecology") return "生态观测";
  return "异常";
}

function sourceText(item) {
  if (!item) return "未知";
  return item.task_title ? "云端同步点" : "本地离线点";
}

function buildGuidanceQuestion(item) {
  const typeText = eventTypeText(item?.event_type);
  const desc = (item?.description || "").trim();
  return `巡护中发现${typeText}事件，情况为：${desc}。请给出分步处置建议和注意事项。`;
}

function askGuidanceForEvent(item) {
  const question = buildGuidanceQuestion(item);
  router.push({
    name: "qa",
    query: { q: question },
  });
}

function bindNetworkListeners() {
  window.addEventListener("online", async () => {
    online.value = true;
    await autoSyncIfPending();
  });
  window.addEventListener("offline", () => {
    online.value = false;
  });
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

async function refreshLocal() {
  tasks.value = await getAllRecords(stores.patrolTasks);
  const points = await getAllRecords(stores.patrolPoints);
  const events = await getAllRecords(stores.patrolEvents);
  localPoints.value = activeTaskLocalId.value
    ? points.filter((item) => item.task_local_id === activeTaskLocalId.value)
    : points;
  localEvents.value = activeTaskLocalId.value
    ? events.filter((item) => item.task_local_id === activeTaskLocalId.value)
    : events;
}

async function startLocalTask() {
  const localId = uid("task");
  const task = {
    local_id: localId,
    title: `离线巡护任务 ${new Date().toLocaleString()}`,
    status: "in_progress",
    started_at: new Date().toISOString(),
    ended_at: null,
    synced: false,
    user_id: authStore.user?.id || null,
  };
  await putRecord(stores.patrolTasks, task);
  activeTaskLocalId.value = localId;
  await refreshLocal();
  renderMapMarkers();
  showSuccessToast("已开始离线巡护");
}

async function endLocalTask() {
  if (!activeTaskLocalId.value) {
    showFailToast("请先开始巡护");
    return;
  }
  const all = await getAllRecords(stores.patrolTasks);
  const task = all.find((item) => item.local_id === activeTaskLocalId.value);
  if (!task) {
    showFailToast("任务不存在");
    return;
  }
  task.status = "completed";
  task.ended_at = new Date().toISOString();
  task.synced = false;
  await putRecord(stores.patrolTasks, task);
  activeTaskLocalId.value = "";
  await refreshLocal();
  renderMapMarkers();
  showSuccessToast("已结束离线巡护");
}

async function addLocalPoint() {
  if (!activeTaskLocalId.value) {
    showFailToast("请先开始巡护");
    return;
  }
  if (!pointForm.latitude || !pointForm.longitude) {
    showFailToast("请填写坐标");
    return;
  }
  await putRecord(stores.patrolPoints, {
    local_id: uid("point"),
    task_local_id: activeTaskLocalId.value,
    latitude: Number(pointForm.latitude),
    longitude: Number(pointForm.longitude),
    note: pointForm.note || "",
    synced: false,
  });
  showSuccessToast("轨迹点已离线保存");
  await refreshLocal();
  renderMapMarkers();
  pointForm.latitude = "";
  pointForm.longitude = "";
  pointForm.note = "";
}

async function addPointFromGps(coords, note = "GPS自动记录") {
  if (!activeTaskLocalId.value) {
    return;
  }
  await putRecord(stores.patrolPoints, {
    local_id: uid("point"),
    task_local_id: activeTaskLocalId.value,
    latitude: Number(coords.latitude),
    longitude: Number(coords.longitude),
    note,
    synced: false,
  });
  await refreshLocal();
  renderMapMarkers();
}

function getCurrentGps() {
  return new Promise((resolve, reject) => {
    if (!geoSecureSupported.value) {
      reject(new Error("当前访问地址非安全来源，手机浏览器通常会禁止定位。请改用 HTTPS 或 localhost。"));
      return;
    }
    if (!navigator.geolocation) {
      reject(new Error("当前浏览器不支持定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => reject(error),
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 5000,
      }
    );
  });
}

async function locateOnceAndFill() {
  if (!hasActiveTask.value) {
    showFailToast("请先开始巡护");
    return;
  }
  locating.value = true;
  try {
    const position = await getCurrentGps();
    const { latitude, longitude, accuracy } = position.coords;
    pointForm.latitude = String(latitude);
    pointForm.longitude = String(longitude);
    currentPosition.value = {
      latitude: latitude.toFixed(6),
      longitude: longitude.toFixed(6),
      accuracy: `${Math.round(accuracy)}m`,
    };
    await addPointFromGps({ latitude, longitude }, "GPS单次定位");
    showSuccessToast("已获取并保存当前位置");
  } catch (error) {
    showFailToast(error?.message || "定位失败，请检查定位权限");
  } finally {
    locating.value = false;
  }
}

async function autoTrackTick() {
  if (!hasActiveTask.value) return;
  try {
    const position = await getCurrentGps();
    const { latitude, longitude, accuracy } = position.coords;
    currentPosition.value = {
      latitude: latitude.toFixed(6),
      longitude: longitude.toFixed(6),
      accuracy: `${Math.round(accuracy)}m`,
    };
    await addPointFromGps({ latitude, longitude }, "GPS自动记录");
  } catch (_) {
    // Keep silent during auto tracking to avoid repeated toast spam.
  }
}

function stopAutoTrack() {
  autoTracking.value = false;
  if (autoTrackTimer) {
    clearInterval(autoTrackTimer);
    autoTrackTimer = null;
  }
}

function startAutoTrack() {
  if (!hasActiveTask.value) {
    showFailToast("请先开始巡护");
    return;
  }
  stopAutoTrack();
  autoTracking.value = true;
  autoTrackTick();
  autoTrackTimer = setInterval(autoTrackTick, Math.max(5, Number(autoTrackIntervalSec.value)) * 1000);
  showSuccessToast("已开启 GPS 自动记录");
}

async function addLocalEvent() {
  await addLocalEventWithPayload({
    description: eventForm.description,
    event_type: eventForm.event_type || "abnormal",
    latitude: eventForm.latitude ? Number(eventForm.latitude) : null,
    longitude: eventForm.longitude ? Number(eventForm.longitude) : null,
    photo_base64: eventForm.photo_base64 || "",
  });
  eventForm.description = "";
  eventForm.latitude = "";
  eventForm.longitude = "";
  eventForm.photo_base64 = "";
  if (eventPhotoInput.value) eventPhotoInput.value.value = "";
}

async function markCurrentLocationEvent() {
  if (!hasActiveTask.value) {
    showFailToast("请先开始巡护");
    return;
  }
  let latitude = null;
  let longitude = null;
  try {
    const position = await getCurrentGps();
    latitude = Number(position.coords.latitude);
    longitude = Number(position.coords.longitude);
    currentPosition.value = {
      latitude: latitude.toFixed(6),
      longitude: longitude.toFixed(6),
      accuracy: `${Math.round(position.coords.accuracy)}m`,
    };
  } catch (error) {
    showFailToast(error?.message || "定位失败，无法快速标记");
    return;
  }
  await addLocalEventWithPayload(
    {
      description: eventForm.description || "异常点快速标记",
      event_type: eventForm.event_type || "abnormal",
      latitude,
      longitude,
      photo_base64: eventForm.photo_base64 || "",
    },
    { skipSuccessToast: true }
  );
  eventForm.description = "";
  eventForm.latitude = "";
  eventForm.longitude = "";
  eventForm.photo_base64 = "";
  if (eventPhotoInput.value) eventPhotoInput.value.value = "";
  showSuccessToast("已快速标记当前位置异常点");
}

async function onEventPhotoSelected(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showFailToast("请选择图片文件");
    return;
  }
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  eventForm.photo_base64 = String(base64 || "");
  showSuccessToast("异常现场照片已附加");
}

async function addLocalEventWithPayload(payload, opts = {}) {
  if (!activeTaskLocalId.value) {
    showFailToast("请先开始巡护");
    return;
  }
  const description = (payload?.description || "").trim();
  if (!description) {
    showFailToast("请填写异常描述");
    return;
  }
  await putRecord(stores.patrolEvents, {
    local_id: uid("event"),
    task_local_id: activeTaskLocalId.value,
    description,
    event_type: (payload?.event_type || "abnormal").trim() || "abnormal",
    latitude: payload?.latitude ?? null,
    longitude: payload?.longitude ?? null,
    synced: false,
    photo_base64: payload?.photo_base64 || "",
    created_at: new Date().toISOString(),
  });
  if (!opts.skipSuccessToast) {
    showSuccessToast("异常事件已离线保存");
  }
}

async function removeLocalEvent(localId) {
  const ok = window.confirm("确认删除该异常事件？");
  if (!ok) return;
  await deleteRecord(stores.patrolEvents, localId);
  await refreshLocal();
  renderMapMarkers();
  showSuccessToast("异常事件已删除");
}

async function quickReport(eventType, templateText, reportOpts = {}) {
  if (!activeTaskLocalId.value) {
    showFailToast("请先开始巡护");
    return;
  }
  let latitude = null;
  let longitude = null;
  try {
    const position = await getCurrentGps();
    latitude = Number(position.coords.latitude);
    longitude = Number(position.coords.longitude);
    currentPosition.value = {
      latitude: latitude.toFixed(6),
      longitude: longitude.toFixed(6),
      accuracy: `${Math.round(position.coords.accuracy)}m`,
    };
  } catch (_) {
    // GPS acquisition may fail; event can still be reported without coordinates.
  }
  await addLocalEventWithPayload(
    {
      description: templateText,
      event_type: eventType,
      latitude,
      longitude,
    },
    { skipSuccessToast: Boolean(reportOpts.skipSuccessToast) }
  );
}

async function fireEmergencyShortcut() {
  if (!activeTaskLocalId.value) {
    showFailToast("请先开始巡护");
    return;
  }
  await quickReport("fire", "火情快捷：发现疑似烟/火点，已尝试定位并上报。", { skipSuccessToast: true });
  showSuccessToast("已保存火情事件，可前往识图补充现场照片");
  router.push({ name: "identify", query: { scene: "general", hint: "fire" } });
}

async function syncNow() {
  if (!online.value) {
    showFailToast("当前离线，无法同步");
    return;
  }
  syncing.value = true;
  try {
    const payload = {
      tasks: await getAllRecords(stores.patrolTasks),
      points: await getAllRecords(stores.patrolPoints),
      events: await getAllRecords(stores.patrolEvents),
    };
    const { data } = await postWithSyncRetry(apiClient, "/patrol/sync", payload);
    await clearStore(stores.patrolTasks);
    await clearStore(stores.patrolPoints);
    await clearStore(stores.patrolEvents);
    activeTaskLocalId.value = "";
    await refreshLocal();
    renderMapMarkers();
    syncMeta.value = setSyncMeta("patrol", {
      lastSuccessAt: new Date().toISOString(),
      lastError: "",
    });
    const inserted = data?.inserted || {};
    const summary = `任务${inserted.tasks || 0} / 轨迹${inserted.points || 0} / 事件${inserted.events || 0}`;
    showSuccessToast(data?.deduplicated ? `同步已去重（${summary}）` : `同步成功（${summary}）`);
    await loadServerTasks();
    await loadServerEvents();
  } catch (error) {
    const message = withSyncSuggestion(error?.response?.data?.error?.message || "同步失败");
    syncMeta.value = setSyncMeta("patrol", {
      lastError: message,
    });
    showFailToast(message);
  } finally {
    syncing.value = false;
  }
}

async function autoSyncIfPending() {
  if (!online.value || syncing.value) return;
  const localTasks = await getAllRecords(stores.patrolTasks);
  const localPoints = await getAllRecords(stores.patrolPoints);
  const localEvents = await getAllRecords(stores.patrolEvents);
  if (!localTasks.length && !localPoints.length && !localEvents.length) return;
  if (!autoSyncHintShown.value) {
    showSuccessToast("网络已恢复，已自动触发巡护同步");
    autoSyncHintShown.value = true;
  }
  await syncNow();
}

async function loadServerTasks() {
  if (!online.value) return;
  loadingServer.value = true;
  try {
    const { data } = await apiClient.get("/patrol/tasks");
    serverTasks.value = data.items || [];
  } catch (_) {
    // Silent fail for now; this page focuses on offline core.
  } finally {
    loadingServer.value = false;
  }
}

async function loadServerEvents() {
  if (!online.value) return;
  try {
    const { data } = await apiClient.get("/patrol/events");
    serverEvents.value = data.items || [];
    renderMapMarkers();
  } catch (_) {
    serverEvents.value = [];
    renderMapMarkers();
  }
}

async function initMapIfNeeded() {
  if (!online.value || !mapEnabled.value || mapReady.value || !mapContainer.value) return;
  try {
    if (geoSecureSupported.value && !currentPosition.value.latitude) {
      try {
        const position = await getCurrentGps();
        currentPosition.value = {
          latitude: Number(position.coords.latitude).toFixed(6),
          longitude: Number(position.coords.longitude).toFixed(6),
          accuracy: `${Math.round(position.coords.accuracy)}m`,
        };
      } catch (_) {
        // Ignore geolocation failure; map can still render with fallback center.
      }
    }
    const AMap = await loadAmapSdk();
    let initialCenter = getInitialMapCenter();
    if (!currentPosition.value.latitude && !localPoints.value.length && !localEvents.value.length) {
      const ipCenter = await getAmapIpCenter(AMap);
      if (ipCenter) {
        initialCenter = ipCenter;
      }
    }
    amapInstance = new AMap.Map(mapContainer.value, {
      zoom: currentPosition.value.latitude ? 15 : 5,
      resizeEnable: true,
      center: initialCenter,
    });
    mapReady.value = true;
    mapError.value = "";
    renderMapMarkers();
  } catch (error) {
    mapError.value = error?.message || "地图初始化失败";
  }
}

function clearMapMarkers() {
  if (!amapInstance || !amapMarkers.length) return;
  amapInstance.remove(amapMarkers);
  amapMarkers = [];
}

function clearMapPolyline() {
  if (!amapInstance || !amapPolyline) return;
  amapInstance.remove(amapPolyline);
  amapPolyline = null;
}

function renderMapMarkers() {
  if (!amapInstance || !mapReady.value) return;
  clearMapMarkers();
  clearMapPolyline();

  const trackPoints = localPoints.value
    .map((item) => ({
      lng: Number(item.longitude),
      lat: Number(item.latitude),
      note: item.note || "轨迹点",
      isEvent: false,
    }))
    .filter((item) => !Number.isNaN(item.lng) && !Number.isNaN(item.lat));

  const eventPoints = localEvents.value
    .map((item) => ({
      lng: Number(item.longitude),
      lat: Number(item.latitude),
      note: item.description || "异常事件",
      isEvent: true,
      event: item,
      isCloud: false,
    }))
    .filter((item) => !Number.isNaN(item.lng) && !Number.isNaN(item.lat));
  const cloudEventPoints = serverEvents.value
    .map((item) => ({
      lng: Number(item.longitude),
      lat: Number(item.latitude),
      note: item.description || "云端异常",
      isEvent: true,
      event: item,
      isCloud: true,
    }))
    .filter((item) => !Number.isNaN(item.lng) && !Number.isNaN(item.lat));

  const allPoints = [...trackPoints, ...eventPoints, ...cloudEventPoints];

  if (currentPosition.value.latitude && currentPosition.value.longitude) {
    allPoints.push({
      lng: Number(currentPosition.value.longitude),
      lat: Number(currentPosition.value.latitude),
      note: "当前位置",
      isEvent: false,
    });
  }

  if (!allPoints.length) return;

  if (trackPoints.length >= 2) {
    amapPolyline = new window.AMap.Polyline({
      path: trackPoints.map((pt) => [pt.lng, pt.lat]),
      strokeColor: "#1989fa",
      strokeWeight: 5,
      strokeOpacity: 0.85,
      showDir: true,
    });
    amapInstance.add(amapPolyline);
  }

  amapMarkers = allPoints.map((pt) => {
    if (pt.isEvent) {
      const marker = new window.AMap.CircleMarker({
        center: [pt.lng, pt.lat],
        radius: 8,
        strokeColor: pt.isCloud ? "#1989fa" : "#ee0a24",
        strokeWeight: 2,
        fillColor: pt.isCloud ? "#1989fa" : "#ee0a24",
        fillOpacity: 0.6,
        title: pt.note,
      });
      marker.on("click", () => {
        activeEventPreview.value = pt.event || null;
      });
      return marker;
    }
    return new window.AMap.Marker({
      position: [pt.lng, pt.lat],
      title: pt.note,
    });
  });
  amapInstance.add(amapMarkers);
  amapInstance.setFitView(amapMarkers, false, [60, 60, 60, 60], 16);
}

onMounted(async () => {
  bindNetworkListeners();
  await refreshLocal();
  await loadServerTasks();
  await loadServerEvents();
  await nextTick();
  await initMapIfNeeded();
});

onUnmounted(() => {
  stopAutoTrack();
  clearMapMarkers();
  clearMapPolyline();
  if (amapInstance) {
    amapInstance.destroy();
    amapInstance = null;
  }
});

watch(online, async (value) => {
  if (value) {
    await nextTick();
    await initMapIfNeeded();
  }
});
</script>

<template>
  <div class="page">
    <van-nav-bar title="巡护助手（离线优先）" left-arrow @click-left="$router.back()" />

    <div class="card">
      <p>
        当前网络：
        <span :class="online ? 'online' : 'offline'">{{ online ? "在线" : "离线" }}</span>
      </p>
      <van-button type="primary" block @click="startLocalTask">开始巡护（离线）</van-button>
      <van-button type="warning" block @click="endLocalTask">结束巡护（离线）</van-button>
      <van-button type="success" block :loading="syncing" @click="syncNow">立即同步</van-button>
      <p>本地任务数：{{ tasks.length }}</p>
      <p>最近同步成功：{{ syncMeta.lastSuccessAt || "暂无" }}</p>
      <p v-if="syncMeta.lastError" class="error-tip">最近同步失败：{{ syncMeta.lastError }}</p>
    </div>

    <div class="card">
      <h3>GPS 记录（离线可用）</h3>
      <p v-if="!geoSecureSupported" class="warn-tip">
        当前为非 HTTPS 地址，浏览器可能拒绝定位。可先手动填写经纬度，或改用 HTTPS 真机访问。
      </p>
      <van-field
        v-model="autoTrackIntervalSec"
        type="number"
        label="自动间隔(秒)"
        placeholder="默认15"
      />
      <van-button type="primary" block :loading="locating" :disabled="!hasActiveTask" @click="locateOnceAndFill">
        获取当前位置并记录
      </van-button>
      <van-button
        v-if="!autoTracking"
        type="success"
        block
        :disabled="!hasActiveTask"
        @click="startAutoTrack"
      >
        开启自动记录
      </van-button>
      <van-button v-else type="warning" block @click="stopAutoTrack">停止自动记录</van-button>
      <p v-if="currentPosition.latitude">
        当前位置：{{ currentPosition.latitude }}, {{ currentPosition.longitude }}
        （精度 {{ currentPosition.accuracy }}）
      </p>
    </div>

    <div class="card">
      <h3>在线地图（高德）</h3>
      <p v-if="!mapEnabled">未配置高德 Key，地图功能未启用</p>
      <p v-else-if="!online">当前离线，地图暂停，仍可记录坐标</p>
      <p v-else-if="mapError">{{ mapError }}</p>
      <div v-else ref="mapContainer" class="map-box" />
      <div v-if="activeEventPreview" class="event-preview">
        <p class="event-preview-title">点位详情：{{ eventTypeText(activeEventPreview.event_type) }}</p>
        <p>{{ activeEventPreview.description }}</p>
        <p>来源：{{ sourceText(activeEventPreview) }}</p>
        <p v-if="activeEventPreview.task_title">来源任务：{{ activeEventPreview.task_title }}</p>
        <p v-if="activeEventPreview.created_at">记录时间：{{ activeEventPreview.created_at }}</p>
        <p>
          坐标：{{ activeEventPreview.latitude ?? "无" }}，{{ activeEventPreview.longitude ?? "无" }}
        </p>
        <img
          v-if="activeEventPreview.photo_base64"
          :src="activeEventPreview.photo_base64"
          class="event-photo"
          alt="异常现场"
        />
      </div>
      <p>当前离线轨迹点：{{ localPoints.length }}</p>
      <p>当前离线异常点：{{ localEvents.length }}</p>
      <p>云端异常点：{{ serverEvents.length }}</p>
    </div>

    <div class="card">
      <h3>离线上报轨迹点</h3>
      <van-field v-model="pointForm.latitude" label="纬度" placeholder="例如 30.1234" />
      <van-field v-model="pointForm.longitude" label="经度" placeholder="例如 120.1234" />
      <van-field v-model="pointForm.note" label="备注" placeholder="可选" />
      <van-button type="success" block :disabled="!hasActiveTask" @click="addLocalPoint">
        保存轨迹点
      </van-button>
    </div>

    <div class="card">
      <h3>一键上报</h3>
      <van-button type="primary" block :disabled="!hasActiveTask" @click="quickReport('disease', '发现病害，已拍照并上报')">
        发现病害：一键上报
      </van-button>
      <van-button type="danger" block :disabled="!hasActiveTask" @click="quickReport('fire', '发现火情疑似点，建议紧急处置')">
        发现火情：一键上报
      </van-button>
      <van-button type="danger" plain block :disabled="!hasActiveTask" @click="fireEmergencyShortcut">
        火情快捷：上报并前往识图
      </van-button>
      <van-button
        type="warning"
        block
        :disabled="!hasActiveTask"
        @click="quickReport('illegal_logging', '发现疑似盗伐迹象，已记录证据')"
      >
        发现盗伐：一键上报
      </van-button>
      <van-button
        type="default"
        block
        :disabled="!hasActiveTask"
        @click="quickReport('ecology', '发现野生动物活动迹象，已完成生态观测记录')"
      >
        发现动物：一键上报
      </van-button>
    </div>

    <div class="card">
      <h3>离线记录异常事件</h3>
      <van-field label="分类">
        <template #input>
          <select v-model="eventForm.event_type" class="scene-select">
            <option value="abnormal">异常</option>
            <option value="disease">病害</option>
            <option value="pest">虫害</option>
            <option value="fire">火情</option>
            <option value="illegal_logging">盗伐</option>
            <option value="ecology">生态观测</option>
          </select>
        </template>
      </van-field>
      <van-field v-model="eventForm.description" label="描述" placeholder="异常现象描述" />
      <van-field v-model="eventForm.latitude" label="纬度" placeholder="可选" />
      <van-field v-model="eventForm.longitude" label="经度" placeholder="可选" />
      <van-button type="default" block @click="eventPhotoInput?.click()">上传现场照片（可选）</van-button>
      <input
        ref="eventPhotoInput"
        type="file"
        accept="image/*"
        capture="environment"
        class="hidden-input"
        @change="onEventPhotoSelected"
      />
      <img v-if="eventForm.photo_base64" :src="eventForm.photo_base64" class="event-photo" alt="现场预览" />
      <van-button type="warning" block :disabled="!hasActiveTask" @click="markCurrentLocationEvent">
        一键标记当前位置异常
      </van-button>
      <van-button type="danger" block :disabled="!hasActiveTask" @click="addLocalEvent">
        保存异常事件
      </van-button>
    </div>

    <div class="card">
      <h3>本地异常事件列表</h3>
      <p v-if="!localEvents.length">暂无本地异常事件</p>
      <div
        v-for="item in localEvents"
        :key="item.local_id"
        class="event-item"
        :class="{
          'is-disease': item.event_type === 'disease',
          'is-pest': item.event_type === 'pest',
          'is-fire': item.event_type === 'fire',
          'is-illegal': item.event_type === 'illegal_logging',
          'is-ecology': item.event_type === 'ecology',
        }"
      >
        <p class="event-title">
          {{ eventTypeText(item.event_type) }}
          <span v-if="['disease', 'pest', 'ecology'].includes(item.event_type)" class="event-tag">识图联动</span>
        </p>
        <p class="event-desc">{{ item.description }}</p>
        <p class="event-meta">
          坐标：{{ item.latitude ?? "无" }}, {{ item.longitude ?? "无" }}
        </p>
        <p class="event-meta">时间：{{ item.created_at || "未知" }}</p>
        <img v-if="item.photo_base64" :src="item.photo_base64" class="event-photo" alt="现场照片" />
        <div class="event-actions">
          <van-button size="small" type="primary" plain @click="askGuidanceForEvent(item)">
            生成问答建议
          </van-button>
          <van-button size="small" type="danger" plain @click="removeLocalEvent(item.local_id)">
            删除事件
          </van-button>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>云端异常点列表</h3>
      <p v-if="!serverEvents.length">暂无云端异常点</p>
      <div
        v-for="item in serverEvents"
        :key="`cloud_${item.id}`"
        class="event-item"
        @click="activeEventPreview = item"
      >
        <p class="event-title">{{ eventTypeText(item.event_type) }}（{{ item.task_title }}）</p>
        <p class="event-desc">{{ item.description }}</p>
        <p class="event-meta">时间：{{ item.created_at || "未知" }}</p>
        <p class="event-meta">坐标：{{ item.latitude ?? "无" }}, {{ item.longitude ?? "无" }}</p>
      </div>
    </div>

    <div class="card">
      <h3>云端巡护历史</h3>
      <van-loading v-if="loadingServer" size="20px">加载中...</van-loading>
      <p v-else-if="!serverTasks.length">暂无云端任务</p>
      <van-cell
        v-for="item in serverTasks"
        :key="item.id"
        :title="`#${item.id} ${item.title}`"
        :label="`状态：${item.status}`"
      />
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #f7f8fa;
  padding: 16px;
}

.card {
  background: #fff;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
  display: grid;
  gap: 10px;
}

.online {
  color: #07c160;
  font-weight: 600;
}

.offline {
  color: #ee0a24;
  font-weight: 600;
}

.error-tip {
  color: #ee0a24;
}

.warn-tip {
  color: #ff976a;
}

.hidden-input {
  display: none;
}

.scene-select {
  width: 100%;
  height: 32px;
  border: 1px solid #dcdee0;
  border-radius: 6px;
  padding: 0 8px;
  background: #fff;
}

.map-box {
  width: 100%;
  height: 260px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #f2f3f5;
}

.event-preview {
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  padding: 8px;
}

.event-preview-title {
  margin: 0;
  font-weight: 600;
}

.event-item {
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  padding: 8px;
  display: grid;
  gap: 4px;
}

.event-item.is-disease {
  border-color: #1989fa;
  background: #f0f7ff;
}

.event-item.is-pest {
  border-color: #ff976a;
  background: #fff8f3;
}

.event-item.is-fire {
  border-color: #ee0a24;
  background: #fff2f2;
}

.event-item.is-illegal {
  border-color: #ff976a;
  background: #fff7ef;
}

.event-item.is-ecology {
  border-color: #07c160;
  background: #f2fbf5;
}

.event-title {
  margin: 0;
  font-weight: 600;
}

.event-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 11px;
  color: #1989fa;
  border: 1px solid #1989fa;
  background: #fff;
}

.event-desc {
  margin: 0;
  color: #323233;
}

.event-meta {
  margin: 0;
  font-size: 12px;
  color: #969799;
}

.event-photo {
  width: 100%;
  max-height: 180px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid #f2f3f5;
}

.event-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
