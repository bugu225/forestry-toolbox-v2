import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from flask import current_app

# 百度两路合并后，若最高置信度仍低于此值，视为「未识别为可信动植物」
NON_BIOTA_CONFIDENCE_MAX = 0.15

ONLY_BIOTA_GUIDE_ZH = (
    "百度植物与动物识别通道**未将该图判定为足够可信的动植物类别**（或两路均无有效返回）。\n"
    "**本识图功能仅支持植物与动物相关主体**（如树木、花草、鸟类、昆虫等），无法对化妆品、日用品、建筑、文字界面等非生物场景给出有效鉴定。\n"
    "请更换为清晰的动植物主体后重试。"
)

UNCONFIGURED_NOTICE_ZH = (
    "未配置百度识图密钥或缺少图片数据。\n"
    "请在 **backend/.env.local** 或 **项目根目录 .env.local** 中填写 `PLANT_API_KEY`、`PLANT_API_SECRET`（参考仓库 `.env.example`），"
    "保存后**重启后端**；并确认本机能访问 `https://aip.baidubce.com`、账号额度正常。"
)


def _norm_score(raw) -> float:
    """百度 score 一般为 0~1；若遇 0~100 则归一化。"""
    try:
        x = float(raw or 0)
    except (TypeError, ValueError):
        return 0.0
    if x > 1.0:
        return max(0.0, min(x / 100.0, 1.0))
    return max(0.0, min(x, 1.0))


def _max_confidence(top_k: list) -> float:
    if not top_k:
        return 0.0
    return max(float(x.get("confidence") or 0) for x in top_k)


def _build_user_notice_zh(top_k: list, provider: str) -> str | None:
    """在「仍有候选列表」但需弱化信任时使用（真实百度且置信度偏低）。"""
    mx = _max_confidence(top_k)
    if not top_k:
        return None

    if mx < 0.22:
        return (
            f"在当前图像下，植物与动物通道的综合最高置信度仅约 {mx * 100:.0f}%，整体偏低；"
            "画面可能不包含清晰的典型植物或动物，或与林业识图常见场景不符。"
            "若主体明显为非生物物体，下列候选很可能不具备参考价值。"
        )
    return None


def _parse_baidu_top(results, source: str, limit: int):
    out = []
    for item in (results or [])[:limit]:
        name = (item.get("name") or "").strip()
        if not name:
            continue
        out.append({"name": name, "confidence": _norm_score(item.get("score")), "source": source})
    return out


def _request_baidu_classify(api_base_url: str, access_token: str, path: str, payload_image: str, timeout: int):
    """注意：可能被 ThreadPoolExecutor 子线程调用，禁止在此读取 Flask current_app。"""
    base = (api_base_url or "").rstrip("/")
    url = f"{base}{path}"
    response = requests.post(
        url,
        params={"access_token": access_token},
        data={"image": payload_image, "baike_num": 0},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json() or {}
    if payload.get("error_code"):
        raise ValueError(
            f"百度识图失败：{payload.get('error_msg', 'unknown')} ({payload.get('error_code')})"
        )
    return payload.get("result") or []


def identify_plant(image_name: str, image_base64: str | None):
    """
    调用百度「植物识别」与「动物识别」，合并为一条结果列表（按置信度排序）。
    每项含 name、confidence、source（plant | animal）。
    返回 (top_k, provider, used_mock, latency_ms, user_notice_zh)。

    - 未配置密钥：top_k 为空，不再返回假物种列表。
    - 调用失败：top_k 为空，提示检查密钥与网络。
    - 两路均无命中或置信度极低：top_k 为空，返回 ONLY_BIOTA 专用说明（等价于「不是可信动植物」）。
    """
    api_key = current_app.config["PLANT_API_KEY"]
    api_secret = current_app.config["PLANT_API_SECRET"]
    base_url = current_app.config["PLANT_API_BASE_URL"]
    timeout = current_app.config["THIRD_PARTY_TIMEOUT_SECONDS"]
    retries = current_app.config["THIRD_PARTY_RETRIES"]

    if not api_key or not api_secret or not image_base64:
        return [], "unconfigured", False, 0, UNCONFIGURED_NOTICE_ZH

    token_endpoint = f"{base_url.rstrip('/')}/oauth/2.0/token"
    plant_path = "/rest/2.0/image-classify/v1/plant"
    animal_path = "/rest/2.0/image-classify/v1/animal"

    payload_image = image_base64
    if payload_image.startswith("data:"):
        payload_image = payload_image.split(",", 1)[1]

    last_error: Exception | None = None
    for _ in range(retries + 1):
        start = time.perf_counter()
        try:
            token_response = requests.post(
                token_endpoint,
                params={
                    "grant_type": "client_credentials",
                    "client_id": api_key,
                    "client_secret": api_secret,
                },
                timeout=timeout,
            )
            token_response.raise_for_status()
            access_token = (token_response.json() or {}).get("access_token")
            if not access_token:
                raise ValueError("未获取到 access_token")

            plant_top: list = []
            animal_top: list = []
            errors: list[str] = []
            api_base = (base_url or "").rstrip("/")

            def run_plant():
                raw = _request_baidu_classify(api_base, access_token, plant_path, payload_image, timeout)
                return _parse_baidu_top(raw, "plant", 5)

            def run_animal():
                raw = _request_baidu_classify(api_base, access_token, animal_path, payload_image, timeout)
                return _parse_baidu_top(raw, "animal", 5)

            with ThreadPoolExecutor(max_workers=2) as pool:
                future_map = {
                    pool.submit(run_plant): "plant",
                    pool.submit(run_animal): "animal",
                }
                for fut in as_completed(future_map):
                    label = future_map[fut]
                    try:
                        rows = fut.result()
                        if label == "plant":
                            plant_top = rows
                        else:
                            animal_top = rows
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f"{label}:{exc}")

            merged = plant_top + animal_top
            merged.sort(key=lambda x: -x["confidence"])
            top_k = merged[:8]
            latency_ms = int((time.perf_counter() - start) * 1000)

            if not top_k:
                detail = f"（{';'.join(errors)}）" if errors else ""
                notice = (
                    ONLY_BIOTA_GUIDE_ZH
                    + (f"\n\n通道侧信息：植物/动物接口未返回有效标签{detail}" if detail else "")
                )
                return [], "baidu-no-hit", False, latency_ms, notice

            mx = _max_confidence(top_k)
            if mx < NON_BIOTA_CONFIDENCE_MAX:
                notice = ONLY_BIOTA_GUIDE_ZH + (
                    f"\n\n（当前最高置信度约 {mx * 100:.1f}% ，低于判定阈值，故不展示具体候选名称。）"
                )
                return [], "baidu-non-biota", False, latency_ms, notice

            prov_bits = []
            if plant_top:
                prov_bits.append("plant")
            if animal_top:
                prov_bits.append("animal")
            provider = "baidu_" + "+".join(prov_bits) if prov_bits else "baidu"
            if errors:
                provider += ";partial"

            notice = _build_user_notice_zh(top_k, provider)
            return top_k, provider, False, latency_ms, notice
        except Exception as exc:  # noqa: BLE001
            last_error = exc

    err = last_error or RuntimeError("unknown")
    notice = (
        "调用百度识图失败，请检查：`PLANT_API_KEY` / `PLANT_API_SECRET` 是否正确、"
        "本机网络能否访问百度智能云、接口额度是否充足，并适当增大 `THIRD_PARTY_TIMEOUT_SECONDS` 后重启后端。\n"
        f"摘要：{err!s}"[:400]
    )
    return [], "baidu-error", False, 0, notice
