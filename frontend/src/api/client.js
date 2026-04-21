import axios from "axios";
import { useAuthStore } from "../stores/auth";

function resolveBaseURL() {
  const fromEnv = import.meta.env.VITE_API_BASE;
  if (fromEnv) return fromEnv;
  // 开发与生产均默认同源 /api：dev 由 Vite 代理到 Flask；生产由 Nginx 等反代到后端。
  // 若需直连某台机器上的后端（无反代），构建前设置 VITE_API_BASE，例如 http://127.0.0.1:5000/api
  return "/api";
}

/** 普通接口；联网问答含 LLM，单独用更长超时（见 QA_ASK_TIMEOUT_MS） */
const apiClient = axios.create({
  baseURL: resolveBaseURL(),
  timeout: 8000,
});

/** 与后端 LLM 超时（含林业门控 + 作答）匹配，避免 8s 前端先断开 */
export const QA_ASK_TIMEOUT_MS = 120000;

apiClient.interceptors.request.use((config) => {
  const authStore = useAuthStore();
  if (authStore.token) {
    config.headers.Authorization = `Bearer ${authStore.token}`;
  }
  return config;
});

export default apiClient;
