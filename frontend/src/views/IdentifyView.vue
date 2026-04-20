<script setup>
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import { showFailToast, showSuccessToast } from "vant";
import apiClient from "../api/client";
import { useAuthStore } from "../stores/auth";
import { useNetworkStore } from "../stores/network";
import { deleteRecord, getAllRecords, getRecord, putRecord, stores } from "../services/offlineDb";

const authStore = useAuthStore();
const networkStore = useNetworkStore();
const { effectiveOnline: online } = storeToRefs(networkStore);

/** 识图走同步接口，百度双通道可能较慢 */
const IDENTIFY_SYNC_TIMEOUT_MS = 60000;
/** 中部对话：user 含 image；assistant 含 text / pending */
const chatMessages = ref([]);
const chatScrollRef = ref(null);
/** 图集全屏覆盖功能区（不含顶栏与底栏） */
const showGallery = ref(false);
/** 图集内大图预览（黑底、固定比例画幅、元数据、上/下一张） */
const showGalleryPreview = ref(false);
/** 图集大图预览内：底部「识图信息」半屏页 */
const showGalleryIdentifySheet = ref(false);
const galleryPreviewIndex = ref(0);
const galleryRaw = ref([]);
const cameraInput = ref(null);
const albumInput = ref(null);
/** 直连摄像头（getUserMedia），失败则回退到 file input */
const cameraBusy = ref(false);

/** 拍摄前元数据弹窗（不依赖网络）；确定后才进入识图流程 */
const showShotMetaPopup = ref(false);
const metaLocationLoading = ref(false);
const metaForm = reactive({
  datetimeLocal: "",
  lat: "",
  lng: "",
  category: "plant",
});
let metaDialogResolve = null;

const sortedGallery = computed(() =>
  [...galleryRaw.value].sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return tb - ta;
  })
);

const galleryPreviewItem = computed(() => {
  if (!showGalleryPreview.value) return null;
  const list = sortedGallery.value;
  const i = galleryPreviewIndex.value;
  if (i < 0 || i >= list.length) return null;
  return list[i];
});

const galleryViewerMeta = computed(() => formatGalleryItemMeta(galleryPreviewItem.value));

const galleryViewerIdentifyText = computed(() => buildGalleryIdentifyPreviewText(galleryPreviewItem.value));

function formatGalleryItemMeta(item) {
  if (!item) {
    return { time: "—", location: "—", category: "—" };
  }
  const sm = item.shot_meta;
  let time = "";
  if (sm?.shotTimeDisplay) {
    time = sm.shotTimeDisplay;
  } else if (sm?.datetimeLocal) {
    time = formatShotTimeForDisplay(sm.datetimeLocal);
  } else if (item.created_at) {
    const d = new Date(item.created_at);
    time = Number.isNaN(d.getTime()) ? "无记录" : formatShotTimeForDisplay(toDatetimeLocalValue(d));
  } else {
    time = "无记录";
  }
  const location = formatLocationLineForDisplay(sm);
  const category =
    sm?.categoryZh || (sm?.category ? categoryLabelZh(sm.category) : "") || "无记录（旧图）";
  return { time, location, category };
}

/** 顶栏/图集：经纬度统一显示为一位小数；兼容仅存 locationLine 的旧数据 */
function formatLocationLineForDisplay(sm) {
  if (!sm || typeof sm !== "object") return "无记录（旧图或未填写）";
  const lat = sm.lat;
  const lng = sm.lng;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `经度 ${lng.toFixed(1)}，纬度 ${lat.toFixed(1)}（WGS84）`;
  }
  const line = String(sm.locationLine || "").trim();
  if (!line) return "无记录（旧图或未填写）";
  const m = line.match(/经度\s*([-+]?\d+(?:\.\d+)?)\s*，\s*纬度\s*([-+]?\d+(?:\.\d+)?)/);
  if (m) {
    const lo = Number(m[1]);
    const la = Number(m[2]);
    if (Number.isFinite(lo) && Number.isFinite(la)) {
      return `经度 ${lo.toFixed(1)}，纬度 ${la.toFixed(1)}（WGS84）`;
    }
  }
  return line;
}

/** 与识图助手气泡正文一致：动植物+简介 / 非动植物提示 / 离线或未记录等 */
function buildGalleryIdentifyPreviewText(item) {
  if (!item) return "";
  const gi = item.gallery_identify;
  if (!gi || typeof gi !== "object") {
    return "暂无云端识图记录（旧图或未识别）。请联网后在识图页重新上传或选择该图以完成识别。";
  }
  if (gi.status === "success" && gi.synced && typeof gi.synced === "object") {
    return formatIdentifyReply(gi.synced);
  }
  if (gi.status === "offline") {
    return "当前为离线保存，未进行云端识图。请连接网络后在识图页重新上传或从图集选择该图以完成识别。";
  }
  if (gi.status === "no_login") {
    return "未登录时无法调用云端识图。请登录后在识图页重新发起识别。";
  }
  if (gi.status === "error") {
    return (gi.message || "").trim() || "识别失败，请检查网络与登录状态后重试。";
  }
  if (gi.status === "empty") {
    return "服务端未返回识别结果，请稍后重试。";
  }
  return "暂无识图说明。";
}

function pickIdentifySnapshotForGallery(synced) {
  if (!synced || typeof synced !== "object") return null;
  return {
    identify_display_mode: synced.identify_display_mode,
    user_notice_zh: synced.user_notice_zh,
    primary_label_zh: synced.primary_label_zh,
    primary_confidence: synced.primary_confidence,
    deepseek_intro_zh: synced.deepseek_intro_zh,
    top_k: synced.top_k,
    risk_level: synced.risk_level,
    provider: synced.provider,
    used_mock: synced.used_mock,
  };
}

async function persistGalleryIdentify(localId, galleryIdentify) {
  if (!localId || !galleryIdentify) return;
  try {
    const existing = await getRecord(stores.identifyGallery, localId);
    if (!existing) return;
    await putRecord(stores.identifyGallery, { ...existing, gallery_identify: galleryIdentify });
  } catch {
    /* 忽略写入失败，对话区仍已展示 */
  }
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function stripDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return "";
  const idx = dataUrl.indexOf("base64,");
  return idx >= 0 ? dataUrl.slice(idx + 7) : dataUrl;
}

function riskLabel(level) {
  const map = { high: "高", medium: "中", low: "低" };
  return map[level] || level || "低";
}

/** 避免把安卓系统给的纯数字文件名当作「物种名」传给后端 mock */
function safeImageFileName(hint) {
  const h = (hint || "").trim();
  const stem = h.includes(".") ? h.slice(0, h.lastIndexOf(".")) : h;
  if (h && stem && !/^\d{5,}$/.test(stem) && stem.length < 120) {
    const lower = h.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") || lower.endsWith(".webp")) {
      return h;
    }
    return `${stem}.jpg`;
  }
  return `识图_${Date.now()}.jpg`;
}

/** 旧版：完整候选列表（缓存命中、离线预计算等仍走此逻辑） */
function formatIdentifyReplyLegacy(synced) {
  const notice = (synced?.user_notice_zh || "").trim();
  const top = synced?.top_k || [];
  const lines = [];
  if (notice) {
    lines.push(notice);
    lines.push("");
  }
  if (!top.length) {
    if (!notice) {
      lines.push("未得到有效候选，请换更清晰的主体或稍后重试。");
    }
    return lines.join("\n").trimEnd();
  }
  if (!notice) {
    lines.push("根据当前图像，综合植物与动物识别通道，得到以下结果（仅供参考）：");
    lines.push("");
  } else {
    lines.push("—— 以下为系统返回条目（若上文已说明为占位或弱置信，请酌信）——");
    lines.push("");
  }
  lines.push("🌿 候选物种");
  top.slice(0, 6).forEach((it, idx) => {
    const src = it.source === "animal" ? "动物" : "植物";
    const pct = ((Number(it.confidence) || 0) * 100).toFixed(0);
    lines.push(`  ${idx + 1}. ${it.name || "未知"}（${pct}% · ${src}）`);
  });
  lines.push("");
  lines.push("📌 补充说明");
  lines.push(`  · 风险等级：${riskLabel(synced?.risk_level)}`);
  lines.push(`  · 提供方：${synced?.provider || "unknown"}${synced?.used_mock ? "（演示数据）" : ""}`);
  return lines.join("\n");
}

function formatIdentifyReply(synced) {
  const mode = synced?.identify_display_mode;
  if (mode === "non_biota_gate") {
    return (synced?.user_notice_zh || "").trim();
  }
  if (mode === "biota_with_intro" && synced?.primary_label_zh) {
    const pct = Math.round((Number(synced.primary_confidence) || 0) * 100);
    const head = `${synced.primary_label_zh} 约 ${pct}% 概率`;
    const intro = (synced.deepseek_intro_zh || "").trim();
    if (intro) {
      return `${head}\n\n${intro}`;
    }
    return `${head}\n\n（暂无 AI 简介：请配置 LLM_API_KEY 或稍后重试）`;
  }
  return formatIdentifyReplyLegacy(synced);
}

function patchAssistantMessage(assistantId, text, pending) {
  const i = chatMessages.value.findIndex((m) => m.id === assistantId);
  if (i >= 0) {
    const row = chatMessages.value[i];
    chatMessages.value[i] = { ...row, text, pending };
  }
}

function toDatetimeLocalValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${y}-${mo}-${da}T${h}:${mi}`;
}

function formatShotTimeForDisplay(datetimeLocal) {
  const s = (datetimeLocal || "").trim();
  if (!s) return "未填写";
  const [d, t] = s.split("T");
  if (!d || !t) return s;
  const [y, mo, da] = d.split("-").map(Number);
  const [hh, mm] = t.split(":");
  if (![y, mo, da].every((n) => Number.isFinite(n))) return s;
  return `${y}年${mo}月${da}日 ${String(hh || "").padStart(2, "0")}:${String(mm || "").padStart(2, "0")}`;
}

function categoryLabelZh(cat) {
  const m = { plant: "植物", animal: "动物", other: "其他" };
  return m[cat] || "其他";
}

function formatUserMetaPrefix(meta) {
  if (!meta) return "";
  const lines = [
    `拍摄时间：${meta.shotTimeDisplay || "未填写"}`,
    `拍摄位置：${meta.locationLine || "未填写"}`,
    `类别：${meta.categoryZh || categoryLabelZh(meta.category)}`,
  ];
  return lines.join("\n");
}

function composeAssistantWithMeta(meta, body) {
  const b = (body || "").trim();
  const prefix = formatUserMetaPrefix(meta).trim();
  if (!prefix) return b;
  if (!b) return prefix;
  return `${prefix}\n\n${b}`;
}

function resetMetaForm() {
  metaForm.datetimeLocal = toDatetimeLocalValue(new Date());
  metaForm.lat = "";
  metaForm.lng = "";
  metaForm.category = "plant";
}

/** @returns {Promise<object|null>} meta 或取消时为 null */
function openShotMetaDialog() {
  resetMetaForm();
  return new Promise((resolve) => {
    if (metaDialogResolve) {
      metaDialogResolve(null);
      metaDialogResolve = null;
    }
    metaDialogResolve = resolve;
    showShotMetaPopup.value = true;
  });
}

function buildShotMetaFromForm() {
  let dt = String(metaForm.datetimeLocal || "").trim();
  if (!dt) {
    dt = toDatetimeLocalValue(new Date());
  }
  const latStr = String(metaForm.lat || "").trim();
  const lngStr = String(metaForm.lng || "").trim();
  const lat = latStr === "" ? NaN : Number(latStr);
  const lng = lngStr === "" ? NaN : Number(lngStr);
  let locationLine = "未填写（未获取 GPS）";
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    locationLine = `经度 ${lng.toFixed(1)}，纬度 ${lat.toFixed(1)}（WGS84）`;
  }
  return {
    datetimeLocal: dt,
    shotTimeDisplay: formatShotTimeForDisplay(dt),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    locationLine,
    category: metaForm.category,
    categoryZh: categoryLabelZh(metaForm.category),
  };
}

function confirmShotMeta() {
  const meta = buildShotMetaFromForm();
  const r = metaDialogResolve;
  metaDialogResolve = null;
  showShotMetaPopup.value = false;
  r?.(meta);
}

function cancelShotMeta() {
  const r = metaDialogResolve;
  metaDialogResolve = null;
  showShotMetaPopup.value = false;
  r?.(null);
}

function onShotMetaPopupClosed() {
  if (metaDialogResolve) {
    const r = metaDialogResolve;
    metaDialogResolve = null;
    r(null);
  }
}

function applyCurrentTimeToMeta() {
  metaForm.datetimeLocal = toDatetimeLocalValue(new Date());
}

function formatGeoError(error, fallback = "获取位置失败，可手动输入经纬度") {
  const code = Number(error?.code || 0);
  if (code === 1) {
    return "定位权限被拒绝：请在系统与浏览器设置中允许位置权限后重试。";
  }
  if (code === 2) {
    return "定位不可用：请确认手机定位服务（GPS）已开启，并在室外或网络较好环境重试。";
  }
  if (code === 3) {
    return "定位超时：请稍后重试，或关闭省电模式后再试。";
  }
  if (window.isSecureContext === false) {
    return "当前页面不是安全上下文，浏览器可能拒绝定位。请改用 HTTPS 或 localhost 访问。";
  }
  return fallback;
}

function fillCurrentLocation() {
  if (!navigator.geolocation) {
    showFailToast("当前环境不支持定位");
    return;
  }
  metaLocationLoading.value = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      metaLocationLoading.value = false;
      const la = pos.coords?.latitude;
      const lo = pos.coords?.longitude;
      if (typeof la !== "number" || typeof lo !== "number") {
        showFailToast("未能读取有效坐标");
        return;
      }
      metaForm.lat = la.toFixed(1);
      metaForm.lng = lo.toFixed(1);
    },
    (error) => {
      metaLocationLoading.value = false;
      showFailToast(formatGeoError(error));
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

/** 不把 axios 英文原句直接给用户看 */
function formatIdentifyApiError(err) {
  const serverMsg = err?.response?.data?.error?.message;
  if (serverMsg && typeof serverMsg === "string") return serverMsg;
  const status = err?.response?.status;
  if (status === 401) {
    return "登录已失效或未携带有效令牌，请退出本页后重新登录，再使用云端识图。";
  }
  if (status === 403) {
    return "没有权限访问识图服务。";
  }
  if (status === 404) {
    return "识图接口不存在，请确认后端已启动且前端代理配置正确。";
  }
  if (status === 413) {
    return "上传图片过大，被网关拒绝（常见为 Nginx 默认仅允许 1MB 请求体）。请在服务器 Nginx 的 server 块中设置 client_max_body_size 20m; 并重载 Nginx，或换用较小/较低分辨率照片。";
  }
  if (status === 414) {
    return "请求 URL 或数据过长被网关拒绝，请换用较小图片或调整服务器限制。";
  }
  if (status >= 500) {
    return "服务端暂时不可用，请稍后再试。";
  }
  const code = err?.code;
  const raw = String(err?.message || "");
  if (code === "ECONNABORTED" || /timeout/i.test(raw)) {
    return "识图请求超时，请稍后重试。";
  }
  if (/status code 401/i.test(raw)) {
    return "登录已失效或未携带有效令牌，请退出本页后重新登录，再使用云端识图。";
  }
  if (!err?.response) {
    return "无法连接识图服务（无响应）。请确认与登录使用同一站点地址、HTTPS 与 API 协议一致；若已配置 Nginx 反代，请检查 client_max_body_size 与后端是否运行。";
  }
  return "识别失败，请检查网络与登录状态后重试。";
}

async function scrollChatToBottom() {
  await nextTick();
  const el = chatScrollRef.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

/**
 * 展示用户图片气泡 → 调用云端识图 → 展示助手气泡（失败时写原因）
 * @param meta 弹窗确认后的拍摄信息（时间/位置/类别），会置于助手回复开头
 */
async function addChatAndIdentify(dataUrl, source, imageTitle, meta) {
  if (!dataUrl || !dataUrl.startsWith("data:image")) {
    showFailToast("无效的图片数据");
    return false;
  }
  if (dataUrl.length > 14 * 1024 * 1024) {
    showFailToast("图片过大");
    return false;
  }
  if (!meta || typeof meta !== "object") {
    showFailToast("缺少拍摄信息");
    return false;
  }

  const userId = uid("im_user");
  const assistantId = uid("im_ai");
  chatMessages.value.push({
    id: userId,
    role: "user",
    image: dataUrl,
    createdAt: Date.now(),
  });
  chatMessages.value.push({
    id: assistantId,
    role: "assistant",
    text: "",
    pending: true,
    createdAt: Date.now(),
  });
  await scrollChatToBottom();

  const galleryLocalId = await savePhotoToGallery(dataUrl, source, { silent: true, skipRefresh: true, shotMeta: meta });
  if (!galleryLocalId) {
    patchAssistantMessage(
      assistantId,
      composeAssistantWithMeta(meta, "图片未能保存到图集（无效或过大），请重试。"),
      false
    );
    await refreshGallery();
    await scrollChatToBottom();
    return false;
  }

  if (!online.value) {
    patchAssistantMessage(
      assistantId,
      composeAssistantWithMeta(
        meta,
        "当前设备离线，已按您填写的信息记录。云端识图与简介分析需要联网，联网后可从图集中再次发起识别。"
      ),
      false
    );
    await persistGalleryIdentify(galleryLocalId, { status: "offline" });
    await refreshGallery();
    await scrollChatToBottom();
    return true;
  }

  if (!authStore.token?.trim()) {
    patchAssistantMessage(
      assistantId,
      composeAssistantWithMeta(
        meta,
        "当前未登录，无法调用云端识图。请先到登录页完成登录；照片已保存到图集。云端识图需要联网且需登录。"
      ),
      false
    );
    showFailToast("请先登录");
    await persistGalleryIdentify(galleryLocalId, { status: "no_login" });
    await refreshGallery();
    await scrollChatToBottom();
    return true;
  }

  try {
    const job = {
      local_id: uid("identify_job"),
      image_name: safeImageFileName(imageTitle),
      image_base64: stripDataUrl(dataUrl),
      scene_type: "general",
      result_json: [],
      created_at: new Date().toISOString(),
    };
    const { data } = await apiClient.post("/identify/sync", { jobs: [job] }, { timeout: IDENTIFY_SYNC_TIMEOUT_MS });
    const synced = (data.synced_items || [])[0];
    if (!synced) {
      patchAssistantMessage(assistantId, composeAssistantWithMeta(meta, "服务端未返回识别结果，请稍后重试。"), false);
      await persistGalleryIdentify(galleryLocalId, { status: "empty" });
    } else {
      patchAssistantMessage(assistantId, composeAssistantWithMeta(meta, formatIdentifyReply(synced)), false);
      await persistGalleryIdentify(galleryLocalId, {
        status: "success",
        synced: pickIdentifySnapshotForGallery(synced),
      });
    }
  } catch (err) {
    const msg = formatIdentifyApiError(err);
    patchAssistantMessage(assistantId, composeAssistantWithMeta(meta, msg), false);
    await persistGalleryIdentify(galleryLocalId, { status: "error", message: msg });
    const st = err?.response?.status;
    showFailToast(st === 401 ? "登录已失效，请重新登录" : "识图请求失败");
  }

  await refreshGallery();
  await scrollChatToBottom();
  return true;
}

async function refreshGallery() {
  galleryRaw.value = await getAllRecords(stores.identifyGallery);
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
      const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
}

/** @returns {Promise<string|null>} 成功返回 local_id，失败返回 null */
async function savePhotoToGallery(dataUrl, source, options = {}) {
  const { silent = false, skipRefresh = false, shotMeta = null } = options;
  if (!dataUrl || !dataUrl.startsWith("data:image")) {
    if (!silent) showFailToast("无效的图片数据");
    return null;
  }
  if (dataUrl.length > 14 * 1024 * 1024) {
    if (!silent) showFailToast("图片过大，未保存");
    return null;
  }
  const localId = uid("gal");
  const record = {
    local_id: localId,
    image_data: dataUrl,
    source,
      created_at: new Date().toISOString(),
  };
  if (shotMeta && typeof shotMeta === "object") {
    record.shot_meta = {
      datetimeLocal: shotMeta.datetimeLocal,
      shotTimeDisplay: shotMeta.shotTimeDisplay,
      lat: shotMeta.lat,
      lng: shotMeta.lng,
      locationLine: shotMeta.locationLine,
      category: shotMeta.category,
      categoryZh: shotMeta.categoryZh,
    };
  }
  await putRecord(stores.identifyGallery, record);
  if (!skipRefresh) {
    await refreshGallery();
  }
  if (!silent) {
    showSuccessToast("已保存到图集");
  }
  return localId;
}

async function captureViaGetUserMedia() {
  const nav = navigator.mediaDevices;
  if (!nav?.getUserMedia) return null;
  const stream = await nav.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false,
  });
  const video = document.createElement("video");
  video.setAttribute("playsinline", "true");
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
    for (let i = 0; i < 60; i += 1) {
      if (video.videoWidth > 0) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    if (!video.videoWidth) {
      throw new Error("no frame");
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}

async function triggerCamera() {
  if (cameraBusy.value) return;
  cameraBusy.value = true;
  try {
    const dataUrl = await captureViaGetUserMedia();
    if (dataUrl && dataUrl.startsWith("data:image")) {
      const meta = await openShotMetaDialog();
      if (!meta) return;
      await addChatAndIdentify(dataUrl, "camera", `拍摄_${Date.now()}.jpg`, meta);
      return;
    }
  } catch {
    /* 非安全上下文、用户拒绝、或不支持时走 file */
  } finally {
    cameraBusy.value = false;
  }
  cameraInput.value?.click();
}

async function processAlbumFileList(files) {
  let ok = 0;
  let eligible = 0;
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > 10 * 1024 * 1024) continue;
    eligible += 1;
    try {
      const dataUrl = await readAsDataURL(file);
      const meta = await openShotMetaDialog();
      if (!meta) continue;
      const done = await addChatAndIdentify(dataUrl, "album", file.name || "相册.jpg", meta);
      if (done) ok += 1;
    } catch {
      /* skip */
    }
  }
  await refreshGallery();
  if (!eligible && files.length) {
    showFailToast("没有可添加的图片");
  } else if (!ok && eligible) {
    showFailToast("未发起识图（已取消或处理失败）");
  } else if (ok > 1) {
    showSuccessToast(`已对 ${ok} 张发起识图`);
  }
}

async function triggerAlbum() {
  if (typeof window.showOpenFilePicker === "function") {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: "图片",
            accept: {
              "image/jpeg": [".jpg", ".jpeg"],
              "image/png": [".png"],
              "image/webp": [".webp"],
              "image/heic": [".heic"],
              "image/heif": [".heif"],
            },
          },
        ],
      });
      const files = [];
      for (const h of handles) {
        files.push(await h.getFile());
      }
      if (files.length) await processAlbumFileList(files);
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
    }
  }
  albumInput.value?.click();
}

function openGallery() {
  showGallery.value = true;
}

function closeGallery() {
  showGallery.value = false;
  closeGalleryPreview();
}

function openGalleryPreview(index) {
  const list = sortedGallery.value;
  if (!list.length) return;
  const i = Math.max(0, Math.min(index, list.length - 1));
  galleryPreviewIndex.value = i;
  showGalleryIdentifySheet.value = false;
  showGalleryPreview.value = true;
}

function closeGalleryIdentifySheet() {
  showGalleryIdentifySheet.value = false;
}

function openGalleryIdentifySheet() {
  showGalleryIdentifySheet.value = true;
}

function closeGalleryPreview() {
  showGalleryIdentifySheet.value = false;
  showGalleryPreview.value = false;
}

function galleryPreviewPrev() {
  if (galleryPreviewIndex.value > 0) {
    showGalleryIdentifySheet.value = false;
    galleryPreviewIndex.value -= 1;
  }
}

function galleryPreviewNext() {
  const max = sortedGallery.value.length - 1;
  if (galleryPreviewIndex.value < max) {
    showGalleryIdentifySheet.value = false;
    galleryPreviewIndex.value += 1;
  }
}

async function onCameraFile(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showFailToast("请选择图片文件");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showFailToast("图片不能超过 10MB");
    return;
  }
  try {
    const dataUrl = await readAsDataURL(file);
    const meta = await openShotMetaDialog();
    if (!meta) return;
    await addChatAndIdentify(dataUrl, "camera", file.name || "拍摄.jpg", meta);
  } catch {
    showFailToast("图片读取失败");
  }
}

async function onAlbumFiles(ev) {
  const files = Array.from(ev.target.files || []);
  ev.target.value = "";
  if (!files.length) return;
  await processAlbumFileList(files);
}

async function removeGalleryPhoto(row) {
  const ok = window.confirm("从图集中删除这张照片？");
  if (!ok) return;
  const list = sortedGallery.value;
  const delIdx = list.findIndex((x) => x.local_id === row.local_id);
  const viewingThis =
    showGalleryPreview.value && list[galleryPreviewIndex.value]?.local_id === row.local_id;
  await deleteRecord(stores.identifyGallery, row.local_id);
  await refreshGallery();
  if (viewingThis) {
    const next = sortedGallery.value;
    if (!next.length) {
      closeGalleryPreview();
    } else {
      galleryPreviewIndex.value = Math.min(delIdx, next.length - 1);
    }
  }
  showSuccessToast("已删除");
}

onMounted(async () => {
  await refreshGallery();
  window.addEventListener("online", () => networkStore.setNavigatorOnline(true));
  window.addEventListener("offline", () => networkStore.setNavigatorOnline(false));
});
</script>

<template>
  <div class="identify-page">
    <van-nav-bar title="AI识图" left-arrow @click-left="$router.back()">
      <template #right>
        <span class="nav-network-one" aria-live="polite">网络：{{ online ? "在线" : "离线" }}</span>
      </template>
    </van-nav-bar>

    <main ref="chatScrollRef" class="identify-main" aria-label="识图功能区">
      <div class="func-shell">
        <div class="chat-area">
          <template v-if="!chatMessages.length">
            <div class="chat-empty">
              <p class="chat-empty-title">识图对话</p>
              <p class="chat-empty-desc">
                使用下方「摄像头拍摄」或「从相册添加」。您的图片会以气泡显示在右侧，识别结果以气泡显示在左侧。图集可浏览已保存照片。
              </p>
            </div>
          </template>
          <template v-else>
            <div v-for="m in chatMessages" :key="m.id">
              <div v-if="m.role === 'user'" class="chat-row chat-row--user">
                <div class="bubble bubble--user-img">
                  <img class="chat-thumb" :src="m.image" alt="我发送的图片" />
                </div>
              </div>
              <div v-else class="chat-row chat-row--assistant">
                <div class="bubble bubble--assistant">
                  <span v-if="m.pending" class="bubble-pending">识别中…</span>
                  <pre v-else class="bubble-text">{{ m.text }}</pre>
                </div>
              </div>
            </div>
          </template>
        </div>

        <Transition name="gallery-fade">
          <div v-if="showGallery" class="gallery-overlay" role="dialog" aria-modal="true" aria-label="图集">
            <div class="gallery-toolbar">
              <button type="button" class="gallery-back" @click="closeGallery">返回</button>
              <span class="gallery-title">图集</span>
              <span class="gallery-spacer" />
            </div>
            <div class="gallery-body">
              <p v-if="!sortedGallery.length" class="gallery-empty">
                暂无照片，请使用下方「摄像头拍摄」或「从相册添加」保存到图集
              </p>
              <div v-else class="gallery-grid">
                <div
                  v-for="(item, idx) in sortedGallery"
                  :key="item.local_id"
                  class="gallery-cell"
                  role="button"
                  tabindex="0"
                  @click="openGalleryPreview(idx)"
                  @keydown.enter.prevent="openGalleryPreview(idx)"
                  @keydown.space.prevent="openGalleryPreview(idx)"
                >
                  <img class="gallery-img" :src="item.image_data" alt="图集照片" />
                  <button
                    type="button"
                    class="gallery-del"
                    aria-label="删除"
                    @click.stop="removeGalleryPhoto(item)"
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </main>

    <footer class="bottom-dock">
      <input
        ref="cameraInput"
        type="file"
        accept="image/*"
        capture="environment"
        class="hidden-input"
        @change="onCameraFile"
      />
      <input
        ref="albumInput"
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
        multiple
        class="hidden-input"
        @change="onAlbumFiles"
      />

      <button type="button" class="dock-btn dock-btn--side" @click="openGallery">图集</button>
      <button
        type="button"
        class="dock-btn dock-btn--camera"
        aria-label="摄像头拍摄"
        :disabled="cameraBusy"
        @click="triggerCamera"
      >
        <span class="dock-camera-line">摄像头</span>
        <span class="dock-camera-line">拍摄</span>
      </button>
      <button type="button" class="dock-btn dock-btn--side" @click="triggerAlbum">从相册添加</button>
    </footer>

    <van-popup
      v-model:show="showShotMetaPopup"
      position="bottom"
      round
      :style="{ maxHeight: '88vh' }"
      :close-on-click-overlay="false"
      class="shot-meta-popup-wrap"
      @closed="onShotMetaPopupClosed"
    >
      <div class="shot-meta-sheet">
        <p class="shot-meta-title">拍摄信息</p>
        <p class="shot-meta-hint">以下为本地填写，不消耗网络；点「确定」后才会保存图片并尝试云端识图。</p>

        <div class="shot-meta-block">
          <span class="shot-meta-label">拍摄时间</span>
          <input v-model="metaForm.datetimeLocal" class="shot-meta-datetime" type="datetime-local" />
          <van-button size="small" plain type="primary" block class="shot-meta-gap" @click="applyCurrentTimeToMeta">
            使用当前时间
          </van-button>
        </div>

        <div class="shot-meta-block">
          <span class="shot-meta-label">拍摄位置（GPS，WGS84）</span>
          <van-field v-model="metaForm.lng" label="经度" placeholder="可选" type="text" inputmode="decimal" />
          <van-field v-model="metaForm.lat" label="纬度" placeholder="可选" type="text" inputmode="decimal" />
          <van-button
            size="small"
            plain
            type="primary"
            block
            class="shot-meta-gap"
            :loading="metaLocationLoading"
            @click="fillCurrentLocation"
          >
            使用当前位置
          </van-button>
        </div>

        <div class="shot-meta-block">
          <span class="shot-meta-label">类别</span>
          <van-radio-group v-model="metaForm.category" direction="horizontal" class="shot-meta-cats">
            <van-radio name="plant">植物</van-radio>
            <van-radio name="animal">动物</van-radio>
            <van-radio name="other">其他</van-radio>
          </van-radio-group>
        </div>

        <div class="shot-meta-actions">
          <van-button block class="shot-meta-cancel" @click="cancelShotMeta">取消</van-button>
          <van-button block type="primary" @click="confirmShotMeta">确定</van-button>
        </div>
      </div>
    </van-popup>

    <Teleport to="body">
      <Transition name="gv-fade">
        <div
          v-if="showGalleryPreview"
          class="gallery-viewer-root"
          role="dialog"
          aria-modal="true"
          aria-label="图集大图预览"
        >
          <button type="button" class="gv-close" aria-label="关闭预览" @click="closeGalleryPreview">×</button>

          <header class="gv-header">
            <div class="gv-top-meta" aria-live="polite">
              <p class="gv-top-meta-line">拍摄时间：{{ galleryViewerMeta.time }}</p>
              <p class="gv-top-meta-line">拍摄位置：{{ galleryViewerMeta.location }}</p>
              <p class="gv-top-meta-line">类别：{{ galleryViewerMeta.category }}</p>
            </div>
          </header>

          <div class="gv-main">
            <div class="gv-stage">
              <div class="gv-aspect">
                <img
                  v-if="galleryPreviewItem"
                  class="gv-img"
                  :src="galleryPreviewItem.image_data"
                  alt="大图预览"
        />
      </div>
    </div>
          </div>

          <button
            type="button"
            class="gv-nav gv-nav--prev"
            aria-label="上一张"
            :disabled="galleryPreviewIndex <= 0 || showGalleryIdentifySheet"
            @click="galleryPreviewPrev"
          >
            ‹
          </button>
          <button
            type="button"
            class="gv-nav gv-nav--next"
            aria-label="下一张"
            :disabled="galleryPreviewIndex >= sortedGallery.length - 1 || showGalleryIdentifySheet"
            @click="galleryPreviewNext"
          >
            ›
          </button>
          <button
            type="button"
            class="gv-identify-trigger"
            :disabled="showGalleryIdentifySheet"
            @click="openGalleryIdentifySheet"
          >
            识图信息
          </button>

          <Transition name="gv-sheet-fade">
            <div
              v-if="showGalleryIdentifySheet"
              class="gv-identify-mask"
              role="presentation"
              @click="closeGalleryIdentifySheet"
            >
              <div class="gv-sheet-spacer" aria-hidden="true" />
              <div class="gv-identify-sheet" role="dialog" aria-modal="true" aria-label="识图信息" @click.stop>
                <p class="gv-sheet-close-hint">轻触上方空白处关闭</p>
                <div class="gv-identify-bubble gv-identify-bubble--sheet">
                  <pre class="gv-identify-text">{{ galleryViewerIdentifyText }}</pre>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.identify-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  max-height: 100vh;
  max-height: 100dvh;
  background: #f7f8fa;
  box-sizing: border-box;
  overflow: hidden;
}

.identify-page :deep(.van-nav-bar) {
  flex-shrink: 0;
}

.nav-network-one {
  font-size: 13px;
  font-weight: 500;
  color: #646566;
}

.identify-main {
  flex: 1 1 0%;
  height: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  background: #fff;
}

.func-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-height: 100%;
  background: #fff;
}

.chat-area {
  flex: 1 1 auto;
  box-sizing: border-box;
  padding: 12px 14px 20px;
  min-height: 100%;
}

.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: min(52vh, 360px);
  padding: 24px 12px;
  text-align: center;
}

.chat-empty-title {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 600;
  color: #323233;
}

.chat-empty-desc {
  margin: 0;
  max-width: 300px;
  font-size: 13px;
  color: #646566;
  line-height: 1.55;
}

.chat-row {
  display: flex;
  margin-bottom: 14px;
}

.chat-row--user {
  justify-content: flex-end;
}

.chat-row--assistant {
  justify-content: flex-start;
}

.bubble {
  box-sizing: border-box;
}

.bubble--user-img {
  max-width: 72%;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
  border: 1px solid #e8eaed;
  background: #fff;
}

.chat-thumb {
  display: block;
  max-width: 220px;
  width: 100%;
  height: auto;
  vertical-align: bottom;
}

.bubble--assistant {
  max-width: 88%;
  padding: 10px 14px;
  border-radius: 14px 14px 14px 4px;
  background: #f7f8fa;
  border: 1px solid #ebedf0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.bubble-text {
  margin: 0;
  font-size: 15px;
  line-height: 1.55;
  color: #323233;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.bubble-pending {
  font-size: 14px;
  color: #969799;
}

.gallery-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.gallery-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid #ebedf0;
  gap: 8px;
}

.gallery-back {
  border: none;
  background: #f2f3f5;
  color: #323233;
  font-size: 14px;
  padding: 6px 14px;
  border-radius: 8px;
  cursor: pointer;
}

.gallery-title {
  flex: 1;
  text-align: center;
  font-weight: 600;
  font-size: 16px;
  color: #323233;
}

.gallery-spacer {
  width: 64px;
}

.gallery-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 12px;
}

.gallery-empty {
  margin: 40px 16px 0;
  text-align: center;
  color: #969799;
  font-size: 14px;
  line-height: 1.6;
}

.gallery-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.gallery-cell {
  position: relative;
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  background: #f2f3f5;
  cursor: pointer;
}

.gallery-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.gallery-del {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}

.gallery-fade-enter-active,
.gallery-fade-leave-active {
  transition: opacity 0.18s ease;
}

.gallery-fade-enter-from,
.gallery-fade-leave-to {
  opacity: 0;
}

.bottom-dock {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
  background: #fff;
  border-top: 1px solid #ebedf0;
}

.hidden-input {
  display: none;
}

.dock-btn {
  border: none;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
}

.dock-btn--side {
  flex: 1;
  max-width: 120px;
  height: 44px;
  border-radius: 10px;
  background: #fff;
  color: #323233;
  border: 1px solid #dcdee0;
}

.dock-btn--camera {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  flex-shrink: 0;
  background: linear-gradient(145deg, #39a0ff, #1989fa);
  color: #fff;
  box-shadow: 0 4px 14px rgba(25, 137, 250, 0.35);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 6px 4px;
  gap: 0;
  line-height: 1.15;
}

.dock-btn--camera:disabled {
  opacity: 0.65;
  cursor: wait;
}

.dock-camera-line {
  font-size: 11px;
  font-weight: 700;
}

.shot-meta-popup-wrap :deep(.van-popup) {
  overflow-y: auto;
}

.shot-meta-sheet {
  padding: 16px 16px max(16px, env(safe-area-inset-bottom));
  box-sizing: border-box;
}

.shot-meta-title {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 600;
  color: #323233;
  text-align: center;
}

.shot-meta-hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: #969799;
  line-height: 1.5;
  text-align: center;
}

.shot-meta-block {
  margin-bottom: 14px;
}

.shot-meta-label {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 600;
  color: #323233;
}

.shot-meta-datetime {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  margin-bottom: 8px;
  font-size: 15px;
  border: 1px solid #ebedf0;
  border-radius: 8px;
  background: #f7f8fa;
  color: #323233;
}

.shot-meta-gap {
  margin-top: 4px;
}

.shot-meta-sheet :deep(.van-field) {
  padding: 8px 0;
  background: transparent;
}

.shot-meta-cats {
  margin-top: 4px;
  gap: 12px;
}

.shot-meta-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}

.shot-meta-cancel {
  flex: 1;
  border: 1px solid #dcdee0;
  color: #323233;
}

.shot-meta-actions .van-button--primary {
  flex: 1;
}

/* 图集大图预览：顶栏拍摄信息、中部原图（contain）、底部识图气泡（与对话区助手样式一致） */
.gallery-viewer-root {
  position: fixed;
  inset: 0;
  z-index: 10060;
  box-sizing: border-box;
  background: #000;
  display: flex;
  flex-direction: column;
  padding: 0 max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom))
    max(12px, env(safe-area-inset-left));
  padding-top: max(10px, env(safe-area-inset-top));
}

.gv-close {
  position: absolute;
  top: max(10px, env(safe-area-inset-top));
  right: max(12px, env(safe-area-inset-right));
  z-index: 3;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 26px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.2);
}

.gv-header {
  flex-shrink: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 52px 8px 4px;
  text-align: left;
}

.gv-top-meta {
  margin: 0;
}

.gv-top-meta-line {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.4;
  color: #d0d0d0;
  word-break: break-word;
}

.gv-top-meta-line:last-child {
  margin-bottom: 0;
}

/* 单行 grid：避免 .gv-stage 内仅绝对定位导致 flex 子项高度为 0；底栏按钮悬浮不占行 */
.gv-main {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  align-content: stretch;
  padding-bottom: 96px;
}

.gv-stage {
  min-height: 0;
  min-width: 0;
  position: relative;
  width: 100%;
  overflow: hidden;
}

.gv-aspect {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.gv-img {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  vertical-align: bottom;
}

.gv-identify-trigger {
  position: absolute;
  bottom: max(22px, env(safe-area-inset-bottom));
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  padding: 10px 22px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  background: rgba(32, 32, 32, 0.92);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
}

.gv-identify-trigger:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 识图信息：遮罩 + 底栏页，盖住左右箭头与中间按钮；点上方半透明区关闭 */
.gv-identify-mask {
  position: fixed;
  inset: 0;
  z-index: 10070;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.52);
}

.gv-sheet-spacer {
  flex: 1 1 auto;
  min-height: 48px;
}

.gv-identify-sheet {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  max-height: min(82vh, 720px);
  min-height: min(32vh, 280px);
  padding: 8px 0 0;
  border-radius: 16px 16px 0 0;
  background: #fff;
  box-shadow: 0 -6px 28px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.gv-sheet-close-hint {
  margin: 0 16px 8px;
  font-size: 12px;
  color: #969799;
  text-align: center;
}

/* 与识图页 .bubble--assistant 一致；在底栏页内可滚动 */
.gv-identify-bubble {
  margin: 0 12px max(12px, env(safe-area-inset-bottom));
  padding: 10px 14px;
  border-radius: 14px 14px 14px 4px;
  background: #f7f8fa;
  border: 1px solid #ebedf0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.gv-identify-bubble--sheet {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.gv-identify-text {
  margin: 0;
  font-size: 15px;
  line-height: 1.55;
  color: #323233;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.gv-sheet-fade-enter-active,
.gv-sheet-fade-leave-active {
  transition: opacity 0.2s ease;
}

.gv-sheet-fade-enter-from,
.gv-sheet-fade-leave-to {
  opacity: 0;
}

.gv-nav {
  position: absolute;
  bottom: max(20px, env(safe-area-inset-bottom));
  z-index: 2;
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 50%;
  background: #1989fa;
  color: #fff;
  font-size: 28px;
  line-height: 1;
  font-weight: 300;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}

.gv-nav:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.gv-nav--prev {
  left: max(16px, env(safe-area-inset-left));
}

.gv-nav--next {
  right: max(16px, env(safe-area-inset-right));
}

.gv-fade-enter-active,
.gv-fade-leave-active {
  transition: opacity 0.2s ease;
}

.gv-fade-enter-from,
.gv-fade-leave-to {
  opacity: 0;
}
</style>
