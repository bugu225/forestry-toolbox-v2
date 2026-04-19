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


# 与前端知识库分组顺序一致；分类必须落在此集合内（否则归为「其他」）
FORESTRY_KNOWLEDGE_CATEGORIES = (
    "森林防火",
    "林木病虫害",
    "造林抚育",
    "林地与采伐",
    "生态巡护",
    "野生动植物保护",
    "政策法规与执法",
    "机具与作业安全",
    "油茶与经济林",
    "生态修复",
    "其他",
)


def _extract_json_object(raw: str) -> dict:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```\s*$", "", text)
    text = text.strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        raise ValueError("无法解析模型返回的 JSON")
    data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise ValueError("模型返回不是 JSON 对象")
    return data


def organize_knowledge_document(raw_text: str, source_filename: str | None = None) -> dict:
    """
    联网调用 LLM，将用户资料整理为固定字段。返回 dict 供前端写入 IndexedDB。
    raises ValueError: 未配置 Key、正文为空、解析失败等。
    """
    base_url = current_app.config["LLM_API_BASE_URL"]
    api_key = current_app.config["LLM_API_KEY"]
    model = current_app.config["LLM_MODEL_NAME"]
    timeout = current_app.config["LLM_TIMEOUT_SECONDS"]
    max_chars = int(current_app.config.get("LLM_KNOWLEDGE_IMPORT_MAX_CHARS", 14000))
    full_text = (raw_text or "").strip()
    if not full_text:
        raise ValueError("正文不能为空")
    if not api_key or not base_url:
        raise ValueError("未配置 LLM，无法在线整理资料")

    text_for_model = full_text[:max_chars]
    fname = (source_filename or "").strip() or "未命名文件"

    cats = "、".join(FORESTRY_KNOWLEDGE_CATEGORIES)
    system_content = (
        "你是林业资料编目助手。根据用户提供的正文，提取结构化信息。"
        "category 必须从以下类目中选择其一（完全一致）："
        f"{cats}。"
        "若难以归类，选「其他」。"
        "只输出一个 JSON 对象，不要 markdown 代码围栏，不要其它说明文字。"
        '字段：title（≤40字）、category（上述之一）、keywords（3～8个字符串数组）、'
        'summary（≤300字中文摘要，覆盖要点）。'
    )
    user_content = (
        f"【文件名】{fname}\n\n【正文】\n{text_for_model}"
        + (f"\n\n（正文已截断至前 {max_chars} 字用于分析，分类仍应代表全文主题）" if len(full_text) > max_chars else "")
    )

    endpoint = f"{base_url.rstrip('/')}/chat/completions"
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
            "temperature": 0.2,
            "max_tokens": 900,
        },
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json() or {}
    choices = payload.get("choices") or []
    raw_out = ((choices[0].get("message") or {}).get("content") or "").strip() if choices else ""
    if not raw_out:
        raise ValueError("模型返回为空")

    try:
        data = _extract_json_object(raw_out)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"无法解析整理结果，请重试或缩短正文：{exc}") from exc
    title = str(data.get("title") or "").strip() or fname
    if len(title) > 80:
        title = title[:80]
    category = str(data.get("category") or "").strip() or "其他"
    if category not in FORESTRY_KNOWLEDGE_CATEGORIES:
        category = "其他"
    kw_raw = data.get("keywords") or []
    if isinstance(kw_raw, str):
        kw_raw = [k.strip() for k in re.split(r"[,，;；\s]+", kw_raw) if k.strip()]
    keywords = []
    for k in kw_raw:
        if not isinstance(k, str):
            continue
        s = k.strip()
        if s and s not in keywords:
            keywords.append(s)
        if len(keywords) >= 10:
            break
    if len(keywords) < 3:
        keywords = (keywords + ["林业", "资料", "速查"])[:3]

    summary = str(data.get("summary") or "").strip() or title
    if len(summary) > 500:
        summary = summary[:500]

    content_cap = 150000
    body = full_text[:content_cap]
    if len(full_text) > content_cap:
        summary = (summary + "（正文过长，已截断保存）")[:500]

    return {
        "title": title,
        "category": category,
        "keywords": keywords,
        "summary": summary,
        "content": body,
        "source_filename": fname,
    }


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


def brief_species_intro_zh(species_name: str, *, source_channel: str = "") -> str:
    """
    调用 DeepSeek 生成不超过 100 个汉字（含标点）的物种简介；未配置 Key 或失败时返回空串。
    仅在 Flask 请求上下文中调用（使用 current_app）。
    """
    base_url = (current_app.config.get("LLM_API_BASE_URL") or "").strip()
    api_key = (current_app.config.get("LLM_API_KEY") or "").strip()
    model = current_app.config.get("LLM_MODEL_NAME", "deepseek-chat")
    timeout = int(current_app.config.get("LLM_IDENTIFY_INTRO_TIMEOUT_SECONDS", 28))
    name = (species_name or "").strip()
    if not name or not api_key:
        return ""

    ch = "植物" if source_channel == "plant" else ("动物" if source_channel == "animal" else "动植物")
    system_content = (
        "你是林业与生态领域的科普助手。仅用简体中文输出一段连续文字，不要使用 Markdown、编号、引号或小标题。"
        "总长度严格不超过 100 个汉字（含标点），只写该物种最核心、便于野外辨认或管护认知的要点。"
    )
    user_content = (
        f"物种名称：{name}\n"
        f"百度识图通道：{ch}\n"
        "请直接输出简介正文，不要重复物种名当标题。"
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
                "temperature": 0.25,
                "max_tokens": 220,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json() or {}
        choices = payload.get("choices") or []
        text = ((choices[0].get("message") or {}).get("content") or "").strip() if choices else ""
        text = re.sub(r"[\r\n]+", "", text) if text else ""
        if not text:
            return ""
        if len(text) > 100:
            return text[:99] + "…"
        return text
    except Exception:  # noqa: BLE001
        return ""
