import { computed, ref } from "vue";
import { defineStore } from "pinia";

/** 闪断网防抖（ms）：避免瞬时 offline 导致地图/界面反复「掉线」 */
const OFFLINE_DEBOUNCE_MS = 2600;
let offlineDebounceTimer = null;

/**
 * 在 `app.use(pinia)` 之后调用一次。在线立即同步；离线延迟再标为断网（仍不影响 geolocation 内对 `navigator.onLine` 的直接读取）。
 */
export function bindDebouncedNavigatorListeners(getStore) {
  if (typeof window === "undefined") return () => {};
  const onOnline = () => {
    if (offlineDebounceTimer) {
      window.clearTimeout(offlineDebounceTimer);
      offlineDebounceTimer = null;
    }
    getStore().setNavigatorOnline(true);
  };
  const onOffline = () => {
    if (offlineDebounceTimer) window.clearTimeout(offlineDebounceTimer);
    offlineDebounceTimer = window.setTimeout(() => {
      offlineDebounceTimer = null;
      if (!navigator.onLine) getStore().setNavigatorOnline(false);
    }, OFFLINE_DEBOUNCE_MS);
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    if (offlineDebounceTimer) {
      window.clearTimeout(offlineDebounceTimer);
      offlineDebounceTimer = null;
    }
  };
}

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
