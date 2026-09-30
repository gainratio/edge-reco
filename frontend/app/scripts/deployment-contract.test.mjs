import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "../../..");
const DAGGER = resolve(ROOT, ".dagger/src/edge_reco/main.py");
const WRANGLER_RELEASE = resolve(import.meta.dirname, "wrangler-release.sh");
const WORKFLOW = resolve(ROOT, ".github/workflows/deploy.yml");
const FRONTEND_PACKAGE = resolve(import.meta.dirname, "../../package.json");
const DAGGER_SCRIPT_DIRS = [
	resolve(ROOT, ".dagger/src/edge_reco"),
	resolve(ROOT, ".dagger/scripts"),
	resolve(ROOT, "backend/scripts"),
	resolve(ROOT, "frontend/app/scripts"),
];

async function productionScripts(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	return entries
		.filter(
			({ name }) => /\.(?:mjs|py|sh)$/u.test(name) && !name.includes(".test."),
		)
		.map(({ name }) => resolve(directory, name));
}

function assertDeployPermissions(workflow) {
	assert.match(
		workflow,
		/permissions:\n {2}contents: read\n {2}actions: read\n {2}checks: read/u,
	);
}

test("Dagger delegates Pages delivery while retaining local live verification", async () => {
	const dagger = await readFile(DAGGER, "utf8");
	const wrangler = await readFile(WRANGLER_RELEASE, "utf8");
	assert.match(dagger, /dag\.cloudflare_pages\(\)/u);
	assert.match(dagger, /playwright\.live\.config\.ts/u);
	assert.match(dagger, /deployment_url/u);
	assert.doesNotMatch(dagger, /async def _disable_git_deployments/u);
	assert.doesNotMatch(dagger, /async def _deploy_artifact/u);
	assert.doesNotMatch(wrangler, /pages deploy \/artifact/u);
});

test("Dagger installs jq before running deployment contracts", async () => {
	const dagger = await readFile(DAGGER, "utf8");
	const quality = dagger.slice(
		dagger.indexOf("def _frontend_quality"),
		dagger.indexOf("def _browser_e2e"),
	);
	assert.match(quality, /apt-get[^\n]*install[^\n]*jq/u);
});

test("every retained production script uses an existing or unique scratch path", async () => {
	const paths = (
		await Promise.all(DAGGER_SCRIPT_DIRS.map(productionScripts))
	).flat();
	const scripts = await Promise.all(
		paths.map((path) => readFile(path, "utf8")),
	);
	for (const script of scripts) assert.doesNotMatch(script, /\/work(?:\/|\b)/u);
});

test("deploy workflow is only a pinned checkout and Dagger invocation", async () => {
	const workflow = await readFile(WORKFLOW, "utf8");
	assert.doesNotMatch(workflow, /^\s+run:/mu);
	assertDeployPermissions(workflow);
	assert.doesNotMatch(
		workflow,
		/\b(?:id-token|packages|deployments): write\b/u,
	);
	assert.match(workflow, /workflow_run\.event == 'push'/u);
	assert.match(workflow, /workflow_run\.conclusion == 'success'/u);
	assert.match(workflow, /workflow_run\.head_branch == 'main'/u);
	assert.match(
		workflow,
		/workflow_run\.head_repository\.full_name == github\.repository/u,
	);
	assert.match(workflow, /persist-credentials: false/u);
	assert.match(
		workflow,
		/ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u,
	);
	assert.match(workflow, /dagger\/dagger-for-github@[0-9a-f]{40}/u);
	assert.match(workflow, /environment: production/u);
	// Inverted contract (was: the call must contain `--commit-sha=${{ github.event.
	// workflow_run.head_sha }}` and friends, which pasted event text into
	// dagger-for-github's bash). Event values now arrive only through `env:` and the
	// call references them as double-quoted shell variables.
	assert.match(
		workflow,
		/HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u,
	);
	assert.match(
		workflow,
		/RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/u,
	);
	assert.match(
		workflow,
		/RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \}\}/u,
	);
	assert.match(workflow, /--commit-sha="\$HEAD_SHA"/u);
	assert.match(workflow, /--workflow-run-id="\$RUN_ID"/u);
	assert.match(workflow, /--run-attempt="\$RUN_ATTEMPT"/u);
	assert.doesNotMatch(workflow, /--[a-z-]+=\$\{\{/u);
	assert.match(workflow, /cloudflare-api-token=env:CLOUDFLARE_API_TOKEN/u);
	assert.match(workflow, /cloudflare-account-id=env:CLOUDFLARE_ACCOUNT_ID/u);
	assert.match(workflow, /github-token=env:GITHUB_TOKEN/u);
	assert.doesNotMatch(workflow, /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID): [^$]/u);
	assert.doesNotMatch(workflow, /workflow_dispatch:/u);
});

test("deploy permissions fail closed without protected-check visibility", async () => {
	const workflow = await readFile(WORKFLOW, "utf8");
	const insufficient = workflow.replace("  checks: read\n", "");
	assert.throws(() => assertDeployPermissions(insufficient));
});

test("Wrangler is an exact repository dependency", async () => {
	const packageJson = JSON.parse(await readFile(FRONTEND_PACKAGE, "utf8"));
	assert.match(packageJson.devDependencies.wrangler, /^\d+\.\d+\.\d+$/u);
});

test("the release preflight checks Wrangler against the package.json pin, not a copy", async () => {
	const wrangler = await readFile(WRANGLER_RELEASE, "utf8");
	assert.match(wrangler, /devDependencies\.wrangler/u);
	assert.match(wrangler, /grep -Fx "\$expected"/u);
	assert.doesNotMatch(wrangler, /grep -Fx '\d+\.\d+\.\d+'/u);
});

test("the quality gate builds and validates the Pages artifact", async () => {
	const packageJson = JSON.parse(await readFile(FRONTEND_PACKAGE, "utf8"));
	assert.match(packageJson.scripts["gate:quality"], /build:pages/u);
	assert.match(packageJson.scripts["gate:quality"], /test:artifacts/u);
});
