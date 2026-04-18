import json
import re

import requests
from flask import current_app


def classify_forestry_related(question: str, conversation_snippet: str | None = None) -> bool:
    """
    判断用户问题是否与林业工作相关。返回 False 表示应拒绝回答。
    网络错误或解析失败时返回 True（放行），避免门控故障导致服务不可用。
    """
    base_url = current_app.config["LLM_API_BASE_URL"]
    api_key = current_app.config["LLM_API_KEY"]
    model = current_app.config["LLM_MODEL_NAME"]
    timeout = int(current_app.config.get("LLM_CLASSIFY_TIMEOUT_SECONDS", 20))
    q = (question or "").strip()
    if not q:
        return True

    if not api_key or not base_url:
        return True

    if conversation_snippet and conversation_snippet.strip():
        user_content = (
            "【近期对话片段】\n"
            f"{conversation_snippet.strip()}\n\n"
            "【当前一句提问】\n"
            f"{q}\n\n"
            "请结合上下文判断「当前提问」是否与林业相关。"
        )
    else:
        user_content = f"【用户提问】\n{q}"

    system_content = (
        "你是内容分类器，只判断用户问题是否与林业工作相关。"
        "相关包括：森林管护、森林防火、造林抚育、林木病虫害、林地与采伐、生态巡护、"
        "野生动植物保护（林业场景）、常见树种栽培与管护、林业政策法规与作业安全等。"
        "不相关包括：与林业无关的编程、游戏、娱乐、财经、纯闲聊等。"
        "若近期对话在讨论林业，而当前句为简短承接（如「呢」「再说详细点」），仍视为相关。"
        "只输出一行 JSON，不要有其他文字，格式严格为："
        '{"forestry": true} 或 {"forestry": false}'
    )
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    try:
        response = requests.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_content},
                    {"role": "user", "content": user_content},
                ],
                "temperature": 0,
                "max_tokens": 32,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json() or {}
        choices = payload.get("choices") or []
        raw = ((choices[0].get("message") or {}).get("content") or "").strip() if choices else ""
        if not raw:
            return True
        m = re.search(r"\{[^{}]*\}", raw, re.DOTALL)
        blob = m.group(0) if m else raw
        data = json.loads(blob)
        if isinstance(data, dict) and "forestry" in data:
            return bool(data["forestry"])
    except Exception:  # noqa: BLE001
        return True
    return True


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
    timeout = current_app.config["LLM_TIMEOUT_SECONDS"]
    max_ctx = int(current_app.config.get("LLM_CONTEXT_MESSAGES_MAX", 20))
    citations = citations or []
    context_messages = context_messages or []

    if not api_key or not base_url:
        return local_fallback_answer(question), "fallback-local"

    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    if citations:
        system_content = (
            "你是林业助手。若下方提供了「引用资料」，请优先依据引用作答并在相应处保留引用编号（如[1][2]）；"
            "若引用不足以完整回答问题，可结合可靠的通用林业与植物学常识作补充说明。"
            "回答简洁清晰。"
        )
        refs = "\n".join(
            [
                f"[{idx+1}] 来源：{item.get('source', '未知来源')}；片段：{item.get('snippet', '')}"
                for idx, item in enumerate(citations)
            ]
        )
        user_content = f"问题：{question}\n\n引用资料：\n{refs}\n\n请作答。"
    else:
        system_content = (
            "你是林业与植物领域的助手，请用准确、简洁的中文回答用户问题；不确定时请明确说明。"
        )
        user_content = f"问题：{question}"

    prompt_messages = [{"role": "system", "content": system_content}]
    for msg in context_messages[-max_ctx:]:
        role = (msg.get("role") or "").strip()
        content = (msg.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        prompt_messages.append({"role": role, "content": content})
    prompt_messages.append({"role": "user", "content": user_content})
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
