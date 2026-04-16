<script setup>
import { onMounted, ref } from "vue";
import { showFailToast, showSuccessToast } from "vant";

import apiClient from "../api/client";

const loading = ref(false);
const items = ref([]);
const filters = ref({
  module: "",
  status: "",
  deduplicated: "",
});

function moduleText(moduleKey) {
  if (moduleKey === "identify") return "识图";
  if (moduleKey === "qa") return "问答";
  if (moduleKey === "patrol") return "巡护";
  return moduleKey || "未知";
}

function statusText(status) {
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  return status || "未知";
}

function buildSummary(item) {
  const summary = item?.summary || {};
  if (item.module === "identify") {
    return `插入 ${Number(summary.inserted || 0)} 条`;
  }
  if (item.module === "qa") {
    return `会话 ${Number(summary.inserted_sessions || 0)} / 消息 ${Number(summary.inserted_messages || 0)}`;
  }
  if (item.module === "patrol") {
    return `任务 ${Number(summary.tasks || 0)} / 轨迹 ${Number(summary.points || 0)} / 事件 ${Number(summary.events || 0)}`;
  }
  return "无统计";
}

async function loadAudits() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: "50" });
    if (filters.value.module) params.set("module", filters.value.module);
    if (filters.value.status) params.set("status", filters.value.status);
    if (filters.value.deduplicated) params.set("deduplicated", filters.value.deduplicated);
    const { data } = await apiClient.get(`/sync/audits?${params.toString()}`);
    items.value = data.items || [];
  } catch (error) {
    showFailToast(error?.response?.data?.error?.message || "加载同步审计失败");
  } finally {
    loading.value = false;
  }
}

async function clearAudits() {
  const target = filters.value.module || "all";
  const ok = window.confirm(
    target === "all" ? "确认清空全部审计日志？（不会删除业务数据）" : `确认清空 ${moduleText(target)} 审计日志？`
  );
  if (!ok) return;
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (filters.value.module) params.set("module", filters.value.module);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const { data } = await apiClient.delete(`/sync/audits${suffix}`);
    showSuccessToast(`已清理 ${Number(data?.deleted || 0)} 条审计日志`);
    await loadAudits();
  } catch (error) {
    showFailToast(error?.response?.data?.error?.message || "清理审计日志失败");
  } finally {
    loading.value = false;
  }
}

onMounted(loadAudits);
</script>

<template>
  <div class="page">
    <van-nav-bar title="同步审计" left-arrow @click-left="$router.back()" />
    <div class="card">
      <div class="filters">
        <label class="filter-item">
          <span>模块</span>
          <select v-model="filters.module">
            <option value="">全部</option>
            <option value="identify">识图</option>
            <option value="qa">问答</option>
            <option value="patrol">巡护</option>
          </select>
        </label>
        <label class="filter-item">
          <span>状态</span>
          <select v-model="filters.status">
            <option value="">全部</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
          </select>
        </label>
        <label class="filter-item">
          <span>去重</span>
          <select v-model="filters.deduplicated">
            <option value="">全部</option>
            <option value="true">去重命中</option>
            <option value="false">未命中</option>
          </select>
        </label>
      </div>
      <van-button type="primary" plain block :loading="loading" @click="loadAudits">刷新审计记录</van-button>
      <van-button type="danger" plain block :loading="loading" @click="clearAudits">清理当前筛选日志</van-button>
      <p v-if="!items.length && !loading">暂无同步记录</p>
      <div v-for="item in items" :key="item.id" class="audit-item">
        <p class="line">
          <span class="left">模块：{{ moduleText(item.module) }}</span>
          <span
            class="right"
            :class="{ ok: item.status === 'success', fail: item.status === 'failed' }"
          >
            {{ statusText(item.status) }}{{ item.deduplicated ? " / 去重命中" : "" }}
          </span>
        </p>
        <p class="line"><span class="left">统计：{{ buildSummary(item) }}</span></p>
        <p v-if="item.error_message" class="line fail">失败原因：{{ item.error_message }}</p>
        <p class="time">{{ item.created_at }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #f7f8fa;
  padding: 16px;
}

.card {
  background: #fff;
  border-radius: 8px;
  padding: 12px;
  display: grid;
  gap: 10px;
}

.filters {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.filter-item {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: #646566;
}

.filter-item select {
  height: 32px;
  border: 1px solid #dcdee0;
  border-radius: 6px;
  padding: 0 6px;
  background: #fff;
}

.audit-item {
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  padding: 8px;
  display: grid;
  gap: 6px;
}

.line {
  margin: 0;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.left {
  color: #323233;
}

.right {
  font-weight: 600;
}

.ok {
  color: #07c160;
}

.fail {
  color: #ee0a24;
}

.time {
  margin: 0;
  color: #969799;
  font-size: 12px;
}
</style>
