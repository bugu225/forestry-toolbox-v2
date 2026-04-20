# 林业百宝箱 v2

面向中国大学生计算机设计大赛 **Web 应用与开发** 赛道的林业工具站点：在**本机离线能力**（IndexedDB 存问答会话、知识条目、识图图集等）与**联网能力**（鉴权、LLM 问答、云端识图）之间取得平衡。

当前版本以三块前端能力为主：林业知识问答、林业识图、智能巡护（本地离线版）。其中巡护模块已恢复为**前端本地闭环**（轨迹采样、事件标记、地图可视化、事件管理），但**仍未接入巡护后端同步接口**。

## 功能概览

| 模块 | 说明 |
|------|------|
| 登录与鉴权 | JWT，`/api/auth/login` 等 |
| 林业知识问答 | 联网调用 LLM；本地 IndexedDB 保存会话与消息；知识库资料可导入（含 PDF 文本提取） |
| 林业识图 | 拍照/相册、图集、调用 `/api/identify/sync` 做识别（路径名沿用 `sync`，实为识图主接口） |
| 智能巡护（本地离线版） | 开始/结束巡护、5 分钟自动轨迹采样、事件标记（类型/备注/照片/录音）、事件筛选/排序/导出（JSON）、联网时高德地图轨迹展示 |
| 首页「其他、等等」 | 退出登录；**断网测试**开关；**申请定位权限**按钮（主动触发定位授权并给出细分错误提示） |

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

> 巡护/识图定位提示：若在手机上通过 `http://局域网IP:5173` 访问，浏览器可能因**非安全上下文**拒绝定位。建议使用 HTTPS（正式域名或内网穿透地址）测试定位能力。

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
5. **识图与 Nginx 请求体上限**：`POST /api/identify/sync` 携带 **Base64 图片**，请求体常 **大于 1MB**。Nginx 默认 **`client_max_body_size 1m`** 会返回 **413**，手机端往往只显示「识图请求失败」。请在 **`server { ... }` 内**增加一行 **`client_max_body_size 20m;`**（或更大），并对 **`location /api/`** 适当增加 **`proxy_read_timeout 120s;`** 等，然后执行 **`sudo nginx -t && sudo systemctl reload nginx`**。同时确认后端 **`PLANT_API_KEY` / `PLANT_API_SECRET`** 已配置并重启 **`forestry-backend`**。

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

**已移除**：`POST /api/qa/sync`、巡护相关 API、同步审计 API（当前巡护为前端本地模式）。

## 离线与「断网测试」

- 问答/识图界面根据 **有效在线状态** 决定是否走联网请求：由 Pinia `stores/network.js` 合并 **浏览器 `online`/`offline` 事件** 与首页 **模拟断网** 开关。  
- 模拟断网仅影响本应用内逻辑，**不会**断开系统网络；若需完全阻断 HTTP，需另行在请求层拦截（未默认内置）。
