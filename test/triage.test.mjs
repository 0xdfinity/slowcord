import test from "node:test";
import assert from "node:assert/strict";
import { parseDigest, deterministicTriage, formatDigestHtml } from "../dist/slow/triage.js";

function message(overrides = {}) {
	return {
		id: "1",
		bridge: "Main bridge",
		guild: "Server",
		channel: "general",
		author: "Ada",
		authorId: "42",
		ts: "2026-10-22T10:00:00.000Z",
		content: "hello",
		mentionsOwner: false,
		...overrides
	};
}

test("parseDigest strips fences and validates summary and needsYou", () => {
	const buffer = [message({ id: "m1" }), message({ id: "m2" })];
	const longSummary = "x".repeat(200);
	const longWhy = "y".repeat(200);
	const raw = [
		"Here is the digest:",
		"```json",
		JSON.stringify({
			summary: ["  first  ", "", "   ", longSummary, "second", "third", "fourth"],
			needsYou: [
				{ id: "m1", why: `  ${longWhy}  ` },
				{ id: "ghost", why: "unknown message" },
				{ id: "m2", why: "asks a question" }
			],
			quiet: true
		}),
		"```",
		"Enjoy."
	].join("\n");

	const digest = parseDigest(raw, buffer);

	assert.equal(digest.summary.length, 4);
	assert.equal(digest.summary[0], "first");
	assert.equal(digest.summary[1].length, 160);
	assert.deepEqual(digest.summary.slice(2), ["second", "third"]);
	assert.deepEqual(digest.needsYou.map(item => item.id), ["m1", "m2"]);
	assert.equal(digest.needsYou[0].why.length, 120);
	assert.equal(digest.needsYou[1].why, "asks a question");
	assert.equal(digest.quiet, true);
});

test("parseDigest drops needsYou ids that are not in the buffer", () => {
	const buffer = [message({ id: "known" })];
	const raw = JSON.stringify({
		summary: ["a"],
		needsYou: [
			{ id: "known", why: "ok" },
			{ id: "unknown", why: "bad" }
		],
		quiet: false
	});

	const digest = parseDigest(raw, buffer);

	assert.deepEqual(digest.needsYou, [{ id: "known", why: "ok" }]);
});

test("parseDigest caps needsYou at six valid items", () => {
	const buffer = Array.from({ length: 8 }, (_, index) => message({ id: `m${index}` }));
	const raw = JSON.stringify({
		summary: [],
		needsYou: buffer.map(entry => ({ id: entry.id, why: "asks a question" })),
		quiet: false
	});

	const digest = parseDigest(raw, buffer);

	assert.equal(digest.needsYou.length, 6);
	assert.deepEqual(
		digest.needsYou.map(item => item.id),
		["m0", "m1", "m2", "m3", "m4", "m5"]
	);
});

test("parseDigest defaults quiet to false and tolerates wrong field types", () => {
	const digest = parseDigest('{"summary":"nope","needsYou":"nope"}', []);
	assert.deepEqual(digest, { summary: [], needsYou: [], quiet: false });
	assert.equal(parseDigest('{"quiet":"yes"}', []).quiet, false);
	assert.equal(parseDigest('{"quiet":true}', []).quiet, true);
});

test("parseDigest finds the first object even with nested braces and trailing prose", () => {
	const digest = parseDigest('Here: {"summary":["a } b"],"needsYou":[],"quiet":false} then {"x":1}', []);
	assert.deepEqual(digest, { summary: ["a } b"], needsYou: [], quiet: false });
});

test("parseDigest throws a clear error when JSON is missing or invalid", () => {
	assert.throws(() => parseDigest("no json here", []), /JSON object/i);
	assert.throws(() => parseDigest("```json\n{broken: true}\n```", []), /parse/i);
	assert.throws(() => parseDigest("{'single': 'quotes'}", []), /parse/i);
});

test("deterministicTriage picks mentions, questions, and owner ids", () => {
	const ownerId = "424242";
	const buffer = [
		message({ id: "q", author: "Ada", content: "Can you review this?" }),
		message({ id: "mention", author: "Bob", content: "hey boss, ok?", mentionsOwner: true }),
		message({ id: "owner", author: "Cleo", content: "ping <@424242> when free" }),
		message({ id: "chat", author: "Dan", content: "lunch soon" })
	];

	const digest = deterministicTriage(buffer, ownerId);

	assert.deepEqual(digest.needsYou, [
		{ id: "q", why: "asks a question" },
		{ id: "mention", why: "mentions you" },
		{ id: "owner", why: "mentions you" }
	]);
	assert.deepEqual(digest.summary, [
		"Ada: Can you review this?",
		"Bob: hey boss, ok?",
		"Cleo: ping <@424242> when free"
	]);
	assert.equal(digest.quiet, false);
});

test("deterministicTriage is quiet when empty and truncates snippets", () => {
	assert.deepEqual(deterministicTriage([]), { summary: [], needsYou: [], quiet: true });

	const buffer = Array.from({ length: 6 }, (_, index) =>
		message({ id: `m${index}`, author: "Ada", content: "hi" })
	);
	buffer[0] = message({ id: "long", author: "Ada", content: "z".repeat(300) });

	const digest = deterministicTriage(buffer);

	assert.equal(digest.summary.length, 3);
	assert.equal(digest.summary[0], `Ada: ${"z".repeat(120)}`);
	assert.ok(digest.summary.every(line => line.length <= 125));
});

test("formatDigestHtml escapes HTML and hides message ids", () => {
	const digest = {
		summary: ["Ada: Tom & Jerry <3"],
		needsYou: [{ id: "123456789012345678", why: "asks <you> & waits" }],
		quiet: false
	};

	const html = formatDigestHtml(digest, "Main & Co <bridge>");

	assert.ok(html.startsWith("<b>Slowcord · Main &amp; Co &lt;bridge&gt;</b>"));
	assert.ok(html.includes("• Ada: Tom &amp; Jerry &lt;3"));
	assert.ok(html.includes("<b>Needs you</b>"));
	assert.ok(html.includes("• asks &lt;you&gt; &amp; waits"));
	assert.ok(!html.includes("123456789012345678"));
	assert.ok(!html.includes("<3"));
	assert.ok(html.length < 4096);
});

test("formatDigestHtml keeps the payload under the Telegram limit", () => {
	const digest = {
		summary: Array.from({ length: 40 }, (_, index) => `${index} ${"s".repeat(160)}`),
		needsYou: Array.from({ length: 6 }, (_, index) => ({ id: `id${index}`, why: `${index} ${"w".repeat(120)}` })),
		quiet: false
	};

	const html = formatDigestHtml(digest, "Main bridge");

	assert.ok(html.length < 4096);
	assert.ok(html.startsWith("<b>Slowcord · Main bridge</b>"));
	assert.ok(html.includes("<b>Needs you</b>"));
});
