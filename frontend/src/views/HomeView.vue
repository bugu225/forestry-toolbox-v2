<script setup>
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { showToast } from "vant";
import { useAuthStore } from "../stores/auth";
import { useNetworkStore } from "../stores/network";

const authStore = useAuthStore();
const networkStore = useNetworkStore();
const { simulateOffline, effectiveOnline } = storeToRefs(networkStore);
const router = useRouter();

/** 默认收起「其他」区块 */
const moreActive = ref([]);

const username = computed(() => authStore.user?.username || "用户");

const networkHint = computed(() => {
  if (simulateOffline.value) {
    return "模拟断网中（本应用内视为离线，用于测试）";
  }
  return effectiveOnline.value ? "当前网络：在线" : "当前网络：离线";
});

function goQa() {
  router.push({ name: "qa" });
}

function goIdentify() {
  router.push({ name: "identify" });
}

function goPatrol() {
  showToast({ message: "正在开发中", position: "middle" });
}

function logout() {
  authStore.clearAuth();
  router.push({ name: "login" });
}

function onSimulateOfflineChange(checked) {
  networkStore.setSimulateOffline(checked);
  showToast({
    message: checked ? "已开启模拟断网" : "已恢复为真实网络状态",
    position: "bottom",
  });
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="功能首页" />

    <div class="home-main">
      <p class="welcome">你好，{{ username }}</p>

      <div class="entry-cards" role="navigation" aria-label="功能入口">
        <button type="button" class="entry-card entry-card--qa" @click="goQa">
          <span class="entry-card-title">林业知识问答</span>
          <span class="entry-card-desc">AI 问答与知识检索</span>
        </button>
        <button type="button" class="entry-card entry-card--id" @click="goIdentify">
          <span class="entry-card-title">林业识图</span>
          <span class="entry-card-desc">图集、拍照与相册</span>
        </button>
        <button type="button" class="entry-card entry-card--patrol" @click="goPatrol">
          <span class="entry-card-title">巡护助手</span>
          <span class="entry-card-desc">轨迹与异常上报</span>
        </button>
      </div>

      <van-collapse v-model="moreActive" :border="false" class="more-collapse">
        <van-collapse-item title="其他、等等" name="more" class="more-item">
          <div class="more-inner">
            <p class="more-line muted">{{ networkHint }}</p>
            <van-cell center title="断网测试" label="开启后在本应用内模拟离线，不影响系统其它应用">
              <template #right-icon>
                <van-switch
                  :model-value="simulateOffline"
                  size="20px"
                  @update:model-value="onSimulateOfflineChange"
                />
              </template>
            </van-cell>
            <van-button class="more-logout" type="danger" block round @click="logout">退出登录</van-button>
          </div>
        </van-collapse-item>
      </van-collapse>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #f0f2f5;
}

.home-main {
  padding: 16px 16px 28px;
  max-width: 520px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.welcome {
  margin: 0;
  font-size: 15px;
  color: #646566;
  text-align: center;
}

.entry-cards {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.entry-card {
  width: 100%;
  border: none;
  border-radius: 14px;
  padding: 20px 18px;
  text-align: left;
  cursor: pointer;
  color: #fff;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}

.entry-card:active {
  transform: scale(0.98);
}

.entry-card-title {
  display: block;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.entry-card-desc {
  display: block;
  margin-top: 6px;
  font-size: 13px;
  opacity: 0.92;
  font-weight: 400;
}

.entry-card--qa {
  background: linear-gradient(135deg, #3a8afe 0%, #1989fa 100%);
}

.entry-card--id {
  background: linear-gradient(135deg, #34c759 0%, #07c160 100%);
}

.entry-card--patrol {
  background: linear-gradient(135deg, #ffb14a 0%, #ff976a 100%);
}

.more-collapse {
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
}

.more-collapse :deep(.van-collapse-item__title) {
  font-weight: 600;
  color: #323233;
}

.more-inner {
  display: grid;
  gap: 12px;
  padding-bottom: 4px;
}

.more-line {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.more-line.muted {
  color: #969799;
  font-size: 12px;
}

.more-inner :deep(.van-cell) {
  padding-left: 0;
  padding-right: 0;
}

.more-logout {
  margin-top: 4px;
}
</style>
