"""识图请求前：EXIF 方向校正、缩略、统一 RGB JPEG，减轻手机实拍与百度接口的分布差异。"""
from __future__ import annotations

import base64
from io import BytesIO

from PIL import Image, ImageOps

MAX_SIDE = 2048
JPEG_QUALITY = 90


def normalize_identify_image_base64(b64: str) -> str:
    """
    输入可为纯 base64 或 data URL；失败时返回去掉 data 前缀后的原始 base64，避免整链失败。
    """
    raw = (b64 or "").strip()
    if raw.startswith("data:"):
        try:
            raw = raw.split(",", 1)[1]
        except IndexError:
            return (b64 or "").strip()
    try:
        binary = base64.b64decode(raw, validate=False)
    except Exception:
        return raw
    try:
        im = Image.open(BytesIO(binary))
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "P"):
            if im.mode == "RGBA":
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[3])
                im = bg
            else:
                im = im.convert("RGB")
        elif im.mode != "RGB":
            im = im.convert("RGB")
        w, h = im.size
        if max(w, h) > MAX_SIDE:
            im.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
        buf = BytesIO()
        im.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return raw
