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

巡护页首屏：先 **`count`** 再空闲时载入列表数据；**高德地图**拆为 `components/PatrolMapPanel.vue` 且默认不加载，需点击「显示地图」或事件「定位」时再拉 SDK。`offlineDb.js` 对轨迹/事件按任务 **限量游标读取**，避免数万条一次性进内存卡死主线程。

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

### 0）一键准备「隧道联调」环境（可选）

在仓库根目录执行（会生成或提示编辑 `.env.local`，**不会覆盖**已有 `.env.local`）：

```powershell
cd path\to\forestry-toolbox-v2
powershell -ExecutionPolicy Bypass -File .\scripts\Prep-TunnelDev.ps1
```

脚本会打印**必须由你本人完成的步骤**（安装隧道客户端、运行 `cloudflared`、把 HTTPS 域名写入 `CORS_ORIGINS`、手机开定位权限等）。详见下文 **2.1）本地 + 内网穿透**。

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

默认：`http://localhost:5173`。开发时推荐在项目根目录 `.env.local` 中设置 **`VITE_API_BASE=/api`**，由 Vite 把 `/api` 代理到本机 Flask（见 `frontend/vite.config.js`）。

> 巡护/识图定位提示：若在手机上通过 `http://局域网IP:5173` 访问，浏览器可能因**非安全上下文**拒绝定位。建议使用 HTTPS（正式域名或内网穿透地址）测试定位能力。

### 2.1）本地 + 内网穿透（手机用公网 HTTPS 打开你电脑上的 dev）

适用：**手机 4G/5G** 或外网访问你本机正在跑的 `npm run dev`，且希望 **HTTPS**（定位、部分 API 更友好）。

**推荐做法：一条隧道指到前端 5173**（cpolar、ngrok、Cloudflare Tunnel、花生壳等均可，按各工具文档在本机安装客户端）。

1. 本机照常启动：`python backend/run.py` 与 `npm run dev`（`vite.config.js` 已 `host: 0.0.0.0`）。
2. 把隧道「本地端口」设为 **5173**，记下工具给出的 **HTTPS 公网地址**，例如 `https://abc.example-tunnel.com`。
3. 在项目根目录 **`.env.local`**（勿提交 Git）中配置：
   - **`VITE_API_BASE=/api`**：手机访问隧道域名时，接口仍走「当前页面同源」的 `/api`，由 **Vite 代理**到本机 `5000`，无需把后端再暴露一条隧道。
   - **`CORS_ORIGINS`**：在原有 `http://localhost:5173` 基础上**追加**你的隧道来源，与浏览器地址栏一致，例如  
     `CORS_ORIGINS=http://localhost:5173,https://abc.example-tunnel.com`  
     （多个用英文逗号分隔，**不要**多余空格除非键名要求）。
4. **改完 `.env.local` 后重启后端与 Vite**，再用手机打开隧道 HTTPS 地址测试。

**任选一种穿透工具（示例）**

- **ngrok**（国际、注册后配置 authtoken）：安装后执行 `ngrok http 5173`，控制台会打印 `https://xxxx.ngrok-free.app` 之类地址，把它写进 `CORS_ORIGINS` 并重启后端。  
- **Cloudflare Tunnel（cloudflared）**：按官方文档执行 `cloudflared tunnel --url http://127.0.0.1:5173`，得到 `https://xxx.trycloudflare.com` 等临时 HTTPS 域名，同样写入 `CORS_ORIGINS`。  
- **cpolar / 花生壳**（国内常用）：客户端里新建隧道，本地端口 **5173**，使用工具分配的 **HTTPS** 公网地址写入 `CORS_ORIGINS`。

#### 花生壳（Oray）与本项目对接（你已安装客户端时）

1. **登录**花生壳账号，打开 **内网穿透**（或「TCP / 网站」类映射，以你安装的版本界面为准）。  
2. **新建映射**：内网主机填 **`127.0.0.1`**，内网端口填 **`5173`**（对应本机 `npm run dev` 的 Vite）。不要映射到 5000，除非你打算改 `VITE_API_BASE` 走直连后端（不推荐，见上文）。  
3. 保存后复制花生壳给出的 **外网访问地址**。  
   - **测 GPS / 巡护定位**：请尽量使用 **`https://` 开头**的地址（若当前只有 `http://`，部分手机浏览器会限制定位；可在花生壳里开启 **HTTPS 映射**或使用带 HTTPS 的域名套餐，以花生壳文档为准）。  
4. 地址栏里怎么写，`CORS_ORIGINS` 里就要怎么写（协议 + 主机 + 端口，与之一致），例如：  
   `CORS_ORIGINS=http://localhost:5173,https://你的域名.vip`  
5. 根目录 **`.env.local`** 保持 **`VITE_API_BASE=/api`**，改完 **重启 Flask 与 `npm run dev`**。  
6. 本机 **Windows 防火墙** 若拦截本机程序访问，需允许 **Python / Node** 或放行 **5173**（仅本机回环时一般不必）。  
7. 手机用 **移动数据** 打开花生壳外网地址测试；系统与浏览器均允许定位。

手机用 **4G/5G** 打开隧道地址后，在系统设置里为该浏览器打开**定位权限**；站点内首次使用定位时浏览器还会再弹一次授权，需点**允许**。`vite.config.js` 已设置 **`server.allowedHosts: true`**，避免隧道域名被 Vite 拦截。

若你**只穿透了后端 5000**、页面仍用 `http://本机IP:5173`，则前端需 **`VITE_API_BASE=https://你的后端隧道地址/api`**，且 `CORS_ORIGINS` 里要包含 `http://本机IP:5173`（此方式仍可能因 HTTP 页面触发定位限制，不如「只穿透 5173」省心）。

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

### 腾讯云轻量应用服务器：长期对外访问（推荐，不等同于「再穿透一层」）

轻量云一般已有 **公网 IP**，网站长期上线不必再套家用意义上的内网穿透；标准做法是 **域名 + Nginx + HTTPS**：

1. **域名**：在域名注册商处把 **A 记录** 指到轻量实例的公网 IP（若用腾讯云 DNSPod，在控制台添加解析即可）。若域名需 **ICP 备案**，请按腾讯云备案流程完成后再开 80/443。  
2. **服务器**：`/opt/forestry-toolbox-v2`（或你的目录）拉代码、配 `backend/.env.local` 或 systemd 的 `EnvironmentFile`，其中生产前端构建使用 **`VITE_API_BASE=https://你的域名/api`**（与 Nginx 反代路径一致）。  
3. **Nginx**：`root` 指向 `frontend/dist`，`location /api/` `proxy_pass` 到本机后端（如 `127.0.0.1:5000`）；参考仓库 `docs/nginx-forestry-example.conf`。  
4. **HTTPS**：使用 **Let’s Encrypt**（`certbot --nginx -d 你的域名`）或腾讯云 SSL 证书托管，保证全站 HTTPS，便于定位与高德等能力。  
5. **防火墙**：轻量控制台「防火墙」放行 **80、443**；仅 SSH 时放行 22。

这样用户长期访问的是 **`https://你的域名`**，稳定、可备案、可续期证书，与「本机开发时临时开隧道」是两种场景。

若你另有需求（例如：**没有公网 IP 的家里的设备** 要通过云主机中转访问），才需要在云上部署 **frp server** 等专用穿透/中继方案，与本仓库默认部署模型不同，需单独设计端口与安全策略。

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
