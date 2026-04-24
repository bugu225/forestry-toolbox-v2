from datetime import datetime, timezone

from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(32), default="user", nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)


class PlantIdentification(db.Model):
    __tablename__ = "plant_identifications"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    image_name = db.Column(db.String(255), nullable=False)
    result_json = db.Column(db.JSON, nullable=False)
    confidence = db.Column(db.Float, nullable=False, default=0.0)
    scene_type = db.Column(db.String(32), nullable=True)
    risk_level = db.Column(db.String(16), nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)


class QASession(db.Model):
    __tablename__ = "qa_sessions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    title = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)


class QAMessage(db.Model):
    __tablename__ = "qa_messages"

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer, db.ForeignKey("qa_sessions.id"), nullable=False, index=True)
    role = db.Column(db.String(16), nullable=False)
    content = db.Column(db.Text, nullable=False)
    citations = db.Column(db.JSON, nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)


class KnowledgeDoc(db.Model):
    __tablename__ = "knowledge_docs"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    category = db.Column(db.String(64), nullable=False, default="general")
    keywords = db.Column(db.JSON, nullable=False, default=list)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)


class PatrolSyncRecord(db.Model):
    """巡护数据云端快照：按用户 + 客户端任务 local_id 幂等覆盖。"""

    __tablename__ = "patrol_sync_records"
    __table_args__ = (db.UniqueConstraint("user_id", "client_task_local_id", name="uq_patrol_user_client_task"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    client_task_local_id = db.Column(db.String(128), nullable=False)
    payload_json = db.Column(db.JSON, nullable=False)
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
