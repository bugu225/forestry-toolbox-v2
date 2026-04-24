<script setup>
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { showFailToast, showSuccessToast } from "vant";

import { useAuthStore } from "../stores/auth";

const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);

const form = reactive({
  username: "",
  password: "",
});

function resolveLoginError(error) {
  if (error?.response?.status === 401) {
    return "用户名或密码错误";
  }
  const serverMsg = error?.response?.data?.error?.message;
  if (serverMsg) return serverMsg;
  if (error?.code === "ECONNABORTED" || /timeout/i.test(error?.message || "")) {
    return "请求超时，请检查网络或稍后重试";
  }
  if (error?.request && !error?.response) {
    return "网络异常：请检查手机网络与站点是否可访问";
  }
  return "请求失败，请稍后重试";
}

async function submit() {
  loading.value = true;
  try {
    await authStore.login(form);
    showSuccessToast("登录成功");
    router.push({ name: "home" });
  } catch (error) {
    const message = resolveLoginError(error);
    showFailToast(message);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="page">
    <h1 class="title">林业智能巡护助手</h1>
    <van-form @submit="submit">
      <van-cell-group inset>
        <van-field v-model="form.username" name="username" label="用户名" required autocomplete="username" />
        <van-field
          v-model="form.password"
          type="password"
          name="password"
          label="密码"
          required
          autocomplete="current-password"
        />
      </van-cell-group>
      <div class="actions">
        <van-button round block type="primary" native-type="submit" :loading="loading">
          使用内部账号登录
        </van-button>
      </div>
    </van-form>
  </div>
</template>

<style scoped>
.page {
  padding: 28px 16px calc(32px + env(safe-area-inset-bottom, 0));
  min-height: 100dvh;
  box-sizing: border-box;
  background: #f7f8fa;
}

.title {
  text-align: center;
  margin: 0 0 28px;
  font-size: 18px;
  font-weight: 600;
  color: #323233;
  line-height: 1.45;
  padding: 0 8px;
}

.actions {
  margin: 20px 16px 0;
}
</style>
