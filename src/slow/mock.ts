import { SlowProvider } from "./types";

const FIRST_MESSAGE_ID = /"id"\s*:\s*"([^"]+)"/;

const DRAFT_REPLY = "Sounds good — I will take a look this afternoon.";

export function createMockProvider(): SlowProvider {
	return {
		name: "mock",

		async generate(prompt: string): Promise<string> {
			if (prompt.includes("SLOWCORD_TASK=digest")) {
				const match = FIRST_MESSAGE_ID.exec(prompt);
				const id = match?.[1] ?? "1";
				return JSON.stringify({
					summary: [
						"The team settled the release date.",
						"Two questions are waiting on you."
					],
					needsYou: [{ id, why: "asks you a direct question" }],
					quiet: false
				});
			}

			if (prompt.includes("SLOWCORD_TASK=draft")) {
				return DRAFT_REPLY;
			}

			throw new Error(
				"Mock provider requires a prompt containing SLOWCORD_TASK=digest or SLOWCORD_TASK=draft"
			);
		}
	};
}
