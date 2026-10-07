import { lazy, Suspense } from 'react'
import { Terminal } from './components/Terminal'

/** 3D 场景单独打包：终端 UI 先渲染，three.js 随后接管背景 */
const Landscape = lazy(() => import('./scene/Landscape'))

export default function App() {
  return (
    <>
      <Suspense fallback={null}>
        <Landscape />
      </Suspense>
      <div className="grain" aria-hidden="true" />

      <main className="app">
        <header className="app__head">
          <p className="app__eyebrow">
            <span className="app__eyebrow-dot" aria-hidden="true" />
            余额查询 · Balance Checker
          </p>
          <h1 className="app__title">DeepSeek 余额查询</h1>
          <p className="app__subtitle">
            粘贴你的 API Key，看看账户里还剩多少钱、这笔钱大概还能聊多久 —— 结果直接说人话。
          </p>
        </header>

        <Terminal />

        <footer className="app__foot">
          <p>
            默认由浏览器直连 <code>api.deepseek.com</code>，密钥不经过本站服务器；只有在你手动选择「用本站代理重试」时，
            才会经 Cloudflare 边缘函数转发一次，不记录、不落盘。
          </p>
          <p>
            本站是第三方小工具，与 DeepSeek 官方无关联；余额数据来自官方只读接口，价格与计费以
            <a href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing" target="_blank" rel="noreferrer noopener">
              官方定价页
            </a>
            为准。
          </p>
        </footer>
      </main>
    </>
  )
}
