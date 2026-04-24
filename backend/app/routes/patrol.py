from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from ..extensions import db
from ..models import PatrolSyncRecord

patrol_bp = Blueprint("patrol", __name__)


def _error(message: str, code: str = "bad_request", status_code: int = 422):
    return jsonify({"error": {"code": code, "message": message}}), status_code


def _current_user_id() -> int:
    return int(get_jwt_identity())


@patrol_bp.post("/sync")
@jwt_required()
def sync_patrol():
    """上传或覆盖当前用户下某次巡护的完整快照（任务 + 点 + 事件）。"""
    data = request.get_json(silent=True) or {}
    client_task_local_id = (data.get("client_task_local_id") or "").strip()
    task = data.get("task")
    points = data.get("points")
    events = data.get("events")
    if not client_task_local_id:
        return _error("缺少 client_task_local_id")
    if not isinstance(task, dict) or not isinstance(points, list) or not isinstance(events, list):
        return _error("task 须为对象，points、events 须为数组")
    task_local = (task.get("local_id") or "").strip()
    if task_local != client_task_local_id:
        return _error("task.local_id 须与 client_task_local_id 一致")

    uid = _current_user_id()
    payload = {"task": task, "points": points, "events": events}
    now = datetime.now(timezone.utc)

    row = PatrolSyncRecord.query.filter_by(user_id=uid, client_task_local_id=client_task_local_id).first()
    if row:
        row.payload_json = payload
        row.updated_at = now
    else:
        row = PatrolSyncRecord(
            user_id=uid,
            client_task_local_id=client_task_local_id,
            payload_json=payload,
            updated_at=now,
        )
        db.session.add(row)
    db.session.commit()
    return jsonify({"id": row.id, "client_task_local_id": client_task_local_id, "updated_at": row.updated_at.isoformat()})


@patrol_bp.get("/tasks")
@jwt_required()
def list_patrol_tasks():
    rows = (
        PatrolSyncRecord.query.filter_by(user_id=_current_user_id())
        .order_by(PatrolSyncRecord.updated_at.desc())
        .limit(100)
        .all()
    )
    out = []
    for r in rows:
        t = (r.payload_json or {}).get("task") or {}
        out.append(
            {
                "id": r.id,
                "client_task_local_id": r.client_task_local_id,
                "title": t.get("title") or r.client_task_local_id,
                "started_at": t.get("started_at"),
                "ended_at": t.get("ended_at"),
                "status": t.get("status"),
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
        )
    return jsonify({"items": out})


@patrol_bp.get("/tasks/<int:record_id>")
@jwt_required()
def get_patrol_task(record_id: int):
    row = PatrolSyncRecord.query.filter_by(id=record_id, user_id=_current_user_id()).first()
    if not row:
        return _error("记录不存在", code="not_found", status_code=404)
    p = row.payload_json or {}
    return jsonify(
        {
            "id": row.id,
            "client_task_local_id": row.client_task_local_id,
            "task": p.get("task"),
            "points": p.get("points") or [],
            "events": p.get("events") or [],
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
    )
