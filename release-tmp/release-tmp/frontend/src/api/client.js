import axios from "axios";
import { useAuthStore } from "../stores/auth";

function resolveBaseURL() {
  const fromEnv = import.meta.env.VITE_API_BASE;
  if (fromEnv) return fromEnv;
  // 生产构建未配 env 时仍指向默认后端；开发默认 /api 走 Vite 代理
  return import.meta.env.DEV ? "/api" : "http://localhost:5000/api";
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
