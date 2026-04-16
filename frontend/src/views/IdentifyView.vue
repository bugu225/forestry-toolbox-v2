<script setup>
import { onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { showFailToast, showSuccessToast } from "vant";
import apiClient from "../api/client";
import { postWithSyncRetry } from "../utils/syncRetry";
import { clearStore, getAllRecords, putRecord, stores } from "../services/offlineDb";
import { getSyncMeta, setSyncMeta } from "../services/syncMeta";

const pendingFile = ref(null);
const jobs = ref([]);
const syncing = ref(false);
const online = ref(navigator.onLine);
const cameraInput = ref(null);
const syncedResults = ref([]);
const serverHistory = ref([]);
const syncMeta = ref(getSyncMeta("identify"));
const autoSyncHintShown = ref(false);
const route = useRoute();
const identifyScene = ref("general");
const flowBanner = ref("");
const cameraHint = ref("");

function riskText(level) {
  if (level === "high") return "高风险";
  if (level === "medium") return "中风险";
  return "低风险";
}

function sceneText(scene) {
  if (scene === "disease") return "病害识别";
  if (scene === "pest") return "虫害识别";
  return "通用识别";
}

function eventTypeByScene(scene) {
  if (scene === "pest") return "pest";
  return "disease";
}

function withSyncSuggestion(message) {
  const base = message || "同步失败";
  return `${base}。请检查网络、百度Key配置，确认后重试。`;
}

function uid() {
  return `identify_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function buildPatrolId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

async function refreshJobs() {
  jobs.value = await getAllRecords(stores.identifyJobs);
}

async function ensurePatrolTask() {
  const tasks = await getAllRecords(stores.patrolTasks);
  const inProgress = tasks.find((item) => item.status === "in_progress");
  if (inProgress) return inProgress.local_id;
  const localId = buildPatrolId("task");
  await putRecord(stores.patrolTasks, {
    local_id: localId,
    title: `识图转上报任务 ${new Date().toLocaleString()}`,
    status: "in_progress",
    started_at: new Date().toISOString(),
    ended_at: null,
    synced: false,
    user_id: null,
  });
  return localId;
}

function getCurrentGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("当前浏览器不支持定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => reject(error),
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5000,
      }
    );
  });
}

async function saveOfflineJob() {
  if (!pendingFile.value) {
    showFailToast("请先选择图片");
    return;
  }
  try {
    const file = pendingFile.value;
    const imageBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    await putRecord(stores.identifyJobs, {
      local_id: uid(),
      image_name: file.name || "离线图片.jpg",
      image_base64: imageBase64,
      scene_type: identifyScene.value,
      result_json: [],
      created_at: new Date().toISOString(),
    });
    pendingFile.value = null;
    if (cameraInput.value) cameraInput.value.value = "";
    await refreshJobs();
    const diseaseTip =
      identifyScene.value === "disease"
        ? "已保存病害识图任务。可「立即同步」后在结果中「转巡护上报」，或到巡护页补充描述。"
        : "已离线保存识图任务";
    showSuccessToast(diseaseTip);
  } catch (_) {
    showFailToast("图片读取失败，请重试");
  }
}

function onFileSelected(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showFailToast("请选择图片文件");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showFailToast("图片不能超过 10MB");
    return;
  }
  pendingFile.value = file;
  showSuccessToast(`已选择：${file.name}`);
}

function openCameraPicker() {
  cameraHint.value = "若未直接打开相机，说明浏览器限制了拍照调用，请改用下方“相册选择”或更换支持相机调用的浏览器。";
  cameraInput.value?.click();
}

async function syncNow() {
  if (!online.value) {
    showFailToast("当前离线，无法同步");
    return;
  }
  syncing.value = true;
  try {
    const payload = { jobs: await getAllRecords(stores.identifyJobs) };
    const { data } = await postWithSyncRetry(apiClient, "/identify/sync", payload);
    syncedResults.value = data.synced_items || [];
    await clearStore(stores.identifyJobs);
    await refreshJobs();
    await loadServerHistory();
    syncMeta.value = setSyncMeta("identify", {
      lastSuccessAt: new Date().toISOString(),
      lastError: "",
    });
    const count = Number(data?.inserted || 0);
    showSuccessToast(data?.deduplicated ? `识图同步已去重（${count} 条）` : `识图任务同步成功（${count} 条）`);
  } catch (error) {
    const message = withSyncSuggestion(error?.response?.data?.error?.message || "同步失败");
    syncMeta.value = setSyncMeta("identify", {
      lastError: message,
    });
    showFailToast(message);
  } finally {
    syncing.value = false;
  }
}

async function loadServerHistory() {
  if (!online.value) return;
  try {
    const { data } = await apiClient.get("/identify/history");
    serverHistory.value = data.items || [];
  } catch (_) {
    // Keep silent for history loading failure.
  }
}

async function autoSyncIfPending() {
  if (!online.value || syncing.value) return;
  const pendingJobs = await getAllRecords(stores.identifyJobs);
  if (!pendingJobs.length) return;
  if (!autoSyncHintShown.value) {
    showSuccessToast("网络已恢复，已自动触发识图同步");
    autoSyncHintShown.value = true;
  }
  await syncNow();
}

async function syncPatrolNow() {
  const tasks = await getAllRecords(stores.patrolTasks);
  const points = await getAllRecords(stores.patrolPoints);
  const events = await getAllRecords(stores.patrolEvents);
  if (!tasks.length && !points.length && !events.length) return false;
  await postWithSyncRetry(apiClient, "/patrol/sync", { tasks, points, events });
  await clearStore(stores.patrolTasks);
  await clearStore(stores.patrolPoints);
  await clearStore(stores.patrolEvents);
  return true;
}

async function reportToPatrol(item, syncImmediately = false) {
  try {
    const taskLocalId = await ensurePatrolTask();
    const topK = item?.top_k || [];
    const sceneType = item?.scene_type || "general";
    const topPlant = topK[0]?.name || "未知目标";
    const topConfidence = ((Number(topK[0]?.confidence || 0) * 100).toFixed(1) || "0.0");
    const top3Text = topK
      .slice(0, 3)
      .map((plant) => `${plant.name || "未知"}(${(Number(plant.confidence || 0) * 100).toFixed(1)}%)`)
      .join("，");
    let latitude = null;
    let longitude = null;
    try {
      const pos = await getCurrentGps();
      latitude = Number(pos.coords.latitude);
      longitude = Number(pos.coords.longitude);
    } catch (_) {
      // GPS may be unavailable; keep report flow available.
    }
    await putRecord(stores.patrolEvents, {
      local_id: buildPatrolId("event"),
      task_local_id: taskLocalId,
      description:
        `识图联动上报（${sceneText(sceneType)}）：${item?.image_name || "图片"}；` +
        `主识别：${topPlant}（${topConfidence}%）；` +
        `Top3：${top3Text || "无"}`,
      event_type: eventTypeByScene(sceneType),
      latitude,
      longitude,
      synced: false,
    });
    if (syncImmediately && online.value) {
      await syncPatrolNow();
      showSuccessToast("已转巡护并完成同步");
      return;
    }
    showSuccessToast(latitude && longitude ? "已转上报并附带GPS坐标" : "已转上报（未获取到GPS）");
  } catch (_) {
    showFailToast("转上报失败，请重试");
  }
}

function applyRouteQuery() {
  const s = (route.query.scene || "").toString();
  if (["general", "disease", "pest"].includes(s)) {
    identifyScene.value = s;
  }
  const hint = (route.query.hint || "").toString();
  if (hint === "fire") {
    flowBanner.value =
      "火情辅助：若已在巡护完成火情上报，可用通用识图记录现场；同步识别结果后可「转巡护上报」补充材料。";
    if (!s) {
      identifyScene.value = "general";
    }
  } else {
    flowBanner.value = "";
  }
}

watch(
  () => route.query,
  () => {
    applyRouteQuery();
  },
  { deep: true }
);

onMounted(async () => {
  applyRouteQuery();
  window.addEventListener("online", async () => {
    online.value = true;
    await autoSyncIfPending();
  });
  window.addEventListener("offline", () => (online.value = false));
  await refreshJobs();
  await loadServerHistory();
});
</script>

<template>
  <div class="page">
    <van-nav-bar title="识图（离线优先）" left-arrow @click-left="$router.back()" />
    <div class="card">
      <p>网络：{{ online ? "在线" : "离线" }}</p>
      <van-notice-bar v-if="flowBanner" wrapable left-icon="info-o" color="#1989fa" background="#ecf9ff">
        {{ flowBanner }}
      </van-notice-bar>
      <van-field label="识别类型">
        <template #input>
          <select v-model="identifyScene" class="scene-select">
            <option value="general">通用识别</option>
            <option value="disease">病害识别</option>
            <option value="pest">虫害识别</option>
          </select>
        </template>
      </van-field>
      <van-button type="primary" block @click="openCameraPicker">拍照上传</van-button>
      <input
        ref="cameraInput"
        type="file"
        accept="image/*"
        capture="environment"
        class="hidden-input"
        @change="onFileSelected"
      />
      <p v-if="cameraHint" class="warn-tip">{{ cameraHint }}</p>
      <p v-if="pendingFile">待保存：{{ pendingFile.name }}</p>
      <van-button type="primary" block @click="saveOfflineJob">离线保存识图任务</van-button>
      <van-button type="success" block :loading="syncing" @click="syncNow">立即同步</van-button>
      <p>最近同步成功：{{ syncMeta.lastSuccessAt || "暂无" }}</p>
      <p v-if="syncMeta.lastError" class="error-tip">最近同步失败：{{ syncMeta.lastError }}</p>
    </div>

    <div class="card" v-if="syncedResults.length">
      <h3>最近同步结果</h3>
      <div v-for="(item, idx) in syncedResults" :key="`${item.image_name}_${idx}`" class="result-block">
        <p class="result-title">
          {{ item.image_name }}（{{ sceneText(item.scene_type) }} / {{ item.provider }}{{ item.used_mock ? " / 降级" : "" }}）
        </p>
        <p class="risk-line">风险等级：{{ riskText(item.risk_level) }}</p>
        <van-cell
          v-for="(plant, pIdx) in item.top_k"
          :key="`${plant.name}_${pIdx}`"
          :title="plant.name"
          :value="`${(Number(plant.confidence || 0) * 100).toFixed(1)}%`"
        />
        <div class="report-actions">
          <van-button size="small" type="warning" plain @click="reportToPatrol(item)">转巡护上报</van-button>
          <van-button
            size="small"
            type="primary"
            plain
            :disabled="!online"
            @click="reportToPatrol(item, true)"
          >
            转巡护并同步
          </van-button>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>本地待同步任务</h3>
      <p v-if="!jobs.length">暂无任务</p>
      <van-cell
        v-for="item in jobs"
        :key="item.local_id"
        :title="item.image_name"
        :label="`类型：${sceneText(item.scene_type)}；创建时间：${item.created_at}`"
      />
    </div>

    <div class="card">
      <h3>云端识图历史</h3>
      <p v-if="!serverHistory.length">暂无云端历史</p>
      <div v-for="item in serverHistory" :key="item.id" class="result-block">
        <p class="result-title">
          {{ item.image_name }}（{{ sceneText(item.scene_type) }} / {{ riskText(item.risk_level) }} /
          {{ (Number(item.confidence || 0) * 100).toFixed(1) }}%）
        </p>
        <van-cell
          v-for="(plant, pIdx) in item.result_json || []"
          :key="`${item.id}_${plant.name}_${pIdx}`"
          :title="plant.name"
          :value="`${(Number(plant.confidence || 0) * 100).toFixed(1)}%`"
        />
      </div>
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

.result-block {
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  padding: 8px;
}

.result-title {
  margin: 0 0 6px 0;
  font-weight: 600;
}

.risk-line {
  margin: 0;
  color: #ff976a;
  font-size: 13px;
}

.report-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.error-tip {
  color: #ee0a24;
}

.warn-tip {
  color: #ff976a;
  margin: 0;
  font-size: 12px;
}
</style>
