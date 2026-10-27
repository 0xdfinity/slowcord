import { BufferedMessage } from "./types";

const MAX_MESSAGES = 100;
const MAX_CONTENT_CHARS = 1200;
const DRAFT_CONTEXT_MESSAGES = 10;

interface DigestPromptMessage {
	id: string;
	author: string;
	channel: string;
	content: string;
	mentionsOwner: boolean;
}

export function buildDigestPrompt(
	messages: BufferedMessage[],
	owner: { id?: string; name?: string }
): string {
	const ownerName = owner.name?.trim() || "unknown";
	const ownerId = owner.id?.trim() || "unknown";
	const payload: DigestPromptMessage[] = messages.slice(-MAX_MESSAGES).map(message => ({
		id: message.id,
		author: message.author,
		channel: message.channel,
		content: truncate(message.content),
		mentionsOwner: message.mentionsOwner
	}));

	return [
		"SLOWCORD_TASK=digest",
		"You are Slowcord, a lazy Discord digest. Report only what matters.",
		`Owner: ${ownerName} (Discord id ${ownerId}).`,
		`Messages: ${JSON.stringify(payload)}`,
		"",
		"Rules:",
		"- Use only ids that appear in Messages. Never invent an id.",
		"- summary: 2-4 plain-text bullets, each <= 160 characters, no markdown.",
		"- needsYou: messages that mention the owner, ask the owner a direct question, or block other people. Max 6. \"why\" <= 12 words.",
		"- If nothing matters, return {\"summary\":[],\"needsYou\":[],\"quiet\":true}.",
		"Return ONLY the JSON object {\"summary\":string[],\"needsYou\":[{\"id\":string,\"why\":string}],\"quiet\":boolean}"
	].join("\n");
}

export function buildDraftPrompt(message: BufferedMessage, context: BufferedMessage[]): string {
	const lines = context
		.filter(item => item.id !== message.id)
		.slice(-DRAFT_CONTEXT_MESSAGES)
		.map(item => `${item.author}: ${oneLine(item.content)}`);

	return [
		"SLOWCORD_TASK=draft",
		"You are replying in a Discord channel on behalf of a busy user.",
		"Write a natural reply, <= 400 characters, no markdown, no invented facts.",
		lines.length > 0 ? "Context:" : "Context: (no earlier messages)",
		...lines,
		`Message to answer: ${truncate(message.content)}`,
		"Return only the reply text."
	].join("\n");
}

function truncate(content: string): string {
	return content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content;
}

function oneLine(content: string): string {
	return truncate(content).replace(/\s+/g, " ").trim();
}
