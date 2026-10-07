/**
 * localStorage 读写：只在用户主动勾选「记住密钥」时才会用到。
 * 隐私模式 / 禁用存储时会抛错，这里全部吞掉并退化为“不记住”。
 */

const KEY_STORAGE = 'deepseek-balance:api-key'
const REMEMBER_PREF = 'deepseek-balance:remember'

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    /* 忽略：不可写就当没这回事 */
  }
}

export function loadRememberedKey(): string {
  return safeGet(KEY_STORAGE) ?? ''
}

export function saveRememberedKey(key: string | null): void {
  safeSet(KEY_STORAGE, key && key.trim() ? key.trim() : null)
}

export function loadRememberPref(): boolean {
  return safeGet(REMEMBER_PREF) === '1'
}

export function saveRememberPref(remember: boolean): void {
  safeSet(REMEMBER_PREF, remember ? '1' : null)
}
