/**
 * 极简富文本标记 —— 只支持三种写法，足够播报用，且完全不用 innerHTML：
 *   **加粗**   `行内代码`   [文字](https://链接)   裸链接 https://…
 *
 * 为什么要把文本切成 token：打字机效果是逐 token 显示的，
 * 链接/代码必须整体出现，否则用户会先看到半截 `[控制台](https://pl…` 这种原始标记。
 */

export type RichTokenKind = "plain" | "code" | "bold" | "link";

export interface RichToken {
	kind: RichTokenKind;
	/** 展示文本（已去掉标记符号） */
	text: string;
	/** 仅 link 有值 */
	href?: string;
	/** 该 token 打完后额外停顿的毫秒数 */
	pause?: number;
}

const PATTERN =
	/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s，。；：！？）)"'<>]+)|`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;

/** 标点后的自然停顿，让打字节奏像人在说话 */
export function pauseFor(char: string): number {
	if (/[。！？!?]/.test(char)) return 190;
	if (/[；;：:]/.test(char)) return 90;
	if (/[，、,]/.test(char)) return 65;
	return 0;
}

/** 把纯文本切成“打字单元”：中文 2 字一组，ASCII 3 字一组，标点单独收尾 */
export function splitPlain(text: string): RichToken[] {
	const chars = Array.from(text);
	const tokens: RichToken[] = [];
	let buffer = "";

	for (const char of chars) {
		buffer += char;
		const isAscii = char.charCodeAt(0) < 128;
		const isPunctuation = /[。！？；：，、,.!?;:]/.test(char);
		if (isPunctuation || buffer.length >= (isAscii ? 3 : 2)) {
			tokens.push({ kind: "plain", text: buffer, pause: pauseFor(char) });
			buffer = "";
		}
	}
	if (buffer) tokens.push({ kind: "plain", text: buffer, pause: 0 });
	return tokens;
}

/** 把一行带标记的文案切成可逐段展示的 token 序列 */
export function segmentRich(source: string): RichToken[] {
	const tokens: RichToken[] = [];
	let cursor = 0;
	let match: RegExpExecArray | null;

	PATTERN.lastIndex = 0;
	while ((match = PATTERN.exec(source)) !== null) {
		const [full, linkLabel, linkHref, bareUrl, code, bold] = match;
		if (match.index > cursor) tokens.push(...splitPlain(source.slice(cursor, match.index)));

		if (linkLabel && linkHref) {
			tokens.push({ kind: "link", text: linkLabel, href: linkHref });
		} else if (bareUrl) {
			// `](url` 这种残缺的 markdown 链接：把 URL 当普通文本，免得打字或写错时露出半个链接
			const prefix = source.slice(Math.max(0, match.index - 2), match.index);
			if (prefix === "](") tokens.push(...splitPlain(bareUrl));
			else tokens.push({ kind: "link", text: bareUrl, href: bareUrl });
		} else if (code) {
			tokens.push({ kind: "code", text: code });
		} else if (bold) {
			tokens.push({ kind: "bold", text: bold });
		}

		cursor = match.index + full.length;
	}

	if (cursor < source.length) tokens.push(...splitPlain(source.slice(cursor)));
	return tokens;
}

/** 去掉标记，得到纯文本（用于复制摘要、无障碍朗读） */
export function tokensToPlain(tokens: RichToken[]): string {
	return tokens.map((token) => token.text).join("");
}

/** 已完成部分 + 未完成部分的纯文本（用于 aria-label / title） */
export function plainText(source: string): string {
	return tokensToPlain(segmentRich(source));
}
