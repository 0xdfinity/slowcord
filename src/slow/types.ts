export interface BufferedMessage {
	id: string;
	bridge: string;
	guild: string;
	channel: string;
	author: string;
	authorId: string;
	ts: string;
	content: string;
	mentionsOwner: boolean;
}

export interface NeedsYouItem {
	id: string;
	why: string;
}

export interface Digest {
	summary: string[];
	needsYou: NeedsYouItem[];
	quiet: boolean;
}

export interface SlowState {
	version: 1;
	enabledBridges: string[];
	lastDigestAt: Record<string, string>;
	digestCount: number;
}

export interface SlowConfig {
	provider: "google" | "mock";
	googleApiKey?: string;
	googleModel: string;
	intervalMin: number;
	ownerDiscordId?: string;
	maxBuffer: number;
	port: number;
	sentryDsn?: string;
}

export interface SlowProvider {
	name: string;
	generate(prompt: string, opts?: { json?: boolean; maxTokens?: number }): Promise<string>;
}

export interface Store {
	readState(): Promise<SlowState>;
	writeState(state: SlowState): Promise<void>;
	isEnabled(bridge: string): Promise<boolean>;
	setEnabled(bridge: string, on: boolean): Promise<void>;
	append(message: BufferedMessage): Promise<void>;
	readBuffer(bridge?: string): Promise<BufferedMessage[]>;
	clearBuffer(bridge: string): Promise<void>;
	bufferSize(): Promise<number>;
}

export interface DigestRunner {
	run(bridgeName: string): Promise<Digest | null>;
	lastDigest(bridgeName: string): Digest | undefined;
}

export interface DraftRecord {
	id: string;
	text: string;
	bridge: string;
	messageId: string;
	createdAt: string;
}

export interface DraftService {
	create(messageId: string, bridgeName: string): Promise<DraftRecord | null>;
	approve(draftId: string): Promise<boolean>;
	cancel(draftId: string): boolean;
	get(draftId: string): DraftRecord | undefined;
}

export interface SlowEngine {
	onDiscordMessage(message: any, bridge: any): Promise<boolean>;
	registerCommands(tgBot: any): void;
	start(): void;
	health(): Promise<Record<string, unknown>>;
}
