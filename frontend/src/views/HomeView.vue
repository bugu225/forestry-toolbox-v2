<script setup>
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { showFailToast, showSuccessToast } from "vant";

import apiClient, { QA_ASK_TIMEOUT_MS } from "../api/client";
import { postWithSyncRetry } from "../utils/syncRetry";
import { useAuthStore } from "../stores/auth";
import { clearStore, deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";
import { getSyncMeta, setSyncMeta } from "../services/syncMeta";

const authStore = useAuthStore();
const router = useRouter();
const online = ref(navigator.onLine);
/** 默认收起「其他」区块，主流程只保留三入口 */
const moreActive = ref([]);

const username = computed(() => authStore.user?.username || "用户");
const pending = ref({ identify: 0, qa: 0, patrol: 0 });
const syncOverview = ref({
  identify: getSyncMeta("identify"),
  qa: getSyncMeta("qa"),
  patrol: getSyncMeta("patrol"),
});
const retryingAll = ref(false);
const retryReport = ref([]);
const pwaInstallReady = ref(false);
const pwaInstalled = ref(false);
const pwaStatusText = ref("未检测");
const pwaUpdateReady = ref(false);
const pwaUpdateRegistration = ref(null);
let deferredInstallPrompt = null;
const topPendingModule = computed(() => {
  const entries = [
    { key: "identify", count: pending.value.identify },
    { key: "qa", count: pending.value.qa },
    { key: "patrol", count: pending.value.patrol },
  ].sort((a, b) => b.count - a.count);
  return entries[0];
});
const moduleHealth = computed(() => {
  const specs = [
    { key: "identify", label: "识图" },
    { key: "qa", label: "问答" },
    { key: "patrol", label: "巡护" },
  ];
  return specs.map((item) => {
    const pendingCount = pending.value[item.key] || 0;
    const lastError = syncOverview.value[item.key]?.lastError || "";
    if (lastError) {
      return { ...item, level: "error", text: "失败", hint: lastError };
    }
    if (pendingCount > 0) {
      return { ...item, level: "warning", text: "待同步", hint: `待同步 ${pendingCount} 条` };
    }
    return { ...item, level: "ok", text: "正常", hint: "无待同步数据" };
  });
});

async function refreshPending() {
  pending.value.identify = (await getAllRecords(stores.identifyJobs)).length;
  pending.value.qa =
    (await getAllRecords(stores.qaSessions)).length +
    (await getAllRecords(stores.qaMessages)).length +
    (await getAllRecords(stores.qaPendingQuestions)).length;
  pending.value.patrol =
    (await getAllRecords(stores.patrolTasks)).length +
    (await getAllRecords(stores.patrolPoints)).length +
    (await getAllRecords(stores.patrolEvents)).length;
}

function refreshSyncOverview() {
  syncOverview.value = {
    identify: getSyncMeta("identify"),
    qa: getSyncMeta("qa"),
    patrol: getSyncMeta("patrol"),
  };
}

function goIdentify() {
  router.push({ name: "identify" });
}

function goQa() {
  router.push({ name: "qa" });
}

function goPatrol() {
  router.push({ name: "patrol" });
}

function goSyncAudits() {
  router.push({ name: "syncAudits" });
}

function goTopPendingModule() {
  const target = topPendingModule.value;
  if (!target || target.count <= 0) return;
  if (target.key === "identify") goIdentify();
  if (target.key === "qa") goQa();
  if (target.key === "patrol") goPatrol();
}

function toStatusText(status) {
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  return "跳过";
}

function buildFailureSuggestion(module) {
  if (module === "识图") return "建议：检查网络与百度 Key 配置后重试。";
  if (module === "问答") return "建议：检查网络、DeepSeek Key 与账户余额后重试。";
  if (module === "巡护") return "建议：检查网络、登录状态与定位权限后重试。";
  return "建议：检查网络与配置后重试。";
}

function buildFailedDetail(module, message) {
  const base = message || "同步失败";
  return `${base} ${buildFailureSuggestion(module)}`;
}

function detectPwaInstalled() {
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches;
  const iosStandalone = window.navigator.standalone === true;
  pwaInstalled.value = Boolean(standalone || iosStandalone);
  pwaStatusText.value = pwaInstalled.value ? "已添加到主屏幕" : "未添加到主屏幕";
}

async function triggerPwaInstall() {
  if (!deferredInstallPrompt) {
    showFailToast("当前浏览器未提供安装弹窗，请使用“添加到主屏幕”手动安装");
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  pwaInstallReady.value = false;
  if (choice?.outcome === "accepted") {
    showSuccessToast("已触发安装，请按提示完成");
  }
}

function onPwaUpdateReady(event) {
  pwaUpdateReady.value = true;
  pwaUpdateRegistration.value = event?.detail?.registration || null;
}

function applyPwaUpdateNow() {
  const reg = pwaUpdateRegistration.value;
  const waiting = reg?.waiting;
  if (!waiting) {
    showFailToast("暂未检测到可更新版本");
    return;
  }
  waiting.postMessage({ type: "SKIP_WAITING" });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.location.reload();
  }, { once: true });
}

async function retryIdentify() {
  const jobs = await getAllRecords(stores.identifyJobs);
  if (!jobs.length) return { module: "识图", status: "skipped", detail: "无待同步数据" };
  await postWithSyncRetry(apiClient, "/identify/sync", { jobs });
  await clearStore(stores.identifyJobs);
  setSyncMeta("identify", { lastSuccessAt: new Date().toISOString(), lastError: "" });
  return { module: "识图", status: "success", detail: `已同步 ${jobs.length} 条` };
}

async function retryQa() {
  const sessions = await getAllRecords(stores.qaSessions);
  const messages = await getAllRecords(stores.qaMessages);
  const pendingQuestions = await getAllRecords(stores.qaPendingQuestions);
  if (!sessions.length && !messages.length && !pendingQuestions.length) {
    return { module: "问答", status: "skipped", detail: "无待同步数据" };
  }
  if (sessions.length || messages.length) {
    await postWithSyncRetry(apiClient, "/qa/sync", { sessions, messages });
    await clearStore(stores.qaSessions);
    await clearStore(stores.qaMessages);
  }
  let answered = 0;
  for (const item of pendingQuestions) {
    const question = (item?.question || "").trim();
    if (!question) {
      await deleteRecord(stores.qaPendingQuestions, item.local_id);
      continue;
    }
    const { data } = await apiClient.post("/qa/ask", { question }, { timeout: QA_ASK_TIMEOUT_MS });
    const sessionLocalId = `qa_session_online_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    await putRecord(stores.qaSessions, {
      local_id: sessionLocalId,
      title: question.slice(0, 24),
      created_at: new Date().toISOString(),
    });
    await putRecord(stores.qaMessages, {
      local_id: `qa_msg_user_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      session_local_id: sessionLocalId,
      role: "user",
      content: question,
      citations: [],
    });
    await putRecord(stores.qaMessages, {
      local_id: `qa_msg_assistant_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      session_local_id: sessionLocalId,
      role: "assistant",
      content: data.answer || "",
      citations: data.citations || [],
    });
    await deleteRecord(stores.qaPendingQuestions, item.local_id);
    answered += 1;
  }
  setSyncMeta("qa", { lastSuccessAt: new Date().toISOString(), lastError: "" });
  return {
    module: "问答",
    status: "success",
    detail: `已同步 ${sessions.length + messages.length} 条，补答 ${answered} 条`,
  };
}

async function retryPatrol() {
  const tasks = await getAllRecords(stores.patrolTasks);
  const points = await getAllRecords(stores.patrolPoints);
  const events = await getAllRecords(stores.patrolEvents);
  const total = tasks.length + points.length + events.length;
  if (!total) return { module: "巡护", status: "skipped", detail: "无待同步数据" };
  await postWithSyncRetry(apiClient, "/patrol/sync", { tasks, points, events });
  await clearStore(stores.patrolTasks);
  await clearStore(stores.patrolPoints);
  await clearStore(stores.patrolEvents);
  setSyncMeta("patrol", { lastSuccessAt: new Date().toISOString(), lastError: "" });
  return { module: "巡护", status: "success", detail: `已同步 ${total} 条` };
}

async function retryAllSync() {
  if (!navigator.onLine) {
    showFailToast("当前离线，无法执行全部重试");
    return;
  }
  retryingAll.value = true;
  retryReport.value = [];
  const results = [];
  const tasks = [
    { key: "identify", label: "识图", run: retryIdentify },
    { key: "qa", label: "问答", run: retryQa },
    { key: "patrol", label: "巡护", run: retryPatrol },
  ];
  for (const item of tasks) {
    try {
      const result = await item.run();
      results.push(result);
    } catch (error) {
      const message = error?.response?.data?.error?.message || "同步失败";
      setSyncMeta(item.key, { lastError: message });
      results.push({
        module: item.label,
        status: "failed",
        detail: buildFailedDetail(item.label, message),
      });
    }
  }
  retryReport.value = results;
  await refreshPending();
  refreshSyncOverview();
  if (results.some((item) => item.status === "failed")) {
    showFailToast("全部重试已完成：存在失败项");
  } else {
    showSuccessToast("全部重试已完成");
  }
  retryingAll.value = false;
}

function logout() {
  authStore.clearAuth();
  router.push({ name: "login" });
}

onMounted(refreshPending);
onMounted(refreshSyncOverview);
onMounted(() => {
  detectPwaInstalled();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    pwaInstallReady.value = true;
  });
  window.addEventListener("appinstalled", () => {
    pwaInstalled.value = true;
    pwaInstallReady.value = false;
    pwaStatusText.value = "已添加到主屏幕";
    showSuccessToast("PWA 安装完成");
  });
  window.addEventListener("pwa-update-ready", onPwaUpdateReady);
  window.addEventListener("online", () => {
    online.value = true;
  });
  window.addEventListener("offline", () => {
    online.value = false;
  });
});
</script>

<template>
  <div class="page">
    <van-nav-bar title="功能首页" />

    <div class="home-main">
      <p class="welcome">你好，{{ username }}</p>

      <div class="entry-cards" role="navigation" aria-label="功能入口">
        <button type="button" class="entry-card entry-card--qa" @click="goQa">
          <span class="entry-card-title">林业知识问答</span>
          <span class="entry-card-desc">AI 问答与知识检索</span>
        </button>
        <button type="button" class="entry-card entry-card--id" @click="goIdentify">
          <span class="entry-card-title">林业识图</span>
          <span class="entry-card-desc">拍照识植物 / 离线保存</span>
        </button>
        <button type="button" class="entry-card entry-card--patrol" @click="goPatrol">
          <span class="entry-card-title">巡护助手</span>
          <span class="entry-card-desc">轨迹与异常上报</span>
        </button>
      </div>

      <van-collapse v-model="moreActive" :border="false" class="more-collapse">
        <van-collapse-item title="其他、等等" name="more" class="more-item">
          <div class="more-inner">
            <p class="more-line">
              待同步：识图 {{ pending.identify }}，问答 {{ pending.qa }}，巡护 {{ pending.patrol }}
            </p>
            <div class="pwa-tip">
              <p class="pwa-title">离线优先：建议添加到主屏幕</p>
              <p>PWA：{{ pwaStatusText }}</p>
              <van-button v-if="pwaInstallReady" type="primary" size="small" block @click="triggerPwaInstall">
                一键安装到主屏幕
              </van-button>
              <van-button v-else-if="!pwaInstalled" type="default" plain size="small" block>
                若无安装按钮，请在浏览器菜单中选择「添加到主屏幕」
              </van-button>
              <van-button v-if="pwaUpdateReady" type="warning" size="small" block @click="applyPwaUpdateNow">
                检测到新版本，立即更新
              </van-button>
            </div>
            <p class="more-line muted">
              最近同步 · 识图 {{ syncOverview.identify.lastSuccessAt || "暂无" }}；问答
              {{ syncOverview.qa.lastSuccessAt || "暂无" }}；巡护
              {{ syncOverview.patrol.lastSuccessAt || "暂无" }}
            </p>
            <div class="health-list">
              <p class="health-title">模块状态</p>
              <div v-for="item in moduleHealth" :key="item.key" class="health-item">
                <span class="health-left">
                  <span class="health-dot" :class="`is-${item.level}`" />
                  <span>{{ item.label }}：{{ item.text }}</span>
                </span>
                <span class="health-hint">{{ item.hint }}</span>
              </div>
            </div>
            <div class="more-actions">
              <van-button type="default" plain size="small" block @click="refreshPending(); refreshSyncOverview()">
                刷新同步状态
              </van-button>
              <van-button type="primary" size="small" block :loading="retryingAll" @click="retryAllSync">
                全部重试同步
              </van-button>
              <van-button
                type="default"
                size="small"
                block
                :disabled="!topPendingModule || topPendingModule.count <= 0"
                @click="goTopPendingModule"
              >
                前往待同步最多模块
              </van-button>
              <van-button type="default" size="small" block @click="goSyncAudits">查看同步审计</van-button>
            </div>
            <div v-if="retryReport.length" class="retry-report">
              <h4>全部重试结果</h4>
              <van-cell
                v-for="(item, idx) in retryReport"
                :key="`${item.module}_${idx}`"
                :title="`${item.module}：${toStatusText(item.status)}`"
                :label="item.detail"
              />
            </div>
          </div>
        </van-collapse-item>
      </van-collapse>

      <van-button class="logout-btn" type="danger" block round @click="logout">退出登录</van-button>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #f0f2f5;
}

.home-main {
  padding: 16px 16px 28px;
  max-width: 520px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.welcome {
  margin: 0;
  font-size: 15px;
  color: #646566;
  text-align: center;
}

.entry-cards {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.entry-card {
  width: 100%;
  border: none;
  border-radius: 14px;
  padding: 20px 18px;
  text-align: left;
  cursor: pointer;
  color: #fff;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}

.entry-card:active {
  transform: scale(0.98);
}

.entry-card-title {
  display: block;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.entry-card-desc {
  display: block;
  margin-top: 6px;
  font-size: 13px;
  opacity: 0.92;
  font-weight: 400;
}

.entry-card--qa {
  background: linear-gradient(135deg, #3a8afe 0%, #1989fa 100%);
}

.entry-card--id {
  background: linear-gradient(135deg, #34c759 0%, #07c160 100%);
}

.entry-card--patrol {
  background: linear-gradient(135deg, #ffb14a 0%, #ff976a 100%);
}

.more-collapse {
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
}

.more-collapse :deep(.van-collapse-item__title) {
  font-weight: 600;
  color: #323233;
}

.more-inner {
  display: grid;
  gap: 12px;
  padding-bottom: 4px;
}

.more-line {
  margin: 0;
  font-size: 13px;
  color: #323233;
  line-height: 1.5;
}

.more-line.muted {
  color: #969799;
  font-size: 12px;
}

.more-actions {
  display: grid;
  gap: 8px;
}

.logout-btn {
  margin-top: 4px;
}

.pwa-tip {
  border: 1px solid #d5f5e3;
  background: #f4fff8;
  border-radius: 8px;
  padding: 10px;
  display: grid;
  gap: 8px;
}

.pwa-title {
  margin: 0;
  font-weight: 600;
  color: #07c160;
}

.retry-report {
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  padding: 8px;
}

.retry-report h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
}

.health-list {
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  padding: 8px;
  display: grid;
  gap: 6px;
}

.health-title {
  margin: 0 0 4px 0;
  font-weight: 600;
  font-size: 13px;
}

.health-item {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.health-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.health-dot.is-ok {
  background: #07c160;
}

.health-dot.is-warning {
  background: #ff976a;
}

.health-dot.is-error {
  background: #ee0a24;
}

.health-hint {
  color: #969799;
  text-align: right;
}
</style>
