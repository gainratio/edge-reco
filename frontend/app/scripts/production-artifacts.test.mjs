import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = process.env.PRODUCTION_ARTIFACT_DIR
	? resolve(APP_DIR, process.env.PRODUCTION_ARTIFACT_DIR)
	: undefined;

const ROUTES = [
	{ path: "/", file: "index.html" },
	{ path: "/edgeproc", file: "edgeproc.html" },
	{ path: "/github", file: "github.html" },
	{ path: "/faq", file: "faq.html" },
];

const SOCIAL_ROUTES = ROUTES.filter(({ path }) => path !== "/");

// /github is the only page whose job is to hand crawlers a path to every
// repository. Google had zero pages indexed for five of these eight because
// nothing on the open web linked to them — a sitemap alone does not carry
// authority, an <a href> does. Pin the full set so a future edit cannot quietly
// drop one back into invisibility.
const PUBLIC_REPOS = [
	"edge-reco",
	"edge-proc",
	"edgeproc-core",
	"aml-filter",
	"privacy-core",
	"assay",
	"almamesh",
	"ci",
];
/** gainratio is canonical for every public repo, `ci` included. */
const ORG = "https://github.com/gainratio";
const MAINTAINER = "https://github.com/hseshadr";
const repoUrl = (repo) => `${ORG}/${repo}`;

// The three live sites are separate domains with no inbound links between them.
// Every page must reach the other two, or each stays an island.
const SIBLING_SITES = ["https://aml-filter.com/", "https://almamesh.com/"];

// A Set, deliberately: these assertions must match a whole href, never a
// substring of one. `"…/hseshadr".includes()`-style checks pass for
// `https://evil.example/?q=https://github.com/hseshadr`, and CodeQL is right to
// flag that shape even inside a test.
function hrefs(document) {
	return new Set(
		[...document.querySelectorAll("a[href]")].map((a) =>
			a.getAttribute("href"),
		),
	);
}
const AI_CRAWLERS = [
	"GPTBot",
	"OAI-SearchBot",
	"ChatGPT-User",
	"ClaudeBot",
	"Claude-Web",
	"anthropic-ai",
	"PerplexityBot",
	"Google-Extended",
	"CCBot",
	"Bytespider",
];

function artifactPath(file) {
	if (DIST_DIR !== undefined) {
		return join(DIST_DIR, file);
	}
	return file === "index.html"
		? join(APP_DIR, file)
		: join(APP_DIR, "public", file);
}

async function artifact(file) {
	return readFile(artifactPath(file), "utf8");
}

async function htmlDocument(file) {
	return new JSDOM(await artifact(file)).window.document;
}

function content(document, selector) {
	const value = document
		.querySelector(selector)
		?.getAttribute("content")
		?.trim();
	assert.ok(value, `missing content for ${selector}`);
	return value;
}

function wordCount(document) {
	const body = document.body.cloneNode(true);
	for (const element of body.querySelectorAll("script, style")) {
		element.remove();
	}
	return body.textContent.trim().split(/\s+/u).filter(Boolean).length;
}

function crawlText(document) {
	return document.body.textContent.replace(/\s+/gu, " ").trim();
}

function cspHash(script) {
	const digest = createHash("sha256")
		.update(script.textContent ?? "")
		.digest("base64");
	return `'sha256-${digest}'`;
}

test("root exposes substantive crawlable product content", async () => {
	const document = await htmlDocument("index.html");
	const text = crawlText(document);
	assert.ok(
		wordCount(document) >= 150,
		"root HTML must expose at least 150 crawlable words before JavaScript runs",
	);
	assert.match(text, /signed catalog bundle/i);
	assert.match(text, /BM25/i);
	assert.match(text, /Reciprocal Rank Fusion/i);
});

test("production artifact exposes a verifiable source identity", async (t) => {
	if (DIST_DIR === undefined) {
		t.skip("build identity exists only in the generated production dist");
		return;
	}
	const identity = JSON.parse(await artifact("build.json"));
	assert.match(identity.commit, /^[0-9a-f]{40}$/u);
	assert.match(identity.version, /^\d+\.\d+\.\d+$/u);
	assert.match(identity.buildTime, /^\d{4}-\d{2}-\d{2}T[^\s]+Z$/u);
	assert.equal(identity.bundleId, "amazon-demo");
	assert.equal(identity.bundleVersion, "v1");
	assert.match(identity.bundleManifestHash, /^[0-9a-f]{64}$/u);
	assert.equal(identity.channel, "stable");
});

test("production artifact carries the canonical-host Pages worker", async (t) => {
	if (DIST_DIR === undefined) {
		t.skip(
			"the advanced-mode worker exists only in the generated production dist",
		);
		return;
	}
	const worker = await artifact("_worker.js");
	assert.match(worker, /www\.edge-reco\.com/u);
	assert.match(worker, /Response\.redirect\(url\.toString\(\), 308\)/u);
	assert.match(worker, /env\.ASSETS\.fetch\(request\)/u);
});

test("root and EdgeProc snippets stay within search-result limits", async () => {
	for (const file of ["index.html", "edgeproc.html"]) {
		const document = await htmlDocument(file);
		const title = document.querySelector("title")?.textContent.trim() ?? "";
		const description = content(document, 'meta[name="description"]');
		assert.ok(
			title.length >= 30 && title.length <= 60,
			`${file} title is ${title.length} chars`,
		);
		assert.ok(
			description.length >= 120 && description.length <= 160,
			`${file} description is ${description.length} chars`,
		);
	}
});

test("every supporting route has complete Open Graph and Twitter metadata", async () => {
	for (const { path, file } of SOCIAL_ROUTES) {
		const document = await htmlDocument(file);
		const canonical = document
			.querySelector('link[rel="canonical"]')
			?.getAttribute("href");
		assert.equal(canonical, `https://edge-reco.com${path}`);

		for (const property of [
			"og:type",
			"og:site_name",
			"og:title",
			"og:description",
			"og:url",
			"og:image",
			"og:image:width",
			"og:image:height",
			"og:image:alt",
		]) {
			content(document, `meta[property="${property}"]`);
		}

		for (const name of [
			"twitter:card",
			"twitter:title",
			"twitter:description",
			"twitter:image",
			"twitter:image:alt",
		]) {
			content(document, `meta[name="${name}"]`);
		}
		assert.equal(content(document, 'meta[property="og:url"]'), canonical);
		assert.equal(
			content(document, 'meta[name="twitter:card"]'),
			"summary_large_image",
		);
	}
});

test("sitemap lists every canonical route with an ISO lastmod date", async () => {
	const document = new JSDOM(await artifact("sitemap.xml"), {
		contentType: "text/xml",
	}).window.document;
	const entries = [...document.querySelectorAll("url")].map((entry) => ({
		loc: entry.querySelector("loc")?.textContent,
		lastmod: entry.querySelector("lastmod")?.textContent,
	}));
	assert.deepEqual(
		entries.map(({ loc }) => loc),
		ROUTES.map(({ path }) => `https://edge-reco.com${path}`),
	);
	for (const { lastmod } of entries) {
		assert.match(lastmod ?? "", /^\d{4}-\d{2}-\d{2}$/u);
		assert.ok(!Number.isNaN(Date.parse(lastmod ?? "")));
	}
});

test("/github links every public repository with real describing copy", async () => {
	const document = await htmlDocument("github.html");
	const links = hrefs(document);
	for (const repo of PUBLIC_REPOS) {
		const url = repoUrl(repo);
		assert.ok(links.has(url), `/github is missing a link to ${repo}`);
	}
	assert.ok(
		links.has(MAINTAINER),
		"/github is missing the maintainer profile link",
	);

	// A bare link is weak; the anchor's surrounding copy is what a crawler
	// weighs. Every repo's list item must carry a sentence, not just a URL.
	for (const repo of PUBLIC_REPOS) {
		const anchor = [...document.querySelectorAll("ul.repos a")].find(
			(a) => a.getAttribute("href") === repoUrl(repo),
		);
		assert.ok(anchor, `${repo} is not listed in a repository list`);
		const copy = anchor.closest("li").textContent.replace(/\s+/gu, " ").trim();
		assert.ok(
			copy.split(" ").length >= 20,
			`${repo} has only ${copy.split(" ").length} words of describing copy`,
		);
	}
});

test("every crawlable page links out to the sibling sites and the org", async () => {
	for (const { file } of ROUTES) {
		const links = hrefs(await htmlDocument(file));
		for (const site of SIBLING_SITES) {
			assert.ok(links.has(site), `${file} does not link to ${site}`);
		}
		assert.ok(
			links.has(ORG),
			`${file} does not link to the gainratio GitHub org`,
		);
	}
});

test("llms.txt lists every repository and every live site", async () => {
	const llms = await artifact("llms.txt");
	for (const repo of PUBLIC_REPOS) {
		assert.ok(llms.includes(repoUrl(repo)), `llms.txt missing ${repo}`);
	}
	for (const site of SIBLING_SITES) {
		assert.ok(llms.includes(site), `llms.txt missing ${site}`);
	}
});

test("unknown routes use a noindex 404 instead of the SPA shell", async () => {
	const document = await htmlDocument("404.html");
	assert.match(content(document, 'meta[name="robots"]'), /noindex/i);
	assert.match(
		document.querySelector("title")?.textContent ?? "",
		/not found/i,
	);
	assert.ok(document.querySelector('a[href="/"]'));

	const redirects = await artifact("_redirects");
	assert.doesNotMatch(redirects, /\/index\.html\s+200/u);
	assert.doesNotMatch(redirects, /^\/\*\s+/mu);
});

test("delivery headers enforce transport and a resource-aware CSP", async () => {
	const headers = await artifact("_headers");
	assert.match(headers, /\/build\.json\s+Cache-Control:\s*no-store/iu);
	assert.match(
		headers,
		/Strict-Transport-Security:\s*max-age=(?:31536000|\d{9,})/iu,
	);
	assert.match(headers, /^\s*! Access-Control-Allow-Origin\s*$/mu);

	const csp = headers
		.split("\n")
		.find((line) => line.trim().startsWith("Content-Security-Policy:"));
	assert.ok(csp, "missing Content-Security-Policy header");
	for (const directive of [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'self'",
		"form-action 'self'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"worker-src 'self' blob:",
		"connect-src 'self'",
	]) {
		assert.ok(csp.includes(directive), `CSP missing ${directive}`);
	}
	assert.ok(!csp.includes("script-src *"));
	assert.ok(!csp.includes("'unsafe-eval'"));

	for (const { file } of ROUTES) {
		const document = await htmlDocument(file);
		for (const script of document.querySelectorAll("script:not([src])")) {
			assert.ok(
				csp.includes(cspHash(script)),
				`${file} inline script is not CSP-hashed`,
			);
		}
	}
});

test("delivery headers pin the trust root and immutable release assets", async () => {
	const headers = await artifact("_headers");
	assert.match(
		headers,
		/\/public\.key\s+Content-Type:\s*application\/octet-stream\s+Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/iu,
	);
	for (const path of [
		"/bundle/chunk/*",
		"/bundle/manifest/*",
		"/assets/*",
		"/models/*",
		"/ort/*",
	]) {
		const block = headers.slice(headers.indexOf(path));
		assert.ok(block.startsWith(path), `missing header block for ${path}`);
		assert.match(
			block.split(/\n(?=\/)/u, 1)[0] ?? "",
			/Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/iu,
		);
	}
});

test("the app shell has no third-party font dependency", async () => {
	const document = await htmlDocument("index.html");
	const externalFonts = [...document.querySelectorAll("link[href]")]
		.map((link) => link.getAttribute("href") ?? "")
		.filter((href) => /fonts\.(?:googleapis|gstatic)\.com/u.test(href));
	assert.deepEqual(externalFonts, []);

	const headers = await artifact("_headers");
	assert.doesNotMatch(headers, /fonts\.(?:googleapis|gstatic)\.com/u);
	assert.doesNotMatch(headers, /media-amazon\.com/u);

	const serviceWorkerConfig = await readFile(
		join(APP_DIR, "vite.config.ts"),
		"utf8",
	);
	assert.doesNotMatch(
		serviceWorkerConfig,
		/"(?:huggingface\.co|hf\.co|cdn\.jsdelivr\.net)"/u,
	);
});

test("robots.txt and llms.txt keep AI crawlers and canonical sources accessible", async () => {
	const robots = await artifact("robots.txt");
	for (const crawler of AI_CRAWLERS) {
		assert.match(robots, new RegExp(`User-agent: ${crawler}\\s+Allow: /`, "u"));
	}
	assert.match(robots, /Sitemap: https:\/\/edge-reco\.com\/sitemap\.xml/u);

	const llms = await artifact("llms.txt");
	for (const url of [
		"https://edge-reco.com/",
		"https://edge-reco.com/edgeproc",
		"https://edge-reco.com/faq",
		"https://github.com/gainratio/edge-reco",
		"https://github.com/gainratio/edge-proc",
	]) {
		assert.ok(llms.includes(url), `llms.txt missing ${url}`);
	}
});
