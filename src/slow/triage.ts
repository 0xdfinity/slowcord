import { BufferedMessage, Digest, NeedsYouItem } from "./types";

const MAX_SUMMARY_ITEMS = 4;
const MAX_SUMMARY_CHARS = 160;
const MAX_NEEDS_ITEMS = 6;
const MAX_WHY_CHARS = 120;
const MAX_SNIPPET_CHARS = 120;
const MAX_HTML_CHARS = 4096;
const MAX_BRIDGE_NAME_CHARS = 128;

function stripFences(raw: string): string {
	return raw.replace(/^[ \t]*```[^\n]*$/gm, "");
}

function extractFirstObject(source: string): string | null {
	const start = source.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === "\"") inString = false;
			continue;
		}
		if (character === "\"") inString = true;
		else if (character === "{") depth += 1;
		else if (character === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}
	return null;
}

export function parseDigest(raw: string, buffer: BufferedMessage[]): Digest {
	const json = extractFirstObject(stripFences(raw));
	if (json === null) throw new Error("Could not find a JSON object in the digest response");
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not parse digest JSON: ${reason}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Could not parse digest JSON: expected an object");
	}
	const record = parsed as Record<string, unknown>;

	const summary: string[] = [];
	if (Array.isArray(record.summary)) {
		for (const item of record.summary) {
			if (summary.length >= MAX_SUMMARY_ITEMS) break;
			if (typeof item !== "string") continue;
			const line = item.trim().slice(0, MAX_SUMMARY_CHARS);
			if (line.length === 0) continue;
			summary.push(line);
		}
	}

	const knownIds = new Set(buffer.map(message => message.id));
	const needsYou: NeedsYouItem[] = [];
	if (Array.isArray(record.needsYou)) {
		for (const item of record.needsYou) {
			if (needsYou.length >= MAX_NEEDS_ITEMS) break;
			if (typeof item !== "object" || item === null) continue;
			const candidate = item as Record<string, unknown>;
			const rawId = candidate.id;
			const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : null;
			if (id === null || !knownIds.has(id)) continue;
			const why = typeof candidate.why === "string" ? candidate.why.trim().slice(0, MAX_WHY_CHARS) : "";
			needsYou.push({ id, why });
		}
	}

	return {
		summary,
		needsYou,
		quiet: typeof record.quiet === "boolean" ? record.quiet : false
	};
}

export function deterministicTriage(buffer: BufferedMessage[], ownerId?: string): Digest {
	const needsYou: NeedsYouItem[] = [];
	for (const message of buffer) {
		if (needsYou.length >= MAX_NEEDS_ITEMS) break;
		const mentionsOwner =
			message.mentionsOwner || (ownerId !== undefined && ownerId.length > 0 && message.content.includes(ownerId));
		const asksQuestion = message.content.includes("?");
		if (!mentionsOwner && !asksQuestion) continue;
		needsYou.push({ id: message.id, why: mentionsOwner ? "mentions you" : "asks a question" });
	}
	const summary = buffer
		.slice(0, 3)
		.map(message => `${message.author}: ${message.content.slice(0, MAX_SNIPPET_CHARS)}`);
	return { summary, needsYou, quiet: buffer.length === 0 };
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatDigestHtml(digest: Digest, bridgeName: string): string {
	const header = `<b>Slowcord · ${escapeHtml(bridgeName.slice(0, MAX_BRIDGE_NAME_CHARS))}</b>`;
	const summaryLines = digest.summary.map(line => `• ${escapeHtml(line)}`);
	const needsLines = digest.needsYou.map(item => `• ${escapeHtml(item.why)}`);
	let summaryCount = summaryLines.length;
	let needsCount = needsLines.length;

	const build = (): string => {
		const lines = [header];
		for (let index = 0; index < summaryCount; index += 1) lines.push(summaryLines[index]);
		if (needsCount > 0) {
			lines.push("<b>Needs you</b>");
			for (let index = 0; index < needsCount; index += 1) lines.push(needsLines[index]);
		}
		return lines.join("\n");
	};

	while (build().length >= MAX_HTML_CHARS && summaryCount > 0) summaryCount -= 1;
	while (build().length >= MAX_HTML_CHARS && needsCount > 0) needsCount -= 1;
	const html = build();
	return html.length < MAX_HTML_CHARS ? html : `${html.slice(0, MAX_HTML_CHARS - 2)}…`;
}
