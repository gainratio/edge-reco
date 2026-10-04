#!/usr/bin/env node
/**
 * Node-version preflight for the canonical gate.
 *
 * WHY THIS EXISTS
 *
 * This repo carried TWO Node pins that disagreed, in the worst possible
 * direction: `.nvmrc` said 24, legacy quality workflows hardcoded 24, and
 * `deploy.yml` read `.node-version` — so
 * legacy CI tested on Node 24 while the artifact shipped to edge-reco.com was BUILT on
 * Node 22. The deployed build ran on a runtime nothing tested against, and the
 * local gate enforced neither.
 *
 * That is not a cosmetic difference. In a sibling repo this exact class of skew
 * reported three permanently-broken tests as green for an entire session: Node
 * 22's WebCrypto REJECTS the cross-realm bare `ArrayBuffer` passed through the
 * shared @gainratio/browser verifier, and Node 24 ACCEPTS it. Same commit, same
 * lockfile — the runtime alone flipped the result. The signed-bundle tests
 * exercise that dependency path.
 *
 * So this FAILS rather than warns. A warning is precisely what got ignored: it
 * scrolls past above several minutes of subsequent output and the gate still
 * exits 0, which is the only signal anyone reads.
 *
 * WHY EXACT MATCH, NOT `>=`
 *
 * A floor structurally cannot catch this. `engines.node: ">=22.12"` is already
 * satisfied by 24.16.0 — the bug WAS a behavioural change in a later major, so
 * any range that admits both runtimes admits the bug. `.nvmrc` pins one exact
 * build and both Dagger and deploy install exactly that build, so runtime identity
 * is the only property worth asserting. Bumping Node is a deliberate act: edit
 * `frontend/.nvmrc`, and local, Dagger, and the deploy build move together.
 *
 * WHY .nvmrc IS THE ONLY PIN
 *
 * `.node-version` was deleted rather than kept in sync. Two files that must
 * agree are two files that can disagree; this one already had. Every consumer
 * now reads `frontend/.nvmrc`: `nvm use`, Dagger, deploy, and this script.
 */
import { readFileSync } from "node:fs";

/** The single source of truth — the same file `actions/setup-node` reads. */
export const NVMRC = new URL("../../.nvmrc", import.meta.url);

const normalize = (version) => version.trim().replace(/^v/, "");

/**
 * Compare the running Node against the pinned one.
 *
 * @param {string} activeVersion `process.version`, e.g. "v24.16.0".
 * @param {string} nvmrcSource Raw `.nvmrc` contents.
 * @returns {{ ok: boolean, message: string }}
 */
export function nodeVersionVerdict(activeVersion, nvmrcSource) {
	const pinned = normalize(nvmrcSource);
	const active = normalize(activeVersion);

	if (pinned === "") {
		return {
			ok: false,
			message:
				"Node preflight: frontend/.nvmrc is empty, so the gate cannot prove it is running the version Dagger uses. Pin an exact version (e.g. 24.16.0).",
		};
	}

	if (active === pinned) {
		return {
			ok: true,
			message: `Node preflight: ${active} matches frontend/.nvmrc — same runtime as Dagger and as the deployed build.`,
		};
	}

	return {
		ok: false,
		message: [
			`Node preflight FAILED: this shell runs Node ${active}, but frontend/.nvmrc pins ${pinned}.`,
			"",
			`Dagger and the production deploy (deploy.yml) both install ${pinned}`,
			`from frontend/.nvmrc, so a gate run on ${active} proves nothing about either.`,
			"That skew is exactly how three permanently-broken tests were reported green in a sibling repo.",
			"",
			"Fix it:",
			`  nvm install ${pinned} && nvm use ${pinned}   # from frontend/, 'nvm use' alone reads .nvmrc`,
			"",
			"Intentionally moving the project to a new Node? Edit frontend/.nvmrc — it is the ONLY pin,",
			"and local, Dagger, and the deployed build all follow it together.",
		].join("\n"),
	};
}

function main() {
	const verdict = nodeVersionVerdict(
		process.version,
		readFileSync(NVMRC, "utf8"),
	);
	if (!verdict.ok) {
		console.error(verdict.message);
		process.exit(1);
	}
	console.log(verdict.message);
}

// Only run as a CLI, never when imported by the test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main();
}
