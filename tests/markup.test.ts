import { describe, expect, it } from 'vitest'
import { plainText, segmentRich, splitPlain, tokensToPlain } from '../src/lib/markup'

describe('segmentRich', () => {
  it('把链接切成一个整体 token，不会露出半截标记', () => {
    const tokens = segmentRich('到 [控制台](https://platform.deepseek.com/api_keys) 看看')
    const links = tokens.filter((token) => token.kind === 'link')
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('控制台')
    expect(links[0]!.href).toBe('https://platform.deepseek.com/api_keys')
    expect(tokensToPlain(tokens)).toBe('到 控制台 看看')
  })

  it('识别行内代码、加粗与裸链接', () => {
    const tokens = segmentRich('用 `clear` **清屏**，或访问 https://example.com/x')
    expect(tokens.some((token) => token.kind === 'code' && token.text === 'clear')).toBe(true)
    expect(tokens.some((token) => token.kind === 'bold' && token.text === '清屏')).toBe(true)
    const link = tokens.find((token) => token.kind === 'link')
    expect(link?.href).toBe('https://example.com/x')
  })

  it('半截标记（打字打到一半）不会被当成链接', () => {
    const tokens = segmentRich('到 [控制台](https://platf')
    expect(tokens.some((token) => token.kind === 'link')).toBe(false)
    expect(tokensToPlain(tokens)).toBe('到 [控制台](https://platf')
  })

  it('中文标点结尾的裸链接不会把标点吞进去', () => {
    const tokens = segmentRich('地址是 https://example.com/x，记得打开')
    const link = tokens.find((token) => token.kind === 'link')
    expect(link?.href).toBe('https://example.com/x')
    expect(tokensToPlain(tokens)).toBe('地址是 https://example.com/x，记得打开')
  })
})

describe('splitPlain', () => {
  it('标点处收尾并带上停顿', () => {
    const tokens = splitPlain('好的，没问题。')
    expect(tokens.every((token) => token.kind === 'plain')).toBe(true)
    expect(tokensToPlain(tokens)).toBe('好的，没问题。')
    expect(tokens.some((token) => (token.pause ?? 0) > 150)).toBe(true)
  })

  it('英文按 3 个字符一组，中文最多 2 个字一组', () => {
    const tokens = splitPlain('abcdef')
    expect(tokens[0]!.text.length).toBeLessThanOrEqual(3)
    const chinese = splitPlain('很长的句子')
    expect(chinese.every((token) => token.text.length <= 2)).toBe(true)
  })
})

describe('plainText', () => {
  it('去掉全部标记符号', () => {
    expect(plainText('**加粗** 与 `代码` 与 [链接](https://a.dev)')).toBe('加粗 与 代码 与 链接')
  })
})
