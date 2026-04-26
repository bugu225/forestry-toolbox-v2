/**
 * 识图前统一预处理：纠正 EXIF 方向、限制长边、转 JPEG，减轻手机实拍与接口训练数据分布差异。
 * @param {File|Blob|string} input File/Blob 或 data URL
 * @returns {Promise<string>} data:image/jpeg;base64,...
 */
const MAX_LONG_SIDE = 1680;
const JPEG_QUALITY = 0.9;

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image_load_failed"));
    img.src = url;
  });
}

async function decodeToDrawable(input) {
  if (typeof input === "string" && input.startsWith("data:")) {
    const blob = await fetch(input).then((r) => r.blob());
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(blob, { imageOrientation: "from-image" });
      } catch {
        /* 继续走 Image */
      }
    }
    return loadImageFromUrl(input);
  }
  if (input instanceof Blob && typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(input, { imageOrientation: "from-image" });
    } catch {
      /* 继续走 objectURL + Image */
    }
  }
  if (input instanceof Blob) {
    const url = URL.createObjectURL(input);
    try {
      return await loadImageFromUrl(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  throw new Error("unsupported_input");
}

function drawableSize(d) {
  const w = Number(d.naturalWidth || d.width || 0);
  const h = Number(d.naturalHeight || d.height || 0);
  return { w, h };
}

function drawScaledToJpegDataUrl(drawable) {
  const { w: sw, h: sh } = drawableSize(drawable);
  if (!sw || !sh) throw new Error("empty_dimensions");
  let w = sw;
  let h = sh;
  const m = Math.max(w, h);
  if (m > MAX_LONG_SIDE) {
    const scale = MAX_LONG_SIDE / m;
    w = Math.max(2, Math.round(w * scale));
    h = Math.max(2, Math.round(h * scale));
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no_canvas");
  ctx.drawImage(drawable, 0, 0, w, h);
  if (typeof drawable.close === "function") {
    try {
      drawable.close();
    } catch {
      /* ignore */
    }
  }
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/**
 * @param {File|Blob|string} input
 * @returns {Promise<string>}
 */
export async function prepareImageForIdentify(input) {
  const drawable = await decodeToDrawable(input);
  return drawScaledToJpegDataUrl(drawable);
}
