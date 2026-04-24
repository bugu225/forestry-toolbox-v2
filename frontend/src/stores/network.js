import { computed, ref } from "vue";
import { defineStore } from "pinia";

/**
 * 手机网络在线状态 + 可选「模拟断网」（仅本应用内测试离线，不改系统网络）。
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
