import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../dist/slow/store.js";

const DEFAULT_STATE = { version: 1, enabledBridges: [], lastDigestAt: {}, digestCount: 0 };

function makeDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slowcord-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

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

test("a fresh store reads the default state and an empty buffer", async t => {
	const dir = makeDir(t);
	const store = createStore(dir);

	assert.deepEqual(await store.readState(), DEFAULT_STATE);
	assert.equal(await store.isEnabled("Main bridge"), false);
	assert.deepEqual(await store.readBuffer(), []);
	assert.deepEqual(await store.readBuffer("Main bridge"), []);
	assert.equal(await store.bufferSize(), 0);
	assert.ok(fs.statSync(dir).isDirectory());
});

test("setEnabled persists across store instances and does not duplicate", async t => {
	const dir = makeDir(t);
	const first = createStore(dir);
	await first.setEnabled("Main bridge", true);
	await first.setEnabled("Side bridge", true);
	assert.equal(await first.isEnabled("Main bridge"), true);

	const second = createStore(dir);
	assert.equal(await second.isEnabled("Main bridge"), true);
	assert.deepEqual((await second.readState()).enabledBridges, ["Main bridge", "Side bridge"]);

	await second.setEnabled("Main bridge", false);
	assert.equal(await first.isEnabled("Main bridge"), false);
	assert.equal(await first.isEnabled("Side bridge"), true);

	await second.setEnabled("Main bridge", true);
	await second.setEnabled("Main bridge", true);
	const state = await second.readState();
	assert.deepEqual(state.enabledBridges.filter(bridge => bridge === "Main bridge"), ["Main bridge"]);
});

test("writeState persists every field atomically", async t => {
	const dir = makeDir(t);
	const store = createStore(dir);
	const state = {
		version: 1,
		enabledBridges: ["Main bridge"],
		lastDigestAt: { "Main bridge": "2026-10-22T10:00:00.000Z" },
		digestCount: 3
	};

	await store.writeState(state);

	assert.deepEqual(await store.readState(), state);
	const raw = fs.readFileSync(path.join(dir, "state.json"), "utf8");
	assert.deepEqual(JSON.parse(raw), state);
	assert.equal(fs.existsSync(path.join(dir, "state.json.tmp")), false);
});

test("append writes one JSON line per message and readBuffer filters by bridge", async t => {
	const dir = makeDir(t);
	const store = createStore(dir);
	await Promise.all([
		store.append(message({ id: "1", bridge: "A", content: "first" })),
		store.append(message({ id: "2", bridge: "B", content: "second" })),
		store.append(message({ id: "3", bridge: "A", content: "third" }))
	]);

	assert.equal(await store.bufferSize(), 3);
	assert.deepEqual((await store.readBuffer()).map(entry => entry.id), ["1", "2", "3"]);
	assert.deepEqual((await store.readBuffer("A")).map(entry => entry.id), ["1", "3"]);
	assert.deepEqual((await store.readBuffer("B")).map(entry => entry.id), ["2"]);
	assert.deepEqual(await store.readBuffer("missing"), []);

	const lines = fs.readFileSync(path.join(dir, "buffer.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 3);
	for (const line of lines) assert.equal(typeof JSON.parse(line).id, "string");
});

test("readBuffer and bufferSize skip malformed lines", async t => {
	const dir = makeDir(t);
	const store = createStore(dir);
	const valid = message({ id: "good" });
	fs.writeFileSync(
		path.join(dir, "buffer.jsonl"),
		`not json\n${JSON.stringify(valid)}\n{"id":"partial"}\n\n`,
		"utf8"
	);

	assert.deepEqual((await store.readBuffer()).map(entry => entry.id), ["good"]);
	assert.equal(await store.bufferSize(), 1);
});

test("clearBuffer removes only the requested bridge", async t => {
	const dir = makeDir(t);
	const store = createStore(dir);
	await store.append(message({ id: "a1", bridge: "A" }));
	await store.append(message({ id: "b1", bridge: "B" }));
	await store.append(message({ id: "a2", bridge: "A" }));

	await store.clearBuffer("A");

	assert.equal(await store.bufferSize(), 1);
	assert.deepEqual((await store.readBuffer()).map(entry => entry.id), ["b1"]);
	assert.deepEqual((await store.readBuffer("B")).map(entry => entry.id), ["b1"]);
	assert.deepEqual(await store.readBuffer("A"), []);

	await store.clearBuffer("missing");
	assert.equal(await store.bufferSize(), 1);

	await store.clearBuffer("B");
	assert.equal(await store.bufferSize(), 0);
	assert.equal(fs.existsSync(path.join(dir, "buffer.jsonl.tmp")), false);
});

test("missing or corrupt state falls back to defaults and stays writable", async t => {
	const dir = makeDir(t);
	fs.writeFileSync(path.join(dir, "state.json"), "{not json", "utf8");
	const store = createStore(dir);

	assert.deepEqual(await store.readState(), DEFAULT_STATE);
	assert.equal(await store.isEnabled("Main bridge"), false);

	fs.writeFileSync(
		path.join(dir, "state.json"),
		JSON.stringify({ version: 1, enabledBridges: "Main bridge", lastDigestAt: {}, digestCount: 2 }),
		"utf8"
	);
	assert.deepEqual(await store.readState(), DEFAULT_STATE);

	await store.setEnabled("Main bridge", true);
	assert.equal(await store.isEnabled("Main bridge"), true);
	const state = await store.readState();
	assert.equal(state.version, 1);
	assert.equal(state.digestCount, 0);
	assert.deepEqual(state.enabledBridges, ["Main bridge"]);
});

test("concurrent appends are serialized without losing lines", async t => {
	const dir = makeDir(t);
	const store = createStore(dir);
	const writes = Array.from({ length: 25 }, (_, index) =>
		store.append(message({ id: String(index), content: `message ${index}` }))
	);
	await Promise.all(writes);

	assert.equal(await store.bufferSize(), 25);
	const buffer = await store.readBuffer();
	assert.deepEqual(buffer.map(entry => entry.id), Array.from({ length: 25 }, (_, index) => String(index)));
});
