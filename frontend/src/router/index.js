import { createRouter, createWebHistory } from "vue-router";

import { useAuthStore } from "../stores/auth";

const routes = [
  { path: "/login", name: "login", component: () => import("../views/LoginView.vue") },
  { path: "/", name: "home", component: () => import("../views/HomeView.vue"), meta: { requiresAuth: true } },
  { path: "/identify", name: "identify", component: () => import("../views/IdentifyView.vue"), meta: { requiresAuth: true } },
  { path: "/qa", name: "qa", component: () => import("../views/QaView.vue"), meta: { requiresAuth: true } },
  { path: "/patrol", name: "patrol", component: () => import("../views/PatrolView.vue"), meta: { requiresAuth: true } },
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
