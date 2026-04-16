from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from ..extensions import db
from ..models import SyncAuditLog

sync_bp = Blueprint("sync", __name__)


@sync_bp.get("/audits")
@jwt_required()
def list_sync_audits():
    identity = int(get_jwt_identity())
    raw_limit = request.args.get("limit", "30")
    module = (request.args.get("module") or "").strip()
    status = (request.args.get("status") or "").strip()
    deduplicated = (request.args.get("deduplicated") or "").strip().lower()
    try:
        limit = max(1, min(int(raw_limit), 100))
    except ValueError:
        limit = 30

    query = SyncAuditLog.query.filter_by(user_id=identity)
    if module in ("identify", "qa", "patrol"):
        query = query.filter_by(module=module)
    if status in ("success", "failed"):
        query = query.filter_by(status=status)
    if deduplicated in ("true", "false"):
        query = query.filter_by(deduplicated=(deduplicated == "true"))

    rows = query.order_by(SyncAuditLog.created_at.desc()).limit(limit).all()
    return jsonify(
        {
            "items": [
                {
                    "id": row.id,
                    "module": row.module,
                    "status": row.status,
                    "deduplicated": bool(row.deduplicated),
                    "summary": row.summary_json or {},
                    "error_message": row.error_message or "",
                    "created_at": row.created_at.isoformat(),
                }
                for row in rows
            ]
        }
    )


@sync_bp.delete("/audits")
@jwt_required()
def clear_sync_audits():
    identity = int(get_jwt_identity())
    module = (request.args.get("module") or "").strip()

    query = SyncAuditLog.query.filter_by(user_id=identity)
    if module in ("identify", "qa", "patrol"):
        query = query.filter_by(module=module)

    deleted = query.delete(synchronize_session=False)
    db.session.commit()
    return jsonify({"ok": True, "deleted": int(deleted), "module": module or "all"})
