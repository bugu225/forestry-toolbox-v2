<template>
  <router-view />
</template>

<script setup>
import { onMounted, onUnmounted } from "vue";
import { showDialog } from "vant";

let updateHandler = null;

onMounted(() => {
  updateHandler = (event) => {
    const registration = event.detail?.registration;
    showDialog({
      title: "发现新版本",
      message: "应用已更新，点击确定刷新以使用最新版本。",
      confirmButtonText: "立即更新",
      showCancelButton: true,
      cancelButtonText: "稍后",
    }).then(() => {
      if (registration?.waiting) {
        registration.waiting.postMessage("SKIP_WAITING");
      }
      window.location.reload();
    }).catch(() => {});
  };
  window.addEventListener("pwa-update-ready", updateHandler);
});

onUnmounted(() => {
  if (updateHandler) {
    window.removeEventListener("pwa-update-ready", updateHandler);
  }
});
</script>

<style>
/* 纯移动端基线：禁止横向溢出、适配安全区与动态视口高度 */
html,
body {
  margin: 0;
  max-width: 100%;
  overflow-x: hidden;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

#app {
  min-height: 100dvh;
  min-height: -webkit-fill-available;
  max-width: 100%;
  box-sizing: border-box;
}
</style>
