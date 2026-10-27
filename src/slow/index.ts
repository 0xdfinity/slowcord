import path from "path";
import { Logger } from "../Logger";
import { Settings } from "../settings/Settings";
import { loadConfig } from "./config";
import { createProvider } from "./provider";
import { createStore } from "./store";
import { parseDigest, deterministicTriage } from "./triage";
import { createDigest } from "./digest";
import { registerCommands } from "./commands";
import { createDrafts } from "./drafts";
import { startHealthServer } from "./health";
import { span } from "./sentry";
import { BufferedMessage, SlowEngine } from "./types";

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export interface SlowDeps {
	logger: Logger;
	dcBot: any;
	tgBot: any;
	bridgeMap: any;
	settings: Settings;
	dataDir: string;
}

export function createSlow(deps: SlowDeps): SlowEngine {
	const config = loadConfig();
	const store = createStore(path.join(deps.dataDir, "slow"));
	const provider = createProvider(config);
	const drafts = createDrafts({
		provider,
		store,
		dcBot: deps.dcBot,
		settings: deps.settings,
		logger: deps.logger,
		config
	});
	const digest = createDigest({
		provider,
		store,
		tgBot: deps.tgBot,
		logger: deps.logger,
		config,
		settings: deps.settings,
		parse: parseDigest,
		fallback: deterministicTriage
	});

	const pushMention = async (item: BufferedMessage, bridge: any): Promise<void> => {
		try {
			const text =
				`<b>Needs you now</b> · #${escapeHtml(item.channel)}\n` +
				`<b>${escapeHtml(item.author)}</b>: ${escapeHtml(item.content.slice(0, 200))}`;
			await span("slow.triage", () =>
				deps.tgBot.telegram.sendMessage(bridge.telegram.chatId, text, {
					parse_mode: "HTML",
					message_thread_id: bridge.tgThread,
					reply_markup: {
						inline_keyboard: [[{ text: "Draft reply", callback_data: `slow:draft:${item.id}` }]]
					}
				})
			);
		} catch (err: any) {
			deps.logger.error(
				`[slow] Could not push a mention for ${bridge.name}:`,
				err?.toString?.() ?? String(err)
			);
		}
	};

	return {
		async onDiscordMessage(message: any, bridge: any): Promise<boolean> {
			if (!(await store.isEnabled(bridge.name))) return false;
			const owner = config.ownerDiscordId;
			const content = String(message.cleanContent ?? "").slice(0, 1200);
			const buffered: BufferedMessage = {
				id: String(message.id),
				bridge: bridge.name,
				guild: message.guild?.name ?? "",
				channel: (message.channel as any)?.name ?? "",
				author: message.member?.displayName ?? message.author?.username ?? "unknown",
				authorId: String(message.author?.id ?? ""),
				ts: new Date(message.createdTimestamp ?? Date.now()).toISOString(),
				content,
				mentionsOwner: Boolean(
					owner && (content.includes(owner) || Boolean(message.mentions?.users?.has?.(owner)))
				)
			};
			await span("slow.buffer", async () => {
				await store.append(buffered);
			});
			if (buffered.mentionsOwner) {
				await pushMention(buffered, bridge);
			}
			return true;
		},

		registerCommands(tgBot: any): void {
			registerCommands(tgBot, {
				store,
				digest,
				drafts,
				settings: deps.settings,
				dcBot: deps.dcBot,
				config,
				logger: deps.logger
			});
		},

		start(): void {
			void startHealthServer(() => this.health(), config.port);
			if (!config.intervalMin || config.intervalMin <= 0) return;
			const timer = setInterval(async () => {
				const bridges = deps.settings.bridges.filter(bridge => bridge.direction !== "t2d");
				for (const bridge of bridges) {
					try {
						if (!(await store.isEnabled(bridge.name))) continue;
						if ((await store.readBuffer(bridge.name)).length === 0) continue;
						await digest.run(bridge.name);
					} catch (err: any) {
						deps.logger.error(`[slow] Digest failed for ${bridge.name}:`, err?.toString?.() ?? String(err));
					}
				}
			}, config.intervalMin * 60_000);
			if (typeof timer.unref === "function") timer.unref();
		},

		async health(): Promise<Record<string, unknown>> {
			const state = await store.readState();
			return {
				ok: true,
				uptime: Math.round(process.uptime()),
				discordReady: Boolean(deps.dcBot.isReady?.()),
				telegramReady: Boolean(deps.tgBot?.botInfo),
				provider: provider.name,
				model: config.googleModel,
				enabledBridges: state.enabledBridges,
				buffered: await store.bufferSize(),
				lastDigestAt: state.lastDigestAt
			};
		}
	};
}
