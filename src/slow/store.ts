import fs from "fs";
import path from "path";
import { BufferedMessage, SlowState, Store } from "./types";

function defaultState(): SlowState {
	return { version: 1, enabledBridges: [], lastDigestAt: {}, digestCount: 0 };
}

function isBufferedMessage(value: unknown): value is BufferedMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return (
		typeof message.id === "string" &&
		typeof message.bridge === "string" &&
		typeof message.guild === "string" &&
		typeof message.channel === "string" &&
		typeof message.author === "string" &&
		typeof message.authorId === "string" &&
		typeof message.ts === "string" &&
		typeof message.content === "string" &&
		typeof message.mentionsOwner === "boolean"
	);
}

function parseMessages(raw: string | null): BufferedMessage[] {
	if (raw === null) return [];
	const messages: BufferedMessage[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isBufferedMessage(parsed)) messages.push(parsed);
		} catch {
			// A truncated final line must not take down the whole buffer read.
		}
	}
	return messages;
}

function parseState(raw: string | null): SlowState {
	if (raw === null) return defaultState();
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return defaultState();
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return defaultState();
	const record = data as Record<string, unknown>;
	const enabled = record.enabledBridges;
	const lastDigestAt = record.lastDigestAt;
	if (record.version !== 1) return defaultState();
	if (!Array.isArray(enabled) || !enabled.every(bridge => typeof bridge === "string")) return defaultState();
	if (typeof lastDigestAt !== "object" || lastDigestAt === null || Array.isArray(lastDigestAt)) return defaultState();
	const entries = Object.entries(lastDigestAt as Record<string, unknown>);
	if (entries.some(([, value]) => typeof value !== "string")) return defaultState();
	if (typeof record.digestCount !== "number" || !Number.isFinite(record.digestCount)) return defaultState();
	const digestAt: Record<string, string> = {};
	for (const [bridge, value] of entries) digestAt[bridge] = value as string;
	return {
		version: 1,
		enabledBridges: [...(enabled as string[])],
		lastDigestAt: digestAt,
		digestCount: record.digestCount
	};
}

function sanitizeState(state: SlowState): SlowState {
	const enabledBridges = Array.isArray(state.enabledBridges)
		? state.enabledBridges.filter(bridge => typeof bridge === "string")
		: [];
	const lastDigestAt: Record<string, string> = {};
	const digestSource: unknown = state.lastDigestAt;
	if (typeof digestSource === "object" && digestSource !== null) {
		for (const [bridge, value] of Object.entries(digestSource)) {
			if (typeof value === "string") lastDigestAt[bridge] = value;
		}
	}
	return {
		version: 1,
		enabledBridges,
		lastDigestAt,
		digestCount: Number.isFinite(state.digestCount) ? state.digestCount : 0
	};
}

export function createStore(dir: string): Store {
	const statePath = path.join(dir, "state.json");
	const bufferPath = path.join(dir, "buffer.jsonl");
	let tail: Promise<void> = Promise.resolve();

	fs.mkdirSync(dir, { recursive: true });

	function serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = tail.then(operation, operation);
		tail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	async function readText(file: string): Promise<string | null> {
		try {
			return await fs.promises.readFile(file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	async function writeAtomic(file: string, data: string): Promise<void> {
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		await fs.promises.writeFile(tmp, data, "utf8");
		await fs.promises.rename(tmp, file);
	}

	async function loadState(): Promise<SlowState> {
		return parseState(await readText(statePath));
	}

	async function saveState(state: SlowState): Promise<void> {
		await writeAtomic(statePath, `${JSON.stringify(sanitizeState(state))}\n`);
	}

	async function loadBuffer(bridge?: string): Promise<BufferedMessage[]> {
		const messages = parseMessages(await readText(bufferPath));
		return bridge === undefined ? messages : messages.filter(message => message.bridge === bridge);
	}

	return {
		readState(): Promise<SlowState> {
			return serialize(loadState);
		},

		writeState(state: SlowState): Promise<void> {
			return serialize(() => saveState(state));
		},

		isEnabled(bridge: string): Promise<boolean> {
			return serialize(async () => (await loadState()).enabledBridges.includes(bridge));
		},

		setEnabled(bridge: string, on: boolean): Promise<void> {
			return serialize(async () => {
				const state = await loadState();
				const enabled = new Set(state.enabledBridges);
				if (on) enabled.add(bridge);
				else enabled.delete(bridge);
				state.enabledBridges = [...enabled];
				await saveState(state);
			});
		},

		append(message: BufferedMessage): Promise<void> {
			return serialize(async () => {
				await fs.promises.mkdir(dir, { recursive: true });
				await fs.promises.appendFile(bufferPath, `${JSON.stringify(message)}\n`, "utf8");
			});
		},

		readBuffer(bridge?: string): Promise<BufferedMessage[]> {
			return serialize(() => loadBuffer(bridge));
		},

		clearBuffer(bridge: string): Promise<void> {
			return serialize(async () => {
				const raw = await readText(bufferPath);
				if (raw === null) return;
				const kept: string[] = [];
				let total = 0;
				for (const line of raw.split(/\r?\n/)) {
					if (!line.trim()) continue;
					total += 1;
					try {
						const parsed: unknown = JSON.parse(line);
						if (isBufferedMessage(parsed) && parsed.bridge !== bridge) kept.push(line);
					} catch {
						// Malformed lines belong to no bridge, so a clear drops them.
					}
				}
				if (kept.length === total) return;
				await writeAtomic(bufferPath, kept.length > 0 ? `${kept.join("\n")}\n` : "");
			});
		},

		bufferSize(): Promise<number> {
			return serialize(async () => parseMessages(await readText(bufferPath)).length);
		}
	};
}
