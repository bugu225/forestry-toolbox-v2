# 林业百宝箱 v2

本项目用于中国大学生计算机设计大赛 Web 应用与开发赛道，采用“离线优先 + 联网增强”的实现策略。

## 当前完成度（功能视角）

- 用户登录鉴权（JWT）
- 三大核心模块：识图、问答、巡护
- 本地离线存储（IndexedDB）
- 联网同步与失败提示
- 同步幂等去重（避免重复入库）
- 同步审计（查询、筛选、清理）
- 网络恢复后自动触发同步（识图/问答/巡护）

## 技术栈

- 前端：`Vue 3` + `Vite` + `Pinia` + `Vue Router` + `Vant`
- 后端：`Flask` + `Flask-JWT-Extended` + `Flask-SQLAlchemy`
- 数据库：`SQLite`
- 本地离线：`IndexedDB`

## 目录结构

- `frontend/`：前端工程
- `backend/`：后端工程
- `docs/`：项目文档

## 环境变量

项目根目录使用 `.env.local`，后端与前端都会读取：

- 后端关键项：`PLANT_API_KEY`、`PLANT_API_SECRET`、`LLM_API_KEY`
- 前端关键项：`VITE_API_BASE`、`VITE_AMAP_JS_KEY`、`VITE_AMAP_SECURITY_JS_CODE`

可参考 `.env.example` 填写。

## 本地启动（Windows / PowerShell）

### 1) 启动后端

```powershell
cd d:\ITproject\cursor\forestry-toolbox-v2\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python .\run.py
```

健康检查：`http://localhost:5000/api/health`（若启用 HTTPS 则 `https://localhost:5000/api/health`）

### 2) 启动前端

```powershell
cd d:\ITproject\cursor\forestry-toolbox-v2\frontend
npm install
npm run dev
```

访问地址：`http://localhost:5173`（若启用 HTTPS 则 `https://localhost:5173`）

### 3) 真机联调（手机访问）

确保电脑与手机在同一 Wi-Fi，下方示例以 `192.168.148.78` 为电脑局域网 IP：

- 后端已监听 `0.0.0.0:5000`
- 前端 Vite 已监听 `0.0.0.0:5173`
- `.env.local` 中：
  - `VITE_API_BASE=http://192.168.148.78:5000/api`
  - `CORS_ORIGINS` 包含 `http://192.168.148.78:5173`

手机浏览器访问：`http://192.168.148.78:5173`

若无法访问，请在 Windows 防火墙放行入站 TCP 端口 `5000`、`5173`（专用网络）。

### 4) HTTPS 真机联调

根目录 `.env.local` 已支持：

- `VITE_USE_HTTPS=1`
- `FLASK_USE_HTTPS=1`

默认会使用开发证书（adhoc/self-signed）。若你有固定证书，可配置：

- `VITE_SSL_CERT`、`VITE_SSL_KEY`
- `FLASK_SSL_CERT`、`FLASK_SSL_KEY`

注意：手机端需信任证书，否则 HTTPS 请求会被拦截。

## 核心 API（当前版本）

### 通用与鉴权

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

### 识图模块

- `POST /api/identify/sync`
- `GET /api/identify/history`（含 `scene_type`、`risk_level`，旧数据缺省为 `general` / `low`）

### 问答模块

- `POST /api/qa/ask`
- `POST /api/qa/sync`
- `GET /api/qa/knowledge-search`（林业知识速查；`/api/qa/policy-search` 仍兼容）
- `GET /api/qa/knowledge-docs`（离线资料库下载）
- `GET /api/qa/sessions`
- `GET /api/qa/sessions/<session_id>/messages`

### 巡护模块

- `POST /api/patrol/sync`
- `GET /api/patrol/tasks`
- `GET /api/patrol/events`

### 同步审计

- `GET /api/sync/audits`
- `DELETE /api/sync/audits`

## 同步机制说明（简版）

- 前端离线数据先写入 IndexedDB
- 联网时可手动同步，也可在网络恢复时自动同步
- 后端对同步 payload 做哈希去重，避免重传重复写入
- 每次同步写入审计日志，可按模块/状态/去重命中筛选

