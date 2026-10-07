# DeepSeek 余额查询

> 粘贴 DeepSeek API Key，看清账户还剩多少钱、这笔钱大概还能聊多少轮 —— 结果直接说人话。

一个部署在 Cloudflare 上的单页小工具：Three.js 实时渲染的暮色山谷作背景，中间是一块磨砂玻璃终端，
输入密钥后逐字「打」出余额播报。

![tech](https://img.shields.io/badge/React%2019-Vite%208-61dafb) ![tech](https://img.shields.io/badge/Three.js-r186-000000) ![tech](https://img.shields.io/badge/Cloudflare-Workers-f38020)

## 它做了什么

- **3D 风景背景**：程序化生成的山脉、湖面倒影、星空与光尘，带泛光（Bloom）与色调映射。
  鼠标移动有视差，画面缓慢呼吸；性能不足时自动降档（关泛光、降分辨率）。
- **磨砂玻璃终端**：居中弹出的终端窗口，`backdrop-filter` 毛玻璃 + 顶部高光边，含历史输入、
  `help` / `about` / `clear` 命令与快捷键。
- **流式播报**：结果不是把 JSON 甩给你，而是像有人在打字一样逐字交代 —— 余额卡片、
  充值/赠送构成条、「还能聊多少轮」的粗算表，全部对不齐的字段都被翻译成人话。
- **错误也讲人话**：密钥无效、余额耗尽、限流、被网络拦截、超时、接口改版，各有对应的解释与下一步建议。

## 隐私模型（重要）

| 路径 | 何时使用 | 密钥去向 |
| --- | --- | --- |
| **浏览器直连**（默认） | 每次查询 | 由浏览器直接发往 `api.deepseek.com`，本站服务器看不到 |
| **本站边缘代理** | 仅当你手动点击「用本站代理重试」 | 经本站 Cloudflare Worker 转发一次，不记录、不落盘 |

- 页面不会把密钥写入任何持久化存储，**除非**你主动勾选「在此浏览器记住密钥」（写入 localStorage）。
- 边缘代理不做日志采集（`worker/index.ts` 里没有任何 `console.log`），响应头统一 `no-store`。
- 前端 CSP：`connect-src` 只放行本站与 `https://api.deepseek.com`。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite 8 |
| 3D | Three.js（自写天空/水面/山体着色器 + UnrealBloom 后处理） |
| 边缘 | Cloudflare Workers 静态资源 + 一个 `/api/balance` 代理函数 |
| 测试 | Vitest（56 条单测，覆盖播报文案、错误映射、金额格式化、牌价换算） |

## 本地开发

```bash
pnpm install
pnpm dev            # 前端 → http://127.0.0.1:5173
```

### 不带真实密钥也能看完整流程

开发环境内置了演示数据（生产构建会被 Vite 插件剥离，不会进产物）：

```text
demo          # 人民币 110 元（充值 100 + 赠送 10）
demo usd      # 只有美元余额
demo multi    # 两个币种
demo empty    # 余额为 0、不可用
demo 401      # 密钥无效
demo 402      # 余额不足
demo 500      # 服务端故障
demo net      # 网络被拦截（会给出「用本站代理重试」按钮）
demo timeout  # 超时
```

### 联调边缘代理

```bash
npx wrangler dev --port 8787    # 终端 A：本地 Worker（同时托管 dist/）
pnpm dev                        # 终端 B：前端，/api/* 会转发到 8787
# 然后访问 http://127.0.0.1:5173/?via=proxy 强制走代理路径
```

## 代码检查、测试与构建

```bash
pnpm lint        # oxlint 静态检查（24 个文件约 60ms）
pnpm typecheck   # tsc -b
pnpm test        # Vitest，58 个用例
pnpm build       # 类型检查 + 产物构建到 dist/
pnpm cf:dev      # 构建 + 本地跑真实的 Worker 环境
```

静态检查用 **oxlint** 而不是 ESLint：ESLint 的 TypeScript 解析器（`typescript-eslint`）目前
[不支持 TypeScript 7 的 API](https://github.com/typescript-eslint/typescript-eslint/issues/10940)，
而本项目用的是 TS 7 + Vite 8；oxlint 自带 TS 解析，不依赖 TS 的 JS API，也不需要为它降级编译器。
规则取舍写在 [.oxlintrc.json](.oxlintrc.json) 的注释里，其中 `no-console` 是硬约束：
本站承诺「密钥不记录」，所以源码里不允许出现任何 console 输出。

## 部署到 Cloudflare

```bash
npx wrangler login      # 浏览器里完成授权（只需一次）
npx wrangler whoami     # 确认登的是哪个账号（多账号时 wrangler 会追问 account）
pnpm run deploy         # 构建 + 部署，默认地址 https://deepseek-balance.<你的子域>.workers.dev
```

> ⚠️ 部署请用 `pnpm run deploy`，不要写 `pnpm deploy` —— 后者会命中 pnpm 自带的
> workspace 部署命令（作用是往目录里拷包），跟本站无关。用 npm 的话 `npm run deploy` 正常。

部署完成后建议自查（把 `<url>` 换成实际地址）：

```bash
curl -sI <url>/ | grep -i content-security-policy      # 应返回一行 CSP
curl -s -X POST <url>/api/balance \
  -H 'content-type: application/json' \
  -d '{"key":"sk-1234567890abcdefghijklmnopqrstuv"}'   # 应返回 401 + 官方错误原文
```

- 项目名、入口、路由规则都在 `wrangler.jsonc`：静态资源走 `dist/`，只有 `/api/*` 会先进 Worker。
- 绑定自定义域名：Cloudflare 控制台 → Workers & Pages → `deepseek-balance` → Settings → Domains & Routes；
  或直接在 `wrangler.jsonc` 里加 `"routes": [{ "pattern": "你的域名/*", "zone_name": "你的域名" }]`。
- 想换个 Worker 名（= 默认域名前缀），改 `wrangler.jsonc` 的 `name` 即可。
- 回滚：控制台 → 该 Worker → Deployments，选上一个版本重新部署即可。

## 项目结构

```
src/
  scene/       Three.js 场景：createLandscape.ts（天空/山体/水面/松树/光尘）、noise.ts、Landscape.tsx
  lib/
    deepseek.ts  接口调用、错误分类、密钥清洗（直连 / 代理两条路径）
    narrate.ts   ★ 把接口返回值翻译成自然语言「播报稿」
    pricing.ts   官方牌价 + 「还能聊多少轮」的换算
    markup.ts    极简富文本（链接/代码/加粗）分段，供打字机逐段显示
    format.ts    金额、数量、时间的展示格式化
  hooks/useTerminalSession.ts  播报调度：逐 token 播放、跳过动画、取消、重试
  components/   Terminal.tsx、Blocks.tsx（余额卡/估算表/按钮组）、RichText.tsx
worker/index.ts  Cloudflare Worker：静态资源 + /api/balance 代理
```

## 维护提示

- **牌价会变**：`src/lib/pricing.ts` 里的价格核对日期是 `PRICING_VERIFIED_ON`。
  换算只用于「这笔钱大概还能用多久」的粗略估计，页面已明确标注以官网为准。
- **接口若改版**：`src/lib/types.ts` 的 `isBalanceResponse` 会识别不出来，页面会播报
  「收到了回复，但内容不是余额数据」，而不是静默出错。
