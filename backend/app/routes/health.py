from flask import Blueprint, current_app, jsonify

health_bp = Blueprint("health", __name__)


@health_bp.get("/health")
def health_check():
    return jsonify({"ok": True, "service": "forestry-toolbox-v2-api"})


@health_bp.get("/public/client-config")
def public_client_config():
    """
    未鉴权：供前端在构建时未注入高德 Key 时拉取（同源 /api）。
    不返回任何第三方密钥，仅返回高德 JS Key（公开、域名白名单约束）与能力开关。
    """
    amap_key = (current_app.config.get("AMAP_JS_KEY") or "").strip()
    amap_sec = (current_app.config.get("AMAP_SECURITY_JS_CODE") or "").strip()
    tianditu_key = (current_app.config.get("TIANDITU_JS_KEY") or "").strip()
    plant_ok = bool(
        (current_app.config.get("PLANT_API_KEY") or "").strip()
        and (current_app.config.get("PLANT_API_SECRET") or "").strip()
    )
    llm_ok = bool((current_app.config.get("LLM_API_KEY") or "").strip())
    return jsonify(
        {
            "amap_js_key": amap_key,
            "amap_security_js_code": amap_sec,
            "tianditu_js_key": tianditu_key,
            "features": {
                "plant_identify": plant_ok,
                "qa_llm": llm_ok,
            },
        }
    )
