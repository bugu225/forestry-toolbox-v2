from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from ..extensions import db
from ..models import PlantIdentification
from ..services.llm_provider import brief_species_intro_zh
from ..services.plant_provider import identify_plant

identify_bp = Blueprint("identify", __name__)

NON_BIOTA_GATE_MSG = (
    "非植物、非动物主体。您上传的内容不是动植物主体，超出了本识图功能范围；"
    "本功能仅支持对植物、动物进行识别与简介。请拍摄或上传清晰的树木、花草、鸟类、昆虫等图像后再试。"
)


def _is_negative_placeholder_name(name: str) -> bool:
    """百度通道会返回「非动物」「非植物」等否定类标签，不作为有效物种。"""
    n = (name or "").strip()
    if not n:
        return True
    if n in ("非动物", "非植物", "非生物"):
        return True
    if n.startswith("非动物") or n.startswith("非植物"):
        return True
    return False


def _best_biota_candidate(top_k: list) -> dict | None:
    rows = [
        x
        for x in (top_k or [])
        if isinstance(x, dict) and not _is_negative_placeholder_name(str(x.get("name") or ""))
    ]
    if not rows:
        return None
    rows.sort(key=lambda x: -float(x.get("confidence") or 0))
    return rows[0]


def _build_risk_level(scene_type: str, confidence: float) -> str:
    scene = (scene_type or "general").strip()
    score = float(confidence or 0.0)
    if scene == "pest":
        if score >= 0.75:
            return "high"
        if score >= 0.45:
            return "medium"
        return "low"
    if scene == "disease":
        if score >= 0.80:
            return "high"
        if score >= 0.50:
            return "medium"
        return "low"
    if scene == "wildlife":
        if score >= 0.70:
            return "high"
        if score >= 0.40:
            return "medium"
        return "low"
    if score >= 0.85:
        return "medium"
    return "low"


@identify_bp.get("/history")
@jwt_required()
def history():
    identity = int(get_jwt_identity())
    rows = (
        PlantIdentification.query.filter_by(user_id=identity)
        .order_by(PlantIdentification.created_at.desc())
        .all()
    )
    return jsonify(
        {
            "items": [
                {
                    "id": row.id,
                    "image_name": row.image_name,
                    "result_json": row.result_json,
                    "confidence": row.confidence,
                    "scene_type": row.scene_type or "general",
                    "risk_level": row.risk_level or "low",
                    "created_at": row.created_at.isoformat(),
                }
                for row in rows
            ]
        }
    )


@identify_bp.post("/sync")
@jwt_required()
def sync_identify():
    """识图主接口：提交任务并返回识别结果（路径名沿用 /sync，避免前端大规模改动）。"""
    identity = int(get_jwt_identity())
    try:
        payload = request.get_json(silent=True) or {}
        jobs = payload.get("jobs") or []

        inserted = 0
        synced_items = []
        for item in jobs:
            image_name = (item.get("image_name") or "").strip() or "离线图片"
            scene_type = (item.get("scene_type") or "general").strip() or "general"
            local_result = item.get("result_json")
            user_notice_zh = None
            if isinstance(local_result, list) and local_result:
                top_k = local_result
                provider = "local-precomputed"
                used_mock = True
            else:
                top_k, provider, used_mock, _, user_notice_zh = identify_plant(image_name, item.get("image_base64"))

            best = _best_biota_candidate(top_k) if top_k else None
            intro_zh = ""
            display_mode = "legacy_full_list"
            out_notice = user_notice_zh

            if isinstance(local_result, list) and local_result:
                display_mode = "legacy_full_list"
            elif not top_k:
                display_mode = "empty_or_error"
            elif best is None:
                display_mode = "non_biota_gate"
                out_notice = NON_BIOTA_GATE_MSG
            else:
                display_mode = "biota_with_intro"
                out_notice = None
                if not used_mock and str(provider or "").lower().startswith("baidu"):
                    intro_zh = brief_species_intro_zh(
                        str(best.get("name") or "").strip(),
                        source_channel=str(best.get("source") or ""),
                    )

            confidence = max([float(it.get("confidence", 0)) for it in top_k], default=0.0) if top_k else 0.0
            risk_level = _build_risk_level(scene_type, confidence)
            db.session.add(
                PlantIdentification(
                    user_id=identity,
                    image_name=image_name,
                    result_json=top_k,
                    confidence=confidence,
                    scene_type=scene_type,
                    risk_level=risk_level,
                )
            )
            inserted += 1
            synced_items.append(
                {
                    "image_name": image_name,
                    "top_k": top_k,
                    "confidence": confidence,
                    "provider": provider,
                    "used_mock": used_mock,
                    "scene_type": scene_type,
                    "risk_level": risk_level,
                    "user_notice_zh": out_notice,
                    "identify_display_mode": display_mode,
                    "primary_label_zh": (best.get("name") if best else None) or None,
                    "primary_confidence": float(best.get("confidence") or 0) if best else None,
                    "deepseek_intro_zh": intro_zh or None,
                }
            )

        db.session.commit()
        return jsonify({"ok": True, "deduplicated": False, "inserted": inserted, "synced_items": synced_items})
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        return jsonify({"error": {"code": "identify_failed", "message": f"识图失败：{exc}"}}), 500
