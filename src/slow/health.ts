import * as http from "http";

const PAGE_STYLE = `
	:root { color-scheme: dark; }
	* { box-sizing: border-box; }
	body {
		margin: 0;
		min-height: 100vh;
		background: #0b0d10;
		color: #e6e9ef;
		font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
		display: flex;
		justify-content: center;
		padding: 48px 20px;
	}
	main { width: 100%; max-width: 560px; }
	header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
	h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0.02em; }
	.status { padding: 2px 10px; border-radius: 999px; border: 1px solid #2a2f38; font-size: 12px; }
	.status.ok { color: #7ee2a8; border-color: #234b36; background: #10231a; }
	.status.degraded { color: #ffb4a8; border-color: #5a2a24; background: #2a1512; }
	table { width: 100%; border-collapse: collapse; border: 1px solid #1d222a; border-radius: 8px; }
	th, td { padding: 10px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid #1d222a; }
	th { width: 38%; color: #8b93a1; font-weight: 500; background: #0f1217; }
	tr:last-child th, tr:last-child td { border-bottom: 0; }
	ul { margin: 0; padding-left: 16px; }
	.yes { color: #7ee2a8; }
	.no { color: #ffb4a8; }
	footer { margin-top: 14px; color: #6d7583; font-size: 12px; }
	a { color: #9cc4ff; text-decoration: none; }
	a:hover { text-decoration: underline; }
`;

/**
 * Start the Slowcord health/status HTTP server.
 *
 * `GET /healthz` serves the raw JSON from `getHealth`, `GET /` serves a small
 * dark status page, and everything else is a 404. Listen failures are logged
 * instead of thrown so a busy port never takes the bridge down.
 */
export function startHealthServer(getHealth: () => Promise<Record<string, unknown>>, port: number): http.Server {
	const server = http.createServer((req, res) => {
		void handleRequest(req, res, getHealth).catch(() => {
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			}
			if (!res.writableEnded) {
				res.end("Internal Server Error");
			}
		});
	});

	server.on("error", err => {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[slow] health server error: ${message}`);
	});

	try {
		server.listen(port);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[slow] health server could not listen on port ${port}: ${message}`);
	}

	return server;
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	getHealth: () => Promise<Record<string, unknown>>
): Promise<void> {
	if (req.method !== "GET") {
		sendNotFound(res);
		return;
	}

	let pathname: string;
	try {
		pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	} catch {
		sendNotFound(res);
		return;
	}

	if (pathname === "/healthz") {
		try {
			sendJson(res, 200, await getHealth());
		} catch {
			sendJson(res, 500, { ok: false, error: "health check failed" });
		}
		return;
	}

	if (pathname === "/favicon.svg") {
		sendSvg(res, FAVICON);
		return;
	}

	if (pathname === "/") {
		try {
			sendHtml(res, 200, renderStatusPage(await getHealth()));
		} catch {
			sendHtml(res, 500, renderStatusPage({ ok: false, uptime: process.uptime() }));
		}
		return;
	}

	sendNotFound(res);
}

function renderStatusPage(health: Record<string, unknown>): string {
	const ok = health.ok === true;
	const statusClass = ok ? "ok" : "degraded";
	const discordReady =
		health.discordReady === true
			? `<span class="yes">yes</span>`
			: health.discordReady === false
				? `<span class="no">no</span>`
				: "—";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>Slowcord</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<header>
<h1>Slowcord</h1>
<span class="status ${statusClass}">${ok ? "ok" : "degraded"}</span>
</header>
<table>
<tbody>
${statusRow("Provider", asText(health.provider))}
${statusRow("Model", asText(health.model))}
${statusRow("Discord ready", discordReady)}
${statusRow("Telegram ready", health.telegramReady === true ? `<span class="yes">yes</span>` : `<span class="no">no</span>`)}
${statusRow("Enabled bridges", formatBridges(health.enabledBridges))}
${statusRow("Buffered", asText(health.buffered))}
${statusRow("Last digest", formatLastDigest(health.lastDigestAt))}
${statusRow("Uptime", formatUptime(health.uptime))}
</tbody>
</table>
<footer>JSON: <a href="/healthz">/healthz</a></footer>
</main>
</body>
</html>`;
}

function statusRow(label: string, valueHtml: string): string {
	return `<tr><th scope="row">${escapeHtml(label)}</th><td>${valueHtml}</td></tr>`;
}

function asText(value: unknown): string {
	if (typeof value === "string") return value.length > 0 ? escapeHtml(value) : "—";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "—";
}

function formatBridges(value: unknown): string {
	if (!Array.isArray(value)) return "none";
	const names = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	if (names.length === 0) return "none";
	return `<ul>${names.map(name => `<li>${escapeHtml(name)}</li>`).join("")}</ul>`;
}

function formatLastDigest(value: unknown): string {
	if (typeof value === "string") {
		return value.length > 0 ? escapeHtml(formatTimestamp(value)) : "never";
	}

	if (value && typeof value === "object" && !Array.isArray(value)) {
		const entries = Object.entries(value as Record<string, unknown>).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0
		);
		if (entries.length === 0) return "never";
		entries.sort((a, b) => b[1].localeCompare(a[1]));
		const items = entries
			.map(([bridge, timestamp]) => `<li>${escapeHtml(bridge)}: ${escapeHtml(formatTimestamp(timestamp))}</li>`)
			.join("");
		return `<ul>${items}</ul>`;
	}

	return "never";
}

function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return timestamp;
	return `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function formatUptime(value: unknown): string {
	const seconds = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) return "—";

	const total = Math.floor(seconds);
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (days > 0 || hours > 0) parts.push(`${hours}h`);
	if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
	parts.push(`${secs}s`);
	return parts.join(" ");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
	const payload = JSON.stringify(body) ?? "null";
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}

function sendHtml(res: http.ServerResponse, statusCode: number, body: string): void {
	res.writeHead(statusCode, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0d10"/><path d="M8 12h16M8 16h11M8 20h16" stroke="#7ee2a8" stroke-width="2.5" stroke-linecap="round"/></svg>`;

function sendSvg(res: http.ServerResponse, body: string): void {
	res.writeHead(200, {
		"Content-Type": "image/svg+xml; charset=utf-8",
		"Cache-Control": "public, max-age=86400",
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}

function sendNotFound(res: http.ServerResponse): void {
	const body = "Not found";
	res.writeHead(404, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}
