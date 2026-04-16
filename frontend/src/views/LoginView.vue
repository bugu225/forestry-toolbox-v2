<script setup>
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { showFailToast, showSuccessToast } from "vant";

import { useAuthStore } from "../stores/auth";

const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);
const isRegisterMode = ref(false);

const form = reactive({
  username: "",
  password: "",
});

async function submit() {
  loading.value = true;
  try {
    if (isRegisterMode.value) {
      await authStore.register(form);
      showSuccessToast("注册成功");
    } else {
      await authStore.login(form);
      showSuccessToast("登录成功");
    }
    router.push({ name: "home" });
  } catch (error) {
    const message = error?.response?.data?.error?.message || "请求失败，请稍后重试";
    showFailToast(message);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="page">
    <h1>林业百宝箱 v2</h1>
    <van-form @submit="submit">
      <van-cell-group inset>
        <van-field v-model="form.username" name="username" label="用户名" required />
        <van-field v-model="form.password" type="password" name="password" label="密码" required />
      </van-cell-group>
      <div class="actions">
        <van-button round block type="primary" native-type="submit" :loading="loading">
          {{ isRegisterMode ? "注册并登录" : "登录" }}
        </van-button>
        <van-button plain round block type="default" @click="isRegisterMode = !isRegisterMode">
          {{ isRegisterMode ? "切换到登录" : "没有账号？去注册" }}
        </van-button>
      </div>
    </van-form>
  </div>
</template>

<style scoped>
.page {
  padding: 24px 16px;
}

h1 {
  text-align: center;
  margin-bottom: 24px;
}

.actions {
  margin: 16px;
  display: grid;
  gap: 12px;
}
</style>
