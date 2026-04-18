import fs from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '')
  const useHttps = ['1', 'true', 'True'].includes(env.VITE_USE_HTTPS || '')
  const certPath = env.VITE_SSL_CERT || ''
  const keyPath = env.VITE_SSL_KEY || ''
  const hasCustomCert = certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)

  const apiTarget = env.VITE_DEV_API_PROXY_TARGET || 'http://127.0.0.1:5000'

  return {
    envDir: '..',
    plugins: [vue()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      https: useHttps
        ? hasCustomCert
          ? {
              cert: fs.readFileSync(certPath),
              key: fs.readFileSync(keyPath),
            }
          : true
        : false,
      // 与根目录 .env.local 中 VITE_API_BASE=/api 配套：开发时把 /api 转发到 Flask，避免跨域与误打到 Vite 静态资源
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
