import base64
import time
from pathlib import Path

import requests
from flask import current_app


def _mock_identify_result(image_name: str):
    base = (image_name or "未知植物").split(".")[0]
    return [
        {"name": f"{base}（候选1）", "confidence": 0.85},
        {"name": f"{base}（候选2）", "confidence": 0.63},
        {"name": f"{base}（候选3）", "confidence": 0.44},
    ]


def identify_plant(image_name: str, image_base64: str | None):
    """
    Return (top_k, provider, used_mock, latency_ms)
    """
    api_key = current_app.config["PLANT_API_KEY"]
    api_secret = current_app.config["PLANT_API_SECRET"]
    base_url = current_app.config["PLANT_API_BASE_URL"]
    timeout = current_app.config["THIRD_PARTY_TIMEOUT_SECONDS"]
    retries = current_app.config["THIRD_PARTY_RETRIES"]

    if not api_key or not api_secret or not image_base64:
        return _mock_identify_result(image_name), "mock", True, 0

    token_endpoint = f"{base_url.rstrip('/')}/oauth/2.0/token"
    identify_endpoint = f"{base_url.rstrip('/')}/rest/2.0/image-classify/v1/plant"

    last_error = None
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

            # If payload already contains data-url prefix, strip it.
            payload_image = image_base64
            if payload_image.startswith("data:"):
                payload_image = payload_image.split(",", 1)[1]

            response = requests.post(
                identify_endpoint,
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
            results = payload.get("result") or []
            top_k = []
            for item in results[:5]:
                name = (item.get("name") or "").strip()
                if not name:
                    continue
                top_k.append({"name": name, "confidence": float(item.get("score", 0))})
            if not top_k:
                raise ValueError("识图结果为空")
            latency_ms = int((time.perf_counter() - start) * 1000)
            return top_k, "baidu_plant", False, latency_ms
        except Exception as exc:  # noqa: BLE001
            last_error = exc

    fallback = _mock_identify_result(image_name)
    return fallback, f"mock-fallback:{type(last_error).__name__}", True, 0
