import { defineStore } from "pinia";
import apiClient from "../api/client";

const TOKEN_KEY = "ftb2_token";
const USER_KEY = "ftb2_user";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || "",
    user: JSON.parse(localStorage.getItem(USER_KEY) || "null"),
  }),
  actions: {
    setAuth(token, user) {
      this.token = token;
      this.user = user;
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clearAuth() {
      this.token = "";
      this.user = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },
    async login(payload) {
      const { data } = await apiClient.post("/auth/login", payload);
      this.setAuth(data.access_token, data.user);
      return data;
    },
    async register(payload) {
      const { data } = await apiClient.post("/auth/register", payload);
      this.setAuth(data.access_token, data.user);
      return data;
    },
  },
});
