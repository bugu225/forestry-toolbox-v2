<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { showFailToast, showSuccessToast } from "vant";
import apiClient, { QA_ASK_TIMEOUT_MS } from "../api/client";
import { postWithSyncRetry } from "../utils/syncRetry";
import { clearStore, deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";
import { getSyncMeta, setSyncMeta } from "../services/syncMeta";

const online = ref(navigator.onLine);
const route = useRoute();
const router = useRouter();
const syncing = ref(false);
const onlineAsking = ref(false);
const form = reactive({ question: "" });
const sessions = ref([]);
const messages = ref([]);
const previewAnswer = ref("");
const previewCitations = ref([]);
const previewProvider = ref("");
const cloudSessions = ref([]);
const cloudMessages = ref([]);
const selectedCloudSessionId = ref(null);
const syncMeta = ref(getSyncMeta("qa"));
const autoSyncHintShown = ref(false);
const policyKeyword = ref("");
const policyResults = ref([]);
const localKnowledgeDocs = ref([]);
const localKnowledgeResults = ref([]);
const pendingQuestions = ref([]);
const pendingAnswerReport = ref([]);
const listening = ref(false);
const speechSupported = ref(false);
const speaking = ref(false);
let speechRecognizer = null;

/** 当前聊天会话（本地 local_id）；新建对话时为 null */
const activeChatSessionLocalId = ref(null);
const chatScrollRef = ref(null);

/** knowledge=知识库速查；qa=AI 问答；离线时固定为知识库 */
const activeModule = ref("knowledge");

watch(online, (isOnline) => {
  if (!isOnline) {
    activeModule.value = "knowledge";
  }
});

function setActiveModule(module) {
  if (module === "qa" && !online.value) return;
  activeModule.value = module;
}

const chatMessages = computed(() => {
  const sid = activeChatSessionLocalId.value;
  if (!sid) return [];
  return messages.value
    .filter((m) => m.session_local_id === sid)
    .sort(compareChatMessages);
});

const sortedSessions = computed(() =>
  [...sessions.value].sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return tb - ta;
  })
);

const groupedSessions = computed(() => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = startOfToday - 7 * 86400000;
  const today = [];
  const week = [];
  const older = [];
  for (const s of sortedSessions.value) {
    const t = new Date(s.created_at || 0).getTime();
    if (t >= startOfToday) today.push(s);
    else if (t >= weekAgo) week.push(s);
    else older.push(s);
  }
  return { today, week, older };
});

const historyDrawerOpen = ref(false);

function startNewChat() {
  activeChatSessionLocalId.value = null;
  selectedCloudSessionId.value = null;
  form.question = "";
}

function onNewChatClick() {
  startNewChat();
}

async function openHistoryDrawer() {
  await refreshLocal();
  historyDrawerOpen.value = true;
}

async function selectHistorySession(localId) {
  await refreshLocal();
  activeChatSessionLocalId.value = localId;
  const s = sessions.value.find((x) => x.local_id === localId);
  selectedCloudSessionId.value = s?.cloud_session_id || null;
  historyDrawerOpen.value = false;
  nextTick(() => scrollChatToBottom());
}

function applyRouteQuery() {
  const q = route.query;
  if (q.new === "1") {
    if (online.value) {
      startNewChat();
      activeModule.value = "qa";
    }
    router.replace({ path: "/qa" });
    return;
  }
  if (q.session && online.value) {
    const sid = String(q.session);
    activeChatSessionLocalId.value = sid;
    activeModule.value = "qa";
    const s = sessions.value.find((x) => x.local_id === sid);
    selectedCloudSessionId.value = s?.cloud_session_id || null;
    router.replace({ path: "/qa" });
    nextTick(() => scrollChatToBottom());
  }
}

async function scrollChatToBottom() {
  await nextTick();
  const el = chatScrollRef.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

watch(
  () => chatMessages.value.length,
  () => scrollChatToBottom()
);

watch(
  () => route.fullPath,
  async () => {
    if (route.name !== "qa") return;
    await refreshLocal();
    applyRouteQuery();
  }
);

function withSyncSuggestion(message) {
  const base = message || "同步失败";
  return `${base}。请检查网络、DeepSeek Key与余额后重试。`;
}

/** 区分超时与其它错误，避免 LLM 较慢时误提示「Key/余额」 */
function formatQaAskFailure(error) {
  const serverMsg = error?.response?.data?.error?.message;
  if (serverMsg) return serverMsg;
  const code = error?.code;
  const msg = String(error?.message || "");
  if (code === "ECONNABORTED" || /timeout/i.test(msg)) {
    return "请求超时：问答耗时较长，请稍候再试。若多次失败请检查网络或后端是否正常运行。";
  }
  if (error?.response?.status === 401) {
    return "登录已过期，请重新登录后再试。";
  }
  return withSyncSuggestion("发送失败");
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

/** 气泡排序：优先 created_at；旧数据从 local_id 内时间戳解析；同一时刻用户在前、助手在后 */
function messageSortValue(m) {
  if (m?.created_at) {
    return new Date(m.created_at).getTime();
  }
  const match = String(m?.local_id || "").match(/(\d{13,})/);
  return match ? Number(match[1]) : 0;
}

function compareChatMessages(a, b) {
  const ta = messageSortValue(a);
  const tb = messageSortValue(b);
  if (ta !== tb) return ta - tb;
  const order = (r) => (r === "user" ? 0 : r === "assistant" ? 1 : 2);
  return order(a.role) - order(b.role);
}

function localAnswer(question) {
  const q = question || "";
  if (q.includes("烟") || q.includes("火")) {
    return "离线建议：优先确保安全并及时上报烟点位置。";
  }
  if (q.includes("松材线虫") || q.includes("线虫")) {
    return "离线建议：疑似疫木应标记位置并上报检疫部门，勿擅自运输或处理疫木。";
  }
  if (q.includes("防火期") || q.includes("森林防火期")) {
    return "离线建议：防火期因地区而异，以当地公告为准；防火期内严控野外用火。";
  }
  if (q.includes("油茶") && (q.includes("施肥") || q.includes("管护"))) {
    return "离线建议：油茶施肥宜结合树龄与季节，薄肥勤施并保持排水与病虫害巡查。";
  }
  if (q.includes("野生动物") || q.includes("遇兽")) {
    return "离线建议：保持安全距离、勿投喂，缓慢撤离并联系林业或公安处置。";
  }
  return "离线建议：当前为基础离线问答，联网后可获取增强回答。";
}

async function refreshLocal() {
  sessions.value = await getAllRecords(stores.qaSessions);
  messages.value = await getAllRecords(stores.qaMessages);
  localKnowledgeDocs.value = await getAllRecords(stores.qaKnowledgeDocs);
  pendingQuestions.value = await getAllRecords(stores.qaPendingQuestions);
}

async function askOffline() {
  const question = (form.question || "").trim();
  if (!question) {
    showFailToast("请输入问题");
    return;
  }
  const sessionLocalId = uid("qa_session");
  const userMessageId = uid("qa_msg_user");
  const assistantMessageId = uid("qa_msg_assistant");
  const answer = localAnswer(question);
  await putRecord(stores.qaSessions, {
    local_id: sessionLocalId,
    title: question.slice(0, 24),
    created_at: new Date().toISOString(),
  });
  const msgT = Date.now();
  await putRecord(stores.qaMessages, {
    local_id: userMessageId,
    session_local_id: sessionLocalId,
    role: "user",
    content: question,
    citations: [],
    created_at: new Date(msgT).toISOString(),
  });
  await putRecord(stores.qaMessages, {
    local_id: assistantMessageId,
    session_local_id: sessionLocalId,
    role: "assistant",
    content: answer,
    citations: [{ source: "离线规则库", snippet: "基础离线处置建议" }],
    created_at: new Date(msgT + 1).toISOString(),
  });
  previewAnswer.value = answer;
  previewCitations.value = [{ source: "离线规则库", snippet: "基础离线处置建议" }];
  previewProvider.value = "offline-local";
  form.question = "";
  await refreshLocal();
  showSuccessToast("已离线保存问答");
}

async function saveQuestionForOnline() {
  const question = (form.question || "").trim();
  if (!question) {
    showFailToast("请输入问题");
    return;
  }
  await putRecord(stores.qaPendingQuestions, {
    local_id: uid("qa_pending"),
    question,
    created_at: new Date().toISOString(),
  });
  form.question = "";
  await refreshLocal();
  showSuccessToast("问题已保存，联网后可一键补答");
}

function usePresetQuestion(question) {
  form.question = question;
}

function askFromPolicy(item) {
  const title = item?.title || "该知识项";
  if (!online.value) {
    policyKeyword.value = title;
    searchPolicy();
    showSuccessToast("已用标题关键词查询本地资料");
    return;
  }
  form.question = `请结合“${title}”给我具体操作步骤和注意事项。`;
  activeModule.value = "qa";
}

function stopVoiceInput() {
  if (speechRecognizer) {
    speechRecognizer.stop();
  }
  listening.value = false;
}

function startVoiceInput() {
  if (!speechSupported.value) {
    showFailToast("当前浏览器不支持语音输入");
    return;
  }
  if (listening.value) {
    stopVoiceInput();
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showFailToast("当前浏览器不支持语音输入");
    return;
  }
  speechRecognizer = new Recognition();
  speechRecognizer.lang = "zh-CN";
  speechRecognizer.continuous = false;
  speechRecognizer.interimResults = false;
  speechRecognizer.onstart = () => {
    listening.value = true;
  };
  speechRecognizer.onresult = (event) => {
    const text = event?.results?.[0]?.[0]?.transcript || "";
    if (text.trim()) {
      form.question = text.trim();
      showSuccessToast("语音已转为文字");
    }
  };
  speechRecognizer.onerror = () => {
    showFailToast("语音识别失败，请重试");
  };
  speechRecognizer.onend = () => {
    listening.value = false;
  };
  speechRecognizer.start();
}

function speakPreviewAnswer() {
  if (!previewAnswer.value.trim()) {
    showFailToast("暂无可朗读回答");
    return;
  }
  if (!("speechSynthesis" in window)) {
    showFailToast("当前浏览器不支持语音朗读");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(previewAnswer.value);
  utterance.lang = "zh-CN";
  utterance.rate = 1.0;
  utterance.onstart = () => {
    speaking.value = true;
  };
  utterance.onend = () => {
    speaking.value = false;
  };
  utterance.onerror = () => {
    speaking.value = false;
  };
  window.speechSynthesis.speak(utterance);
}

/** 主对话：同一本地会话内多轮，云端 session_id 续写 */
async function sendChatMessage() {
  const question = (form.question || "").trim();
  if (!question) {
    showFailToast("请输入内容");
    return;
  }
  if (!online.value) {
    showFailToast("当前离线");
    return;
  }
  onlineAsking.value = true;
  try {
    const { data } = await apiClient.post(
      "/qa/ask",
      {
        question,
        session_id: selectedCloudSessionId.value || undefined,
      },
      { timeout: QA_ASK_TIMEOUT_MS }
    );

    const sessionLocalId = activeChatSessionLocalId.value || uid("qa_session");
    const existing = sessions.value.find((s) => s.local_id === sessionLocalId);

    await putRecord(stores.qaSessions, {
      local_id: sessionLocalId,
      title: existing?.title || question.slice(0, 48),
      created_at: existing?.created_at || new Date().toISOString(),
      cloud_session_id: data.session_id || existing?.cloud_session_id || undefined,
    });
    if (!activeChatSessionLocalId.value) {
      activeChatSessionLocalId.value = sessionLocalId;
    }

    const msgT = Date.now();
    await putRecord(stores.qaMessages, {
      local_id: uid("qa_msg_user"),
      session_local_id: sessionLocalId,
      role: "user",
      content: question,
      citations: [],
      created_at: new Date(msgT).toISOString(),
    });
    await putRecord(stores.qaMessages, {
      local_id: uid("qa_msg_assistant"),
      session_local_id: sessionLocalId,
      role: "assistant",
      content: data.answer || "",
      citations: data.citations || [],
      created_at: new Date(msgT + 1).toISOString(),
    });

    previewAnswer.value = data.answer || "";
    previewCitations.value = data.citations || [];
    previewProvider.value = data.provider || "unknown";
    selectedCloudSessionId.value = data.session_id || selectedCloudSessionId.value;

    form.question = "";
    await refreshLocal();
    await loadCloudSessions();
    if (selectedCloudSessionId.value) {
      await loadCloudMessages(selectedCloudSessionId.value);
    }
    syncMeta.value = setSyncMeta("qa", {
      lastSuccessAt: new Date().toISOString(),
      lastError: "",
    });

    await nextTick();
    scrollChatToBottom();
  } catch (error) {
    const message = formatQaAskFailure(error);
    syncMeta.value = setSyncMeta("qa", {
      lastError: message,
    });
    showFailToast(message);
  } finally {
    onlineAsking.value = false;
  }
}

async function loadCloudSessions() {
  if (!online.value) return;
  try {
    const { data } = await apiClient.get("/qa/sessions");
    cloudSessions.value = data.items || [];
  } catch (_) {
    // Keep quiet on cloud list loading.
  }
}

async function loadCloudMessages(sessionId) {
  if (!online.value || !sessionId) return;
  try {
    const { data } = await apiClient.get(`/qa/sessions/${sessionId}/messages`);
    cloudMessages.value = data.items || [];
  } catch (_) {
    cloudMessages.value = [];
  }
}

async function searchPolicy() {
  const keyword = (policyKeyword.value || "").trim();
  localKnowledgeResults.value = localKnowledgeDocs.value.filter((item) => {
    if (!keyword) return true;
    if ((item?.title || "").includes(keyword)) return true;
    if ((item?.content || "").includes(keyword)) return true;
    return (item?.keywords || []).some((kw) => kw && kw.includes(keyword));
  });

  if (!online.value) {
    policyResults.value = [];
    if (!localKnowledgeResults.value.length) {
      showFailToast("离线模式下未命中本地资料");
    }
    return;
  }
  try {
    const suffix = keyword ? `?q=${encodeURIComponent(keyword)}` : "";
    const { data } = await apiClient.get(`/qa/knowledge-search${suffix}`);
    policyResults.value = data.items || [];
  } catch (error) {
    showFailToast(error?.response?.data?.error?.message || "知识查询失败");
  }
}

async function syncKnowledgeDocs() {
  if (!online.value) return;
  try {
    const { data } = await apiClient.get("/qa/knowledge-docs");
    await clearStore(stores.qaKnowledgeDocs);
    const docs = data.items || [];
    for (const doc of docs) {
      await putRecord(stores.qaKnowledgeDocs, doc);
    }
  } catch (_) {
    // Keep silent, local docs can still work with cached data.
  }
}

async function answerPendingQuestionsNow() {
  if (!online.value) {
    showFailToast("当前离线，无法联网补答");
    return;
  }
  const pending = await getAllRecords(stores.qaPendingQuestions);
  if (!pending.length) {
    showFailToast("暂无待补答问题");
    return;
  }
  onlineAsking.value = true;
  pendingAnswerReport.value = [];
  let successCount = 0;
  let failedCount = 0;
  for (const item of pending) {
    const question = (item?.question || "").trim();
    if (!question) {
      await deleteRecord(stores.qaPendingQuestions, item.local_id);
      continue;
    }
    try {
      const { data } = await apiClient.post("/qa/ask", { question }, { timeout: QA_ASK_TIMEOUT_MS });
      const sessionLocalId = uid("qa_session_online");
      await putRecord(stores.qaSessions, {
        local_id: sessionLocalId,
        title: question.slice(0, 24),
        created_at: new Date().toISOString(),
      });
      const msgT = Date.now();
      await putRecord(stores.qaMessages, {
        local_id: uid("qa_msg_online_user"),
        session_local_id: sessionLocalId,
        role: "user",
        content: question,
        citations: [],
        created_at: new Date(msgT).toISOString(),
      });
      await putRecord(stores.qaMessages, {
        local_id: uid("qa_msg_online_assistant"),
        session_local_id: sessionLocalId,
        role: "assistant",
        content: data.answer || "",
        citations: data.citations || [],
        created_at: new Date(msgT + 1).toISOString(),
      });
      await deleteRecord(stores.qaPendingQuestions, item.local_id);
      successCount += 1;
      pendingAnswerReport.value.push({
        local_id: item.local_id,
        question,
        status: "success",
        detail: "已补答并写入本地会话",
      });
      previewAnswer.value = data.answer || "";
      previewCitations.value = data.citations || [];
      previewProvider.value = data.provider || "unknown";
    } catch (error) {
      failedCount += 1;
      pendingAnswerReport.value.push({
        local_id: item.local_id,
        question,
        status: "failed",
        detail: error?.response?.data?.error?.message || "联网补答失败",
      });
    }
  }
  await refreshLocal();
  await loadCloudSessions();
  if (failedCount > 0) {
    showFailToast(`补答完成：成功 ${successCount} 条，失败 ${failedCount} 条`);
  } else {
    showSuccessToast(`已联网补答 ${successCount} 条问题`);
  }
  onlineAsking.value = false;
}

async function removePendingQuestion(localId) {
  const ok = window.confirm("确认删除这条待补答问题？");
  if (!ok) return;
  await deleteRecord(stores.qaPendingQuestions, localId);
  await refreshLocal();
  showSuccessToast("已删除待补答问题");
}

async function syncNow() {
  if (!online.value) {
    showFailToast("当前离线，无法同步");
    return;
  }
  syncing.value = true;
  try {
    const payload = {
      sessions: await getAllRecords(stores.qaSessions),
      messages: await getAllRecords(stores.qaMessages),
    };
    const { data } = await postWithSyncRetry(apiClient, "/qa/sync", payload);
    await clearStore(stores.qaSessions);
    await clearStore(stores.qaMessages);
    await refreshLocal();
    syncMeta.value = setSyncMeta("qa", {
      lastSuccessAt: new Date().toISOString(),
      lastError: "",
    });
    const sessionsCount = Number(data?.inserted_sessions || 0);
    const messagesCount = Number(data?.inserted_messages || 0);
    const summary = `会话${sessionsCount} / 消息${messagesCount}`;
    showSuccessToast(data?.deduplicated ? `问答同步已去重（${summary}）` : `问答同步成功（${summary}）`);
  } catch (error) {
    const message = withSyncSuggestion(error?.response?.data?.error?.message || "同步失败");
    syncMeta.value = setSyncMeta("qa", {
      lastError: message,
    });
    showFailToast(message);
  } finally {
    syncing.value = false;
  }
}

async function autoSyncIfPending() {
  if (!online.value || syncing.value) return;
  const sessionsLocal = await getAllRecords(stores.qaSessions);
  const messagesLocal = await getAllRecords(stores.qaMessages);
  if (!sessionsLocal.length && !messagesLocal.length) return;
  if (!autoSyncHintShown.value) {
    showSuccessToast("网络已恢复，已自动触发问答同步");
    autoSyncHintShown.value = true;
  }
  await syncNow();
}

onMounted(async () => {
  speechSupported.value = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  window.addEventListener("online", async () => {
    online.value = true;
    await autoSyncIfPending();
  });
  window.addEventListener("offline", () => (online.value = false));
  await refreshLocal();
  await syncKnowledgeDocs();
  await loadCloudSessions();
  await searchPolicy();
  const guidedQuestion = (route.query.q || "").toString().trim();
  if (guidedQuestion) {
    if (online.value) {
      form.question = guidedQuestion;
      activeModule.value = "qa";
    } else {
      policyKeyword.value = guidedQuestion;
      await searchPolicy();
    }
  }
  applyRouteQuery();
});
</script>

<template>
  <div class="page" :class="{ 'page--qa-module': online && activeModule === 'qa' }">
    <van-nav-bar title="AI 问答页" left-arrow @click-left="$router.back()">
      <template #right>
        <span class="nav-network-one" aria-live="polite">网络：{{ online ? "在线" : "离线" }}</span>
      </template>
    </van-nav-bar>

    <div class="module-switcher">
      <div class="tab-switcher" role="tablist" aria-label="模块切换">
        <button
          type="button"
          role="tab"
          class="tab-btn"
          :class="{ 'is-active': activeModule === 'knowledge' }"
          :aria-selected="activeModule === 'knowledge'"
          @click="setActiveModule('knowledge')"
        >
          知识库速查模块
        </button>
        <button
          type="button"
          role="tab"
          class="tab-btn"
          :class="{ 'is-active': activeModule === 'qa', 'is-disabled': !online }"
          :aria-selected="activeModule === 'qa'"
          :disabled="!online"
          @click="setActiveModule('qa')"
        >
          AI 问答模块{{ online ? "" : "（需联网）" }}
        </button>
      </div>
    </div>

    <div v-if="activeModule === 'knowledge'" class="card function-area function-area--blank" aria-label="知识库速查功能区" />

    <div v-else-if="online && activeModule === 'qa'" class="qa-chat-wrap card">
      <div class="qa-func-inner">
        <div class="qa-func-toolbar">
          <button type="button" class="qa-tool-btn qa-tool-btn--history" @click="openHistoryDrawer">历史</button>
          <button type="button" class="qa-tool-btn qa-tool-btn--new" @click="onNewChatClick">新建</button>
        </div>

        <div ref="chatScrollRef" class="qa-chat-messages">
          <div v-if="!chatMessages.length" class="qa-empty">
            <p class="qa-empty-title">专业知识问答</p>
            <p class="qa-empty-desc">
              在下方输入框发送问题；点左侧「历史」查看会话列表，「新建」开启新对话。
            </p>
          </div>
          <div
            v-for="msg in chatMessages"
            :key="msg.local_id"
            :class="['qa-msg-row', msg.role === 'user' ? 'qa-msg-row--user' : 'qa-msg-row--ai']"
          >
            <div class="qa-bubble">{{ msg.content }}</div>
          </div>
          <div v-if="onlineAsking" class="qa-msg-row qa-msg-row--ai">
            <div class="qa-bubble qa-bubble--typing">正在回复…</div>
          </div>
        </div>

        <div class="qa-input-bar">
          <van-field
            v-model="form.question"
            class="qa-input-field"
            rows="1"
            autosize
            type="textarea"
            maxlength="2000"
            placeholder="发消息…"
            :border="false"
            @keydown.enter.exact.prevent="sendChatMessage"
          />
          <van-button
            type="primary"
            size="small"
            class="qa-send-btn"
            :loading="onlineAsking"
            :disabled="onlineAsking"
            @click="sendChatMessage"
          >
            发送
          </van-button>
        </div>

        <!-- 仅覆盖 AI 功能区（不铺满整页） -->
        <div v-if="historyDrawerOpen" class="qa-history-layer" role="dialog" aria-modal="true" aria-label="历史对话">
          <div class="qa-history-backdrop" @click="historyDrawerOpen = false" />
          <aside class="qa-history-panel">
            <div class="history-drawer-head">
              <span class="history-drawer-title">历史对话</span>
              <button type="button" class="history-drawer-close" aria-label="关闭" @click="historyDrawerOpen = false">
                ×
              </button>
            </div>
            <button
              type="button"
              class="history-drawer-newchat"
              @click="
                onNewChatClick();
                historyDrawerOpen = false;
              "
            >
              + 新建对话
            </button>

            <div class="history-drawer-body">
              <p v-if="!sortedSessions.length" class="history-drawer-empty">暂无历史对话</p>
              <template v-else>
                <section v-if="groupedSessions.today.length" class="history-group">
                  <h4 class="history-group-title">今天</h4>
                  <button
                    v-for="item in groupedSessions.today"
                    :key="item.local_id"
                    type="button"
                    class="history-row"
                    :class="{ 'is-active': item.local_id === activeChatSessionLocalId }"
                    @click="selectHistorySession(item.local_id)"
                  >
                    {{ item.title || "未命名对话" }}
                  </button>
                </section>
                <section v-if="groupedSessions.week.length" class="history-group">
                  <h4 class="history-group-title">本周</h4>
                  <button
                    v-for="item in groupedSessions.week"
                    :key="item.local_id"
                    type="button"
                    class="history-row"
                    :class="{ 'is-active': item.local_id === activeChatSessionLocalId }"
                    @click="selectHistorySession(item.local_id)"
                  >
                    {{ item.title || "未命名对话" }}
                  </button>
                </section>
                <section v-if="groupedSessions.older.length" class="history-group">
                  <h4 class="history-group-title">更早</h4>
                  <button
                    v-for="item in groupedSessions.older"
                    :key="item.local_id"
                    type="button"
                    class="history-row"
                    :class="{ 'is-active': item.local_id === activeChatSessionLocalId }"
                    @click="selectHistorySession(item.local_id)"
                  >
                    {{ item.title || "未命名对话" }}
                  </button>
                </section>
              </template>
            </div>
          </aside>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #f7f8fa;
  padding: 16px;
  padding-bottom: 28px;
}

.page--qa-module {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-height: 100dvh;
  padding-bottom: 0;
  box-sizing: border-box;
}

.page--qa-module .module-switcher {
  flex-shrink: 0;
}

.page--qa-module .qa-chat-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-bottom: 0;
  padding: 0;
  overflow: hidden;
}

.qa-func-inner {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
  border-radius: 0 0 8px 8px;
}

/* 历史侧栏：仅占 AI 功能区内部，宽度约为功能区 2/3 */
.qa-history-layer {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  pointer-events: none;
}

.qa-history-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  pointer-events: auto;
}

.qa-history-panel {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 66.67%;
  min-width: 140px;
  max-width: 90%;
  background: #fff;
  box-shadow: 4px 0 20px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: auto;
  z-index: 1;
}

.qa-func-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: #fff;
  border-bottom: 1px solid #ebedf0;
}

.qa-tool-btn {
  padding: 6px 14px;
  font-size: 14px;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid #dcdee0;
  background: #fff;
}

.qa-tool-btn--history {
  color: #1989fa;
  border-color: #b3d9ff;
  background: #fff;
}

.qa-tool-btn--new {
  color: #07c160;
  border-color: #b3e8c8;
  background: #fff;
}

.qa-tool-btn:active {
  opacity: 0.88;
}

.nav-network-one {
  font-size: 13px;
  font-weight: 500;
  color: #646566;
}

.module-switcher {
  margin-bottom: 12px;
  flex-shrink: 0;
}

.tab-switcher {
  display: flex;
  gap: 0;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #dcdee0;
  background: #fff;
}

.tab-btn {
  flex: 1;
  min-height: 44px;
  padding: 10px 8px;
  margin: 0;
  border: none;
  background: #f7f8fa;
  font-size: 13px;
  font-weight: 500;
  color: #646566;
  line-height: 1.35;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.tab-btn + .tab-btn {
  border-left: 1px solid #dcdee0;
}

.tab-btn.is-active {
  background: linear-gradient(180deg, #e8f4ff 0%, #fff 100%);
  color: #1989fa;
  font-weight: 600;
  box-shadow: inset 0 -2px 0 #1989fa;
}

.tab-btn.is-disabled,
.tab-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.qa-chat-wrap.card {
  padding: 0;
  display: flex;
  flex-direction: column;
}

.qa-chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 16px;
  -webkit-overflow-scrolling: touch;
  background: #f7f8fa;
}

.qa-empty {
  padding: 28px 12px 20px;
  text-align: center;
}

.qa-empty-title {
  margin: 0 0 8px 0;
  font-size: 17px;
  font-weight: 600;
  color: #323233;
}

.qa-empty-desc {
  margin: 0;
  font-size: 13px;
  color: #646566;
  line-height: 1.55;
}

.qa-msg-row {
  display: flex;
  margin-bottom: 14px;
}

.qa-msg-row--user {
  justify-content: flex-end;
}

.qa-msg-row--ai {
  justify-content: flex-start;
}

.qa-bubble {
  max-width: 85%;
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 15px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
}

.qa-msg-row--user .qa-bubble {
  background: #ecf9ff;
  color: #323233;
  border: 1px solid #d0e8ff;
}

.qa-msg-row--ai .qa-bubble {
  background: #fff;
  color: #323233;
  border: 1px solid #ebedf0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.qa-bubble--typing {
  color: #969799 !important;
  font-size: 13px;
  border-style: dashed !important;
}

.qa-input-bar {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
  background: #fff;
  border-top: 1px solid #ebedf0;
}

.qa-input-field {
  flex: 1;
  background: #f7f8fa !important;
  border-radius: 20px !important;
  padding: 6px 12px !important;
}

.qa-input-field :deep(.van-field__control) {
  color: #323233;
}

.qa-input-field :deep(.van-field__control::placeholder) {
  color: #c8c9cc;
}

.qa-send-btn {
  flex-shrink: 0;
  border-radius: 18px !important;
}

.card {
  background: #fff;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
  display: grid;
  gap: 10px;
}

.history-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid #ebedf0;
  flex-shrink: 0;
}

.history-drawer-title {
  font-size: 17px;
  font-weight: 600;
  color: #323233;
}

.history-drawer-close {
  width: 36px;
  height: 36px;
  border: none;
  background: #f7f8fa;
  border-radius: 8px;
  font-size: 22px;
  line-height: 1;
  color: #646566;
  cursor: pointer;
}

.history-drawer-newchat {
  margin: 12px 14px 8px;
  padding: 12px 14px;
  border: 1px solid #07c160;
  border-radius: 10px;
  background: #fff;
  color: #07c160;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
}

.history-drawer-newchat:active {
  background: #f4fff8;
}

.history-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 14px 24px;
  -webkit-overflow-scrolling: touch;
}

.history-drawer-empty {
  margin: 24px 0;
  text-align: center;
  color: #969799;
  font-size: 14px;
}

.history-group {
  margin-bottom: 16px;
}

.history-group-title {
  margin: 0 0 8px 0;
  font-size: 13px;
  font-weight: 500;
  color: #969799;
}

.history-row {
  display: block;
  width: 100%;
  text-align: left;
  padding: 12px 10px;
  margin-bottom: 6px;
  border: 1px solid #ebedf0;
  border-radius: 8px;
  background: #fff;
  color: #323233;
  font-size: 14px;
  line-height: 1.4;
  cursor: pointer;
}

.history-row.is-active {
  background: #ecf9ff;
  border-color: #b3d9ff;
}

.function-area {
  min-height: 200px;
}

.function-area--blank {
  min-height: 240px;
}

.inset-card {
  margin: 0;
  padding: 10px;
  background: #f7f8fa;
  border: 1px solid #ebedf0;
  border-radius: 8px;
  display: grid;
  gap: 8px;
}

.inset-card h3 {
  margin: 0 0 6px 0;
  font-size: 15px;
}

.sync-line {
  margin: 0;
  font-size: 12px;
  color: #646566;
}

.preset-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.policy-item {
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  padding: 8px;
  display: grid;
  gap: 8px;
}

.message-item {
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  padding: 8px;
}

.message-role {
  margin: 0 0 4px 0;
  color: #969799;
  font-size: 12px;
  text-transform: uppercase;
}

.error-tip {
  color: #ee0a24;
}
</style>
