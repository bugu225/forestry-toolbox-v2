import hashlib
import json
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from ..extensions import db
from ..models import PatrolEvent, PatrolPoint, PatrolTask, SyncAuditLog, SyncCheckpoint

patrol_bp = Blueprint("patrol", __name__)


def _parse_iso_datetime(value):
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    # Frontend commonly sends UTC timestamps like 2026-04-16T06:13:34.086Z
    if raw.endswith("Z"):
        raw = f"{raw[:-1]}+00:00"
    return datetime.fromisoformat(raw)


def _tasks_for_hash(tasks: list[dict]):
    normalized = []
    for item in tasks:
        normalized.append(
            {
                "local_id": item.get("local_id") or "",
                "title": item.get("title") or "",
                "status": item.get("status") or "",
                "started_at": item.get("started_at") or "",
                "ended_at": item.get("ended_at") or "",
            }
        )
    normalized.sort(key=lambda x: (x["local_id"], x["title"], x["started_at"]))
    return normalized


def _points_for_hash(points: list[dict]):
    normalized = []
    for item in points:
        normalized.append(
            {
                "local_id": item.get("local_id") or "",
                "task_local_id": item.get("task_local_id") or "",
                "latitude": item.get("latitude"),
                "longitude": item.get("longitude"),
                "note": item.get("note") or "",
            }
        )
    normalized.sort(key=lambda x: (x["task_local_id"], x["local_id"], str(x["latitude"]), str(x["longitude"])))
    return normalized


def _events_for_hash(events: list[dict]):
    normalized = []
    for item in events:
        normalized.append(
            {
                "local_id": item.get("local_id") or "",
                "task_local_id": item.get("task_local_id") or "",
                "description": item.get("description") or "",
                "event_type": item.get("event_type") or "",
                "latitude": item.get("latitude"),
                "longitude": item.get("longitude"),
                "photo_base64": item.get("photo_base64") or "",
            }
        )
    normalized.sort(key=lambda x: (x["task_local_id"], x["local_id"], x["event_type"]))
    return normalized


def _append_sync_audit(*, user_id: int, status: str, deduplicated: bool, summary: dict, error_message: str = ""):
    db.session.add(
        SyncAuditLog(
            user_id=user_id,
            module="patrol",
            status=status,
            deduplicated=deduplicated,
            summary_json=summary,
            error_message=error_message[:500] if error_message else None,
        )
    )


@patrol_bp.get("/tasks")
@jwt_required()
def list_tasks():
    identity = int(get_jwt_identity())
    tasks = PatrolTask.query.filter_by(user_id=identity).order_by(PatrolTask.created_at.desc()).all()
    return jsonify(
        {
            "items": [
                {
                    "id": t.id,
                    "title": t.title,
                    "status": t.status,
                    "started_at": t.started_at.isoformat() if t.started_at else None,
                    "ended_at": t.ended_at.isoformat() if t.ended_at else None,
                }
                for t in tasks
            ]
        }
    )


@patrol_bp.get("/events")
@jwt_required()
def list_events():
    identity = int(get_jwt_identity())
    rows = (
        db.session.query(PatrolEvent, PatrolTask)
        .join(PatrolTask, PatrolTask.id == PatrolEvent.task_id)
        .filter(PatrolTask.user_id == identity)
        .order_by(PatrolEvent.created_at.desc())
        .all()
    )
    return jsonify(
        {
            "items": [
                {
                    "id": event.id,
                    "task_id": event.task_id,
                    "task_title": task.title,
                    "event_type": event.event_type,
                    "description": event.description,
                    "latitude": event.latitude,
                    "longitude": event.longitude,
                    "photo_base64": event.photo_base64,
                    "created_at": event.created_at.isoformat(),
                }
                for event, task in rows
            ]
        }
    )


@patrol_bp.post("/sync")
@jwt_required()
def sync_patrol():
    """
    Sync offline patrol payload to server.
    payload:
    {
      "tasks": [{"local_id":"x1", "title":"...", "status":"...", "started_at":"...","ended_at":"..."}],
      "points": [{"task_local_id":"x1","latitude":...,"longitude":...,"note":"..."}],
      "events": [{"task_local_id":"x1","description":"...","event_type":"abnormal","latitude":...,"longitude":...}]
    }
    """
    identity = int(get_jwt_identity())
    try:
        payload = request.get_json(silent=True) or {}
        tasks = payload.get("tasks") or []
        points = payload.get("points") or []
        events = payload.get("events") or []
        dedup_payload = {
            "tasks": _tasks_for_hash(tasks),
            "points": _points_for_hash(points),
            "events": _events_for_hash(events),
        }
        payload_raw = json.dumps(dedup_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        payload_hash = hashlib.sha256(payload_raw.encode("utf-8")).hexdigest()
        checkpoint = SyncCheckpoint.query.filter_by(
            user_id=identity, module="patrol", payload_hash=payload_hash
        ).first()
        if checkpoint:
            cached = checkpoint.response_json or {}
            cached_inserted = cached.get("inserted", {"tasks": 0, "points": 0, "events": 0})
            _append_sync_audit(
                user_id=identity,
                status="success",
                deduplicated=True,
                summary=cached_inserted,
            )
            db.session.commit()
            return jsonify(
                {
                    "ok": True,
                    "deduplicated": True,
                    "mapped_tasks": cached.get("mapped_tasks", {}),
                    "inserted": cached_inserted,
                }
            )

        local_to_server = {}
        inserted_tasks = 0
        inserted_points = 0
        inserted_events = 0

        for item in tasks:
            local_id = (item.get("local_id") or "").strip()
            title = (item.get("title") or "").strip() or "离线巡护任务"
            status = (item.get("status") or "in_progress").strip()
            started_at = item.get("started_at")
            ended_at = item.get("ended_at")
            task = PatrolTask(
                user_id=identity,
                title=title,
                status=status if status in ("in_progress", "completed") else "in_progress",
                started_at=_parse_iso_datetime(started_at) or datetime.now(timezone.utc),
                ended_at=_parse_iso_datetime(ended_at),
            )
            db.session.add(task)
            db.session.flush()
            inserted_tasks += 1
            if local_id:
                local_to_server[local_id] = task.id

        for item in points:
            task_local_id = (item.get("task_local_id") or "").strip()
            task_id = local_to_server.get(task_local_id)
            if not task_id:
                continue
            latitude = item.get("latitude")
            longitude = item.get("longitude")
            if latitude is None or longitude is None:
                continue
            db.session.add(
                PatrolPoint(
                    task_id=task_id,
                    latitude=float(latitude),
                    longitude=float(longitude),
                    note=(item.get("note") or "").strip() or None,
                )
            )
            inserted_points += 1

        for item in events:
            task_local_id = (item.get("task_local_id") or "").strip()
            task_id = local_to_server.get(task_local_id)
            if not task_id:
                continue
            description = (item.get("description") or "").strip()
            if not description:
                continue
            db.session.add(
                PatrolEvent(
                    task_id=task_id,
                    description=description,
                    event_type=(item.get("event_type") or "abnormal").strip(),
                    latitude=float(item["latitude"]) if item.get("latitude") is not None else None,
                    longitude=float(item["longitude"]) if item.get("longitude") is not None else None,
                    photo_base64=(item.get("photo_base64") or "").strip() or None,
                )
            )
            inserted_events += 1

        inserted_summary = {
            "tasks": inserted_tasks,
            "points": inserted_points,
            "events": inserted_events,
        }
        response_payload = {
            "mapped_tasks": local_to_server,
            "inserted": inserted_summary,
        }
        db.session.add(
            SyncCheckpoint(
                user_id=identity,
                module="patrol",
                payload_hash=payload_hash,
                response_json=response_payload,
            )
        )
        _append_sync_audit(
            user_id=identity,
            status="success",
            deduplicated=False,
            summary=inserted_summary,
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
        return jsonify({"error": {"code": "sync_failed", "message": f"巡护同步失败：{exc}"}}), 500
