import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { MODEL_FILES, MODEL_ID } from "../../scripts/download-model.mjs";

const CARD = "main article.card button.card__overlay";
const BASE_URL = process.env.LIVE_BASE_URL ?? "https://edge-reco.com";
const ORIGIN = new URL(BASE_URL).origin;
const EXPECTED_SHA = process.env.EXPECTED_SHA ?? "";
const sourceLatest = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../backend/examples/catalog/latest",
);

async function fetchJson(url: string) {
	const response = await fetch(url, { cache: "no-store" });
	if (!response.ok) throw new Error(`${url} returned ${response.status}`);
	return response.json();
}

async function verifyRelease() {
	if (!/^[0-9a-f]{40}$/u.test(EXPECTED_SHA))
		throw new Error("invalid release SHA");
	const identity = await fetchJson(`${BASE_URL}/build.json`);
	if (identity.commit !== EXPECTED_SHA)
		throw new Error("live source identity drifted");
	const committed = JSON.parse(await readFile(sourceLatest, "utf8"));
	const bundle = await fetchJson(`${BASE_URL}/bundle/latest`);
	if (JSON.stringify(bundle) !== JSON.stringify(committed))
		throw new Error("live signed bundle drifted");
	if (identity.bundleManifestHash !== bundle.manifest_hash)
		throw new Error("bundle identity drifted");
}

async function verifyModels() {
	for (const file of MODEL_FILES) {
		const response = await fetch(`${BASE_URL}/models/${MODEL_ID}/${file.path}`);
		if (!response.ok) throw new Error(`live model missing: ${file.path}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
			throw new Error(`live model hash mismatch: ${file.path}`);
	}
}

async function verifyRedirect() {
	const path = "/faq?source=deploy-check";
	const response = await fetch(`https://www.edge-reco.com${path}`, {
		redirect: "manual",
	});
	if (![301, 308].includes(response.status))
		throw new Error("canonical redirect status drifted");
	if (response.headers.get("location") !== `${BASE_URL}${path}`)
		throw new Error("canonical redirect target drifted");
}

function backendCalls(page: import("@playwright/test").Page) {
	return page
		.locator(".metrics-strip__tile")
		.filter({ hasText: "backend calls" })
		.locator(".metrics-strip__value");
}

// Dagger `deploy` runs both tags right after upload; a red run rolls production
// back to the deployment that was live before. The rollback's recovery smoke and
// the scheduled `live-probe` workflow run only `@fresh`, because the deployment
// they check is not the one this checkout's EXPECTED_SHA describes.
test("production serves the exact signed release", {
	tag: "@release",
}, async () => {
	await verifyRelease();
	await verifyModels();
	await verifyRedirect();
});

test("fresh visitor completes the backend-free signed storefront journey", {
	tag: "@fresh",
}, async ({ context, page }) => {
	const foreign: string[] = [];
	const errors: string[] = [];
	await context.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin === ORIGIN || ["blob:", "data:"].includes(url.protocol)) {
			return route.continue();
		}
		foreign.push(url.href);
		return route.abort();
	});
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});

	await page.goto("/");
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();
	await expect(page.locator(CARD).first()).toBeVisible();
	await page.getByRole("searchbox", { name: "Search products" }).fill("shirt");
	await expect(page.locator(CARD).first()).toBeVisible();
	await page.locator(CARD).first().click();
	await expect(page.locator(".pdp__title")).toBeVisible();
	await expect(
		page.locator("section.rail--row:has(h2:text-is('Similar items'))"),
	).toBeVisible();
	await page.locator("button.pdp__back").click();
	await expect(backendCalls(page)).toHaveText("0");
	expect(foreign, "production attempted network egress").toEqual([]);
	expect(errors, "production emitted browser errors").toEqual([]);
});
