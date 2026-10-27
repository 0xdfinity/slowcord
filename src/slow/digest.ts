import { Bridge } from "../bridgestuff/Bridge";
import { Settings } from "../settings/Settings";
import { rememberDigestMessages } from "./drafts";
import { buildDigestPrompt } from "./prompts";
import { span } from "./sentry";
import { formatDigestHtml } from "./triage";
import { BufferedMessage, Digest, DigestRunner, SlowConfig, SlowProvider, Store } from "./types";

export interface DigestDeps {
	provider: SlowProvider;
	store: Store;
	tgBot: any;
	logger: any;
	config: SlowConfig;
	settings: Settings;
	parse: (raw: string, buffer: BufferedMessage[]) => Digest;
	fallback: (buffer: BufferedMessage[], ownerId?: string) => Digest;
}

interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

const TELEGRAM_HTML_LIMIT = 4000;
const MAX_DRAFT_BUTTONS = 6;
const QUIET_MESSAGE = "Nothing needs you. Quiet since the last digest.";

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shortReason(err: any): string {
	const raw = String(err?.message ?? err ?? "unknown error")
		.replace(/\s+/g, " ")
		.trim();
	return raw.length > 200 ? `${raw.slice(0, 199)}…` : raw;
}

function clipText(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function clipHtml(html: string, max = TELEGRAM_HTML_LIMIT): string {
	if (html.length <= max) return html;
	const cut = html.lastIndexOf("\n", max);
	return `${(cut > 0 ? html.slice(0, cut) : html.slice(0, max)).trimEnd()}\n…`;
}

export function createDigest(deps: DigestDeps): DigestRunner {
	const lastDigests = new Map<string, Digest>();

	function findBridge(bridgeName: string): Bridge {
		const bridge = deps.settings.bridges.find(candidate => candidate.name === bridgeName);
		if (!bridge) throw new Error(`Unknown bridge: ${bridgeName}`);
		return bridge;
	}

	async function sendToBridge(bridge: Bridge, html: string, keyboard?: InlineKeyboardButton[][]): Promise<void> {
		const extra: Record<string, unknown> = { parse_mode: "HTML" };
		if (bridge.tgThread !== undefined) extra.message_thread_id = bridge.tgThread;
		if (keyboard && keyboard.length > 0) extra.reply_markup = { inline_keyboard: keyboard };
		await deps.tgBot.telegram.sendMessage(bridge.telegram.chatId, html, extra);
	}

	async function run(bridgeName: string): Promise<Digest | null> {
		const messages = await deps.store.readBuffer(bridgeName);
		if (messages.length === 0) return null;
		const bridge = findBridge(bridgeName);
		rememberDigestMessages(bridgeName, messages);

		let raw: string;
		try {
			raw = await span("slow.digest", () =>
				deps.provider.generate(
					buildDigestPrompt(messages, { id: deps.config.ownerDiscordId, name: "the owner" }),
					{ json: true }
				)
			);
		} catch (err: any) {
			const reason = shortReason(err);
			deps.logger.error(`[slow] Provider failed for bridge "${bridgeName}":`, reason);
			try {
				await sendToBridge(bridge, `Model unavailable: ${escapeHtml(reason)}`);
			} catch (sendErr: any) {
				deps.logger.error("[slow] Could not report provider failure to Telegram:", shortReason(sendErr));
			}
			return null;
		}

		let digest: Digest;
		try {
			digest = deps.parse(raw, messages);
		} catch (err: any) {
			deps.logger.warn(`[slow] Could not parse model output for bridge "${bridgeName}":`, shortReason(err));
			digest = deps.fallback(messages, deps.config.ownerDiscordId);
		}

		const summary = Array.isArray(digest.summary) ? digest.summary : [];
		const needsYou = Array.isArray(digest.needsYou) ? digest.needsYou : [];
		const quiet = Boolean(digest.quiet) || summary.length === 0;

		const keyboard: InlineKeyboardButton[][] = quiet
			? []
			: needsYou.slice(0, MAX_DRAFT_BUTTONS).map(item => [
					{
						text: `Draft reply · ${clipText(String(item.why ?? ""), 20)}`,
						callback_data: `slow:draft:${item.id}`
					}
				]);

		const html = quiet ? QUIET_MESSAGE : clipHtml(formatDigestHtml(digest, bridgeName));

		try {
			await sendToBridge(bridge, html, keyboard);
		} catch (err: any) {
			deps.logger.error(`[slow] Could not send digest to Telegram for bridge "${bridgeName}":`, shortReason(err));
			return null;
		}

		try {
			const state = await deps.store.readState();
			state.lastDigestAt[bridgeName] = new Date().toISOString();
			state.digestCount += 1;
			await deps.store.writeState(state);
			await deps.store.clearBuffer(bridgeName);
		} catch (err: any) {
			deps.logger.error(`[slow] Could not persist digest state for bridge "${bridgeName}":`, shortReason(err));
		}

		lastDigests.set(bridgeName, digest);

		return digest;
	}

	function lastDigest(bridgeName: string): Digest | undefined {
		return lastDigests.get(bridgeName);
	}

	return { run, lastDigest };
}
