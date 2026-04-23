<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from "vant";
import { storeToRefs } from "pinia";
import { useNetworkStore } from "../stores/network";
import { deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";

const networkStore = useNetworkStore();
const { effectiveOnline } = storeToRefs(networkStore);

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

const EVENT_TYPES = [
  { value: "pest", label: "病虫害" },
  { value: "fire", label: "火情" },
  { value: "illegal", label: "盗伐" },
  { value: "other", label: "其他异常" },
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

const activeTask = ref(null);
/** 刚结束的一次巡护（用于导出与地图，直至开始新巡护） */
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
const photoInputRef = ref(null);

const mapIframeSrc = computed(() => {
  const pts = points.value;
  if (pts.length < 1) return "";
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const pad = 0.002;
  const bbox = `${minLng - pad},${minLat - pad},${maxLng + pad},${maxLat + pad}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik`;
});

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
        message: "将清空当前页面上的展示数据（已写入本机的历史记录仍保留在数据库中）。",
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
  points.value = [];
  events.value = [];
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
  showSuccessToast("巡护已结束，数据已保存在本机，可导出 JSON");
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
  gpsBusy.value = false;
  const photo = eventPhotoDataUrl.value || null;
  const rec = {
    local_id: uid("pevt"),
    task_local_id: activeTask.value.local_id,
    type: eventType.value,
    lat,
    lng,
    note: (eventNote.value || "").trim(),
    photo_dataurl: photo,
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

onMounted(() => {
  void restoreActivePatrol();
});

onUnmounted(() => {
  clearSamplingTimer();
});
</script>

<template>
  <div class="page">
    <van-nav-bar title="巡护助手" left-arrow @click-left="$router.back()" />

    <van-tabs v-model:active="activeTab" class="tabs">
      <van-tab title="巡护">
        <div class="panel">
          <p class="hint">
            轨迹与事件均保存在本机 IndexedDB，可长时间离线；联网时可在「地图」页查看嵌入示意图。
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
          </div>

          <van-cell-group inset title="最近轨迹点" class="block">
            <van-empty v-if="!points.length" image="search" description="尚无采样点（开始后立即采一点，之后每 5 分钟）" />
            <van-cell
              v-for="p in points.slice(-6).reverse()"
              :key="p.local_id"
              :title="`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`"
              :label="`时间 ${formatTime(p.recorded_at)} · 精度约 ${Math.round(p.accuracy)} m`"
            />
          </van-cell-group>
        </div>
      </van-tab>

      <van-tab title="事件">
        <div class="panel">
          <van-empty v-if="!events.length" description="暂无事件，先在「巡护」中开始巡护并点击记录事件" />
          <van-swipe-cell v-for="ev in events" :key="ev.local_id">
            <van-cell
              :title="`${eventTypeLabel(ev.type)}`"
              :label="`${formatTime(ev.recorded_at)} · ${ev.lat.toFixed(5)}, ${ev.lng.toFixed(5)}${ev.note ? ' · ' + ev.note : ''}`"
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
            使用 OpenStreetMap 嵌入图显示当前巡护轨迹范围（需至少 1 个轨迹点）。
            <span v-if="!effectiveOnline" class="warn">当前为离线，地图可能无法加载瓦片。</span>
          </p>
          <div v-if="mapIframeSrc" class="map-wrap">
            <iframe :src="mapIframeSrc" title="轨迹地图" class="map-iframe" loading="lazy" />
          </div>
          <van-empty v-else description="开始巡护并记录轨迹点后显示地图" />
        </div>
      </van-tab>
    </van-tabs>

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
      <p class="rec-tip">录音功能规划中，当前版本请用文字备注代替。</p>
      <div class="sheet-actions">
        <van-button block type="default" @click="showEventSheet = false">取消</van-button>
        <van-button block type="primary" :loading="gpsBusy" @click="saveEvent">保存</van-button>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
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

.map-wrap {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #ebedf0;
  height: 280px;
}

.map-iframe {
  width: 100%;
  height: 100%;
  border: 0;
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

.ul-label {
  display: block;
  font-size: 14px;
  color: #323233;
  margin-bottom: 8px;
}

.rec-tip {
  font-size: 12px;
  color: #969799;
  margin: 8px 0 16px;
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
