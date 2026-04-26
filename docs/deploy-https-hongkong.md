# 香港（或其它地区）HTTPS 服务器部署要点

本项目前端生产构建默认 **`VITE_API_BASE=/api`**（与站点同源），由 Nginx 把 **`/api/`** 反代到本机 Flask。在香港或其它地区启用 **HTTPS** 的 VPS 上部署时，请按下列清单配置。

## 1. 环境变量（服务器上的 `.env.local` 或 systemd `EnvironmentFile`）

| 变量 | 说明 |
|------|------|
| **`CORS_ORIGINS`** | **必填**。必须与用户地址栏中的**来源**完全一致（含 `https://`、主机名、无路径）。多个用英文逗号分隔，无多余空格。示例：`https://www.example.hk,https://example.hk` |
| **`FLASK_BEHIND_PROXY`** | 置于 Nginx/Caddy 反代后建议设为 **`1`**，以便 Flask 识别 `X-Forwarded-Proto: https` 等转发头。 |
| **`SECRET_KEY` / `JWT_SECRET_KEY`** | 生产环境务必改为**随机长字符串**，勿使用仓库默认值。 |
| **`FLASK_DEBUG`** | 生产设为 **`0`**（或不设置，见 `run.py` 默认）。 |
| **`PLANT_API_*` / `LLM_API_*`** | 识图与问答依赖外网 API，香港服务器一般可直接访问；若走企业代理再单独配置。 |
| **`TIANDITU_JS_KEY`** | 天地图 JS Key；在天地图控制台配置域名白名单，并由 **`/api/public/client-config`** 提供给前端。 |

前端构建仍使用仓库根目录 **`.env.production`** 中的 **`VITE_API_BASE=/api`** 即可（与 Nginx 同源反代一致）。**不要**在参与 `npm run build` 的 env 里写 `http://localhost:5000/...`。

## 2. Nginx

- 参考 **`docs/nginx-https-production.example.conf`**：443、`ssl_certificate`、`client_max_body_size 20m`、`/api/` 的 **`proxy_read_timeout 120s`**（识图与长问答）。
- 证书可使用 **Let’s Encrypt（certbot）** 或云厂商托管证书。
- 配置 **`add_header Strict-Transport-Security ...`** 可按需调整 `max-age` 与是否包含子域。

## 3. 后端进程

- 推荐使用 **gunicorn** / **uwsgi** 等 WSGI 服务监听 `127.0.0.1:5000`，由 Nginx 反代，勿将 `debug=True` 暴露到公网。
- 若暂时使用 **`python run.py`**：请设置 **`FLASK_DEBUG=0`**，并仍由 Nginx 终止 TLS。

## 4. 部署后自检

- 手机浏览器打开 **`https://你的域名`**，登录请求应为同源 **`/api/auth/login`**。
- 识图上传若出现 **413**：检查 Nginx **`client_max_body_size`**。
- 若 CORS 报错：核对 **`CORS_ORIGINS`** 是否与当前访问的 `https://主机名` 完全一致（含是否带 `www`）。

## 5. 时区（可选）

系统级可使用 **`Asia/Hong_Kong`**（例如在 systemd 单元中设置 `Environment=TZ=Asia/Hong_Kong`），便于日志与运维；应用逻辑仍以 UTC 存储为宜。
