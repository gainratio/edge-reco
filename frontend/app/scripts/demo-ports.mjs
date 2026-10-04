// Random-port helpers for the demo orchestrator (demo.mjs).
//
// Why: the demo used to pin :8081 (edge) and :5174 (SPA).
// Those collide with stale containers and sibling projects, surfacing as
// confusing "port in use" / "signature verification failed" errors. Allocating
// free ports per run removes that whole class of failure.
//
// `pickFreePorts` holds all sockets open at once before reading their ports, so
// the returned set is guaranteed distinct (the OS won't hand the same ephemeral
// port to two simultaneous listeners). There is a tiny TOCTOU window between
// closing here and binding in docker/Vite — acceptable for a local dev tool,
// and a real collision fails loudly (re-run gets fresh ports).

import { createServer } from "node:net";

/** Allocate one free TCP port by binding to 0 and reading what the OS assigned. */
export function pickFreePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

/** Allocate `n` distinct free ports (all held open simultaneously, then freed). */
export async function pickFreePorts(n) {
	const servers = await Promise.all(
		Array.from(
			{ length: n },
			() =>
				new Promise((resolve, reject) => {
					const srv = createServer();
					srv.once("error", reject);
					srv.listen(0, "127.0.0.1", () => resolve(srv));
				}),
		),
	);
	const ports = servers.map((srv) => srv.address().port);
	await Promise.all(servers.map((srv) => new Promise((r) => srv.close(r))));
	return ports;
}

/**
 * Parse the host port from `docker compose port <svc> <containerPort>` output.
 * Accepts IPv4 (`0.0.0.0:PORT`) and dual-stack (`[::]:PORT\n0.0.0.0:PORT`).
 * @returns {number|null} the port, or null if nothing parseable.
 */
export function parsePublishedPort(text) {
	for (const line of String(text).split("\n")) {
		const match = line.trim().match(/:(\d+)$/);
		if (match) return Number(match[1]);
	}
	return null;
}
