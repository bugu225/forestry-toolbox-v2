import { computed, ref } from "vue";
import { defineStore } from "pinia";

/**
 * 浏览器真实在线状态 + 可选的「模拟断网」（用于测试离线逻辑，不改变系统网络）。
 */
export const useNetworkStore = defineStore("network", () => {
  const navigatorOnline = ref(typeof navigator !== "undefined" ? navigator.onLine : true);
  const simulateOffline = ref(false);

  const effectiveOnline = computed(() => !simulateOffline.value && navigatorOnline.value);

  function setNavigatorOnline(value) {
    navigatorOnline.value = Boolean(value);
  }

  function setSimulateOffline(value) {
    simulateOffline.value = Boolean(value);
  }

  return {
    navigatorOnline,
    simulateOffline,
    effectiveOnline,
    setNavigatorOnline,
    setSimulateOffline,
  };
});
