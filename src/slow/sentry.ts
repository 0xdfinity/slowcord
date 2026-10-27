import * as Sentry from "@sentry/node";

/**
 * Initialize Sentry when a DSN is configured.
 *
 * Without `SENTRY_DSN` this is a silent no-op: local runs and tests must never
 * depend on (or be polluted by) an observability backend.
 */
export function initSentry(): void {
	const dsn = process.env.SENTRY_DSN;
	if (!dsn) return;

	Sentry.init({
		dsn,
		environment: process.env.SENTRY_ENV || "development",
		tracesSampleRate: 1.0
	});
}

/**
 * Run `fn` inside a Sentry span when Sentry is configured, otherwise just run
 * it. Errors always propagate to the caller.
 */
export async function span<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
	if (!process.env.SENTRY_DSN) {
		return await fn();
	}

	return await Sentry.startSpan({ name, op: "slow" }, async () => await fn());
}
