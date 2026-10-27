import { createGoogleProvider } from "./google";
import { createMockProvider } from "./mock";
import { SlowConfig, SlowProvider } from "./types";

export function createProvider(config: SlowConfig): SlowProvider {
	switch (config.provider) {
		case "google":
			return createGoogleProvider(config);
		case "mock":
			return createMockProvider();
		default:
			throw new Error(
				`Unknown slow provider "${String(config.provider)}"; expected "google" or "mock"`
			);
	}
}
