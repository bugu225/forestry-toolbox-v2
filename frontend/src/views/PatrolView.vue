<script setup>
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import { showFailToast, showSuccessToast } from "vant";
import { loadAmapSdk } from "../services/amapLoader";
import { deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";
import { useNetworkStore } from "../stores/network";

const AUTO_SAMPLE_MS = 5 * 60 * 1000;
const networkStore = useNetworkStore();
const { effectiveOnline: online } = storeToRefs(networkStore);

const currentTask = ref(null);
const patrolPoints = ref([]);
const patrolEvents = ref([]);
const recording = ref(false);
const eventPopupVisible = ref(false);
const eventBusy = ref(false);
const mapWrapRef = ref(null);
const eventPhotoInput = ref(null);
const eventAudioInput = ref(null);
const filterType = ref("all");
const sortOrder = ref("desc");
const focusedEventLocalId = ref("");
let timerId = null;
let map = null;
let polyline = null;
let eventMarkers = [];
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

const hasMap = computed(() => online.value && Boolean(map));
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
const pointCount = computed(() => patrolPoints.value.length);
const eventCount = computed(() => patrolEvents.value.length);

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

async function refreshLocal() {
  const [tasks, points, events] = await Promise.all([
    getAllRecords(stores.patrolTasks),
    getAllRecords(stores.patrolPoints),
    getAllRecords(stores.patrolEvents),
  ]);
  const active = tasks
    .filter((x) => x.status === "recording")
    .sort((a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime())[0];
  currentTask.value = active || null;
  patrolPoints.value = points
    .filter((x) => (active ? x.task_local_id === active.local_id : true))
    .sort((a, b) => new Date(a.captured_at || 0).getTime() - new Date(b.captured_at || 0).getTime());
  patrolEvents.value = events
    .filter((x) => (active ? x.task_local_id === active.local_id : true))
    .sort((a, b) => new Date(b.captured_at || 0).getTime() - new Date(a.captured_at || 0).getTime());
  recording.value = Boolean(active);
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
    await putRecord(stores.patrolPoints, {
      local_id: uid("patrol_point"),
      task_local_id: currentTask.value.local_id,
      lat: pos.lat,
      lng: pos.lng,
      accuracy: pos.accuracy,
      captured_at: new Date().toISOString(),
      source: manual ? "manual" : "auto",
    });
    await refreshLocal();
    renderMap();
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
  await refreshLocal();
  renderMap();
  showSuccessToast("已结束巡护");
}

async function openEventPopup() {
  if (!recording.value || !currentTask.value) {
    showFailToast("请先开始巡护");
    return;
  }
  try {
    const pos = await getCurrentPosition();
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
    await refreshLocal();
    renderMap();
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
  await refreshLocal();
  renderMap();
  showSuccessToast("已删除");
}

function exportEventsJson() {
  if (!patrolEvents.value.length) {
    showFailToast("暂无可导出事件");
    return;
  }
  const blob = new Blob([JSON.stringify(patrolEvents.value, null, 2)], { type: "application/json;charset=utf-8" });
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

function pointToLngLat(row) {
  return [Number(row.lng), Number(row.lat)];
}

function locateEventOnMap(row) {
  focusedEventLocalId.value = row.local_id;
  if (!map || !row) return;
  map.setZoomAndCenter(16, pointToLngLat(row));
}

async function ensureMap() {
  if (!online.value || map || !mapWrapRef.value) return;
  try {
    const AMap = await loadAmapSdk();
    map = new AMap.Map(mapWrapRef.value, {
      zoom: 14,
      center: [116.397428, 39.90923],
    });
  } catch (error) {
    showFailToast(error?.message || "地图加载失败");
  }
}

function clearMapObjects() {
  if (!map) return;
  if (polyline) {
    map.remove(polyline);
    polyline = null;
  }
  if (eventMarkers.length) {
    map.remove(eventMarkers);
    eventMarkers = [];
  }
}

function renderMap() {
  if (!map || !online.value) return;
  clearMapObjects();
  if (patrolPoints.value.length >= 2) {
    const AMap = window.AMap;
    const path = patrolPoints.value.map(pointToLngLat);
    polyline = new AMap.Polyline({
      path,
      strokeColor: "#1989fa",
      strokeWeight: 6,
      lineJoin: "round",
      lineCap: "round",
    });
    map.add(polyline);
    map.setFitView([polyline], false, [60, 40, 40, 40]);
  }
  if (patrolEvents.value.length) {
    const AMap = window.AMap;
    eventMarkers = patrolEvents.value.map((ev) => {
      const meta = eventTypeMeta(ev.type);
      const marker = new AMap.Marker({
        position: pointToLngLat(ev),
        title: `${meta.text} ${formatTime(ev.captured_at)}`,
        label: { content: `<div class="patrol-map-label">${meta.emoji}</div>`, direction: "top" },
      });
      marker.on("click", () => {
        focusedEventLocalId.value = ev.local_id;
      });
      return marker;
    });
    map.add(eventMarkers);
  }
}

onMounted(async () => {
  await refreshLocal();
  if (recording.value) startTimer();
  await ensureMap();
  await nextTick();
  renderMap();
  window.addEventListener("online", async () => {
    networkStore.setNavigatorOnline(true);
    await ensureMap();
    renderMap();
  });
  window.addEventListener("offline", () => {
    networkStore.setNavigatorOnline(false);
  });
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
        <span class="sub">{{ hasMap ? "已加载高德地图" : online ? "地图加载中/未配置 Key" : "离线模式暂不加载地图" }}</span>
      </div>
      <div v-if="online" ref="mapWrapRef" class="map-wrap" />
      <p v-else class="tip">离线下仍持续保存轨迹和事件；联网后自动显示轨迹线与事件点。</p>
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
      <div v-if="!sortedEvents.length" class="empty">暂无事件记录</div>
      <div v-else class="event-list">
        <article
          v-for="ev in sortedEvents"
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
      </div>
    </section>

    <van-popup v-model:show="eventPopupVisible" position="bottom" round :style="{ height: '72%' }">
      <div class="event-form">
        <h3>记录巡护事件</h3>
        <van-field
          v-model="eventDraft.type"
          label="事件类型"
          is-link
          readonly
          :value="eventTypeMeta(eventDraft.type).text"
          @click="
            showFailToast('请在下方单选类型：病虫害 / 火情 / 盗伐 / 其他异常')
          "
        />
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
.sub {
  font-size: 12px;
  color: #969799;
}
.map-wrap {
  margin-top: 8px;
  height: 260px;
  border-radius: 10px;
  overflow: hidden;
}
.filters {
  margin: 8px 0;
}
.empty {
  color: #969799;
  font-size: 13px;
  padding: 8px 0;
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
