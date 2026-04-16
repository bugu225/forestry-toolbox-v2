from flask import Flask
from sqlalchemy import inspect, text

from .config import Config
from .extensions import cors, db, jwt
from .models import KnowledgeDoc
from .routes.auth import auth_bp
from .routes.health import health_bp
from .routes.identify import identify_bp
from .routes.patrol import patrol_bp
from .routes.qa import qa_bp
from .routes.sync import sync_bp


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.from_object(Config)

    db.init_app(app)
    jwt.init_app(app)
    cors.init_app(
        app,
        resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
        supports_credentials=False,
    )

    app.register_blueprint(health_bp, url_prefix="/api")
    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(identify_bp, url_prefix="/api/identify")
    app.register_blueprint(patrol_bp, url_prefix="/api/patrol")
    app.register_blueprint(qa_bp, url_prefix="/api/qa")
    app.register_blueprint(sync_bp, url_prefix="/api/sync")

    with app.app_context():
        from . import models  # noqa: F401

        db.create_all()
        _ensure_sqlite_extra_schema()
        _seed_knowledge_docs()

    return app


def _ensure_sqlite_extra_schema() -> None:
    """Apply minimal SQLite schema upgrades without Alembic."""
    bind = db.engine
    if bind.dialect.name != "sqlite":
        return
    insp = inspect(bind)
    statements = []
    if insp.has_table("plant_identifications"):
        columns = {col["name"] for col in insp.get_columns("plant_identifications")}
        if "scene_type" not in columns:
            statements.append("ALTER TABLE plant_identifications ADD COLUMN scene_type VARCHAR(32)")
        if "risk_level" not in columns:
            statements.append("ALTER TABLE plant_identifications ADD COLUMN risk_level VARCHAR(16)")
    if insp.has_table("patrol_events"):
        columns = {col["name"] for col in insp.get_columns("patrol_events")}
        if "photo_base64" not in columns:
            statements.append("ALTER TABLE patrol_events ADD COLUMN photo_base64 TEXT")
    if not statements:
        return
    with bind.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))


def _seed_knowledge_docs() -> None:
    if KnowledgeDoc.query.count() > 0:
        return
    seeds = [
        KnowledgeDoc(
            title="森林火情应急处置卡",
            category="fire",
            keywords=["火情", "烟点", "应急", "撤离"],
            content="发现烟火后先保障人员安全，定位记录坐标和风向，按分级流程上报并组织撤离。",
        ),
        KnowledgeDoc(
            title="林木病害现场记录规范",
            category="disease",
            keywords=["病害", "取样", "照片", "记录"],
            content="记录树种、受害部位、范围和时间，保留近景/远景照片，必要时采样送检。",
        ),
        KnowledgeDoc(
            title="虫害监测与初步处置",
            category="pest",
            keywords=["虫害", "监测", "诱捕", "除治"],
            content="优先记录虫口密度和受害面积，结合诱捕器和人工巡查，按技术规程处置。",
        ),
        KnowledgeDoc(
            title="巡护轨迹与异常点上报要点",
            category="patrol",
            keywords=["巡护", "轨迹", "异常", "上报"],
            content="轨迹记录应覆盖关键区域，异常点需包含坐标、分类、描述和现场照片。",
        ),
    ]
    db.session.add_all(seeds)
    db.session.commit()
