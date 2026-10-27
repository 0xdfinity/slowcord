import { Bridge } from "../bridgestuff/Bridge";
import { Settings } from "../settings/Settings";
import { DigestRunner, DraftRecord, DraftService, SlowConfig, Store } from "./types";

export interface CommandDeps {
	store: Store;
	digest: DigestRunner;
	drafts: DraftService;
	settings: Settings;
	dcBot: any;
	config: SlowConfig;
	logger: any;
}

interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

interface LineBudget {
	push(line: string): boolean;
	render(truncated: boolean): string;
}

const TELEGRAM_HTML_LIMIT = 4000;
const UNKNOWN_DRAFT = "That draft is unknown or was already handled.";
const NOT_BUFFERED = "That message is no longer buffered, so there is nothing to draft.";

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clipText(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function commandArg(ctx: any): string {
	const text = String(ctx.message?.text ?? "");
	return text.replace(/^\/[^\s@]+(?:@[^\s]+)?\s*/i, "").trim();
}

function firstArg(ctx: any): string {
	return commandArg(ctx).split(/\s+/)[0] ?? "";
}

function listGuilds(dcBot: any): any[] {
	const cache = dcBot?.guilds?.cache;
	if (!cache || typeof cache.values !== "function") return [];
	return Array.from(cache.values()).sort((a: any, b: any) =>
		String(a?.name ?? "").localeCompare(String(b?.name ?? ""))
	);
}

function listTextChannels(guild: any): any[] {
	const cache = guild?.channels?.cache;
	if (!cache || typeof cache.values !== "function") return [];
	const channels: any[] = [];
	for (const channel of cache.values()) {
		if (channel?.viewable === false) continue;
		const isText = typeof channel?.isTextBased === "function" ? channel.isTextBased() : false;
		if (isText) channels.push(channel);
	}
	return channels.sort((a: any, b: any) => String(a?.name ?? "").localeCompare(String(b?.name ?? "")));
}

function createLineBudget(): LineBudget {
	const lines: string[] = [];
	let used = 0;
	return {
		push(line: string): boolean {
			if (used + line.length + 1 > TELEGRAM_HTML_LIMIT) return false;
			lines.push(line);
			used += line.length + 1;
			return true;
		},
		render(truncated: boolean): string {
			return [...lines, ...(truncated ? ["…"] : [])].join("\n");
		}
	};
}

function draftKeyboard(draftId: string): { inline_keyboard: InlineKeyboardButton[][] } {
	return {
		inline_keyboard: [
			[
				{ text: "Approve", callback_data: `slow:approve:${draftId}` },
				{ text: "Regenerate", callback_data: `slow:regen:${draftId}` },
				{ text: "Cancel", callback_data: `slow:cancel:${draftId}` }
			]
		]
	};
}

export function registerCommands(tgBot: any, deps: CommandDeps): void {
	function findBridge(ctx: any): Bridge | undefined {
		const chatId = ctx.chat?.id;
		return deps.settings.bridges.find(bridge => String(bridge.telegram.chatId) === String(chatId));
	}

	async function withBridge(ctx: any, handler: (bridge: Bridge) => Promise<void>): Promise<void> {
		const bridge = findBridge(ctx);
		if (!bridge) {
			await ctx.replyWithHTML("This chat is not connected to a Discord channel.");
			return;
		}
		await handler(bridge);
	}

	async function sendDraft(ctx: any, record: DraftRecord): Promise<void> {
		await ctx.replyWithHTML(escapeHtml(record.text), { reply_markup: draftKeyboard(record.id) });
	}

	async function editMessage(ctx: any, html: string, replyMarkup?: unknown): Promise<void> {
		try {
			await ctx.editMessageText(html, {
				parse_mode: "HTML",
				reply_markup: replyMarkup ?? { inline_keyboard: [] }
			});
		} catch (err: any) {
			const description = String(err?.description ?? err?.message ?? err);
			if (!description.includes("message is not modified")) throw err;
		}
	}

	const guard = (handler: (ctx: any) => Promise<void>) => async (ctx: any): Promise<void> => {
		try {
			await handler(ctx);
		} catch (err: any) {
			deps.logger.error("[slow] Telegram command failed:", String(err?.stack ?? err));
			try {
				await ctx.replyWithHTML("Something went wrong. Try again.");
			} catch {
				// The reply itself failed; the original error is already logged.
			}
		}
	};

	tgBot.command(
		"slow",
		guard(async (ctx: any) => {
			await withBridge(ctx, async bridge => {
				const action = firstArg(ctx).toLowerCase();
				if (action === "on" || action === "off") {
					await deps.store.setEnabled(bridge.name, action === "on");
					await ctx.replyWithHTML(
						`Slow mode <b>${action}</b> for <b>${escapeHtml(bridge.name)}</b>.`
					);
					return;
				}
				if (action === "status") {
					const enabled = await deps.store.isEnabled(bridge.name);
					const buffered = (await deps.store.readBuffer(bridge.name)).length;
					await ctx.replyWithHTML(
						`Slow mode is <b>${enabled ? "on" : "off"}</b> for <b>${escapeHtml(
							bridge.name
						)}</b>.\nBuffered messages: ${buffered}`
					);
					return;
				}
				await ctx.replyWithHTML(
					"Usage: <code>/slow on</code>, <code>/slow off</code>, or <code>/slow status</code>"
				);
			});
		})
	);

	tgBot.command(
		"digest",
		guard(async (ctx: any) => {
			await withBridge(ctx, async bridge => {
				await ctx.replyWithHTML("Reading Discord…");
				const digest = await deps.digest.run(bridge.name);
				if (digest) return;
				const remaining = (await deps.store.readBuffer(bridge.name)).length;
				if (remaining === 0) await ctx.replyWithHTML("Nothing to digest.");
			});
		})
	);

	tgBot.command(
		"servers",
		guard(async (ctx: any) => {
			const guilds = listGuilds(deps.dcBot);
			if (guilds.length === 0) {
				await ctx.replyWithHTML("The bot is not in any Discord server.");
				return;
			}

			const budget = createLineBudget();
			let truncated = false;
			for (const guild of guilds.slice(0, 10)) {
				if (!budget.push(`<b>${escapeHtml(String(guild?.name ?? "unnamed"))}</b>`)) {
					truncated = true;
					break;
				}
				for (const channel of listTextChannels(guild).slice(0, 20)) {
					if (!budget.push(`  #${escapeHtml(String(channel?.name ?? "channel"))}`)) {
						truncated = true;
						break;
					}
				}
				if (truncated) break;
			}
			await ctx.replyWithHTML(budget.render(truncated));
		})
	);

	tgBot.command(
		"channels",
		guard(async (ctx: any) => {
			const query = commandArg(ctx);
			if (!query) {
				await ctx.replyWithHTML("Usage: <code>/channels &lt;server name or id&gt;</code>");
				return;
			}

			const needle = query.toLowerCase();
			const guild = listGuilds(deps.dcBot).find(
				candidate => String(candidate?.id) === query || String(candidate?.name ?? "").toLowerCase() === needle
			);
			if (!guild) {
				await ctx.replyWithHTML(`No Discord server matches <b>${escapeHtml(clipText(query, 80))}</b>.`);
				return;
			}

			const name = escapeHtml(String(guild?.name ?? "unnamed"));
			const channels = listTextChannels(guild).slice(0, 50);
			if (channels.length === 0) {
				await ctx.replyWithHTML(`No visible text channels in <b>${name}</b>.`);
				return;
			}

			const budget = createLineBudget();
			budget.push(`<b>${name}</b>`);
			let truncated = false;
			for (const channel of channels) {
				const id = escapeHtml(String(channel?.id ?? ""));
				if (!budget.push(`  #${escapeHtml(String(channel?.name ?? "channel"))} <code>${id}</code>`)) {
					truncated = true;
					break;
				}
			}
			await ctx.replyWithHTML(budget.render(truncated));
		})
	);

	tgBot.command(
		"draft",
		guard(async (ctx: any) => {
			await withBridge(ctx, async bridge => {
				const argument = firstArg(ctx);
				const index = Number.parseInt(argument, 10);
				if (!argument || Number.isNaN(index) || index < 1) {
					await ctx.replyWithHTML("Usage: <code>/draft &lt;n&gt;</code>");
					return;
				}

				const digest = deps.digest.lastDigest(bridge.name);
				if (!digest) {
					await ctx.replyWithHTML("No digest yet. Run <code>/digest</code> first.");
					return;
				}

				const item = digest.needsYou[index - 1];
				if (!item) {
					await ctx.replyWithHTML(`The last digest has no item ${index}.`);
					return;
				}

				const record = await deps.drafts.create(item.id, bridge.name);
				if (!record) {
					await ctx.replyWithHTML(NOT_BUFFERED);
					return;
				}
				await sendDraft(ctx, record);
			});
		})
	);

	tgBot.command(
		"approve",
		guard(async (ctx: any) => {
			const draftId = firstArg(ctx).toLowerCase();
			if (!draftId) {
				await ctx.replyWithHTML("Usage: <code>/approve &lt;draftId&gt;</code>");
				return;
			}
			const approved = await deps.drafts.approve(draftId);
			await ctx.replyWithHTML(approved ? "Posted." : UNKNOWN_DRAFT);
		})
	);

	tgBot.command(
		"cancel",
		guard(async (ctx: any) => {
			const draftId = firstArg(ctx).toLowerCase();
			if (!draftId) {
				await ctx.replyWithHTML("Usage: <code>/cancel &lt;draftId&gt;</code>");
				return;
			}
			const cancelled = deps.drafts.cancel(draftId);
			await ctx.replyWithHTML(cancelled ? "Cancelled." : UNKNOWN_DRAFT);
		})
	);

	async function handleCallback(ctx: any, kind: string, argument: string): Promise<void> {
		if (kind === "draft") {
			const bridge = findBridge(ctx);
			if (!bridge) {
				await ctx.replyWithHTML("This chat is not connected to a Discord channel.");
				return;
			}
			const record = await deps.drafts.create(argument, bridge.name);
			if (!record) {
				await ctx.replyWithHTML(NOT_BUFFERED);
				return;
			}
			await sendDraft(ctx, record);
			return;
		}

		if (kind === "approve") {
			const approved = await deps.drafts.approve(argument);
			await editMessage(ctx, approved ? "Posted." : UNKNOWN_DRAFT);
			return;
		}

		if (kind === "regen") {
			const existing = deps.drafts.get(argument);
			if (!existing) {
				await editMessage(ctx, UNKNOWN_DRAFT);
				return;
			}
			const record = await deps.drafts.create(existing.messageId, existing.bridge);
			if (!record) {
				await editMessage(ctx, "That message is no longer buffered, so I cannot regenerate it.");
				return;
			}
			await editMessage(ctx, escapeHtml(record.text), draftKeyboard(record.id));
			deps.drafts.cancel(existing.id);
			return;
		}

		const cancelled = deps.drafts.cancel(argument);
		await editMessage(ctx, cancelled ? "Cancelled." : UNKNOWN_DRAFT);
	}

	tgBot.action(/^slow:(draft|approve|regen|cancel):(.+)$/, async (ctx: any) => {
		const match = ctx.match as RegExpMatchArray | undefined;
		const kind = match?.[1];
		const argument = match?.[2];

		try {
			await ctx.answerCbQuery();
		} catch (err: any) {
			deps.logger.warn("[slow] Could not answer callback query:", String(err?.message ?? err));
		}

		if (!kind || !argument) return;

		try {
			await handleCallback(ctx, kind, argument);
		} catch (err: any) {
			deps.logger.error("[slow] Telegram callback failed:", String(err?.stack ?? err));
			try {
				await ctx.replyWithHTML("Something went wrong. Try again.");
			} catch {
				// The reply itself failed; the original error is already logged.
			}
		}
	});
}
