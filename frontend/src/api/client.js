import axios from "axios";
import { useAuthStore } from "../stores/auth";

function resolveBaseURL() {
  const fromEnv = import.meta.env.VITE_API_BASE;
  if (fromEnv) return fromEnv;
  return "/api";
}

const DEFAULT_TIMEOUT_MS = 15000;

const apiClient = axios.create({
  baseURL: resolveBaseURL(),
  timeout: DEFAULT_TIMEOUT_MS,
});

export const QA_ASK_TIMEOUT_MS = 120000;

export const API_READ_TIMEOUT_MS = 40000;

export const IDENTIFY_SYNC_TIMEOUT_MS = 120000;

apiClient.interceptors.request.use((config) => {
  const authStore = useAuthStore();
  if (authStore.token) {
    config.headers.Authorization = `Bearer ${authStore.token}`;
  }
  return config;
});

export default apiClient;
