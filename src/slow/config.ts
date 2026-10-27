import { SlowConfig } from "./types";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SlowConfig {
	const provider = (env.SLOW_PROVIDER || "google") as SlowConfig["provider"];
	return {
		provider,
		googleApiKey: env.GOOGLE_AI_API_KEY,
		googleModel: env.GOOGLE_AI_MODEL || "gemma-3-27b-it",
		intervalMin: Number(env.SLOW_INTERVAL_MIN || 30),
		ownerDiscordId: env.SLOW_OWNER_DISCORD_ID,
		maxBuffer: Number(env.SLOW_MAX_BUFFER || 200),
		port: Number(env.PORT || 8787),
		sentryDsn: env.SENTRY_DSN
	};
}
