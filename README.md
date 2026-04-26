# 林业智能巡护助手

面向中国大学生计算机设计大赛 **Web 应用与开发** 赛道的林业工具站点，在**本机离线能力**与**联网能力**之间取得平衡，为林业工作者提供便捷、高效的移动解决方案。

## 🚀 核心功能

| 模块 | 说明 |
|------|------|
| 🔐 登录与鉴权 | JWT 认证，保障数据安全 |
| 🤖 林业知识问答 | 联网调用 LLM；本地 IndexedDB 保存会话与消息；支持 PDF 文本提取导入 |
| 🌿 林业识图 | 拍照/相册上传、图集管理、云端识别 |
| 🚶 智能巡护 | 本地轨迹记录、事件标记、天地图展示、轨迹回放、PDF 简报导出、云端同步 |
| 🏠 首页 | 断网测试、定位权限申请、退出登录 |
| 📱 PWA 支持 | 可添加到主屏幕，离线访问，类似原生应用体验 |

## 🛠 技术栈

- **前端**：Vue 3 + Vite + Pinia + Vue Router + Vant
- **后端**：Flask + Flask-JWT-Extended + Flask-SQLAlchemy
- **数据库**：SQLite（默认）
- **本地存储**：IndexedDB
- **PWA**：Service Worker + Web App Manifest
- **地图**：天地图 SDK
- **AI**：LLM API + 植物识别 API

## 📁 目录结构

```
forestry-toolbox-v2/
├── backend/                  # 后端应用
│   ├── app/
│   │   ├── routes/          # API 路由（auth、health、identify、patrol、qa）
│   │   ├── services/        # 服务（llm_provider、plant_provider）
│   │   ├── models.py        # 数据模型
│   │   ├── config.py        # 配置管理
│   │   └── extensions.py    # 扩展初始化
│   └── run.py               # 启动入口
├── frontend/                 # 前端应用
│   ├── public/
│   │   ├── manifest.webmanifest  # PWA 配置
│   │   ├── sw.js                 # Service Worker
│   │   └── pwa-*.png             # PWA 图标
│   ├── src/
│   │   ├── views/           # 页面组件
│   │   ├── components/      # 通用组件
│   │   ├── stores/          # 状态管理
│   │   ├── services/        # 服务模块
│   │   └── api/             # API 客户端
│   └── package.json
└── README.md                # 项目说明
```

## ⚙️ 环境变量

### 后端常用
- `PLANT_API_KEY`、`PLANT_API_SECRET`：植物识别 API 凭证
- `LLM_API_KEY`：大语言模型 API 密钥
- `CORS_ORIGINS`：允许的跨域来源
- `TIANDITU_JS_KEY`：天地图 API 密钥
- `FLASK_BEHIND_PROXY`：是否在代理后运行

### 前端常用
- `VITE_API_BASE`：API 基础地址（默认 `/api`）

## 📥 本地启动

### 后端

```powershell
# 进入后端目录
cd backend

# 创建虚拟环境
python -m venv .venv

# 激活虚拟环境
.venvcriptsctivate.ps1  # Windows
# source .venv/bin/activate  # Linux/Mac

# 安装依赖
pip install -r requirements.txt

# 启动服务
python run.py
```

健康检查：`http://localhost:5000/api/health`

### 前端

```powershell
# 进入前端目录
cd frontend

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

访问地址：`http://localhost:5173`

## 🌐 内网穿透（手机测试）

1. 启动本地服务：`python backend/run.py` 和 `npm run dev`
2. 使用 ngrok、cpolar 等工具创建隧道，指向端口 5173
3. 在 `.env.local` 中配置：
   - `VITE_API_BASE=/api`
   - `CORS_ORIGINS` 追加隧道地址
4. 重启服务，使用隧道 HTTPS 地址在手机上测试

## 🚀 生产部署

### 快速更新

```bash
cd /opt/forestry-toolbox-v2
git pull
echo "=== 更新后端 ==="
cd backend && source .venv/bin/activate && pip install -r requirements.txt
echo "=== 构建前端 ==="
cd ../frontend && rm -rf dist && npm ci && npm run build
echo "=== 重启服务 ==="
sudo systemctl restart forestry-backend
sudo nginx -t && sudo systemctl reload nginx
echo "=== 部署完成 ==="
```

### Nginx 配置

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    # SSL 配置
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    # 前端静态文件
    root /opt/forestry-toolbox-v2/frontend/dist;
    index index.html;
    
    # API 代理
    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_read_timeout 120s;
        client_max_body_size 20m;
    }
    
    # 前端路由
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## 📡 核心 API

### 认证
- `POST /api/auth/login` - 用户登录
- `POST /api/auth/register` - 用户注册
- `GET /api/auth/me` - 获取当前用户信息

### 识图
- `POST /api/identify/sync` - 同步识别植物
- `GET /api/identify/history` - 获取识别历史

### 问答
- `POST /api/qa/ask` - 提交问题
- `GET /api/qa/sessions` - 获取会话列表
- `GET /api/qa/sessions/<id>/messages` - 获取会话消息
- `GET /api/qa/knowledge-search` - 搜索知识库
- `POST /api/qa/knowledge-import` - 导入知识

### 巡护
- `POST /api/patrol/sync` - 同步巡护数据
- `GET /api/patrol/tasks` - 获取巡护任务
- `GET /api/patrol/tasks/<id>` - 获取任务详情

## 📱 PWA 功能

### 特性
- ✅ 添加到主屏幕
- ✅ 离线访问
- ✅ 响应式设计
- ✅ 推送通知（需配置）

### 安装方法
1. 使用 Chrome、Safari 等现代浏览器访问
2. 点击浏览器菜单 → 添加到主屏幕
3. 按照提示完成安装
4. 从主屏幕图标启动应用

## 🔋 离线功能

- **本地存储**：IndexedDB 保存数据，支持无网络环境
- **断网测试**：首页提供断网模拟开关
- **自动同步**：网络恢复后自动同步数据

## 🌍 智能巡护

### 功能特点
- **实时轨迹**：每 2 秒自动采样，过滤漂移点
- **事件管理**：支持 6 种事件类型，可添加照片和备注
- **轨迹回放**：滑块控制 + 自动播放
- **地图展示**：天地图集成，显示轨迹和事件
- **PDF 导出**：自定义巡护简报，包含统计信息
- **云端同步**：数据安全备份到云端

## 🎯 技术亮点

1. **离线优先**：IndexedDB 本地存储，确保野外作业可靠
2. **智能识别**：集成植物识别和 LLM 问答
3. **实时定位**：高精度 GPS 定位，轨迹采集
4. **PWA 体验**：类似原生应用，可添加到主屏幕
5. **模块化架构**：前后端分离，易于扩展

## 📝 注意事项

- 首次使用请申请定位权限
- 图片上传建议不超过 5MB
- 生产环境需配置 HTTPS
- 定期备份本地数据
- 推荐使用现代浏览器

---

**林业智能巡护助手** - 为林业工作者打造的专业移动工具，助力生态保护与科学决策！