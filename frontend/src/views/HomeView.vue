<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { showDialog, showToast } from "vant";
import { storeToRefs } from "pinia";
import { describeGeoError, getCurrentPositionCompat } from "../utils/geolocation";
import apiClient from "../api/client";
import { useNetworkStore } from "../stores/network";

const PWA_TIP_DISMISS_KEY = "ftb2_home_pwa_tip_dismissed"
const networkStore = useNetworkStore();
const { simulateOffline, effectiveOnline } = storeToRefs(networkStore);
const router = useRouter();

const moreActive = ref([]);

const networkHint = computed(() => {
  if (simulateOffline.value) {
    return "\u6a21\u62df\u65ad\u7f51\u4e2d\uff08\u672c\u5e94\u7528\u5185\u89c6\u4e3a\u79bb\u7ebf\uff0c\u7528\u4e8e\u6d4b\u8bd5\uff09";
  }
  return effectiveOnline.value ? "\u5f53\u524d\u7f51\u7edc\uff1a\u5728\u7ebf" : "\u5f53\u524d\u7f51\u7edc\uff1a\u79bb\u7ebf";
});

const isStandaloneDisplay = computed(() => {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
    if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
  } catch {}
  if (typeof navigator !== "undefined" && navigator.standalone === true) return true;
  return false;
});

const pwaTipDismissed = ref(false);
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

const isBaiduBrowser = computed(() => {
  const u = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  return /baidubrowser|baiduboxapp|bdbrowser/i.test(u);
});

const isPhoneBrowsing = computed(() => {
  if (typeof navigator === "undefined") return false;
  const u = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android|Mobile|webOS|BlackBerry|Opera Mini|IEMobile|HarmonyOS/i.test(u)) return true;
  if (navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints) > 1) return true;
  return false;
});

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
    return "\u767e\u5ea6\u624b\u673a\u6d4f\u89c8\u5668\u901a\u5e38\u4e0d\u4f1a\u51fa\u73b0\u7cfb\u7edf\u7ea7\u300c\u5b89\u88c5\u300d\u5f39\u7a97\u3002\u8bf7\u70b9\u51fb\u4e0b\u65b9\u300c\u67e5\u770b\u6dfb\u52a0\u684c\u9762\u6b65\u9aa4\u300d\uff0c\u6216\u6253\u5f00\u6d4f\u89c8\u5668\u83dc\u5355\u67e5\u627e\u300c\u6dfb\u52a0\u5230\u684c\u9762\u300d\u300c\u684c\u9762\u5feb\u6377\u65b9\u5f0f\u300d\u7b49\u9009\u9879\uff08\u4e0d\u540c\u7248\u672c\u6587\u6848\u7565\u6709\u5dee\u5f02\uff09\u3002";
  }
  if (isIOS) {
    return "\u70b9 Safari \u5e95\u680f\u300c\u5206\u4eab\u300d\u56fe\u6807\uff0c\u9009\u62e9\u300c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u300d\u5e76\u786e\u8ba4\u3002\u4ece\u4e3b\u5c4f\u5e55\u56fe\u6807\u6253\u5f00\u65f6\uff0c\u79bb\u7ebf\u7f13\u5b58\u4e0e\u5168\u5c4f\u4f53\u9a8c\u66f4\u597d\u3002";
  }
  if (isAndroid) {
    return canNativeInstall.value
      ? "\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u53ef\u5c06\u672c\u5e94\u7528\u6dfb\u52a0\u5230\u624b\u673a\u684c\u9762\uff0c\u6253\u5f00\u540e\u66f4\u63a5\u8fd1\u539f\u751f\u5e94\u7528\uff0c\u79bb\u7ebf\u8bbf\u95ee\u66f4\u7a33\u5b9a\u3002"
      : "\u70b9\u81ea\u5e26\u6d4f\u89c8\u5668\u83dc\u5355\uff08\u22ee\uff0c\u591a\u5728\u53f3\u4e0a\u6216\u5e95\u680f\uff09\uff0c\u9009\u300c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u300d\u6216\u300c\u5b89\u88c5\u5e94\u7528\u300d\u3002\u4ece\u4e3b\u5c4f\u5e55\u56fe\u6807\u6253\u5f00\uff0c\u79bb\u7ebf\u7528\u95ee\u7b54\u3001\u8bc6\u56fe\u3001\u5de1\u62a4\u66f4\u987a\u7545\u3002";
  }
  return "\u70b9\u81ea\u5e26\u6d4f\u89c8\u5668\u83dc\u5355\uff08\u22ee\uff09\uff0c\u9009\u300c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u300d\u6216\u300c\u5b89\u88c5\u5e94\u7528\u300d\uff0c\u56fa\u5b9a\u5230\u624b\u673a\u684c\u9762\uff0c\u4fbf\u4e8e\u79bb\u7ebf\u4f7f\u7528\u3002";
});

function showAddToHomeInstructions() {
  let message = "";
  if (isBaiduBrowser.value) {
    message = [
      "1. \u70b9\u51fb\u6d4f\u89c8\u5668\u5e95\u680f\u300c\u83dc\u5355\u300d\u6216\u300c\u2261\u300d\u3002",
      "2. \u67e5\u627e\u300c\u6536\u85cf\u7f51\u5740\u300d\u300c\u6dfb\u52a0\u4e66\u7b7e\u5230\u684c\u9762\u300d\u300c\u684c\u9762\u5feb\u6377\u65b9\u5f0f\u300d\u300c\u6dfb\u52a0\u5361\u7247\u300d\u7b49\uff08\u4e0d\u540c\u7248\u672c\u540d\u79f0\u4e0d\u540c\uff09\u3002",
      "3. \u82e5\u627e\u4e0d\u5230\uff0c\u53ef\u5c1d\u8bd5\u83dc\u5355\u91cc\u7684\u300c\u5de5\u5177\u7bb1\u300d\u6216\u300c\u66f4\u591a\u5de5\u5177\u300d\u4e2d\u662f\u5426\u6709\u300c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u300d\u3002",
      "4. \u4ecd\u65e0\u6cd5\u6dfb\u52a0\u65f6\uff0c\u5efa\u8bae\u7528 Chrome\u3001Edge \u6216\u7cfb\u7edf\u81ea\u5e26\u6d4f\u89c8\u5668\u6253\u5f00\u672c\u7ad9\u540e\u518d\u8bd5\u3002",
    ].join("\n");
  } else if (isIOS) {
    message =
      "\u5728 Safari \u4e2d\uff1a\u70b9\u5e95\u680f\u300c\u5206\u4eab\u300d\u2191 \u6309\u94ae \u2192 \u4e0b\u6ed1\u627e\u5230\u300c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u300d\u2192 \u7f16\u8f91\u540d\u79f0\u540e\u70b9\u300c\u6dfb\u52a0\u300d\u3002\u4ece\u4e3b\u5c4f\u5e55\u56fe\u6807\u6253\u5f00\u53ef\u83b7\u5f97\u66f4\u63a5\u8fd1\u5168\u5c4f\u7684\u4f53\u9a8c\u3002";
  } else if (isAndroid) {
    message = [
      "1. \u70b9\u6d4f\u89c8\u5668\u53f3\u4e0a\u89d2\u6216\u5e95\u680f\u300c\u83dc\u5355\u300d\uff08\u22ee\uff09\u3002",
      "2. \u9009\u62e9\u300c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u300d\u300c\u5b89\u88c5\u5e94\u7528\u300d\u6216\u300c\u6dfb\u52a0\u5feb\u6377\u65b9\u5f0f\u300d\u3002",
      "3. \u82e5\u65e0\u6b64\u9009\u9879\uff0c\u591a\u4e3a\u5382\u5546\u5b9a\u5236\u6d4f\u89c8\u5668\u9650\u5236\uff0c\u53ef\u6362 Chrome / \u7cfb\u7edf\u6d4f\u89c8\u5668\u6253\u5f00\u672c\u7ad9\u3002",
    ].join("\n");
  } else {
    message = "\u8bf7\u4f7f\u7528\u6d4f\u89c8\u5668\u83dc\u5355\u4e2d\u7684\u300c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u300d\u6216\u300c\u5b89\u88c5\u300d\u529f\u80fd\uff0c\u5c06\u672c\u7ad9\u56fa\u5b9a\u5230\u684c\u9762\u3002";
  }
  showDialog({
    title: "\u6dfb\u52a0\u5230\u624b\u673a\u684c\u9762",
    message,
    confirmButtonText: "\u77e5\u9053\u4e86",
    messageAlign: "left",
  });
}

function dismissPwaTip() {
  pwaTipDismissed.value = true;
  try {
    localStorage.setItem(PWA_TIP_DISMISS_KEY, "1");
  } catch {}
}

async function onNativeInstallClick() {
  if (!deferredInstallPrompt) {
    showToast({ message: "\u8bf7\u70b9\u83dc\u5355\uff08\u22ee\uff09\u9009\u62e9\u300c\u5b89\u88c5\u300d\u6216\u300c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u300d", position: "middle" });
    return;
  }
  try {
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    canNativeInstall.value = false;
    if (choice?.outcome === "accepted") {
      showToast({ message: "\u5df2\u5f00\u59cb\u5b89\u88c5\uff0c\u8bf7\u6309\u7cfb\u7edf\u63d0\u793a\u5b8c\u6210", position: "middle" });
      dismissPwaTip();
    }
  } catch {
    showToast({ message: "\u5b89\u88c5\u6d41\u7a0b\u88ab\u4e2d\u65ad\uff0c\u53ef\u7a0d\u540e\u5728\u83dc\u5355\u4e2d\u91cd\u8bd5", position: "middle" });
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

function onSimulateOfflineChange(checked) {
  networkStore.setSimulateOffline(checked);
  showToast({
    message: checked ? "\u5df2\u5f00\u542f\u6a21\u62df\u65ad\u7f51" : "\u5df2\u6062\u590d\u4e3a\u771f\u5b9e\u7f51\u7edc\u72b6\u6001",
    position: "bottom",
  });
}

function normalizeCheck(ok, detail) {
  return (ok ? "\u2705 " : "\u274c ") + detail;
}

async function runAllInOneDiagnostics() {
  const lines = [];

  lines.push("\u7f51\u7edc\u8fde\u63a5\uff1a" + (effectiveOnline.value ? "\u6b63\u5e38" : "\u5df2\u65ad\u5f00"));

  let geoPermFriendly = "\u672a\u6388\u6743";
  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: "geolocation" });
      const map = { granted: "\u5df2\u6388\u6743", denied: "\u5df2\u62d2\u7edd", prompt: "\u5f85\u8be2\u95ee" };
      geoPermFriendly = map[status?.state] || "\u672a\u77e5";
    } catch {}
  }
  lines.push("\u4f4d\u7f6e\u6743\u9650\uff1a" + geoPermFriendly);

  let camPermFriendly = "\u672a\u6388\u6743";
  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: "camera" });
      const map = { granted: "\u5df2\u6388\u6743", denied: "\u5df2\u62d2\u7edd", prompt: "\u5f85\u8be2\u95ee" };
      camPermFriendly = map[status?.state] || "\u672a\u77e5";
    } catch {}
  }
  lines.push("\u76f8\u673a\u6743\u9650\uff1a" + camPermFriendly);

  const hasGeo = typeof navigator !== "undefined" && Boolean(navigator.geolocation);
  if (hasGeo) {
    try {
      const pos = await getCurrentPositionCompat();
      const acc = Number(pos?.coords?.accuracy || 0);
      const accText = Number.isFinite(acc) ? "\uff08\u7cbe\u5ea6\u7ea6 " + Math.round(acc) + " \u7c73\uff09" : "";
      lines.push(normalizeCheck(true, "\u5b9a\u4f4d\u529f\u80fd\u6b63\u5e38" + accText));
    } catch (error) {
      lines.push(normalizeCheck(false, "\u5b9a\u4f4d\u5931\u8d25\uff1a" + describeGeoError(error, "\u8bf7\u68c0\u67e5\u624b\u673a\u5b9a\u4f4d\u5f00\u5173\u548c\u6d4f\u89c8\u5668\u4f4d\u7f6e\u6743\u9650")));
    }
  } else {
    lines.push(normalizeCheck(false, "\u5b9a\u4f4d\u4e0d\u53ef\u7528\uff1a\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u4f4d\u7f6e\u670d\u52a1"));
  }

  const hasCameraApi = Boolean(navigator.mediaDevices?.getUserMedia);
  if (hasCameraApi) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const t of stream.getTracks()) t.stop();
      lines.push(normalizeCheck(true, "\u62cd\u7167\u529f\u80fd\u6b63\u5e38"));
    } catch (error) {
      const hint = error?.name === "NotAllowedError" ? "\u76f8\u673a\u6743\u9650\u88ab\u62d2\u7edd" : (error?.name || "\u672a\u77e5\u9519\u8bef");
      lines.push(normalizeCheck(false, "\u62cd\u7167\u4e0d\u53ef\u7528\uff1a" + hint));
    }
  } else {
    lines.push(normalizeCheck(false, "\u62cd\u7167\u4e0d\u53ef\u7528\uff1a\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u76f8\u673a"));
  }

  lines.push("");
  lines.push("\u670d\u52a1\u8fde\u63a5\uff1a");
  const apiChecks = [
    { label: "\u77e5\u8bc6\u95ee\u7b54", run: () => apiClient.get("/qa/sessions", { timeout: 10000 }) },
    { label: "\u6797\u4e1a\u8bc6\u56fe", run: () => apiClient.post("/identify/sync", { jobs: [] }, { timeout: 10000 }) },
  ];
  for (const { label, run } of apiChecks) {
    try {
      await run();
      lines.push(normalizeCheck(true, label));
    } catch (error) {
      const code = Number(error?.response?.status || error?.status || 0);
      const hint = code === 401 ? "\u9700\u91cd\u65b0\u767b\u5f55" : code ? "\u5f02\u5e38(" + code + ")" : "\u7f51\u7edc\u4e0d\u901a";
      lines.push(normalizeCheck(false, label + "\uff1a" + hint));
    }
  }

  lines.push("");
  lines.push("\u5982\u67d0\u9879\u68c0\u6d4b\u672a\u901a\u8fc7\uff0c\u53ef\u5c1d\u8bd5\uff1a");
  lines.push("1. \u5728\u624b\u673a\u300c\u8bbe\u7f6e\u300d\u4e2d\u5f00\u542f\u672c\u5e94\u7528\u7684\u5b9a\u4f4d\u548c\u76f8\u673a\u6743\u9650\uff1b");
  lines.push("2. \u68c0\u67e5\u624b\u673a\u7f51\u7edc\uff0c\u5207\u6362\u5230\u7a33\u5b9a\u7684 WiFi \u6216\u79fb\u52a8\u6570\u636e\uff1b");
  lines.push("3. \u53ef\u5c1d\u8bd5\u5207\u6362 WiFi \u6216\u79fb\u52a8\u6570\u636e\u540e\u91cd\u8bd5\u3002");

  showDialog({
    title: "\u4e00\u952e\u68c0\u6d4b",
    message: lines.join("\n"),
    confirmButtonText: "\u6211\u77e5\u9053\u4e86",
    messageAlign: "left",
  });
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
      <p class="welcome">林业智能巡护助手</p>

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
          <span class="entry-card-desc">联网问答与知识检索</span>
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
            <van-button type="primary" plain block @click="runAllInOneDiagnostics">一键检测</van-button>
          </div>
        </van-collapse-item>
      </van-collapse>

      <div class="beian-section">
        <p class="beian-title">备案信息</p>
        <a class="beian-link" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">
          豫ICP备2026018815号-1
        </a>
        <span class="beian-link beian-text">
          公安联网备案：af6c7ecd3acff61ff3fc44ca3009060f
        </span>
      </div>
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

.beian-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 8px 8px;
  margin-top: 8px;
  border-top: 1px solid #ebedf0;
}

.beian-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: #646566;
}

.beian-link {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #969799;
  text-decoration: none;
  transition: color 0.15s;
}

.beian-link:hover {
  color: #1989fa;
}

.beian-text {
  cursor: default;
  user-select: text;
}

.beian-text:hover {
  color: #969799;
}

.beian-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
</style>
