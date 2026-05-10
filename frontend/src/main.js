import { createApp } from "vue";
import { createPinia } from "pinia";
import "vant/lib/index.css";

import App from "./App.vue";
import router from "./router";
import { useNetworkStore, bindDebouncedNavigatorListeners } from "./stores/network";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);

app.config.errorHandler = (err) => {
  console.error("[GlobalError]", err);
};

if (typeof window !== "undefined") {
  bindDebouncedNavigatorListeners(() => useNetworkStore());
}

app.mount("#app");

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        const notifyUpdateReady = () => {
          window.dispatchEvent(new CustomEvent("pwa-update-ready", { detail: { registration } }));
        };

        if (registration.waiting) {
          notifyUpdateReady();
        }

        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              notifyUpdateReady();
            }
          });
        });

        let updateCheckTimer = null;
        const checkForUpdate = () => {
          if (updateCheckTimer) clearTimeout(updateCheckTimer);
          updateCheckTimer = setTimeout(() => {
            registration.update().catch(() => {});
          }, 1000);
        };

        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            checkForUpdate();
          }
        });
        window.addEventListener("online", checkForUpdate);
      })
      .catch((err) => {
        console.warn("[PWA] service worker register failed", err);
      });
  });
}
