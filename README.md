# 林业百宝箱 v2

面向中国大学生计算机设计大赛 **Web 应用与开发** 赛道的林业工具站点：在**本机离线能力**（IndexedDB 存问答会话、知识条目、识图图集等）与**联网能力**（鉴权、LLM 问答、云端识图）之间取得平衡。

当前版本已**收敛为两大核心功能**（林业知识问答、林业识图），并保留首页「巡护助手」**占位入口**（点击提示「正在开发中」）。**已不再提供**服务端巡护接口、批量「同步上传」与同步审计等旧能力。

## 功能概览

| 模块 | 说明 |
|------|------|
| 登录与鉴权 | JWT，`/api/auth/login` 等 |
| 林业知识问答 | 联网调用 LLM；本地 IndexedDB 保存会话与消息；知识库资料可导入（含 PDF 文本提取） |
| 林业识图 | 拍照/相册、图集、调用 `/api/identify/sync` 做识别（路径名沿用 `sync`，实为识图主接口） |
| 首页「其他、等等」 | 退出登录；**断网测试**开关（应用内模拟离线，便于测离线逻辑，不改变系统网络） |
| 巡护助手 | 仅占位，无后端模块 |

## 技术栈

- 前端：`Vue 3` + `Vite` + `Pinia` + `Vue Router` + `Vant`
- 后端：`Flask` + `Flask-JWT-Extended` + `Flask-SQLAlchemy`
- 服务端数据库：默认 `SQLite`（见 `backend` 配置）
- 浏览器本地：`IndexedDB`（`frontend/src/services/offlineDb.js`，当前库版本见文件内 `DB_VERSION`）

## 目录结构

- `frontend/`：前端工程（生产构建输出在 `frontend/dist`）
- `backend/`：Flask 后端
- `docs/`：补充文档（若有）

## 环境变量

可在项目根目录或各子项目旁使用 `.env.local` / `.env.production` 等，具体键名以 `.env.example` 为准。

- **后端常用**：`PLANT_API_KEY`、`PLANT_API_SECRET`（识图通道）、`LLM_API_KEY`、`CORS_ORIGINS` 等
- **前端常用**：`VITE_API_BASE`（生产环境必须指向你的后端 `/api` 根，如 `https://域名/api`）；若使用高德相关能力：`VITE_AMAP_JS_KEY`、`VITE_AMAP_SECURITY_JS_CODE`

## 本地启动（Windows / PowerShell）

### 1）后端

```powershell
cd path\to\forestry-toolbox-v2\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python .\run.py
```

健康检查：`http://localhost:5000/api/health`（若启用 HTTPS 则改为 `https://...`）

### 2）前端开发

```powershell
cd path\to\forestry-toolbox-v2\frontend
npm install
npm run dev
```

默认：`http://localhost:5173`。开发时请在环境变量中将 `VITE_API_BASE` 指到 `http://localhost:5000/api`（或通过 Vite 代理，以你本地配置为准）。

### 3）真机联调（同 Wi-Fi）

将后端监听 `0.0.0.0:5000`、前端 dev 监听 `0.0.0.0:5173`，并把本机局域网 IP 写入 `VITE_API_BASE` 与后端 `CORS_ORIGINS`，手机浏览器访问 `http://<电脑IP>:5173`。防火墙放行对应端口。

### 4）生产构建（部署前）

```bash
cd frontend
npm ci
npm run build
```

**务必在构建前**设置好生产用 `VITE_API_BASE`，否则打包后的前端可能仍指向错误 API 地址。

## 部署提示（服务器）

1. `git pull` 或使用 tag（如 `release-2026-04-19`）检出对应版本。  
2. 后端：虚拟环境内 `pip install -r requirements.txt`，配置环境变量后重启进程。  
3. 前端：`npm ci && npm run build`，用 Nginx 等托管 `frontend/dist`。  
4. 旧版本若曾带巡护/同步审计等表，升级后 SQLite 中可能残留**未再使用的表**，一般不影响运行；若需「干净库」请在**备份后**自行处理数据文件。

## 核心 API（与当前代码一致）

### 通用与鉴权

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

### 识图

- `POST /api/identify/sync`：提交识图任务并返回结果（响应中含 `synced_items` 等字段）
- `GET /api/identify/history`

### 问答

- `POST /api/qa/ask`
- `GET /api/qa/sessions`
- `GET /api/qa/sessions/<session_id>/messages`
- `GET /api/qa/knowledge-search`（与 `GET /api/qa/policy-search` 同一处理）
- `GET /api/qa/knowledge-docs`
- `POST /api/qa/knowledge-import`：联网整理用户粘贴/上传的正文，返回结构化条目供前端写入 IndexedDB

**已移除**：`POST /api/qa/sync`、巡护相关 API、同步审计 API。

## 离线与「断网测试」

- 问答/识图界面根据 **有效在线状态** 决定是否走联网请求：由 Pinia `stores/network.js` 合并 **浏览器 `online`/`offline` 事件** 与首页 **模拟断网** 开关。  
- 模拟断网仅影响本应用内逻辑，**不会**断开系统网络；若需完全阻断 HTTP，需另行在请求层拦截（未默认内置）。
