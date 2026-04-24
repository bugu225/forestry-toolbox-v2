from flask import Flask
from sqlalchemy import inspect, text

from .config import Config
from .extensions import cors, db, jwt
from .models import KnowledgeDoc, PatrolSyncRecord, PlantIdentification, QAMessage, QASession, User
from .routes.auth import INTERNAL_USERS, auth_bp
from .routes.health import health_bp
from .routes.identify import identify_bp
from .routes.patrol import patrol_bp
from .routes.qa import qa_bp


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

    if app.config.get("FLASK_BEHIND_PROXY"):
        from werkzeug.middleware.proxy_fix import ProxyFix

        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    app.register_blueprint(health_bp, url_prefix="/api")
    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(identify_bp, url_prefix="/api/identify")
    app.register_blueprint(qa_bp, url_prefix="/api/qa")
    app.register_blueprint(patrol_bp, url_prefix="/api/patrol")

    with app.app_context():
        from . import models  # noqa: F401

        db.create_all()
        _ensure_sqlite_extra_schema()
        _seed_knowledge_docs()
        _ensure_internal_users()

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
            title="野外作业安全与记录要点",
            category="field",
            keywords=["作业", "安全", "记录", "上报"],
            content="作业前评估风险，关键步骤留痕，异常及时上报。",
        ),
    ]
    db.session.add_all(seeds)
    db.session.commit()


def _purge_user_related_data() -> None:
    """删除依赖 users 的业务数据（顺序满足外键）。"""
    QAMessage.query.delete()
    QASession.query.delete()
    PlantIdentification.query.delete()
    PatrolSyncRecord.query.delete()
    User.query.delete()
    db.session.commit()


def _ensure_internal_users() -> None:
    """仅保留 INTERNAL_USERS 中的内部账号；其余用户及关联数据一并清除。"""
    expected_names = set(INTERNAL_USERS.keys())
    users = User.query.all()
    by_name = {u.username: u for u in users}

    def _state_ok() -> bool:
        if set(by_name) != expected_names or len(users) != len(expected_names):
            return False
        for name, pwd in INTERNAL_USERS.items():
            u = by_name.get(name)
            if not u or not u.check_password(pwd):
                return False
        return True

    if _state_ok():
        return

    _purge_user_related_data()
    for uname, pwd in INTERNAL_USERS.items():
        user = User(username=uname, role="admin")
        user.set_password(pwd)
        db.session.add(user)
    db.session.commit()
