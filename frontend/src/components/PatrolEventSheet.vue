<script setup>
import { ref } from "vue";

const props = defineProps({
  show: { type: Boolean, default: false },
  eventType: { type: String, default: "pest" },
  eventNote: { type: String, default: "" },
  eventPhotoDataUrl: { type: String, default: "" },
  eventTypes: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false },
});

const emit = defineEmits([
  "update:show",
  "update:eventType",
  "update:eventNote",
  "update:eventPhotoDataUrl",
  "save",
]);

const photoInputRef = ref(null);

function triggerPhotoPick() {
  photoInputRef.value?.click();
}

function compressImageFile(file, maxSide = 1600, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read_failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("image_decode_failed"));
      img.onload = () => {
        const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * ratio));
        const h = Math.max(1, Math.round(img.height * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas_failed"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = typeof reader.result === "string" ? reader.result : "";
    };
    reader.readAsDataURL(file);
  });
}

async function onPhotoPick(ev) {
  const file = ev.target?.files?.[0];
  if (!file) return;
  try {
    const compressed = await compressImageFile(file);
    emit("update:eventPhotoDataUrl", compressed);
  } catch {
    const reader = new FileReader();
    reader.onload = () => {
      emit("update:eventPhotoDataUrl", typeof reader.result === "string" ? reader.result : "");
    };
    reader.readAsDataURL(file);
  }
  ev.target.value = "";
}
</script>

<template>
  <van-popup
    :show="show"
    position="bottom"
    round
    :style="{ padding: '16px' }"
    @update:show="(v) => emit('update:show', v)"
  >
    <h3 class="sheet-title">记录事件</h3>
    <van-radio-group
      :model-value="eventType"
      direction="horizontal"
      class="type-row"
      @update:model-value="(v) => emit('update:eventType', v)"
    >
      <van-radio v-for="t in eventTypes" :key="t.value" :name="t.value">{{ t.label }}</van-radio>
    </van-radio-group>
    <van-field
      :model-value="eventNote"
      rows="2"
      autosize
      type="textarea"
      maxlength="500"
      show-word-limit
      label="备注"
      placeholder="现场情况描述"
      @update:model-value="(v) => emit('update:eventNote', v)"
    />
    <div class="uploader-wrap">
      <span class="ul-label">现场照片（可选）</span>
      <input ref="photoInputRef" type="file" accept="image/*" class="hidden-file" @change="onPhotoPick" />
      <van-button size="small" type="primary" plain @click="triggerPhotoPick">选择照片</van-button>
      <img v-if="eventPhotoDataUrl" :src="eventPhotoDataUrl" alt="预览" class="photo-preview" />
    </div>
    <div class="sheet-actions">
      <van-button block type="default" @click="emit('update:show', false)">取消</van-button>
      <van-button block type="primary" :loading="saving" @click="emit('save')">保存</van-button>
    </div>
  </van-popup>
</template>

<style scoped>
.sheet-title {
  margin: 0 0 12px;
  font-size: 16px;
  text-align: center;
}

.type-row {
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 8px;
}

.uploader-wrap {
  margin: 12px 0;
}

.ul-label {
  display: block;
  font-size: 14px;
  color: #323233;
  margin-bottom: 8px;
}

.hidden-file {
  display: none;
}

.photo-preview {
  display: block;
  max-width: 100%;
  max-height: 160px;
  margin-top: 10px;
  border-radius: 8px;
  object-fit: contain;
}

.sheet-actions {
  display: flex;
  gap: 10px;
}

.sheet-actions .van-button {
  flex: 1;
}
</style>
