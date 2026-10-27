import { randomBytes } from "crypto";
import { Bridge } from "../bridgestuff/Bridge";
import { Settings } from "../settings/Settings";
import { sendDiscordReply } from "./discord";
import { buildDraftPrompt } from "./prompts";
import { span } from "./sentry";
import { BufferedMessage, DraftRecord, DraftService, SlowConfig, SlowProvider, Store } from "./types";

export interface DraftDeps {
	provider: SlowProvider;
	store: Store;
	dcBot: any;
	settings: Settings;
	logger: any;
	config: SlowConfig;
}

const MAX_DRAFT_LENGTH = 400;
const CONTEXT_MESSAGES = 10;
const REMEMBERED_MESSAGES = 200;

/**
 * Digests clear the store buffer once they are sent, while their Draft buttons
 * still reference ids from that batch. Keep the last digested messages in
 * memory so drafts and regenerations can still resolve their source message.
 */
const rememberedMessages = new Map<string, BufferedMessage[]>();

export function rememberDigestMessages(bridgeName: string, messages: BufferedMessage[]): void {
	rememberedMessages.set(bridgeName, messages.slice(-REMEMBERED_MESSAGES));
}

export function createDrafts(deps: DraftDeps): DraftService {
	const records = new Map<string, DraftRecord>();

	async function create(messageId: string, bridgeName: string): Promise<DraftRecord | null> {
		let buffer = await deps.store.readBuffer(bridgeName);
		if (!buffer.some(message => message.id === messageId)) {
			const remembered = rememberedMessages.get(bridgeName);
			if (remembered) buffer = remembered;
		}
		const index = buffer.findIndex(message => message.id === messageId);
		if (index < 0) return null;

		const message = buffer[index];
		const context = buffer.slice(Math.max(0, index - CONTEXT_MESSAGES), index);
		const raw = await deps.provider.generate(buildDraftPrompt(message, context), { maxTokens: 300 });
		const text = raw
			.trim()
			.slice(0, MAX_DRAFT_LENGTH)
			.trim();
		if (!text) return null;

		const record: DraftRecord = {
			id: randomBytes(4).toString("hex"),
			text,
			bridge: bridgeName,
			messageId,
			createdAt: new Date().toISOString()
		};
		records.set(record.id, record);
		return record;
	}

	async function approve(draftId: string): Promise<boolean> {
		const record = records.get(draftId);
		if (!record) return false;

		const bridge: Bridge | undefined = deps.settings.bridges.find(candidate => candidate.name === record.bridge);
		if (!bridge) {
			deps.logger.warn(`[slow] Cannot approve draft ${draftId}: unknown bridge "${record.bridge}"`);
			return false;
		}

		await span("slow.approve", async () => {
			await sendDiscordReply(deps.dcBot, bridge.discord.channelId, record.text, record.messageId);
		});

		records.delete(draftId);
		return true;
	}

	function cancel(draftId: string): boolean {
		return records.delete(draftId);
	}

	function get(draftId: string): DraftRecord | undefined {
		return records.get(draftId);
	}

	return { create, approve, cancel, get };
}
