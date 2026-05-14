<script setup>
import { useRouter } from "vue-router";
import { APP_VERSION } from "../version";

const router = useRouter();

function enterApp() {
  router.push({ name: "home" });
}
</script>

<template>
  <div class="welcome-page">
    <div class="welcome-content">
      <div class="welcome-header">
        <h1 class="app-title">林业智能巡护助手</h1>
        <p class="app-subtitle">验证助手</p>
        <p class="app-version">{{ APP_VERSION }}</p>
      </div>

      <button type="button" class="enter-btn" @click="enterApp">
        进入
      </button>

      <div class="beian-section">
        <a class="beian-link" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">
          豫ICP备2026018815号-1
        </a>
        <span class="beian-text">
          公安联网备案：af6c7ecd3acff61ff3fc44ca3009060f
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, #e8f4e8 0%, #f0f7f0 30%, #eaf4ea 60%, #f5f9f5 100%);
  padding: 24px;
}

.welcome-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  max-width: 360px;
  width: 100%;
}

.welcome-header {
  text-align: center;
  margin-bottom: 60px;
}

.app-title {
  margin: 0 0 12px;
  font-size: 28px;
  font-weight: 700;
  color: #1a3c1a;
  letter-spacing: 0.04em;
  line-height: 1.3;
}

.app-subtitle {
  margin: 0 0 16px;
  font-size: 16px;
  color: #5a7a5a;
  font-weight: 500;
  letter-spacing: 0.1em;
}

.app-version {
  margin: 0;
  font-size: 13px;
  color: #8a9a8a;
  font-weight: 400;
}

.enter-btn {
  width: 180px;
  height: 56px;
  border: none;
  border-radius: 28px;
  background: linear-gradient(135deg, #3a8afe 0%, #1989fa 100%);
  color: #fff;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.15em;
  cursor: pointer;
  box-shadow: 0 6px 24px rgba(25, 137, 250, 0.35);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  margin-bottom: 80px;
}

.enter-btn:active {
  transform: scale(0.96);
  box-shadow: 0 4px 16px rgba(25, 137, 250, 0.25);
}

.beian-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 24px;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  width: 100%;
}

.beian-link {
  font-size: 12px;
  color: #969799;
  text-decoration: none;
  transition: color 0.15s;
}

.beian-link:hover {
  color: #1989fa;
}

.beian-text {
  font-size: 12px;
  color: #969799;
  user-select: text;
}
</style>
