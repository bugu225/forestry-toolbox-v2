<script setup>
import { ref } from "vue";
import { showFailToast, showSuccessToast } from "vant";

const gpsLoading = ref(false);
const gpsResult = ref("");

function formatGeoError(error) {
  const code = Number(error?.code || 0);
  if (code === 1) return "定位权限被拒绝，请在浏览器/系统设置中允许定位权限。";
  if (code === 2) return "定位不可用，请确认已开启手机或电脑定位服务（GPS）。";
  if (code === 3) return "定位超时，请稍后重试。";
  return "获取定位失败，请检查网络与定位权限。";
}

async function testGps() {
  if (!navigator.geolocation) {
    showFailToast("当前设备不支持定位能力");
    return;
  }
  gpsLoading.value = true;
  gpsResult.value = "";
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      });
    });
    const lat = Number(pos.coords.latitude || 0).toFixed(6);
    const lng = Number(pos.coords.longitude || 0).toFixed(6);
    const acc = Number(pos.coords.accuracy || 0).toFixed(1);
    gpsResult.value = `经纬度：${lat}, ${lng}（精度约 ${acc} 米）`;
    showSuccessToast("GPS 获取成功");
  } catch (error) {
    const message = formatGeoError(error);
    gpsResult.value = `失败：${message}`;
    showFailToast("GPS 获取失败");
  } finally {
    gpsLoading.value = false;
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="巡护助手" left-arrow @click-left="$router.back()" />
    <section class="card">
      <h3>模块正在开发中</h3>
      <p>巡护助手正在进行重构升级，暂时不可用。</p>
      <p>已下线旧版轨迹采样、事件标记和地图能力，后续会以新版本重新上线。</p>

      <div class="gps-test">
        <van-button type="primary" block :loading="gpsLoading" @click="testGps">获取当前 GPS（测试）</van-button>
        <p v-if="gpsResult" class="gps-result">{{ gpsResult }}</p>
      </div>

      <van-button type="default" block @click="$router.push({ name: 'home' })">返回首页</van-button>
    </section>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #f6f7fb;
  padding: 12px;
}

.card {
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}

h3 {
  margin: 0 0 10px;
  font-size: 18px;
  color: #323233;
}

p {
  margin: 0 0 10px;
  font-size: 14px;
  color: #646566;
  line-height: 1.6;
}

.gps-test {
  margin: 14px 0;
}

.gps-result {
  margin-top: 8px;
  font-size: 13px;
  color: #1989fa;
}
</style>
