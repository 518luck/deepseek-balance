import { useCallback, useEffect, useRef, useState } from 'react'
import {
  looksLikeDeepSeekKey,
  normalizeKey,
  queryBalance,
  type QueryOutcome,
  type Via,
} from '../lib/deepseek'
import { segmentRich, type RichToken } from '../lib/markup'
import {
  narrateAbout,
  narrateFailure,
  narrateHelp,
  narrateSuccess,
  narrateUnknownCommand,
  type Block,
  type NarrationPlan,
  type TerminalAction,
  type TextBlock,
  type Tone,
} from '../lib/narrate'

export type Phase = 'idle' | 'connecting' | 'streaming' | 'done'

/** 文本行：按 token 逐段显示，revealed 表示已经显示到第几个 token */
export interface TextSessionItem {
  type: 'text'
  id: string
  tone: Tone
  tokens: RichToken[]
  revealed: number
  typing: boolean
}

/** 结构化卡片（余额卡 / 估算表 / 按钮组） */
export interface BlockSessionItem {
  type: 'block'
  id: string
  block: Exclude<Block, TextBlock>
  revealed: boolean
}

export type SessionItem = TextSessionItem | BlockSessionItem

export interface SubmitOptions {
  /** 跳过「不像密钥」的预检，直接发请求 */
  force?: boolean
  via?: Via
}

const TICK_MS = 16
const LINE_GAP_MS = 90
const CONNECTING_TEXT = '正在向 api.deepseek.com 查询余额'

/**
 * 开发环境可用 ?via=proxy 强制走代理，方便在没有真实密钥时联调边缘函数。
 * 生产构建里 import.meta.env.DEV 会被替换成 false，这段代码不会进入产物。
 */
const DEV_VIA: Via | null =
  import.meta.env.DEV && typeof window !== 'undefined'
    ? ((new URLSearchParams(window.location.search).get('via') as Via | null) ?? null)
    : null

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isKnownCommand(value: string): 'help' | 'about' | 'clear' | null {
  const command = value.toLowerCase().replace(/^\//, '')
  if (command === 'help' || command === '?' || command === 'h') return 'help'
  if (command === 'about' || command === 'info') return 'about'
  if (command === 'clear' || command === 'cls') return 'clear'
  return null
}

/** 像命令又没命中：纯字母、够短（避免把写错的密钥当成命令） */
function looksLikeCommand(value: string): boolean {
  return /^\/?[a-z]{2,12}$/.test(value)
}

export function useTerminalSession() {
  const [items, setItems] = useState<SessionItem[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [status, setStatus] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)

  const mountedRef = useRef(true)
  /** 当前正在播放的稿子；切换成新对象即代表旧稿作废 */
  const playRef = useRef<{ cancelled: boolean; skip: boolean } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastInputRef = useRef('')
  const itemsRef = useRef<SessionItem[]>([])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (playRef.current) playRef.current.cancelled = true
      abortRef.current?.abort()
    }
  }, [])

  /** items 同时保存在 ref 里：播放循环需要即时读到最新值，不能等 state 回流 */
  const commit = useCallback((next: SessionItem[], guard?: () => boolean) => {
    if (guard && !guard()) return
    itemsRef.current = next
    if (mountedRef.current) setItems(next)
  }, [])

  const stopPlayback = useCallback(() => {
    if (playRef.current) playRef.current.cancelled = true
    playRef.current = null
  }, [])

  const cancel = useCallback(() => {
    stopPlayback()
    abortRef.current?.abort()
    abortRef.current = null
    setStatus(null)
    setPhase((current) => (current === 'idle' ? current : 'done'))
  }, [stopPlayback])

  const clear = useCallback(() => {
    stopPlayback()
    abortRef.current?.abort()
    abortRef.current = null
    itemsRef.current = []
    setItems([])
    setStatus(null)
    setSummary(null)
    setPhase('idle')
  }, [stopPlayback])

  /** 逐 token 播放一份播报稿（新稿开始时自动作废旧稿） */
  const play = useCallback(
    async (plan: NarrationPlan) => {
      stopPlayback()
      const token = { cancelled: false, skip: false }
      playRef.current = token
      const superseded = () => token.cancelled || playRef.current !== token || !mountedRef.current

      setSummary(plan.summary)
      setPhase('streaming')

      // 终端语义：新结果追加在旧输出下面，而不是清屏
      const next: SessionItem[] = [...itemsRef.current]

      for (const block of plan.blocks) {
        if (superseded()) return

        if (block.kind === 'text') {
          const tokens = segmentRich(block.text)
          const index = next.length
          next.push({ type: 'text', id: block.id, tone: block.tone, tokens, revealed: 0, typing: true })
          commit([...next], () => !superseded())

          for (let i = 1; i <= tokens.length; i += 1) {
            if (superseded()) return
            if (token.skip) break
            const current = tokens[i - 1]
            await sleep(TICK_MS + (current?.pause ?? 0))
            if (superseded()) return
            next[index] = { ...(next[index] as TextSessionItem), revealed: i }
            commit([...next], () => !superseded())
          }

          next[index] = { ...(next[index] as TextSessionItem), revealed: tokens.length, typing: false }
          commit([...next], () => !superseded())
          if (!token.skip) await sleep(block.pause ?? LINE_GAP_MS)
          continue
        }

        if (!token.skip) await sleep(block.kind === 'balance' ? 180 : 120)
        if (superseded()) return
        next.push({ type: 'block', id: block.id, block, revealed: Boolean(token.skip) })
        commit([...next], () => !superseded())
        if (!token.skip) await sleep(block.kind === 'balance' ? 220 : 140)
      }

      if (superseded()) return
      playRef.current = null
      setPhase('done')
    },
    [commit, stopPlayback],
  )

  /** 直接播放一个查询结果（开发环境的演示数据也走这里） */
  const present = useCallback(
    (outcome: QueryOutcome) => {
      void play(outcome.ok ? narrateSuccess(outcome) : narrateFailure(outcome))
    },
    [play],
  )

  const runQuery = useCallback(
    async (raw: string, options: SubmitOptions) => {
      stopPlayback()
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      itemsRef.current = itemsRef.current // 保持引用语义，便于阅读

      setStatus(CONNECTING_TEXT)
      setPhase('connecting')

      const outcome = await queryBalance(normalizeKey(raw), {
        via: options.via ?? DEV_VIA ?? 'direct',
        signal: controller.signal,
      })

      // 期间又提交了新查询 / 被取消 / 组件卸载 → 丢弃这次结果
      if (!mountedRef.current || abortRef.current !== controller) return

      abortRef.current = null
      setStatus(null)
      present(outcome)
    },
    [present, stopPlayback],
  )

  const submit = useCallback(
    (raw: string, options: SubmitOptions = {}) => {
      const trimmed = raw.trim()
      lastInputRef.current = raw

      if (!trimmed) {
        void play(narrateFailure({ ok: false, via: 'direct', latencyMs: 0, fetchedAt: Date.now(), kind: 'empty' }))
        return
      }

      const command = isKnownCommand(trimmed)
      if (command === 'clear') {
        clear()
        return
      }
      if (command === 'help') {
        void play(narrateHelp())
        return
      }
      if (command === 'about') {
        void play(narrateAbout())
        return
      }

      const key = normalizeKey(trimmed)
      if (looksLikeDeepSeekKey(key)) {
        void runQuery(raw, options)
        return
      }
      if (looksLikeCommand(trimmed)) {
        void play(narrateUnknownCommand(trimmed))
        return
      }
      if (!options.force) {
        void play(narrateFailure({ ok: false, via: 'direct', latencyMs: 0, fetchedAt: Date.now(), kind: 'shape' }))
        return
      }
      void runQuery(raw, options)
    },
    [clear, play, runQuery],
  )

  const runAction = useCallback(
    (action: TerminalAction) => {
      const raw = lastInputRef.current
      switch (action) {
        case 'force-shape':
          submit(raw, { force: true })
          break
        case 'retry-direct':
          submit(raw, { force: true, via: 'direct' })
          break
        case 'retry-proxy':
          submit(raw, { force: true, via: 'proxy' })
          break
      }
    },
    [submit],
  )

  /** Esc：跳过打字动画，立刻显示全文 */
  const skip = useCallback(() => {
    if (playRef.current) playRef.current.skip = true
  }, [])

  const busy = phase === 'connecting' || phase === 'streaming'

  return { items, phase, status, summary, busy, submit, present, runAction, skip, clear, cancel }
}

export type TerminalSession = ReturnType<typeof useTerminalSession>
