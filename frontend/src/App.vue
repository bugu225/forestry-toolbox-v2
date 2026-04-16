<template>
  <div>
    <div class="network-banner" :class="online ? 'online' : 'offline'">
      {{ online ? "联网模式：支持同步和云端增强" : "离线模式：核心记录可用，稍后手动同步" }}
    </div>
    <router-view />
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from "vue";

const online = ref(navigator.onLine);

const handleOnline = () => {
  online.value = true;
};
const handleOffline = () => {
  online.value = false;
};

onMounted(() => {
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
});

onUnmounted(() => {
  window.removeEventListener("online", handleOnline);
  window.removeEventListener("offline", handleOffline);
});
</script>

<style scoped>
.network-banner {
  text-align: center;
  font-size: 12px;
  padding: 6px 10px;
  color: #fff;
}

.network-banner.online {
  background: #07c160;
}

.network-banner.offline {
  background: #ee0a24;
}
</style>
