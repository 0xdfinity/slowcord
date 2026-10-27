import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleProvider } from "../dist/slow/google.js";
import { createMockProvider } from "../dist/slow/mock.js";
import { createProvider } from "../dist/slow/provider.js";

const baseConfig = {
	provider: "google",
	googleApiKey: "test-google-key",
	googleModel: "gemma-3-27b-it",
	intervalMin: 30,
	ownerDiscordId: "111",
	maxBuffer: 200,
	port: 8787
};

function fakeResponse(status, body) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		async text() {
			return text;
		}
	};
}

test("google posts the prompt and generation config, then reads candidate text", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	try {
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), init });
			return fakeResponse(200, {
				candidates: [{ content: { parts: [{ text: "  hello from gemma  " }] } }]
			});
		};

		const provider = createGoogleProvider(baseConfig);
		const text = await provider.generate("Summarize this");

		assert.equal(text, "hello from gemma");
		assert.equal(calls.length, 1);
		const [call] = calls;
		assert.equal(
			call.url,
			"https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=test-google-key"
		);
		assert.equal(call.init.method, "POST");
		assert.equal(call.init.headers["Content-Type"], "application/json");
		assert.ok(call.init.signal instanceof AbortSignal);
		assert.deepEqual(JSON.parse(call.init.body), {
			contents: [{ parts: [{ text: "Summarize this" }] }],
			generationConfig: { temperature: 0.2, maxOutputTokens: 700 }
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("google honors a custom maxTokens value", async () => {
	const originalFetch = globalThis.fetch;
	let body;
	try {
		globalThis.fetch = async (_url, init) => {
			body = JSON.parse(init.body);
			return fakeResponse(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
		};

		await createGoogleProvider(baseConfig).generate("hi", { json: true, maxTokens: 128 });
		assert.equal(body.generationConfig.maxOutputTokens, 128);
		assert.equal(body.generationConfig.temperature, 0.2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("google rejects without a key and never calls fetch", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	try {
		globalThis.fetch = async () => {
			calls += 1;
			throw new Error("network should not be reached");
		};

		const provider = createGoogleProvider({ ...baseConfig, googleApiKey: undefined });
		await assert.rejects(provider.generate("hi"), /GOOGLE_AI_API_KEY/);
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("google surfaces the HTTP status and a body snippet", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			fakeResponse(429, '{"error":{"message":"quota exceeded for this key"}}');

		const provider = createGoogleProvider(baseConfig);
		await assert.rejects(provider.generate("hi"), err => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /429/);
			assert.match(err.message, /quota exceeded/);
			return true;
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("google rejects a response with the wrong shape", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => fakeResponse(200, { candidates: [{ content: { parts: [] } }] });

		const provider = createGoogleProvider(baseConfig);
		await assert.rejects(
			provider.generate("hi"),
			/candidates\[0\]\.content\.parts\[0\]\.text/
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("mock returns a schema-valid digest using the first id in the prompt", async () => {
	const prompt =
		'SLOWCORD_TASK=digest\nMessages: [{"id": "987654321012345678", "author": "Ana", "channel": "general", "content": "hi", "mentionsOwner": true}]';

	const digest = JSON.parse(await createMockProvider().generate(prompt, { json: true }));

	assert.deepEqual(digest, {
		summary: ["The team settled the release date.", "Two questions are waiting on you."],
		needsYou: [{ id: "987654321012345678", why: "asks you a direct question" }],
		quiet: false
	});
});

test("mock falls back to id 1 when the prompt has no message id", async () => {
	const digest = JSON.parse(await createMockProvider().generate("SLOWCORD_TASK=digest\nMessages: []"));

	assert.equal(digest.needsYou.length, 1);
	assert.equal(digest.needsYou[0].id, "1");
	assert.equal(digest.quiet, false);
});

test("mock returns the deterministic draft reply", async () => {
	const text = await createMockProvider().generate("SLOWCORD_TASK=draft\nMessage to answer: hi");

	assert.equal(text, "Sounds good — I will take a look this afternoon.");
});

test("mock rejects prompts without a known task marker", async () => {
	await assert.rejects(createMockProvider().generate("hello"), /SLOWCORD_TASK/);
});

test("createProvider selects the configured provider", () => {
	assert.equal(createProvider({ ...baseConfig, provider: "google" }).name, "google");
	assert.equal(createProvider({ ...baseConfig, provider: "mock" }).name, "mock");
});

test("createProvider throws for an unknown provider instead of falling back", () => {
	assert.throws(
		() => createProvider({ ...baseConfig, provider: "nope" }),
		/Unknown slow provider "nope"/
	);
});

test("createProvider keeps google selected when the key is missing and fails on generate", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	try {
		globalThis.fetch = async () => {
			calls += 1;
			throw new Error("network should not be reached");
		};

		const provider = createProvider({ ...baseConfig, provider: "google", googleApiKey: undefined });
		assert.equal(provider.name, "google");
		await assert.rejects(provider.generate("hi"), /GOOGLE_AI_API_KEY/);
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
