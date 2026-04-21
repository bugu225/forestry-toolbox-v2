<script setup>
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import { showFailToast, showSuccessToast } from "vant";
import {
  countPatrolEventsForTask,
  countPatrolPointsForTask,
  deleteRecord,
  getAllRecords,
  getPatrolEventsForTask,
  getPatrolEventsForTaskAll,
  getPatrolPointsForTask,
  putRecord,
  stores,
} from "../services/offlineDb";
import { useNetworkStore } from "../stores/network";

const PatrolMapPanel = defineAsyncComponent(() => import("../components/PatrolMapPanel.vue"));

const AUTO_SAMPLE_MS = 5 * 60 * 1000;
const MAX_PATROL_POINTS_UI = 2500;
const MAX_PATROL_EVENTS_UI = 800;
const HENAN_BOUNDS = {
  minLng: 110.35,
  maxLng: 116.65,
  minLat: 31.38,
  maxLat: 36.37,
};

const networkStore = useNetworkStore();
const { effectiveOnline: online } = storeToRefs(networkStore);

const currentTask = ref(null);
const patrolPoints = ref([]);
const patrolEvents = ref([]);
const viewingTaskLocalId = ref("");
const recording = ref(false);
const eventPopupVisible = ref(false);
const eventBusy = ref(false);
const eventPhotoInput = ref(null);
const eventAudioInput = ref(null);
const filterType = ref("all");
const sortOrder = ref("desc");
const focusedEventLocalId = ref("");
const totalPatrolPointCount = ref(0);
const totalPatrolEventCount = ref(0);
const detailsLoading = ref(false);
const mapRequested = ref(false);
const mapPanelRef = ref(null);

let timerId = null;

const eventTypeOptions = [
  { text: "病虫害", value: "pest", emoji: "●" },
  { text: "火情", value: "fire", emoji: "▲" },
  { text: "盗伐", value: "logging", emoji: "■" },
  { text: "其他异常", value: "other", emoji: "⚠" },
];

const eventDraft = reactive({
  type: "other",
  note: "",
  lat: "",
  lng: "",
  capturedAt: "",
  photoDataUrl: "",
  audioDataUrl: "",
});

const sortedEvents = computed(() => {
  const copied = [...patrolEvents.value];
  copied.sort((a, b) => {
    const ta = new Date(a.captured_at || 0).getTime();
    const tb = new Date(b.captured_at || 0).getTime();
    return sortOrder.value === "desc" ? tb - ta : ta - tb;
  });
  if (filterType.value === "all") return copied;
  return copied.filter((x) => x.type === filterType.value);
});
const MAX_EVENTS_IN_LIST = 200;
const displayedEvents = computed(() => sortedEvents.value.slice(0, MAX_EVENTS_IN_LIST));
const hiddenEventListCount = computed(() => Math.max(0, sortedEvents.value.length - MAX_EVENTS_IN_LIST));
const pointCount = computed(() => totalPatrolPointCount.value);
const eventCount = computed(() => totalPatrolEventCount.value);
const uiPointLoaded = computed(() => patrolPoints.value.length);
const uiEventLoaded = computed(() => patrolEvents.value.length);

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function eventTypeMeta(type) {
  return eventTypeOptions.find((x) => x.value === type) || eventTypeOptions[eventTypeOptions.length - 1];
}

function toDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function formatGeoError(error, fallback = "无法获取定位") {
  const code = Number(error?.code || 0);
  if (code === 1) {
    return "定位权限被拒绝：请在系统和浏览器设置中允许位置权限后重试。";
  }
  if (code === 2) {
    return "定位不可用：请确认已开启手机定位服务（GPS），并在室外或网络较好环境重试。";
  }
  if (code === 3) {
    return "定位超时：请稍后重试，或关闭省电模式后再试。";
  }
  if (window.isSecureContext === false) {
    return "当前页面不是安全上下文，浏览器可能拒绝定位。请改用 HTTPS 或 localhost 访问。";
  }
  return fallback;
}

function isWithinHenan(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  return lo >= HENAN_BOUNDS.minLng && lo <= HENAN_BOUNDS.maxLng && la >= HENAN_BOUNDS.minLat && la <= HENAN_BOUNDS.maxLat;
}

function assertHenanScope(lat, lng) {
  if (isWithinHenan(lat, lng)) return true;
  showFailToast("当前位置超出河南省巡护范围，请在河南省范围内使用巡护地图。");
  return false;
}

async function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("当前设备不支持 GPS"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: Number(pos.coords.latitude || 0),
          lng: Number(pos.coords.longitude || 0),
          accuracy: Number(pos.coords.accuracy || 0),
        });
      },
      (error) => reject(new Error(formatGeoError(error, "无法获取定位，请检查定位权限"))),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 20000 }
    );
  });
}

async function refreshPatrolTasksOnly() {
  const tasks = await getAllRecords(stores.patrolTasks);
  const sortedTasks = [...tasks].sort((a, b) => {
    const ta = new Date(a.started_at || a.ended_at || 0).getTime();
    const tb = new Date(b.started_at || b.ended_at || 0).getTime();
    return tb - ta;
  });
  const active = sortedTasks.find((x) => x.status === "recording");
  const latestTask = sortedTasks[0] || null;
  viewingTaskLocalId.value = (active || latestTask)?.local_id || "";
  currentTask.value = active || null;
  recording.value = Boolean(active);
}

async function refreshPatrolCounts() {
  const vid = viewingTaskLocalId.value;
  if (!vid) {
    totalPatrolPointCount.value = 0;
    totalPatrolEventCount.value = 0;
    return;
  }
  const [pc, ec] = await Promise.all([countPatrolPointsForTask(vid), countPatrolEventsForTask(vid)]);
  totalPatrolPointCount.value = pc;
  totalPatrolEventCount.value = ec;
}

async function refreshPatrolDetails() {
  const vid = viewingTaskLocalId.value;
  if (!vid) {
    patrolPoints.value = [];
    patrolEvents.value = [];
    return;
  }
  const [pRes, eRes] = await Promise.all([
    getPatrolPointsForTask(vid, { maxRows: MAX_PATROL_POINTS_UI }),
    getPatrolEventsForTask(vid, { maxRows: MAX_PATROL_EVENTS_UI }),
  ]);
  patrolPoints.value = pRes.rows;
  patrolEvents.value = eRes.rows;
}

async function refreshPatrolDataFull() {
  await refreshPatrolTasksOnly();
  await refreshPatrolCounts();
  await refreshPatrolDetails();
}

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

async function samplePoint(manual = false) {
  if (!currentTask.value) return;
  try {
    const pos = await getCurrentPosition();
    if (!assertHenanScope(pos.lat, pos.lng)) return;
    await putRecord(stores.patrolPoints, {
      local_id: uid("patrol_point"),
      task_local_id: currentTask.value.local_id,
      lat: pos.lat,
      lng: pos.lng,
      accuracy: pos.accuracy,
      captured_at: new Date().toISOString(),
      source: manual ? "manual" : "auto",
    });
    await refreshPatrolDataFull();
    if (manual) showSuccessToast("已记录当前轨迹点");
  } catch (error) {
    if (manual) showFailToast(error?.message || "记录轨迹点失败");
  }
}

function startTimer() {
  stopTimer();
  timerId = setInterval(() => {
    samplePoint(false);
  }, AUTO_SAMPLE_MS);
}

async function startPatrol() {
  if (recording.value) {
    showFailToast("当前巡护已在进行中");
    return;
  }
  const now = new Date().toISOString();
  const task = {
    local_id: uid("patrol_task"),
    status: "recording",
    started_at: now,
    ended_at: "",
    title: `巡护任务 ${new Date().toLocaleString()}`,
  };
  await putRecord(stores.patrolTasks, task);
  currentTask.value = task;
  recording.value = true;
  await samplePoint(true);
  startTimer();
  showSuccessToast("已开始巡护，后台将按 5 分钟自动采样轨迹");
}

async function stopPatrol() {
  if (!currentTask.value) {
    showFailToast("当前没有进行中的巡护");
    return;
  }
  stopTimer();
  await putRecord(stores.patrolTasks, {
    ...currentTask.value,
    status: "done",
    ended_at: new Date().toISOString(),
  });
  currentTask.value = null;
  recording.value = false;
  await refreshPatrolDataFull();
  showSuccessToast("已结束巡护");
}

async function openEventPopup() {
  if (!recording.value || !currentTask.value) {
    showFailToast("请先开始巡护");
    return;
  }
  try {
    const pos = await getCurrentPosition();
    if (!assertHenanScope(pos.lat, pos.lng)) return;
    eventDraft.type = "other";
    eventDraft.note = "";
    eventDraft.lat = pos.lat.toFixed(6);
    eventDraft.lng = pos.lng.toFixed(6);
    eventDraft.capturedAt = new Date().toISOString();
    eventDraft.photoDataUrl = "";
    eventDraft.audioDataUrl = "";
    eventPopupVisible.value = true;
  } catch (error) {
    showFailToast(error?.message || "获取当前定位失败");
  }
}

async function onPickPhoto(ev) {
  const file = ev?.target?.files?.[0];
  ev.target.value = "";
  if (!file) return;
  try {
    eventDraft.photoDataUrl = await toDataUrl(file);
    showSuccessToast("图片已附加");
  } catch {
    showFailToast("图片读取失败");
  }
}

async function onPickAudio(ev) {
  const file = ev?.target?.files?.[0];
  ev.target.value = "";
  if (!file) return;
  try {
    eventDraft.audioDataUrl = await toDataUrl(file);
    showSuccessToast("录音已附加");
  } catch {
    showFailToast("录音读取失败");
  }
}

async function saveEvent() {
  if (!currentTask.value) return;
  if (!assertHenanScope(eventDraft.lat, eventDraft.lng)) return;
  eventBusy.value = true;
  try {
    await putRecord(stores.patrolEvents, {
      local_id: uid("patrol_event"),
      task_local_id: currentTask.value.local_id,
      type: eventDraft.type,
      note: (eventDraft.note || "").trim(),
      lat: Number(eventDraft.lat),
      lng: Number(eventDraft.lng),
      captured_at: eventDraft.capturedAt || new Date().toISOString(),
      photo_data_url: eventDraft.photoDataUrl || "",
      audio_data_url: eventDraft.audioDataUrl || "",
    });
    eventPopupVisible.value = false;
    await refreshPatrolDataFull();
    showSuccessToast("事件已保存");
  } catch {
    showFailToast("保存事件失败");
  } finally {
    eventBusy.value = false;
  }
}

async function removeEvent(row) {
  const ok = window.confirm("确认删除该事件？");
  if (!ok) return;
  await deleteRecord(stores.patrolEvents, row.local_id);
  await refreshPatrolDataFull();
  showSuccessToast("已删除");
}

async function exportEventsJson() {
  const vid = viewingTaskLocalId.value;
  if (!vid) {
    showFailToast("暂无可导出事件");
    return;
  }
  let rows;
  try {
    rows = await getPatrolEventsForTaskAll(vid);
  } catch {
    showFailToast("读取事件失败");
    return;
  }
  if (!rows.length) {
    showFailToast("暂无可导出事件");
    return;
  }
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `patrol_events_${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showSuccessToast("已导出 JSON");
}

function formatTime(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return "无记录";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours()
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function locateEventOnMap(row) {
  focusedEventLocalId.value = row.local_id;
  if (!online.value) return;
  if (!mapRequested.value) {
    mapRequested.value = true;
  }
  for (let i = 0; i < 25; i += 1) {
    await nextTick();
    const panel = mapPanelRef.value;
    if (panel && typeof panel.zoomToEvent === "function") {
      await panel.zoomToEvent(row);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function requestMapPanel() {
  mapRequested.value = true;
}

function onWindowOnline() {
  networkStore.setNavigatorOnline(true);
}

function onWindowOffline() {
  networkStore.setNavigatorOnline(false);
}

onMounted(() => {
  window.addEventListener("online", onWindowOnline);
  window.addEventListener("offline", onWindowOffline);
  void (async () => {
    await refreshPatrolTasksOnly();
    await refreshPatrolCounts();
    if (recording.value) startTimer();
    detailsLoading.value = true;
    try {
      await new Promise((resolve) => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => resolve(), { timeout: 2000 });
        } else {
          setTimeout(resolve, 48);
        }
      });
      await refreshPatrolDetails();
    } finally {
      detailsLoading.value = false;
    }
  })();
});

onUnmounted(() => {
  window.removeEventListener("online", onWindowOnline);
  window.removeEventListener("offline", onWindowOffline);
  stopTimer();
});
</script>

<template>
  <div class="page">
    <van-nav-bar title="智能巡护" left-arrow @click-left="$router.back()">
      <template #right>
        <span class="net-flag">网络：{{ online ? "在线" : "离线" }}</span>
      </template>
    </van-nav-bar>

    <section class="card ops">
      <div class="ops-row">
        <van-button type="primary" :disabled="recording" @click="startPatrol">开始巡护</van-button>
        <van-button type="warning" :disabled="!recording" @click="stopPatrol">结束巡护</van-button>
        <van-button type="default" :disabled="!recording" @click="samplePoint(true)">立即采样</van-button>
      </div>
      <p class="tip">
        {{ recording ? "巡护进行中：每 5 分钟自动记录轨迹点" : "当前未巡护，点击开始后将记录轨迹并支持事件标记" }}
      </p>
      <div class="summary">
        <span>轨迹点：{{ pointCount }}</span>
        <span>事件数：{{ eventCount }}</span>
      </div>
      <p v-if="pointCount > uiPointLoaded || eventCount > uiEventLoaded" class="tip">
        为减轻卡顿，列表仅载入当前任务最近 {{ MAX_PATROL_POINTS_UI }} 个轨迹点与 {{ MAX_PATROL_EVENTS_UI }} 条事件；统计为实际总量。
      </p>
    </section>

    <section class="card event-entry">
      <div class="head">
        <h3>一键事件标记</h3>
        <van-button size="small" type="primary" :disabled="!recording" @click="openEventPopup">记录事件</van-button>
      </div>
      <p class="tip">支持病虫害、火情、盗伐、其他异常；可附加备注、照片与录音。</p>
    </section>

    <section class="card map-box">
      <div class="head">
        <h3>地图轨迹可视化</h3>
      </div>
      <p class="tip">
        地图按需加载：默认不拉取高德脚本，避免首进页面卡死。需要看图时点击下方按钮；定位某条事件时会自动打开地图。
      </p>
      <van-button v-if="online && !mapRequested" block type="primary" plain @click="requestMapPanel">显示地图（加载高德）</van-button>
      <PatrolMapPanel
        v-if="mapRequested && online"
        ref="mapPanelRef"
        :online="online"
        :patrol-points="patrolPoints"
        :patrol-events="patrolEvents"
      />
      <p v-else-if="!online" class="tip">离线不加载在线地图；轨迹与事件仍保存在本机。</p>
    </section>

    <section class="card events-panel">
      <div class="head">
        <h3>事件管理面板</h3>
        <van-button size="small" type="default" @click="exportEventsJson">导出</van-button>
      </div>
      <div class="filters">
        <van-dropdown-menu>
          <van-dropdown-item
            v-model="filterType"
            :options="[{ text: '全部类型', value: 'all' }, ...eventTypeOptions]"
            @change="focusedEventLocalId = ''"
          />
          <van-dropdown-item
            v-model="sortOrder"
            :options="[
              { text: '时间倒序', value: 'desc' },
              { text: '时间正序', value: 'asc' }
            ]"
          />
        </van-dropdown-menu>
      </div>
      <div v-if="detailsLoading" class="empty loading-box">
        <van-loading vertical size="24px">载入轨迹与事件…</van-loading>
      </div>
      <template v-else>
        <div v-if="!sortedEvents.length" class="empty">暂无事件记录</div>
        <div v-else class="event-list">
          <article
            v-for="ev in displayedEvents"
            :key="ev.local_id"
            class="event-item"
            :class="{ focused: focusedEventLocalId === ev.local_id }"
            @click="locateEventOnMap(ev)"
          >
            <div class="line1">
              <span>{{ eventTypeMeta(ev.type).emoji }} {{ eventTypeMeta(ev.type).text }}</span>
              <span>{{ formatTime(ev.captured_at) }}</span>
            </div>
            <p class="line2">位置：{{ Number(ev.lat).toFixed(6) }}, {{ Number(ev.lng).toFixed(6) }}</p>
            <p class="line3">备注：{{ ev.note || "无" }}</p>
            <div class="row-actions">
              <van-button size="mini" type="primary" plain @click.stop="locateEventOnMap(ev)">定位</van-button>
              <van-button size="mini" type="danger" plain @click.stop="removeEvent(ev)">删除</van-button>
            </div>
          </article>
          <p v-if="hiddenEventListCount > 0" class="tip">
            事件列表仅显示最近 {{ MAX_EVENTS_IN_LIST }} 条，已省略 {{ hiddenEventListCount }} 条。
          </p>
        </div>
      </template>
    </section>

    <van-popup v-model:show="eventPopupVisible" position="bottom" round :style="{ height: '72%' }">
      <div class="event-form">
        <h3>记录巡护事件</h3>
        <p class="sub-label">事件类型</p>
        <van-radio-group v-model="eventDraft.type" direction="horizontal" class="type-radios">
          <van-radio v-for="x in eventTypeOptions" :key="x.value" :name="x.value">{{ x.text }}</van-radio>
        </van-radio-group>
        <van-field v-model="eventDraft.capturedAt" label="时间" readonly />
        <van-field v-model="eventDraft.lat" label="纬度" readonly />
        <van-field v-model="eventDraft.lng" label="经度" readonly />
        <van-field v-model="eventDraft.note" type="textarea" rows="4" autosize maxlength="2000" label="备注" />
        <div class="attach-row">
          <input ref="eventPhotoInput" type="file" accept="image/*" class="hidden-input" @change="onPickPhoto" />
          <input ref="eventAudioInput" type="file" accept="audio/*" class="hidden-input" @change="onPickAudio" />
          <van-button size="small" @click="eventPhotoInput?.click()">附加照片</van-button>
          <van-button size="small" @click="eventAudioInput?.click()">附加录音</van-button>
        </div>
        <p class="tip">照片：{{ eventDraft.photoDataUrl ? "已附加" : "未附加" }}；录音：{{ eventDraft.audioDataUrl ? "已附加" : "未附加" }}</p>
        <div class="form-actions">
          <van-button block @click="eventPopupVisible = false">取消</van-button>
          <van-button block type="primary" :loading="eventBusy" @click="saveEvent">保存事件</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #f6f7fb;
  padding-bottom: 16px;
}
.net-flag {
  font-size: 12px;
  color: #646566;
}
.card {
  background: #fff;
  margin: 12px;
  border-radius: 12px;
  padding: 12px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}
.ops-row {
  display: flex;
  gap: 8px;
}
.tip {
  margin: 8px 0 0;
  color: #969799;
  font-size: 12px;
}
.summary {
  margin-top: 10px;
  display: flex;
  gap: 16px;
  color: #323233;
  font-size: 13px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.head h3 {
  margin: 0;
  font-size: 16px;
}
.sub-label {
  margin: 0 0 6px;
  font-size: 14px;
  color: #646566;
}
.map-box .tip:first-of-type {
  margin-top: 4px;
}
.filters {
  margin: 8px 0;
}
.empty {
  color: #969799;
  font-size: 13px;
  padding: 8px 0;
}
.loading-box {
  display: flex;
  justify-content: center;
  padding: 24px 0;
}
.event-list {
  display: grid;
  gap: 8px;
}
.event-item {
  border: 1px solid #e8ebf0;
  border-radius: 10px;
  padding: 10px;
}
.event-item.focused {
  border-color: #1989fa;
  background: #f0f7ff;
}
.line1 {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
}
.line2,
.line3 {
  margin: 6px 0 0;
  font-size: 12px;
  color: #646566;
}
.row-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
.event-form {
  padding: 14px 14px 18px;
}
.event-form h3 {
  margin: 0 0 8px;
}
.type-radios {
  margin: 4px 0 10px;
}
.attach-row {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
.hidden-input {
  display: none;
}
.form-actions {
  margin-top: 14px;
  display: grid;
  gap: 8px;
}
</style>
