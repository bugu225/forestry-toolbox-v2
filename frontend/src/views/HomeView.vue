<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { showToast } from "vant";
import { useAuthStore } from "../stores/auth";
import { useNetworkStore } from "../stores/network";

const PWA_TIP_DISMISS_KEY = "ftb2_home_pwa_tip_dismissed";

const authStore = useAuthStore();
const networkStore = useNetworkStore();
const { simulateOffline, effectiveOnline } = storeToRefs(networkStore);
const router = useRouter();

/** 默认收起「其他」区块 */
const moreActive = ref([]);

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

function requestLocationPermission() {
  if (!navigator.geolocation) {
    showToast({ message: "当前设备不支持定位能力", position: "middle" });
    return;
  }
  if (window.isSecureContext === false) {
    showToast({
      message: "当前不是安全访问（需 https），无法使用定位。请用 https 打开，或在开发时用本机调试地址。",
      position: "middle",
    });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    () => {
      showToast({ message: "定位权限已可用", position: "middle" });
    },
    (error) => {
      const code = Number(error?.code || 0);
      if (code === 1) {
        showToast({ message: "您已拒绝定位，请到系统设置或本应用权限里开启定位。", position: "middle" });
        return;
      }
      if (code === 2) {
        showToast({ message: "定位不可用，请检查手机定位服务（GPS）是否开启。", position: "middle" });
        return;
      }
      if (code === 3) {
        showToast({ message: "定位请求超时，请重试。", position: "middle" });
        return;
      }
      showToast({ message: "定位权限申请失败，请稍后重试。", position: "middle" });
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

onMounted(() => {
  try {
    pwaTipDismissed.value = localStorage.getItem(PWA_TIP_DISMISS_KEY) === "1";
  } catch {
    pwaTipDismissed.value = false;
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
          <van-button v-if="!canNativeInstall" type="default" size="small" round plain @click="dismissPwaTip">
            我知道了
          </van-button>
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
            <van-button type="primary" plain block @click="requestLocationPermission">申请定位权限</van-button>
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
