/** Discord's hard limit for a single message's text content. */
const MAX_CONTENT_LENGTH = 2000;

/**
 * Post a message to a Discord channel, optionally as a reply.
 *
 * The client is typed as `any` because TediCross passes its discord.js client
 * around opaquely and tests use lightweight doubles.
 */
export async function sendDiscordReply(
	dcBot: any,
	channelId: string,
	content: string,
	replyToId?: string
): Promise<void> {
	let channel: any;

	try {
		channel = await dcBot.channels.fetch(channelId);
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`Could not fetch Discord channel ${channelId}: ${reason}`);
	}

	if (!channel) {
		throw new Error(`Discord channel ${channelId} does not exist`);
	}

	if (typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
		throw new Error(`Discord channel ${channelId} is not text-based, so it cannot receive messages`);
	}

	const cappedContent = content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : content;

	await channel.send({
		content: cappedContent,
		reply: replyToId ? { messageReference: replyToId, failIfNotExists: false } : undefined
	});
}
