import hashlib
import json

from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from ..extensions import db
from ..models import PlantIdentification, SyncAuditLog, SyncCheckpoint
from ..services.plant_provider import identify_plant

identify_bp = Blueprint("identify", __name__)


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


def _jobs_for_hash(jobs: list[dict]):
    normalized = []
    for item in jobs:
        normalized.append(
            {
                "local_id": item.get("local_id") or "",
                "image_name": item.get("image_name") or "",
                "image_base64": item.get("image_base64") or "",
                "scene_type": item.get("scene_type") or "general",
                "result_json": item.get("result_json") or [],
                "created_at": item.get("created_at") or "",
            }
        )
    normalized.sort(key=lambda x: (x["local_id"], x["image_name"], x["created_at"]))
    return normalized


def _append_sync_audit(*, user_id: int, status: str, deduplicated: bool, summary: dict, error_message: str = ""):
    db.session.add(
        SyncAuditLog(
            user_id=user_id,
            module="identify",
            status=status,
            deduplicated=deduplicated,
            summary_json=summary,
            error_message=error_message[:500] if error_message else None,
        )
    )


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
    identity = int(get_jwt_identity())
    try:
        payload = request.get_json(silent=True) or {}
        jobs = payload.get("jobs") or []
        dedup_payload = {"jobs": _jobs_for_hash(jobs)}
        payload_raw = json.dumps(dedup_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        payload_hash = hashlib.sha256(payload_raw.encode("utf-8")).hexdigest()
        checkpoint = SyncCheckpoint.query.filter_by(
            user_id=identity, module="identify", payload_hash=payload_hash
        ).first()
        if checkpoint:
            cached = checkpoint.response_json or {}
            summary = {"inserted": cached.get("inserted", 0)}
            _append_sync_audit(
                user_id=identity,
                status="success",
                deduplicated=True,
                summary=summary,
            )
            db.session.commit()
            return jsonify(
                {
                    "ok": True,
                    "deduplicated": True,
                    "inserted": cached.get("inserted", 0),
                    "synced_items": cached.get("synced_items", []),
                }
            )

        inserted = 0
        synced_items = []
        for item in jobs:
            image_name = (item.get("image_name") or "").strip() or "离线图片"
            scene_type = (item.get("scene_type") or "general").strip() or "general"
            local_result = item.get("result_json")
            if isinstance(local_result, list) and local_result:
                top_k = local_result
                provider = "local-precomputed"
                used_mock = True
            else:
                top_k, provider, used_mock, _ = identify_plant(image_name, item.get("image_base64"))
            confidence = max([float(it.get("confidence", 0)) for it in top_k], default=0.0)
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
                }
            )

        response_payload = {"inserted": inserted, "synced_items": synced_items}
        db.session.add(
            SyncCheckpoint(
                user_id=identity,
                module="identify",
                payload_hash=payload_hash,
                response_json=response_payload,
            )
        )
        _append_sync_audit(
            user_id=identity,
            status="success",
            deduplicated=False,
            summary={"inserted": inserted},
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
        return jsonify({"error": {"code": "sync_failed", "message": f"识图同步失败：{exc}"}}), 500
