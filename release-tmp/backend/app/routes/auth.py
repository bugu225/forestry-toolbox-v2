from flask import Blueprint, current_app, jsonify, request
from flask_jwt_extended import create_access_token, get_jwt_identity, jwt_required

from ..extensions import db
from ..models import User

auth_bp = Blueprint("auth", __name__)

# 开发测试：仅允许下列内部账号登录（用户名 -> 密码）
INTERNAL_USERS = {
    "linye": "12345678",
    "杨布谷": "12345678",
}


def _error(message: str, code: str = "bad_request", status_code: int = 422):
    return jsonify({"error": {"code": code, "message": message}}), status_code


@auth_bp.post("/register")
def register():
    if current_app.config.get("DISABLE_PUBLIC_REGISTER", True):
        return _error("公开注册已关闭", code="registration_disabled", status_code=403)

    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if len(username) < 3:
        return _error("用户名至少 3 个字符")
    if len(password) < 6:
        return _error("密码至少 6 位")
    if User.query.filter_by(username=username).first():
        return _error("用户名已存在", code="username_exists")

    user = User(username=username)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    token = create_access_token(identity=str(user.id))
    return (
        jsonify(
            {
                "access_token": token,
                "user": {"id": user.id, "username": user.username, "role": user.role},
            }
        ),
        201,
    )


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    expected_password = INTERNAL_USERS.get(username)
    if expected_password is None or password != expected_password:
        return _error("仅支持内部账号登录，请核对账号与密码", code="invalid_credentials", status_code=401)

    user = User.query.filter_by(username=username).first()
    if not user:
        user = User(username=username, role="admin")
        user.set_password(expected_password)
        db.session.add(user)
        db.session.commit()
    elif not user.check_password(expected_password):
        user.set_password(expected_password)
        db.session.commit()

    token = create_access_token(identity=str(user.id))
    return jsonify(
        {
            "access_token": token,
            "user": {"id": user.id, "username": user.username, "role": user.role},
        }
    )


@auth_bp.get("/me")
@jwt_required()
def me():
    identity = get_jwt_identity()
    user = db.session.get(User, int(identity))
    if not user:
        return _error("用户不存在", code="not_found", status_code=404)
    return jsonify({"id": user.id, "username": user.username, "role": user.role})
