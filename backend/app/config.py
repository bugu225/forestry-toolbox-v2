import os
from pathlib import Path

from dotenv import load_dotenv

# Load env in a deterministic order:
# 1) backend/.env.local
# 2) project-root/.env.local
# 3) process environment
BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = Path(__file__).resolve().parents[2]

load_dotenv(BACKEND_DIR / ".env.local")
load_dotenv(PROJECT_ROOT / ".env.local")
load_dotenv()


class Config:
    # 设为 0 可重新开放 POST /api/auth/register（默认关闭，仅内部账号）
    DISABLE_PUBLIC_REGISTER = os.getenv("DISABLE_PUBLIC_REGISTER", "1").lower() in ("1", "true", "yes")

    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key")
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "dev-jwt-secret")
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL", "sqlite:///forestry_toolbox_v2.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", "10485760"))
    CORS_ORIGINS = [
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
        if origin.strip()
    ]
    # 置于 Nginx/Caddy 等 HTTPS 反代之后时设为 1，以便识别 X-Forwarded-Proto / Host（香港或其它地区生产环境推荐）
    FLASK_BEHIND_PROXY = os.getenv("FLASK_BEHIND_PROXY", "0").lower() in ("1", "true", "yes")
    PLANT_API_BASE_URL = os.getenv("PLANT_API_BASE_URL", "https://aip.baidubce.com")
    PLANT_API_KEY = os.getenv("PLANT_API_KEY", "")
    PLANT_API_SECRET = os.getenv("PLANT_API_SECRET", "")
    LLM_API_BASE_URL = os.getenv("LLM_API_BASE_URL", "https://api.deepseek.com")
    LLM_API_KEY = os.getenv("LLM_API_KEY", "")
    LLM_MODEL_NAME = os.getenv("LLM_MODEL_NAME", "deepseek-chat")
    # 百度图像分类（植物+动物识图等，默认较短）；DeepSeek 单独使用更长超时
    LLM_TIMEOUT_SECONDS = int(os.getenv("LLM_TIMEOUT_SECONDS", "90"))
    LLM_CONTEXT_MESSAGES_MAX = int(os.getenv("LLM_CONTEXT_MESSAGES_MAX", "20"))
    # 林业相关性门控：先发短请求分类，再决定是否完整问答（可用 LLM_FORESTRY_GATE_ENABLED=0 关闭）
    LLM_FORESTRY_GATE_ENABLED = os.getenv("LLM_FORESTRY_GATE_ENABLED", "1").lower() in (
        "1",
        "true",
        "yes",
    )
    LLM_CLASSIFY_TIMEOUT_SECONDS = int(os.getenv("LLM_CLASSIFY_TIMEOUT_SECONDS", "20"))
    LLM_IDENTIFY_INTRO_TIMEOUT_SECONDS = int(os.getenv("LLM_IDENTIFY_INTRO_TIMEOUT_SECONDS", "28"))
    # 知识库导入：送入模型的正文上限（字符）；全文仍可按返回值 content 截断存本地
    LLM_KNOWLEDGE_IMPORT_MAX_CHARS = int(os.getenv("LLM_KNOWLEDGE_IMPORT_MAX_CHARS", "14000"))
    THIRD_PARTY_TIMEOUT_SECONDS = int(os.getenv("THIRD_PARTY_TIMEOUT_SECONDS", "8"))
    THIRD_PARTY_RETRIES = int(os.getenv("THIRD_PARTY_RETRIES", "1"))
    TIANDITU_JS_KEY = (os.getenv("TIANDITU_JS_KEY") or os.getenv("VITE_TIANDITU_JS_KEY") or "").strip()
