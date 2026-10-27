import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createSlow } = await import("../dist/slow/index.js");
const { createStore } = await import("../dist/slow/store.js");

function makeDeps(calls) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slowcord-push-"));
	const tgBot = {
		telegram: {
			sendMessage: async (...args) => {
				calls.push(args);
				return { message_id: calls.length };
			}
		}
	};
	const logger = { info() {}, warn() {}, error() {}, log() {} };
	const slow = createSlow({
		logger,
		dcBot: {},
		tgBot,
		bridgeMap: {},
		settings: { bridges: [] },
		dataDir: dir
	});
	return { dir, slow, tgBot, logger };
}

function discordMessage(id, content, mentionsOwner = false) {
	return {
		id,
		cleanContent: content,
		createdTimestamp: Date.parse("2026-10-22T10:00:00Z"),
		guild: { name: "Test server" },
		channel: { name: "general" },
		author: { id: "111", username: "ada" },
		member: { displayName: "Ada" },
		mentions: { users: { has: (uid) => mentionsOwner && uid === "222" } }
	};
}

const bridge = { name: "Main bridge", telegram: { chatId: -100, }, tgThread: undefined };

test("slow mode off relays normally and buffers nothing", async () => {
	const calls = [];
	const { dir, slow } = makeDeps(calls);
	process.env.SLOW_OWNER_DISCORD_ID = "222";
	const handled = await slow.onDiscordMessage(discordMessage("1", "hello"), bridge);
	assert.equal(handled, false, "slow off must let TediCross relay");
	assert.equal(calls.length, 0, "nothing is pushed to Telegram");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a mention is pushed immediately with a draft button, and still buffered", async () => {
	const calls = [];
	const { dir, slow } = makeDeps(calls);
	process.env.SLOW_OWNER_DISCORD_ID = "222";
	const store = createStore(path.join(dir, "slow"));
	await store.setEnabled(bridge.name, true);

	const handled = await slow.onDiscordMessage(
		discordMessage("2", "Ada, can you check the release?", true),
		bridge
	);

	assert.equal(handled, true, "slow on must suppress the instant relay");
	assert.equal(calls.length, 1, "the mention is pushed at once");
	const [chatId, text, options] = calls[0];
	assert.equal(chatId, -100);
	assert.match(text, /Needs you now/);
	assert.match(text, /#general/);
	const rows = options.reply_markup.inline_keyboard;
	assert.equal(rows[0][0].callback_data, "slow:draft:2");
	assert.equal(await store.bufferSize(), 1, "the mention is also part of the digest");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("chatter waits for the digest and pushes nothing", async () => {
	const calls = [];
	const { dir, slow } = makeDeps(calls);
	process.env.SLOW_OWNER_DISCORD_ID = "222";
	const store = createStore(path.join(dir, "slow"));
	await store.setEnabled(bridge.name, true);

	const handled = await slow.onDiscordMessage(discordMessage("3", "shipping tomorrow"), bridge);

	assert.equal(handled, true);
	assert.equal(calls.length, 0, "chatter is not pushed");
	assert.equal(await store.bufferSize(), 1, "chatter waits in the buffer");
	fs.rmSync(dir, { recursive: true, force: true });
});