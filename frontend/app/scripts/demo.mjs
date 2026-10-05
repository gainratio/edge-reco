// Single orchestrator for the Nimbus demo — the one place the demo logic lives.
//
//   node app/scripts/demo.mjs              backend-free demo: edge + Vite SPA
//
// RANDOM PORTS: every run allocates fresh free ports for the edge and the SPA,
// then threads them through the compose port-mapping, the SPA's
// VITE_BUNDLE_BASE_URL, and the edge preflight. This removes the whole class of
// ":port in use" / cross-project ":8081 collision" failures the fixed ports used
// to cause. Standalone `docker compose up` still defaults to 8081/5174.
//
// poe (poe_tasks.toml + backend/pyproject.toml) and the Makefile are thin
// wrappers over this file, so there is exactly one copy of the orchestration.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickFreePorts } from "./demo-ports.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, "..");
const FRONTEND_DIR = join(HERE, "..", "..");

const run = (cmd, args, opts = {}) =>
	spawnSync(cmd, args, { stdio: "inherit", ...opts });

const die = (msg, cleanup) => {
	console.error(msg);
	cleanup?.();
	process.exit(1);
};

// 1. Docker must be up — the same clear gate the shell task had.
if (run("docker", ["info"], { stdio: "ignore" }).status !== 0) {
	die("Docker is not running — start Docker Desktop first.");
}

// 2. First-run dependency install (matches the old `[ -d node_modules ]` guard).
if (!existsSync(join(FRONTEND_DIR, "node_modules"))) {
	run("pnpm", ["install"], { cwd: FRONTEND_DIR });
}

// 3. Allocate fresh, distinct, free ports for this run.
const [edgePort, spaPort] = await pickFreePorts(2);
const edgeUrl = `http://localhost:${edgePort}`;
const services = ["origin", "edge"];

// Env consumed by docker-compose interpolation (host port mapping).
const composeEnv = { ...process.env, EDGE_HOST_PORT: String(edgePort) };

console.log(`>> edge      -> ${edgeUrl}  (signed bundle the SPA syncs)`);
console.log(
	`>> app       -> http://localhost:${spaPort}  <- opening this in your browser`,
);

// 4. Bring up the stack; --wait blocks until healthchecks pass so the SPA never
// races a not-ready edge.
if (
	run("docker", ["compose", "up", "-d", "--wait", ...services], {
		cwd: FRONTEND_DIR,
		env: composeEnv,
	}).status !== 0
) {
	die("docker compose failed to start the stack.");
}

// 5. Stop (not down) the containers on exit — keeps the caddy volumes for fast
// restarts, same as the old trap.
let stopped = false;
const cleanup = () => {
	if (stopped) return;
	stopped = true;
	spawnSync("docker", ["compose", "stop", ...services], {
		cwd: FRONTEND_DIR,
		env: composeEnv,
		stdio: "ignore",
	});
};
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		cleanup();
		process.exit(0);
	});
}
process.on("exit", cleanup);

// 6. Preflight: prove the chosen edge serves THIS repo's committed bundle before
// opening the SPA (check-edge.mjs reads VITE_BUNDLE_BASE_URL).
if (
	run("node", [join(APP_DIR, "scripts", "check-edge.mjs")], {
		cwd: FRONTEND_DIR,
		env: { ...process.env, VITE_BUNDLE_BASE_URL: edgeUrl },
	}).status !== 0
) {
	die("Edge preflight failed.", cleanup);
}

// 7. Launch the SPA on the chosen port, wired to the chosen edge.
const viteEnv = { ...process.env, VITE_BUNDLE_BASE_URL: edgeUrl };
const vite = spawn(
	"pnpm",
	["exec", "vite", "--open", "--port", String(spaPort), "--strictPort"],
	{ cwd: APP_DIR, env: viteEnv, stdio: "inherit" },
);
vite.on("exit", (code) => {
	cleanup();
	process.exit(code ?? 0);
});
