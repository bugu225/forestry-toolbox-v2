<script setup>
const props = defineProps({
  show: { type: Boolean, default: true },
  points: { type: Array, default: () => [] },
  formatTime: { type: Function, required: true },
  formatCoord: { type: Function, required: true },
});
</script>

<template>
  <van-cell-group v-if="show" inset title="轨迹点（本机存放）" class="block trail-block">
    <van-empty
      v-if="!points.length"
      image="search"
      description="尚无采样点（开始后立即采样，后续按移动状态自动调整频率）"
    />
    <van-cell
      v-for="p in points.slice(-6).reverse()"
      :key="p.local_id"
      :title="`${formatCoord(p.lat)}, ${formatCoord(p.lng)}`"
      :label="`时间 ${formatTime(p.recorded_at)} · 精度约 ${Number.isFinite(Number(p.accuracy)) ? Math.round(Number(p.accuracy)) : '—'} m · 质量 ${p.quality_level || 'unknown'}`"
    />
  </van-cell-group>
</template>

<style scoped>
.block {
  margin-top: 8px;
}

.trail-block {
  margin-top: 12px;
}
</style>
