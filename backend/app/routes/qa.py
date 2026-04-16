import hashlib
import json

from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from ..extensions import db
from ..models import KnowledgeDoc, QAMessage, QASession, SyncAuditLog, SyncCheckpoint
from ..services.llm_provider import ask_llm_or_fallback

qa_bp = Blueprint("qa", __name__)


def _sessions_for_hash(sessions: list[dict]):
    normalized = []
    for item in sessions:
        normalized.append(
            {
                "local_id": item.get("local_id") or "",
                "title": item.get("title") or "",
                "created_at": item.get("created_at") or "",
            }
        )
    normalized.sort(key=lambda x: (x["local_id"], x["title"], x["created_at"]))
    return normalized


def _messages_for_hash(messages: list[dict]):
    normalized = []
    for item in messages:
        normalized.append(
            {
                "local_id": item.get("local_id") or "",
                "session_local_id": item.get("session_local_id") or "",
                "role": item.get("role") or "",
                "content": item.get("content") or "",
                "citations": item.get("citations") or [],
            }
        )
    normalized.sort(key=lambda x: (x["session_local_id"], x["local_id"], x["role"]))
    return normalized


def _append_sync_audit(*, user_id: int, status: str, deduplicated: bool, summary: dict, error_message: str = ""):
    db.session.add(
        SyncAuditLog(
            user_id=user_id,
            module="qa",
            status=status,
            deduplicated=deduplicated,
            summary_json=summary,
            error_message=error_message[:500] if error_message else None,
        )
    )


RULE_CITATION_LIBRARY = [
    {
        "source": "森林防火基础规范（示例）",
        "keywords": ["烟", "火", "火情", "火灾", "燃烧", "明火"],
        "snippet": "发现烟点后应第一时间定位并上报，禁止单人冒险扑救。",
    },
    {
        "source": "林木病虫害识别手册（示例）",
        "keywords": ["病", "虫", "病虫", "病害", "虫害", "叶斑", "枯萎"],
        "snippet": "采样记录应包含时间、地点、树种及异常描述。",
    },
    {
        "source": "松材线虫病防控要点（示例）",
        "keywords": ["松材线虫", "线虫", "松材", "疫木", "除治"],
        "snippet": "疑似疫木应隔离标记并按规定取样送检，避免疫木运输与擅自处理。",
    },
    {
        "source": "森林防火期与火源管理（示例）",
        "keywords": ["防火期", "森林防火期", "禁火", "野外用火"],
        "snippet": "防火期内严控野外用火，具体时段以当地林业部门公告为准。",
    },
    {
        "source": "巡护记录规范（示例）",
        "keywords": ["巡护", "巡查", "轨迹", "点位", "异常", "上报"],
        "snippet": "巡护过程应记录关键点位、异常事件和时间。",
    },
    {
        "source": "应急响应流程（示例）",
        "keywords": ["应急", "处置", "报告", "联动", "风险", "安全"],
        "snippet": "高风险事件先确保人员安全，再进行分级上报和联动处置。",
    },
    {
        "source": "森林火灾应急处置卡（示例）",
        "keywords": ["火灾", "火情", "防火期", "扑救", "灭火", "烟点"],
        "snippet": "火情上报应包含时间、位置、可视烟火范围和现场风险，优先组织人员撤离。",
    },
    {
        "source": "野外伤病急救要点（示例）",
        "keywords": ["急救", "受伤", "蛇咬", "中暑", "骨折", "失温"],
        "snippet": "野外急救应先做生命体征评估，快速止血固定并尽快转运至医疗点。",
    },
    {
        "source": "油茶栽培管理要点（示例）",
        "keywords": ["油茶", "施肥", "栽培", "修剪", "管护"],
        "snippet": "油茶管护应关注整形修剪、季节施肥和病虫害巡查，保持土壤通气与保墒。",
    },
    {
        "source": "森林巡护记录规范（示例）",
        "keywords": ["巡护", "记录", "点位", "轨迹", "异常"],
        "snippet": "巡护记录应包含时间、位置、现场照片和异常描述，便于后续复核。",
    },
    {
        "source": "生态观测记录建议（示例）",
        "keywords": ["生态", "动物", "观测", "记录", "栖息地"],
        "snippet": "生态观测以不惊扰为原则，记录物种、数量、位置与行为特征。",
    },
    {
        "source": "野外遇野生动物安全提示（示例）",
        "keywords": ["野生动物", "遇熊", "遇蛇", "对峙", "驱赶"],
        "snippet": "保持安全距离、避免投喂与突然动作，缓慢撤离并上报主管部门。",
    },
]

POLICY_ITEMS = [
    {
        "id": "fire_emergency",
        "title": "火情应急速查（示例）",
        "keywords": ["火情", "火灾", "应急", "烟点", "撤离"],
        "summary": "优先保障人员安全，快速记录位置与风险信息，完成分级上报。",
    },
    {
        "id": "first_aid",
        "title": "野外急救速查（示例）",
        "keywords": ["急救", "受伤", "中暑", "蛇咬", "失温"],
        "summary": "先做生命体征评估，再止血固定与保温，并尽快联系救援。",
    },
    {
        "id": "tea_management",
        "title": "油茶管护速查（示例）",
        "keywords": ["油茶", "施肥", "修剪", "病虫害", "管护"],
        "summary": "按季节开展修剪与施肥，结合病虫害巡查形成闭环管理。",
    },
    {
        "id": "pine_wilt",
        "title": "松材线虫病速查（示例）",
        "keywords": ["松材线虫", "线虫", "疫木", "松材"],
        "summary": "关注枯死松树与媒介昆虫迹象，按规定报告并配合检疫除治。",
    },
    {
        "id": "fire_season",
        "title": "森林防火期速查（示例）",
        "keywords": ["防火期", "森林防火期", "禁火期", "野外用火"],
        "summary": "防火期时段因地区而异，以政府公告为准；严控火源并及时上报。",
    },
]


def _serialize_doc(doc: KnowledgeDoc):
    return {
        "id": f"doc_{doc.id}",
        "title": doc.title,
        "category": doc.category,
        "keywords": doc.keywords or [],
        "summary": (doc.content or "")[:80],
        "content": doc.content or "",
    }


def _build_rule_citations(question: str):
    q = (question or "").strip()
    if not q:
        return []

    scored = []
    for item in RULE_CITATION_LIBRARY:
        score = sum(1 for kw in item["keywords"] if kw in q)
        if score > 0:
            scored.append((score, {"source": item["source"], "snippet": item["snippet"]}))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    citations = [entry for _, entry in scored[:3]]

    if not citations:
        citations = [
            {
                "source": "通用巡护安全提示（示例）",
                "snippet": "无法确定场景时，先记录现象与位置，保障安全并及时上报。",
            }
        ]

    return citations


def _build_session_context(session_id: int, limit: int = 6):
    rows = (
        QAMessage.query.filter_by(session_id=session_id)
        .order_by(QAMessage.created_at.desc())
        .limit(limit)
        .all()
    )
    context = []
    for row in reversed(rows):
        context.append({"role": row.role, "content": row.content})
    return context


@qa_bp.post("/sync")
@jwt_required()
def sync_qa():
    identity = int(get_jwt_identity())
    try:
        payload = request.get_json(silent=True) or {}
        sessions = payload.get("sessions") or []
        messages = payload.get("messages") or []
        dedup_payload = {
            "sessions": _sessions_for_hash(sessions),
            "messages": _messages_for_hash(messages),
        }
        payload_raw = json.dumps(dedup_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        payload_hash = hashlib.sha256(payload_raw.encode("utf-8")).hexdigest()
        checkpoint = SyncCheckpoint.query.filter_by(user_id=identity, module="qa", payload_hash=payload_hash).first()
        if checkpoint:
            cached = checkpoint.response_json or {}
            _append_sync_audit(
                user_id=identity,
                status="success",
                deduplicated=True,
                summary={
                    "inserted_sessions": cached.get("inserted_sessions", 0),
                    "inserted_messages": cached.get("inserted_messages", 0),
                },
            )
            db.session.commit()
            return jsonify(
                {
                    "ok": True,
                    "deduplicated": True,
                    "mapped_sessions": cached.get("mapped_sessions", {}),
                    "inserted_sessions": cached.get("inserted_sessions", 0),
                    "inserted_messages": cached.get("inserted_messages", 0),
                }
            )

        local_to_server = {}
        inserted_sessions = 0
        for item in sessions:
            local_id = (item.get("local_id") or "").strip()
            title = (item.get("title") or "").strip() or "离线问答会话"
            session = QASession(user_id=identity, title=title)
            db.session.add(session)
            db.session.flush()
            inserted_sessions += 1
            if local_id:
                local_to_server[local_id] = session.id

        inserted_messages = 0
        for item in messages:
            local_session_id = (item.get("session_local_id") or "").strip()
            session_id = local_to_server.get(local_session_id)
            if not session_id:
                continue
            role = (item.get("role") or "user").strip()
            content = (item.get("content") or "").strip()
            if not content:
                continue
            db.session.add(
                QAMessage(
                    session_id=session_id,
                    role=role if role in ("user", "assistant") else "user",
                    content=content,
                    citations=item.get("citations") or [],
                )
            )
            inserted_messages += 1

        response_payload = {
            "mapped_sessions": local_to_server,
            "inserted_sessions": inserted_sessions,
            "inserted_messages": inserted_messages,
        }
        db.session.add(
            SyncCheckpoint(
                user_id=identity,
                module="qa",
                payload_hash=payload_hash,
                response_json=response_payload,
            )
        )
        _append_sync_audit(
            user_id=identity,
            status="success",
            deduplicated=False,
            summary={
                "inserted_sessions": inserted_sessions,
                "inserted_messages": inserted_messages,
            },
        )
        db.session.commit()
        return jsonify({"ok": True, "deduplicated": False, **response_payload})
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        _append_sync_audit(
            user_id=identity,
            status="failed",
            deduplicated=False,
            summary={},
            error_message=str(exc),
        )
        db.session.commit()
        return jsonify({"error": {"code": "sync_failed", "message": f"问答同步失败：{exc}"}}), 500


@qa_bp.post("/ask")
@jwt_required()
def ask_online_or_fallback():
    identity = int(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    session_id = data.get("session_id")
    if not question:
        return jsonify({"error": {"code": "bad_request", "message": "问题不能为空"}}), 422

    if session_id:
        session = QASession.query.filter_by(id=session_id, user_id=identity).first()
        if not session:
            return jsonify({"error": {"code": "not_found", "message": "会话不存在"}}), 404
    else:
        session = QASession(user_id=identity, title=question[:24] or "问答会话")
        db.session.add(session)
        db.session.flush()

    db.session.add(QAMessage(session_id=session.id, role="user", content=question, citations=[]))

    citations = _build_rule_citations(question)
    context_messages = _build_session_context(session.id, limit=6)
    answer, provider = ask_llm_or_fallback(
        question=question,
        citations=citations,
        context_messages=context_messages,
    )
    db.session.add(QAMessage(session_id=session.id, role="assistant", content=answer, citations=citations))
    db.session.commit()

    return jsonify(
        {"answer": answer, "citations": citations, "provider": provider, "session_id": session.id}
    )


@qa_bp.get("/sessions")
@jwt_required()
def list_sessions():
    identity = int(get_jwt_identity())
    rows = (
        QASession.query.filter_by(user_id=identity).order_by(QASession.created_at.desc()).all()
    )
    return jsonify(
        {
            "items": [
                {"id": row.id, "title": row.title, "created_at": row.created_at.isoformat()}
                for row in rows
            ]
        }
    )


@qa_bp.get("/sessions/<int:session_id>/messages")
@jwt_required()
def session_messages(session_id: int):
    identity = int(get_jwt_identity())
    session = QASession.query.filter_by(id=session_id, user_id=identity).first()
    if not session:
        return jsonify({"error": {"code": "not_found", "message": "会话不存在"}}), 404

    rows = QAMessage.query.filter_by(session_id=session.id).order_by(QAMessage.created_at.asc()).all()
    return jsonify(
        {
            "items": [
                {
                    "id": row.id,
                    "role": row.role,
                    "content": row.content,
                    "citations": row.citations or [],
                    "created_at": row.created_at.isoformat(),
                }
                for row in rows
            ]
        }
    )


@qa_bp.get("/knowledge-search")
@qa_bp.get("/policy-search")
@jwt_required()
def knowledge_search():
    keyword = (request.args.get("q") or "").strip()
    docs = KnowledgeDoc.query.order_by(KnowledgeDoc.created_at.desc()).all()
    items = [_serialize_doc(doc) for doc in docs]
    if keyword:
        ranked = []
        for item in items:
            title = item["title"]
            content = item["content"]
            keywords = item["keywords"]
            score = 0
            if keyword in title:
                score += 3
            if keyword in content:
                score += 1
            score += sum(2 for kw in keywords if kw and kw in keyword)
            if score > 0:
                ranked.append((score, item))
        ranked.sort(key=lambda pair: pair[0], reverse=True)
        items = [entry for _, entry in ranked] or items

    if not items:
        items = POLICY_ITEMS
    return jsonify({"items": items})


@qa_bp.get("/knowledge-docs")
@jwt_required()
def list_knowledge_docs():
    docs = KnowledgeDoc.query.order_by(KnowledgeDoc.created_at.desc()).all()
    return jsonify({"items": [_serialize_doc(doc) for doc in docs]})
