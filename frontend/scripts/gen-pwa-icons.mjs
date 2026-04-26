/**
 * 生成占位 PWA 图标（仅当 public 下尚无「自定义」大图时）。
 * 自定义图标：直接替换 frontend/public/pwa-192.png 与 pwa-512.png（建议 192×192、512×512 PNG）。
 * 强制重新生成占位图：node scripts/gen-pwa-icons.mjs --force
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const force = process.argv.includes("--force");

const R = 7;
const G = 193;
const B = 96;

async function shouldSkip() {
  if (force) return false;
  const p192 = path.join(publicDir, "pwa-192.png");
  const p512 = path.join(publicDir, "pwa-512.png");
  try {
    const s192 = await fs.promises.stat(p192);
    const s512 = await fs.promises.stat(p512);
    /** 脚本生成的纯色图标约几百～2KB；你放入的摄影/Logo 通常远大于此 */
    if (s192.size > 4000 && s512.size > 8000) {
      console.log("Skip PWA icon generation: custom pwa-192.png / pwa-512.png already present. Use --force to overwrite.");
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function writeSolidPng(filename, size) {
  const png = new PNG({ width: size, height: size, colorType: 6 });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (size * y + x) << 2;
      png.data[idx] = R;
      png.data[idx + 1] = G;
      png.data[idx + 2] = B;
      png.data[idx + 3] = 255;
    }
  }
  const out = path.join(publicDir, filename);
  return new Promise((resolve, reject) => {
    png
      .pack()
      .pipe(fs.createWriteStream(out))
      .on("finish", resolve)
      .on("error", reject);
  });
}

if (await shouldSkip()) {
  process.exit(0);
}

await fs.promises.mkdir(publicDir, { recursive: true });
await writeSolidPng("pwa-192.png", 192);
await writeSolidPng("pwa-512.png", 512);
console.log("Wrote placeholder public/pwa-192.png and public/pwa-512.png");
