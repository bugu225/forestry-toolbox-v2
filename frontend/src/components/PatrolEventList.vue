<script setup>
const props = defineProps({
  show: { type: Boolean, default: true },
  events: { type: Array, default: () => [] },
  eventTypeLabel: { type: Function, required: true },
  formatTime: { type: Function, required: true },
  formatCoord: { type: Function, required: true },
  locationSourceLabel: { type: Function, required: true },
});

const emit = defineEmits(["focus", "delete"]);
</script>

<template>
  <van-cell-group v-if="show" inset title="事件列表（本机存放）" class="block">
    <van-empty v-if="!events.length" description="暂无事件" />
    <van-swipe-cell v-for="ev in events" :key="ev.local_id">
      <van-cell
        :title="`${eventTypeLabel(ev.type)}`"
        :label="`${formatTime(ev.recorded_at)} · ${formatCoord(ev.lat)}, ${formatCoord(ev.lng)} · ${locationSourceLabel(ev.source)}${Number.isFinite(Number(ev.accuracy)) && Number(ev.accuracy) > 0 ? ' · 精度约 ' + Math.round(Number(ev.accuracy)) + ' m' : ''}${ev.note ? ' · ' + ev.note : ''}${ev.photo_dataurl ? ' · 含照片' : ''}`"
        is-link
        @click="emit('focus', ev)"
      />
      <template #right>
        <van-button square type="danger" text="删除" class="swipe-del" @click="emit('delete', ev)" />
      </template>
    </van-swipe-cell>
  </van-cell-group>
</template>

<style scoped>
.block {
  margin-top: 8px;
}

.swipe-del {
  height: 100%;
}
</style>
