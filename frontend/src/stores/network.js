import { computed, ref } from "vue";
import { defineStore } from "pinia";

const OFFLINE_DEBOUNCE_MS = 2600;
let offlineDebounceTimer = null;

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
