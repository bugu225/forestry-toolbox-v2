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
    },
  }
})
