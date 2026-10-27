import { SlowConfig, SlowProvider } from "./types";

interface GoogleCandidate {
	content?: {
		parts?: {
			text?: unknown;
		}[];
	};
}

interface GoogleResponse {
	candidates?: GoogleCandidate[];
}

const GOOGLE_TIMEOUT_MS = 45_000;

export function createGoogleProvider(config: SlowConfig): SlowProvider {
	return {
		name: "google",

		async generate(prompt: string, opts?: { json?: boolean; maxTokens?: number }): Promise<string> {
			if (!config.googleApiKey) {
				throw new Error(
					"Google provider requires GOOGLE_AI_API_KEY, but no key is configured"
				);
			}

			const url =
				"https://generativelanguage.googleapis.com/v1beta/models/" +
				`${config.googleModel}:generateContent?key=${config.googleApiKey}`;

			let response: Response;
			try {
				response = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [{ parts: [{ text: prompt }] }],
						generationConfig: {
							temperature: 0.2,
							maxOutputTokens: opts?.maxTokens ?? 700
						}
					}),
					signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS)
				});
			} catch (err: unknown) {
				throw new Error(`Google request failed: ${describeError(err)}`);
			}

			const raw = await response.text();
			if (!response.ok) {
				throw new Error(
					`Google request failed with status ${response.status}: ${snippet(raw)}`
				);
			}

			let json: GoogleResponse;
			try {
				json = JSON.parse(raw) as GoogleResponse;
			} catch {
				throw new Error(`Google returned invalid JSON: ${snippet(raw)}`);
			}

			const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
			if (typeof text !== "string") {
				throw new Error(
					`Google response is missing candidates[0].content.parts[0].text: ${snippet(raw)}`
				);
			}

			return text.trim();
		}
	};
}

function snippet(raw: string): string {
	const flat = raw.replace(/\s+/g, " ").trim();
	if (!flat) return "(empty body)";
	return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
