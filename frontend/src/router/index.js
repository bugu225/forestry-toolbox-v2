import { createRouter, createWebHistory } from "vue-router";

import HomeView from "../views/HomeView.vue";
import IdentifyView from "../views/IdentifyView.vue";
import LoginView from "../views/LoginView.vue";
import PatrolView from "../views/PatrolView.vue";
import QaView from "../views/QaView.vue";
import SyncAuditView from "../views/SyncAuditView.vue";
import { useAuthStore } from "../stores/auth";

const routes = [
  { path: "/login", name: "login", component: LoginView },
  { path: "/", name: "home", component: HomeView, meta: { requiresAuth: true } },
  { path: "/identify", name: "identify", component: IdentifyView, meta: { requiresAuth: true } },
  { path: "/qa", name: "qa", component: QaView, meta: { requiresAuth: true } },
  { path: "/patrol", name: "patrol", component: PatrolView, meta: { requiresAuth: true } },
  { path: "/sync-audits", name: "syncAudits", component: SyncAuditView, meta: { requiresAuth: true } },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const authStore = useAuthStore();
  if (to.meta.requiresAuth && !authStore.token) {
    return { name: "login" };
  }
  if (to.name === "login" && authStore.token) {
    return { name: "home" };
  }
  return true;
});

export default router;
