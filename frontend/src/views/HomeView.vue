<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { showDialog, showToast } from "vant";
import { describeGeoError, getCurrentPositionCompat } from "../utils/geolocation";
import { useAuthStore } from "../stores/auth";
import { useNetworkStore } from "../stores/network";

const PWA_TIP_DISMISS_KEY = "ftb2_home_pwa_tip_dismissed";
const PATROL_USE_AMAP_IP_KEY = "ftb2_patrol_use_amap_ip";

const authStore = useAuthStore();
const networkStore = useNetworkStore();
const { simulateOffline, effectiveOnline } = storeToRefs(networkStore);
const router = useRouter();

/** 默认收起「其他」区块 */
const moreActive = ref([]);
const useAmapIpForPatrol = ref(false);

const username = computed(() => authStore.user?.username || "用户");

const networkHint = computed(() => {
  if (simulateOffline.value) {
    return "模拟断网中（本应用内视为离线，用于测试）";
  }
  return effectiveOnline.value ? "当前网络：在线" : "当前网络：离线";
});

/** 是否已以「应用 / 主屏幕」方式打开（含 iOS 主屏幕图标启动） */
const isStandaloneDisplay = computed(() => {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
    if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
  } catch {
    /* ignore */
  }
  if (typeof navigator !== "undefined" && navigator.standalone === true) return true;
  return false;
});

const pwaTipDismissed = ref(false);
/** Chromium：可弹出系统「安装」对话框 */
const canNativeInstall = ref(false);
let deferredInstallPrompt = null;
let beforeInstallHandler = null;
let appInstalledHandler = null;

const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
const isIOS =
  /iPhone|iPad|iPod/i.test(ua) ||
  (typeof navigator !== "undefined" &&
    navigator.platform === "MacIntel" &&
    Number(navigator.maxTouchPoints) > 1);
const isAndroid = /Android/i.test(ua);

/** 百度系内置浏览器通常不触发 beforeinstallprompt，需走菜单手动添加 */
const isBaiduBrowser = computed(() => {
  const u = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  return /baidubrowser|baiduboxapp|bdbrowser/i.test(u);
});

/** 仅在手机端展示「添加到主屏幕」提示 */
const isPhoneBrowsing = computed(() => {
  if (typeof navigator === "undefined") return false;
  const u = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android|Mobile|webOS|BlackBerry|Opera Mini|IEMobile|HarmonyOS/i.test(u)) return true;
  if (navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints) > 1) return true;
  return false;
});

/** 模板中不宜直接写 window，用计算属性避免构建/SSR 告警 */
const showInsecureContextHint = computed(() => {
  if (typeof window === "undefined") return false;
  if (window.isSecureContext) return false;
  const host = window.location?.hostname || "";
  return host !== "localhost" && host !== "127.0.0.1";
});

const showPwaTip = computed(() => {
  if (!isPhoneBrowsing.value) return false;
  if (isStandaloneDisplay.value) return false;
  if (pwaTipDismissed.value) return false;
  return true;
});

const pwaHintBody = computed(() => {
  if (isBaiduBrowser.value) {
    return "百度手机浏览器通常不会出现系统级「安装」弹窗。请点击下方「查看添加桌面步骤」，或打开浏览器菜单查找「添加到桌面」「桌面快捷方式」等选项（不同版本文案略有差异）。";
  }
  if (isIOS) {
    return "点 Safari 底栏「分享」图标，选择「添加到主屏幕」并确认。从主屏幕图标打开时，离线缓存与全屏体验更好。";
  }
  if (isAndroid) {
    return canNativeInstall.value
      ? "点击下方按钮可将本应用添加到手机桌面，打开后更接近原生应用，离线访问更稳定。"
      : "点自带浏览器菜单（⋮，多在右上或底栏），选「添加到主屏幕」或「安装应用」。从主屏幕图标打开，离线用问答、识图、巡护更顺畅。";
  }
  return "点自带浏览器菜单（⋮），选「添加到主屏幕」或「安装应用」，固定到手机桌面，便于离线使用。";
});

function showAddToHomeInstructions() {
  let message = "";
  if (isBaiduBrowser.value) {
    message = [
      "1. 点击浏览器底栏「菜单」或「≡」。",
      "2. 查找「收藏网址」「添加书签到桌面」「桌面快捷方式」「添加卡片」等（不同版本名称不同）。",
      "3. 若找不到，可尝试菜单里的「工具箱」或「更多工具」中是否有「添加到主屏幕」。",
      "4. 仍无法添加时，建议用 Chrome、Edge 或系统自带浏览器打开本站后再试。",
    ].join("\n");
  } else if (isIOS) {
    message =
      "在 Safari 中：点底栏「分享」↑ 按钮 → 下滑找到「添加到主屏幕」→ 编辑名称后点「添加」。从主屏幕图标打开可获得更接近全屏的体验。";
  } else if (isAndroid) {
    message = [
      "1. 点浏览器右上角或底栏「菜单」（⋮）。",
      "2. 选择「添加到主屏幕」「安装应用」或「添加快捷方式」。",
      "3. 若无此选项，多为厂商定制浏览器限制，可换 Chrome / 系统浏览器打开本站。",
    ].join("\n");
  } else {
    message = "请使用浏览器菜单中的「添加到主屏幕」或「安装」功能，将本站固定到桌面。";
  }
  showDialog({
    title: "添加到手机桌面",
    message,
    confirmButtonText: "知道了",
    messageAlign: "left",
  });
}

function dismissPwaTip() {
  pwaTipDismissed.value = true;
  try {
    localStorage.setItem(PWA_TIP_DISMISS_KEY, "1");
  } catch {
    /* ignore */
  }
}

async function onNativeInstallClick() {
  if (!deferredInstallPrompt) {
    showToast({ message: "请点菜单（⋮）选择「安装」或「添加到主屏幕」", position: "middle" });
    return;
  }
  try {
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    canNativeInstall.value = false;
    if (choice?.outcome === "accepted") {
      showToast({ message: "已开始安装，请按系统提示完成", position: "middle" });
      dismissPwaTip();
    }
  } catch {
    showToast({ message: "安装流程被中断，可稍后在菜单中重试", position: "middle" });
  }
}

function goQa() {
  router.push({ name: "qa" });
}

function goIdentify() {
  router.push({ name: "identify" });
}

function goPatrol() {
  router.push({ name: "patrol" });
}

function logout() {
  authStore.clearAuth();
  router.push({ name: "login" });
}

function onSimulateOfflineChange(checked) {
  networkStore.setSimulateOffline(checked);
  showToast({
    message: checked ? "已开启模拟断网" : "已恢复为真实网络状态",
    position: "bottom",
  });
}

function onUseAmapIpForPatrolChange(checked) {
  useAmapIpForPatrol.value = checked;
  try {
    localStorage.setItem(PATROL_USE_AMAP_IP_KEY, checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  showToast({
    message: checked ? "已开启：巡护改用高德 IP 粗定位" : "已关闭：巡护恢复使用 GPS",
    position: "bottom",
  });
}

function requestLocationPermission() {
  if (!navigator.geolocation) {
    showToast({ message: "当前设备不支持定位能力", position: "middle" });
    return;
  }
  getCurrentPositionCompat()
    .then(() => {
      showToast({
        message: "已获取到位置（GPS 或网络定位），巡护与拍摄可自动填经纬度。",
        position: "middle",
      });
    })
    .catch((error) => {
      showToast({ message: describeGeoError(error, "定位申请失败，请稍后重试"), position: "middle" });
    });
}

async function showLocationDiagnostics() {
  const lines = [];
  const secure = typeof window !== "undefined" ? Boolean(window.isSecureContext) : false;
  const onlineState = effectiveOnline.value ? "在线" : "离线";
  const hasGeo = typeof navigator !== "undefined" && Boolean(navigator.geolocation);
  const uaText = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
  const isChrome = /Chrome\/\d+/i.test(uaText);
  const isAndroidChrome = isChrome && /Android/i.test(uaText);

  lines.push(`网络状态：${onlineState}`);
  lines.push(`安全上下文（HTTPS）：${secure ? "是" : "否"}`);
  lines.push(`浏览器定位能力：${hasGeo ? "支持" : "不支持"}`);
  lines.push(`浏览器识别：${isAndroidChrome ? "Android Chrome" : isChrome ? "Chrome 系" : "其他"}`);

  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: "geolocation" });
      lines.push(`定位权限状态：${status?.state || "unknown"}`);
    } catch {
      lines.push("定位权限状态：浏览器不返回（正常）");
    }
  } else {
    lines.push("定位权限状态：当前浏览器不支持 Permissions API");
  }

  if (!hasGeo) {
    lines.push("实时定位测试：失败（浏览器不支持 geolocation）");
  } else {
    try {
      const pos = await getCurrentPositionCompat();
      const lat = Number(pos?.coords?.latitude);
      const lng = Number(pos?.coords?.longitude);
      const acc = Number(pos?.coords?.accuracy);
      lines.push(
        `实时定位测试：成功（经度 ${Number.isFinite(lng) ? lng.toFixed(5) : "—"}，纬度 ${
          Number.isFinite(lat) ? lat.toFixed(5) : "—"
        }，精度约 ${Number.isFinite(acc) ? Math.round(acc) : "—"}m）`
      );
    } catch (error) {
      lines.push(`实时定位测试：失败（${describeGeoError(error, "未知错误")}）`);
    }
  }

  lines.push("");
  lines.push("建议：");
  lines.push("1. 手机系统里开启“高精度定位（GPS+WLAN+移动网络）”；");
  lines.push("2. 关闭省电模式，给 Chrome 允许“位置信息”权限；");
  lines.push("3. 首次定位尽量在室外或窗边等待 10-20 秒；");
  lines.push("4. 若仍失败，可在首页「其他」开启“高德 IP 顶替 GPS”（城市级粗定位）。");

  showDialog({
    title: "定位诊断",
    message: lines.join("\n"),
    confirmButtonText: "我知道了",
    messageAlign: "left",
  });
}

onMounted(() => {
  try {
    pwaTipDismissed.value = localStorage.getItem(PWA_TIP_DISMISS_KEY) === "1";
    useAmapIpForPatrol.value = localStorage.getItem(PATROL_USE_AMAP_IP_KEY) === "1";
  } catch {
    pwaTipDismissed.value = false;
    useAmapIpForPatrol.value = false;
  }

  beforeInstallHandler = (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    canNativeInstall.value = true;
  };
  window.addEventListener("beforeinstallprompt", beforeInstallHandler);
  appInstalledHandler = () => {
    deferredInstallPrompt = null;
    canNativeInstall.value = false;
    dismissPwaTip();
  };
  window.addEventListener("appinstalled", appInstalledHandler);
});

onUnmounted(() => {
  if (beforeInstallHandler) {
    window.removeEventListener("beforeinstallprompt", beforeInstallHandler);
  }
  if (appInstalledHandler) {
    window.removeEventListener("appinstalled", appInstalledHandler);
  }
});
</script>

<template>
  <div class="page">
    <van-nav-bar title="首页" />

    <div class="home-main">
      <p class="welcome">你好，{{ username }}</p>

      <div v-if="showPwaTip" class="pwa-card" role="region" aria-label="添加到主屏幕提示">
        <div class="pwa-card-head">
          <span class="pwa-card-title">添加到手机桌面</span>
          <button type="button" class="pwa-card-close" aria-label="关闭提示" @click="dismissPwaTip">×</button>
        </div>
        <p class="pwa-card-desc">{{ pwaHintBody }}</p>
        <p v-if="showInsecureContextHint" class="pwa-card-warn">
          当前非 HTTPS，部分机型无法添加到桌面；正式使用请用 https 打开本页。
        </p>
        <div class="pwa-card-actions">
          <van-button
            v-if="canNativeInstall"
            type="primary"
            size="small"
            round
            class="pwa-install-btn"
            @click="onNativeInstallClick"
          >
            一键添加到桌面
          </van-button>
          <van-button type="primary" size="small" round plain class="pwa-install-btn" @click="showAddToHomeInstructions">
            查看添加桌面步骤
          </van-button>
          <van-button type="default" size="small" round plain @click="dismissPwaTip">我知道了</van-button>
        </div>
      </div>

      <div class="entry-cards" role="navigation" aria-label="功能入口">
        <button type="button" class="entry-card entry-card--qa" @click="goQa">
          <span class="entry-card-title">林业知识问答</span>
          <span class="entry-card-desc">AI 问答与知识检索</span>
        </button>
        <button type="button" class="entry-card entry-card--id" @click="goIdentify">
          <span class="entry-card-title">林业识图</span>
          <span class="entry-card-desc">图集、拍照与相册</span>
        </button>
        <button type="button" class="entry-card entry-card--patrol" @click="goPatrol">
          <span class="entry-card-title">巡护助手</span>
          <span class="entry-card-desc">轨迹与异常上报</span>
        </button>
      </div>

      <van-collapse v-model="moreActive" :border="false" class="more-collapse">
        <van-collapse-item title="其他、等等" name="more" class="more-item">
          <div class="more-inner">
            <p class="more-line muted">{{ networkHint }}</p>
            <van-cell center title="断网测试" label="开启后在本应用内模拟离线，不影响系统其它应用">
              <template #right-icon>
                <van-switch
                  :model-value="simulateOffline"
                  size="20px"
                  @update:model-value="onSimulateOfflineChange"
                />
              </template>
            </van-cell>
            <van-cell center title="高德 IP 顶替 GPS" label="开启后巡护轨迹采样与事件定位改为高德 IP 粗定位（城市级）">
              <template #right-icon>
                <van-switch
                  :model-value="useAmapIpForPatrol"
                  size="20px"
                  @update:model-value="onUseAmapIpForPatrolChange"
                />
              </template>
            </van-cell>
            <van-button type="primary" plain block @click="requestLocationPermission">申请定位权限</van-button>
            <van-button type="default" plain block @click="showLocationDiagnostics">定位诊断</van-button>
            <van-button class="more-logout" type="danger" block round @click="logout">退出登录</van-button>
          </div>
        </van-collapse-item>
      </van-collapse>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100dvh;
  padding-bottom: env(safe-area-inset-bottom, 0);
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

.pwa-card {
  background: linear-gradient(145deg, #e8f4ff 0%, #f0f9ff 100%);
  border: 1px solid #b3d8ff;
  border-radius: 12px;
  padding: 14px 14px 12px;
  box-shadow: 0 2px 10px rgba(25, 137, 250, 0.08);
}

.pwa-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.pwa-card-title {
  font-size: 15px;
  font-weight: 600;
  color: #1989fa;
}

.pwa-card-close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  color: #646566;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pwa-card-close:active {
  opacity: 0.75;
}

.pwa-card-desc {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.55;
  color: #323233;
}

.pwa-card-warn {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.45;
  color: #ed6a0c;
}

.pwa-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.pwa-install-btn {
  min-width: 132px;
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
  line-height: 1.5;
}

.more-line.muted {
  color: #969799;
  font-size: 12px;
}

.more-inner :deep(.van-cell) {
  padding-left: 0;
  padding-right: 0;
}

.more-logout {
  margin-top: 4px;
}
</style>
