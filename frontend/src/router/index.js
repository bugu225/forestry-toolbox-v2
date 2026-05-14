import { createRouter, createWebHistory } from "vue-router";

const routes = [
  { path: "/", name: "welcome", component: () => import("../views/WelcomeView.vue") },
  { path: "/home", name: "home", component: () => import("../views/HomeView.vue") },
  { path: "/identify", name: "identify", component: () => import("../views/IdentifyView.vue") },
  { path: "/qa", name: "qa", component: () => import("../views/QaView.vue") },
  { path: "/patrol", name: "patrol", component: () => import("../views/PatrolView.vue") },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
