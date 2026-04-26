from flask import Blueprint, current_app, jsonify

health_bp = Blueprint("health", __name__)


@health_bp.get("/health")
def health_check():
    return jsonify({"ok": True, "service": "forestry-toolbox-v2-api"})


@health_bp.get("/public/client-config")
def public_client_config():
    """未鉴权：返回天地图 JS Key（可空）与能力开关。"""
    tianditu_key = (current_app.config.get("TIANDITU_JS_KEY") or "").strip()
    plant_ok = bool(
        (current_app.config.get("PLANT_API_KEY") or "").strip()
        and (current_app.config.get("PLANT_API_SECRET") or "").strip()
    )
    llm_ok = bool((current_app.config.get("LLM_API_KEY") or "").strip())
    return jsonify(
        {
            "tianditu_js_key": tianditu_key,
            "features": {
                "plant_identify": plant_ok,
                "qa_llm": llm_ok,
            },
        }
    )
