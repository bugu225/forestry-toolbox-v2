import axios from "axios";
import { useAuthStore } from "../stores/auth";

function resolveBaseURL() {
  const fromEnv = import.meta.env.VITE_API_BASE;
  if (fromEnv) return fromEnv;
  // 开发与生产均默认同源 /api：dev 由 Vite 代理到 Flask；生产由 Nginx 等反代到后端。
  // 若需直连某台机器上的后端（无反代），构建前设置 VITE_API_BASE，例如 http://127.0.0.1:5000/api
  return "/api";
}

/**
 * 默认请求超时：弱网下 8s 易误杀轻量接口；问答/识图/大 JSON 须在调用处显式传更长 timeout。
 */
const DEFAULT_TIMEOUT_MS = 15000;

const apiClient = axios.create({
  baseURL: resolveBaseURL(),
  timeout: DEFAULT_TIMEOUT_MS,
});

/** 联网问答 / 知识整理（LLM） */
export const QA_ASK_TIMEOUT_MS = 120000;

/** 会话列表、历史消息、巡护列表等读接口（非 LLM，但可能弱网较慢） */
export const API_READ_TIMEOUT_MS = 40000;

/** 识图同步：与 Nginx proxy_read_timeout、后端识图链路对齐 */
export const IDENTIFY_SYNC_TIMEOUT_MS = 120000;

apiClient.interceptors.request.use((config) => {
  const authStore = useAuthStore();
  if (authStore.token) {
    config.headers.Authorization = `Bearer ${authStore.token}`;
  }
  return config;
});

export default apiClient;
