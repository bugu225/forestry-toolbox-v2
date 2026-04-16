<script setup>
import { onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { showFailToast, showSuccessToast } from "vant";
import apiClient from "../api/client";
import { postWithSyncRetry } from "../utils/syncRetry";
import { clearStore, deleteRecord, getAllRecords, putRecord, stores } from "../services/offlineDb";
import { getSyncMeta, setSyncMeta } from "../services/syncMeta";

const online = ref(navigator.onLine);
const route = useRoute();
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

function withSyncSuggestion(message) {
  const base = message || "同步失败";
  return `${base}。请检查网络、DeepSeek Key与余额后重试。`;
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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
  await putRecord(stores.qaMessages, {
    local_id: userMessageId,
    session_local_id: sessionLocalId,
    role: "user",
    content: question,
    citations: [],
  });
  await putRecord(stores.qaMessages, {
    local_id: assistantMessageId,
    session_local_id: sessionLocalId,
    role: "assistant",
    content: answer,
    citations: [{ source: "离线规则库", snippet: "基础离线处置建议" }],
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
  form.question = `请结合“${title}”给我具体操作步骤和注意事项。`;
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

async function askOnlineEnhance() {
  const question = (form.question || "").trim();
  if (!question) {
    showFailToast("请输入问题");
    return;
  }
  if (!online.value) {
    showFailToast("当前离线，请使用离线提问");
    return;
  }
  onlineAsking.value = true;
  try {
    const { data } = await apiClient.post("/qa/ask", {
      question,
      session_id: selectedCloudSessionId.value || undefined,
    });
    previewAnswer.value = data.answer || "";
    previewCitations.value = data.citations || [];
    previewProvider.value = data.provider || "unknown";
    selectedCloudSessionId.value = data.session_id || selectedCloudSessionId.value;

    const sessionLocalId = uid("qa_session_online");
    await putRecord(stores.qaSessions, {
      local_id: sessionLocalId,
      title: question.slice(0, 24),
      created_at: new Date().toISOString(),
    });
    await putRecord(stores.qaMessages, {
      local_id: uid("qa_msg_online_user"),
      session_local_id: sessionLocalId,
      role: "user",
      content: question,
      citations: [],
    });
    await putRecord(stores.qaMessages, {
      local_id: uid("qa_msg_online_assistant"),
      session_local_id: sessionLocalId,
      role: "assistant",
      content: data.answer || "",
      citations: data.citations || [],
    });
    await refreshLocal();
    await loadCloudSessions();
    if (selectedCloudSessionId.value) {
      await loadCloudMessages(selectedCloudSessionId.value);
    }
    syncMeta.value = setSyncMeta("qa", {
      lastSuccessAt: new Date().toISOString(),
      lastError: "",
    });

    showSuccessToast(data.provider === "deepseek" ? "已使用联网增强回答" : "已返回降级回答");
  } catch (error) {
    const message = withSyncSuggestion(error?.response?.data?.error?.message || "联网提问失败");
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
      const { data } = await apiClient.post("/qa/ask", { question });
      const sessionLocalId = uid("qa_session_online");
      await putRecord(stores.qaSessions, {
        local_id: sessionLocalId,
        title: question.slice(0, 24),
        created_at: new Date().toISOString(),
      });
      await putRecord(stores.qaMessages, {
        local_id: uid("qa_msg_online_user"),
        session_local_id: sessionLocalId,
        role: "user",
        content: question,
        citations: [],
      });
      await putRecord(stores.qaMessages, {
        local_id: uid("qa_msg_online_assistant"),
        session_local_id: sessionLocalId,
        role: "assistant",
        content: data.answer || "",
        citations: data.citations || [],
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
    form.question = guidedQuestion;
  }
});
</script>

<template>
  <div class="page">
    <van-nav-bar title="问答（离线优先）" left-arrow @click-left="$router.back()" />
    <div class="card">
      <p>网络：{{ online ? "在线" : "离线" }}</p>
      <van-field v-model="form.question" label="问题" placeholder="请输入问题" />
      <div class="preset-list">
        <van-button
          size="small"
          type="primary"
          plain
          :disabled="!speechSupported"
          :loading="listening"
          @click="startVoiceInput"
        >
          {{ listening ? "停止语音输入" : "语音输入问题" }}
        </van-button>
      </div>
      <div class="preset-list">
        <van-button size="small" plain type="primary" @click="usePresetQuestion('火灾应急流程怎么做？')">
          火灾应急
        </van-button>
        <van-button size="small" plain type="primary" @click="usePresetQuestion('野外伤病如何急救？')">
          伤病急救
        </van-button>
        <van-button size="small" plain type="primary" @click="usePresetQuestion('油茶怎么施肥和管护？')">
          油茶管护
        </van-button>
        <van-button size="small" plain type="primary" @click="usePresetQuestion('巡护记录应该怎么写更规范？')">
          巡护记录
        </van-button>
        <van-button size="small" plain type="primary" @click="usePresetQuestion('松材线虫病怎么治？')">
          松材线虫
        </van-button>
        <van-button size="small" plain type="primary" @click="usePresetQuestion('森林防火期是几月？')">
          森林防火期
        </van-button>
        <van-button size="small" plain type="primary" @click="usePresetQuestion('油茶怎么施肥？')">
          油茶施肥
        </van-button>
        <van-button size="small" plain type="primary" @click="usePresetQuestion('野外遇到野生动物如何应对？')">
          野生动物应对
        </van-button>
      </div>
      <van-button type="primary" block @click="askOffline">离线提问</van-button>
      <van-button type="default" block :loading="onlineAsking" @click="askOnlineEnhance">
        联网增强提问
      </van-button>
      <van-button type="warning" block @click="saveQuestionForOnline">离线仅保存问题</van-button>
      <van-button type="success" block :loading="onlineAsking" @click="answerPendingQuestionsNow">
        联网一键补答离线问题
      </van-button>
      <van-button type="success" block :loading="syncing" @click="syncNow">立即同步</van-button>
      <p>最近同步成功：{{ syncMeta.lastSuccessAt || "暂无" }}</p>
      <p v-if="syncMeta.lastError" class="error-tip">最近同步失败：{{ syncMeta.lastError }}</p>
    </div>

    <div class="card" v-if="previewAnswer">
      <h3>最近回答</h3>
      <p>来源：{{ previewProvider || "unknown" }}</p>
      <p>{{ previewAnswer }}</p>
      <van-button size="small" type="default" plain :loading="speaking" @click="speakPreviewAnswer">
        朗读回答
      </van-button>
      <h4>引用</h4>
      <p v-if="!previewCitations.length">无引用</p>
      <van-cell
        v-for="(item, idx) in previewCitations"
        :key="`${item.source}_${idx}`"
        :title="item.source"
        :label="item.snippet"
      />
    </div>

    <div class="card">
      <h3>林业知识速查</h3>
      <van-field v-model="policyKeyword" label="关键词" placeholder="如：火情 / 急救 / 油茶" />
      <van-button type="default" block @click="searchPolicy">查询知识</van-button>
      <h4>本地资料命中</h4>
      <p v-if="!localKnowledgeResults.length">暂无本地命中</p>
      <div v-for="item in localKnowledgeResults" :key="`local_${item.id}`" class="policy-item">
        <van-cell :title="`${item.title}（离线）`" :label="item.summary || item.content" />
        <van-button size="small" type="primary" plain @click="askFromPolicy(item)">一键追问</van-button>
      </div>
      <h4>云端资料命中</h4>
      <p v-if="!policyResults.length">暂无结果</p>
      <div v-for="item in policyResults" :key="item.id" class="policy-item">
        <van-cell :title="item.title" :label="item.summary" />
        <van-button size="small" type="primary" plain @click="askFromPolicy(item)">一键追问</van-button>
      </div>
    </div>

    <div class="card">
      <h3>待联网补答问题</h3>
      <p v-if="!pendingQuestions.length">暂无待补答问题</p>
      <div v-for="item in pendingQuestions" :key="item.local_id" class="policy-item">
        <van-cell :title="item.question" :label="item.created_at" />
        <van-button size="small" type="danger" plain @click="removePendingQuestion(item.local_id)">删除</van-button>
      </div>
    </div>

    <div class="card" v-if="pendingAnswerReport.length">
      <h3>最近补答结果</h3>
      <van-cell
        v-for="item in pendingAnswerReport"
        :key="`report_${item.local_id}`"
        :title="`${item.status === 'success' ? '成功' : '失败'}：${item.question}`"
        :label="item.detail"
      />
    </div>

    <div class="card">
      <h3>本地会话</h3>
      <p v-if="!sessions.length">暂无会话</p>
      <van-cell v-for="item in sessions" :key="item.local_id" :title="item.title" />
    </div>

    <div class="card">
      <h3>云端会话</h3>
      <p v-if="!cloudSessions.length">暂无云端会话</p>
      <van-cell
        v-for="item in cloudSessions"
        :key="item.id"
        :title="item.title"
        :label="item.created_at"
        @click="selectedCloudSessionId = item.id; loadCloudMessages(item.id)"
      />
      <p v-if="selectedCloudSessionId">当前会话ID：{{ selectedCloudSessionId }}</p>
    </div>

    <div class="card" v-if="selectedCloudSessionId">
      <h3>云端消息</h3>
      <p v-if="!cloudMessages.length">暂无消息</p>
      <div v-for="msg in cloudMessages" :key="msg.id" class="message-item">
        <p class="message-role">{{ msg.role }}</p>
        <p>{{ msg.content }}</p>
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
