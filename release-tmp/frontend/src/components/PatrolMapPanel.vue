<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { showFailToast, showSuccessToast } from "vant";
import { loadAmapSdk } from "../services/amapLoader";

const MAX_PATH_POINTS_ON_MAP = 500;
const MAX_EVENT_MARKERS_ON_MAP = 120;
const HENAN_BOUNDS = {
  minLng: 110.35,
  maxLng: 116.65,
  minLat: 31.38,
  maxLat: 36.37,
};

const props = defineProps({
  online: { type: Boolean, default: false },
  patrolPoints: { type: Array, default: () => [] },
  patrolEvents: { type: Array, default: () => [] },
});

const mapWrapRef = ref(null);
const mapReady = ref(false);
const mapLoading = ref(false);
const mapError = ref("");
let map = null;
let polyline = null;
let eventMarkers = [];
let renderMapRaf = 0;

const eventTypeOptions = [
  { text: "病虫害", value: "pest", emoji: "●" },
  { text: "火情", value: "fire", emoji: "▲" },
  { text: "盗伐", value: "logging", emoji: "■" },
  { text: "其他异常", value: "other", emoji: "⚠" },
];

function eventTypeMeta(type) {
  return eventTypeOptions.find((x) => x.value === type) || eventTypeOptions[eventTypeOptions.length - 1];
}

function formatTime(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return "无记录";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours()
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function pointToLngLat(row) {
  return [Number(row.lng), Number(row.lat)];
}

function clearMapObjects() {
  if (!map) return;
  if (polyline) {
    map.remove(polyline);
    polyline = null;
  }
  if (eventMarkers.length) {
    map.remove(eventMarkers);
    eventMarkers = [];
  }
}

function destroyMap() {
  clearMapObjects();
  if (map) {
    try {
      map.destroy();
    } catch (_) {
      /* ignore */
    }
    map = null;
  }
  mapReady.value = false;
  mapLoading.value = false;
}

function scheduleRenderMap() {
  if (!map || !props.online) return;
  if (renderMapRaf) cancelAnimationFrame(renderMapRaf);
  renderMapRaf = requestAnimationFrame(() => {
    renderMapRaf = 0;
    renderMap();
  });
}

function renderMap() {
  if (!map || !props.online) return;
  clearMapObjects();
  const pts = props.patrolPoints || [];
  const evs = props.patrolEvents || [];
  const pointsForMap = pts.slice(-MAX_PATH_POINTS_ON_MAP);
  if (pointsForMap.length >= 2) {
    const AMap = window.AMap;
    const path = pointsForMap.map(pointToLngLat);
    polyline = new AMap.Polyline({
      path,
      strokeColor: "#1989fa",
      strokeWeight: 5,
      lineJoin: "round",
      lineCap: "round",
    });
    map.add(polyline);
    map.setCenter(path[path.length - 1]);
  }
  if (evs.length) {
    const AMap = window.AMap;
    const eventsForMap = evs.slice(0, MAX_EVENT_MARKERS_ON_MAP);
    eventMarkers = eventsForMap.map((ev) => {
      const meta = eventTypeMeta(ev.type);
      const marker = new AMap.CircleMarker({
        position: pointToLngLat(ev),
        radius: 7,
        strokeWeight: 1,
        strokeColor: "#1f1f1f",
        fillColor: ev.type === "fire" ? "#ee0a24" : ev.type === "pest" ? "#07c160" : ev.type === "logging" ? "#1989fa" : "#ff976a",
        fillOpacity: 0.95,
        bubble: true,
      });
      marker.on("click", () => {
        showSuccessToast(`${meta.emoji} ${meta.text} · ${formatTime(ev.captured_at)}`);
      });
      return marker;
    });
    map.add(eventMarkers);
  }
}

function scheduleIdle(fn) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(fn, { timeout: 2800 });
  } else {
    setTimeout(fn, 500);
  }
}

async function ensureMap() {
  if (!props.online || map) return;
  for (let i = 0; i < 12 && props.online && !mapWrapRef.value; i += 1) {
    await nextTick();
  }
  if (!props.online || !mapWrapRef.value) return;
  try {
    mapLoading.value = true;
    mapError.value = "";
    const AMap = await loadAmapSdk();
    map = new AMap.Map(mapWrapRef.value, {
      zoom: 11,
      center: [113.65, 34.76],
      viewMode: "2D",
      pitchEnable: false,
      rotateEnable: false,
      jogEnable: false,
      zooms: [6, 18],
    });
    const bounds = new AMap.Bounds([HENAN_BOUNDS.minLng, HENAN_BOUNDS.minLat], [HENAN_BOUNDS.maxLng, HENAN_BOUNDS.maxLat]);
    map.setLimitBounds(bounds);
    mapReady.value = true;
  } catch (error) {
    mapReady.value = false;
    if (map) {
      try {
        map.destroy();
      } catch (_) {
        /* ignore */
      }
      map = null;
    }
    mapError.value = error?.message || "地图加载失败";
    showFailToast(mapError.value);
  } finally {
    mapLoading.value = false;
  }
}

async function initMapSilently() {
  if (!props.online || map) return;
  await ensureMap();
  await nextTick();
  scheduleRenderMap();
}

async function initMapOnDemand() {
  mapError.value = "";
  if (!props.online) {
    showFailToast("当前离线，无法加载在线地图");
    return;
  }
  await ensureMap();
  await nextTick();
  scheduleRenderMap();
}

async function zoomToEvent(row) {
  if (!row || !props.online) return;
  await ensureMap();
  await nextTick();
  if (map) map.setZoomAndCenter(16, pointToLngLat(row));
}

defineExpose({ zoomToEvent, initMapOnDemand });

watch(
  () => [props.patrolPoints?.length, props.patrolEvents?.length, mapReady.value, props.online],
  () => {
    if (map && mapReady.value && props.online) scheduleRenderMap();
  }
);

watch(
  () => props.online,
  (isOnline) => {
    if (!isOnline) {
      destroyMap();
      mapError.value = "";
    } else {
      scheduleIdle(() => {
        if (props.online) initMapSilently();
      });
    }
  }
);

onMounted(() => {
  if (props.online) {
    scheduleIdle(() => initMapSilently());
  }
});

onUnmounted(() => {
  destroyMap();
  if (renderMapRaf) cancelAnimationFrame(renderMapRaf);
});
</script>

<template>
  <div class="map-panel">
    <div class="head-actions">
      <span class="sub">{{
        !online ? "离线" : mapReady ? "已加载高德地图" : mapLoading ? "地图加载中…" : "联网后将自动加载"
      }}</span>
      <van-button v-if="online && !mapLoading && !mapReady" size="mini" type="primary" plain @click="initMapOnDemand">
        {{ mapError ? "重试" : "立即加载" }}
      </van-button>
    </div>
    <div v-if="online" class="map-shell">
      <div ref="mapWrapRef" class="map-wrap" />
      <div v-if="mapLoading" class="map-status">地图加载中…</div>
      <div v-else-if="mapError && !mapReady" class="map-status map-status-err">
        <p class="map-err-msg">{{ mapError }}</p>
      </div>
    </div>
    <p v-else class="tip">离线不加载地图</p>
    <p v-if="mapReady && (patrolPoints.length > MAX_PATH_POINTS_ON_MAP || patrolEvents.length > MAX_EVENT_MARKERS_ON_MAP)" class="tip">
      地图仅渲染最近 {{ MAX_PATH_POINTS_ON_MAP }} 个轨迹点与 {{ MAX_EVENT_MARKERS_ON_MAP }} 个事件点。
    </p>
  </div>
</template>

<style scoped>
.map-panel {
  margin-top: 8px;
}
.head-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.sub {
  font-size: 12px;
  color: #969799;
}
.map-shell {
  position: relative;
  min-height: 260px;
}
.map-wrap {
  height: 260px;
  border-radius: 10px;
  overflow: hidden;
}
.map-status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(246, 247, 251, 0.92);
  color: #646566;
  font-size: 13px;
  border-radius: 10px;
  pointer-events: none;
}
.map-status-err {
  flex-direction: column;
  gap: 10px;
  pointer-events: auto;
  padding: 12px;
  text-align: center;
}
.map-err-msg {
  margin: 0;
  font-size: 12px;
  color: #ee0a24;
  line-height: 1.5;
}
.tip {
  margin: 8px 0 0;
  color: #969799;
  font-size: 12px;
}
</style>
