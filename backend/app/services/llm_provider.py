import requests
from flask import current_app


def local_fallback_answer(question: str):
    q = (question or "").strip()
    if "烟" in q or "火" in q:
        return (
            "离线建议：发现烟点后优先确保人身安全，记录位置并立即上报。"
            "避免单人贸然处置，等待联动处置人员。"
        )
    if "病" in q or "虫" in q:
        return "离线建议：记录异常叶片症状、时间和地点，先上报再由专业人员复核。"
    return "离线建议：当前仅提供基础本地回答。联网后可获取增强版问答。"


def ask_llm_or_fallback(
    question: str,
    citations: list[dict] | None = None,
    context_messages: list[dict] | None = None,
):
    base_url = current_app.config["LLM_API_BASE_URL"]
    api_key = current_app.config["LLM_API_KEY"]
    model = current_app.config["LLM_MODEL_NAME"]
    timeout = current_app.config["THIRD_PARTY_TIMEOUT_SECONDS"]
    citations = citations or []
    context_messages = context_messages or []

    if not citations:
        return "无法给出操作建议：当前知识依据不足，请补充资料后重试。", "fallback-no-citation"

    if not api_key or not base_url:
        return local_fallback_answer(question), "fallback-local"

    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    refs = "\n".join(
        [f"[{idx+1}] 来源：{item.get('source', '未知来源')}；片段：{item.get('snippet', '')}" for idx, item in enumerate(citations)]
    )
    prompt_messages = [
        {
            "role": "system",
            "content": "你是林业助手，必须基于给定引用回答，不得编造；无法确定时明确提示无法给出操作建议。",
        }
    ]
    for msg in context_messages[-6:]:
        role = (msg.get("role") or "").strip()
        content = (msg.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        prompt_messages.append({"role": role, "content": content})
    prompt_messages.append(
        {
            "role": "user",
            "content": f"问题：{question}\n\n引用资料：\n{refs}\n\n请给出简洁回答并保留引用编号。",
        }
    )
    try:
        response = requests.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": prompt_messages,
                "temperature": 0.2,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json() or {}
        choices = payload.get("choices") or []
        content = ((choices[0].get("message") or {}).get("content") or "").strip() if choices else ""
        if not content:
            raise ValueError("LLM 响应为空")
        return content, "deepseek"
    except Exception:  # noqa: BLE001
        return local_fallback_answer(question), "fallback-local"
