import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

const DEV_DEMO_STUB = '\0dev-demo-stub'

/**
 * 演示数据（src/lib/demo.ts）只是开发调试工具：
 * 生产构建里把它换成空实现，避免把假数据打进了线上产物。
 * 开发服务器不受影响（apply: 'build'）。
 */
function stripDevDemoPlugin(): Plugin {
  return {
    name: 'deepseek-balance:strip-dev-demo',
    apply: 'build',
    // 必须在 Vite 自己的解析之前拦下这个模块，否则拿到的已经是绝对路径
    enforce: 'pre',
    resolveId(source) {
      if (/(^|\/)\.\.?\/lib\/demo(\.ts)?$/.test(source) || source.endsWith('/src/lib/demo.ts')) {
        return DEV_DEMO_STUB
      }
      return null
    },
    load(id) {
      if (id === DEV_DEMO_STUB) {
        return 'export function demoOutcome() {\n  throw new Error("demo data is only available in dev")\n}\n'
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [react(), stripDevDemoPlugin()],
  build: {
    target: 'es2022',
    // three.js 通过动态 import 引入，Rollup 会自动把它拆成独立 chunk，
    // 首屏只加载终端 UI，3D 场景随后异步接管画面。
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    // 本地联调边缘函数：先跑 `npx wrangler dev --port 8787`，
    // 开发服务器会把 /api/* 转发给它（配合 ?via=proxy 使用）。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
