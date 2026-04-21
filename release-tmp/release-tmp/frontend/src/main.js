import { createApp } from "vue";
import { createPinia } from "pinia";
import Vant from "vant";
import "vant/lib/index.css";

import App from "./App.vue";
import router from "./router";

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(Vant);
app.mount("#app");

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
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
      })
      .catch(() => {
        // Keep silent; app still works without SW.
      });
  });
}
