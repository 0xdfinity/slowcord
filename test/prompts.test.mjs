import test from "node:test";
import assert from "node:assert/strict";
import { buildDigestPrompt, buildDraftPrompt } from "../dist/slow/prompts.js";

function message(overrides = {}) {
	return {
		id: "100",
		bridge: "Main bridge",
		guild: "Slowcord HQ",
		channel: "general",
		author: "Ana",
		authorId: "200",
		ts: "2026-10-22T10:00:00.000Z",
		content: "hello",
		mentionsOwner: false,
		...overrides
	};
}

function digestMessages(prompt) {
	const line = prompt.split("\n").find(item => item.startsWith("Messages: "));
	assert.ok(line, "digest prompt must contain a Messages line");
	return JSON.parse(line.slice("Messages: ".length));
}

test("digest prompt starts with the task marker and includes owner identity", () => {
	const prompt = buildDigestPrompt([message()], { id: "owner-42", name: "Ada" });

	assert.ok(prompt.startsWith("SLOWCORD_TASK=digest\n"));
	assert.match(prompt, /Owner: Ada \(Discord id owner-42\)\./);
	assert.match(prompt, /Messages: \[/);
});

test("digest prompt embeds only the allowed message fields", () => {
	const prompt = buildDigestPrompt([message({ mentionsOwner: true })], {
		id: "owner-42",
		name: "Ada"
	});

	assert.deepEqual(digestMessages(prompt), [
		{
			id: "100",
			author: "Ana",
			channel: "general",
			content: "hello",
			mentionsOwner: true
		}
	]);
});

test("digest prompt states the output rules and JSON schema", () => {
	const prompt = buildDigestPrompt([message()], { id: "owner-42", name: "Ada" });

	assert.match(prompt, /Use only ids that appear in Messages\. Never invent an id\./);
	assert.match(prompt, /2-4 plain-text bullets/);
	assert.match(prompt, /<= 160 characters/);
	assert.match(prompt, /Max 6/);
	assert.match(prompt, /<= 12 words/);
	assert.match(prompt, /Return ONLY the JSON object/);
	assert.ok(
		prompt.includes(
			'{"summary":string[],"needsYou":[{"id":string,"why":string}],"quiet":boolean}'
		)
	);
});

test("digest prompt truncates long content to 1200 characters", () => {
	const prompt = buildDigestPrompt([message({ content: "x".repeat(5000) })], { id: "1" });
	const parsed = digestMessages(prompt);

	assert.equal(parsed[0].content.length, 1200);
	assert.equal(parsed[0].content, "x".repeat(1200));
});

test("digest prompt includes at most the last 100 messages", () => {
	const messages = Array.from({ length: 150 }, (_, index) =>
		message({ id: `m${index}`, content: `message ${index}` })
	);

	const parsed = digestMessages(buildDigestPrompt(messages, { id: "1" }));

	assert.equal(parsed.length, 100);
	assert.equal(parsed[0].id, "m50");
	assert.equal(parsed[99].id, "m149");
});

test("digest prompt falls back to unknown owner values", () => {
	const prompt = buildDigestPrompt([], {});

	assert.match(prompt, /Owner: unknown \(Discord id unknown\)\./);
	assert.match(prompt, /Messages: \[\]/);
});

test("draft prompt starts with the task marker and includes the reply rules", () => {
	const prompt = buildDraftPrompt(message({ content: "Can you review the PR?" }), []);

	assert.ok(prompt.startsWith("SLOWCORD_TASK=draft\n"));
	assert.match(prompt, /on behalf of a busy user/);
	assert.match(prompt, /<= 400 characters/);
	assert.match(prompt, /no markdown/);
	assert.match(prompt, /no invented facts/);
	assert.match(prompt, /Context: \(no earlier messages\)/);
	assert.match(prompt, /Message to answer: Can you review the PR\?/);
	assert.match(prompt, /Return only the reply text\./);
});

test("draft prompt includes only the last 10 context messages as author lines", () => {
	const context = Array.from({ length: 12 }, (_, index) =>
		message({
			id: `c${index}`,
			author: `User${index}`,
			content: `context ${index}`
		})
	);

	const prompt = buildDraftPrompt(message({ id: "target", content: "target" }), context);

	assert.ok(prompt.includes("User2: context 2"));
	assert.ok(prompt.includes("User11: context 11"));
	assert.equal(prompt.includes("User0: context 0"), false);
	assert.equal(prompt.includes("User1: context 1"), false);
	const contextLines = prompt.split("\n").filter(line => /^User\d+: context \d+$/.test(line));
	assert.equal(contextLines.length, 10);
});

test("draft prompt does not repeat the target message in the context block", () => {
	const target = message({ id: "target", content: "please decide" });
	const prompt = buildDraftPrompt(target, [
		message({ id: "a", content: "before" }),
		target,
		message({ id: "b", content: "after" })
	]);

	assert.equal(prompt.split("please decide").length - 1, 1);
	assert.ok(prompt.includes("Ana: before"));
	assert.ok(prompt.includes("Ana: after"));
});

test("draft prompt truncates the message to answer at 1200 characters", () => {
	const prompt = buildDraftPrompt(message({ content: "y".repeat(5000) }), []);

	assert.ok(prompt.includes("y".repeat(1200)));
	assert.equal(prompt.includes("y".repeat(1201)), false);
});
