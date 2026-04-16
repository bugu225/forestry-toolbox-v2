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
    PLANT_API_BASE_URL = os.getenv("PLANT_API_BASE_URL", "https://aip.baidubce.com")
    PLANT_API_KEY = os.getenv("PLANT_API_KEY", "")
    PLANT_API_SECRET = os.getenv("PLANT_API_SECRET", "")
    LLM_API_BASE_URL = os.getenv("LLM_API_BASE_URL", "https://api.deepseek.com")
    LLM_API_KEY = os.getenv("LLM_API_KEY", "")
    LLM_MODEL_NAME = os.getenv("LLM_MODEL_NAME", "deepseek-chat")
    THIRD_PARTY_TIMEOUT_SECONDS = int(os.getenv("THIRD_PARTY_TIMEOUT_SECONDS", "8"))
    THIRD_PARTY_RETRIES = int(os.getenv("THIRD_PARTY_RETRIES", "1"))
