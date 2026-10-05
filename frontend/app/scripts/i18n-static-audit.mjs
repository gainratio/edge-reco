#!/usr/bin/env node
/**
 * Static i18n coverage gate for the BOOTED storefront — the surface the live
 * verify-i18n.mjs (which drives only the pre-boot Landing) never reaches, so
 * booted-storefront strings that escaped extraction would otherwise pass CI.
 *
 * It fails on bare user-facing copy in the audited components: prose string /
 * template literals and JSX text that are neither a t() call nor an explicitly
 * allow-listed data-tier default. This is the cheaper, more robust half of the
 * i18n gate — no browser, no build, zero deps — so a future hardcoded storefront
 * string trips `pnpm test` in CI.
 *
 * It is a small hand-rolled lexer rather than an AST walk because the repo's
 * TypeScript 7 (native preview) ships no JS compiler API. The lexer masks
 * strings + comments so it can (a) read each string/template literal with its
 * surrounding code context and (b) find raw JSX text between tags.
 *
 * Run directly to print findings:  node scripts/i18n-static-audit.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const COMPONENTS_DIR = join(HERE, "..", "src", "components");

// The booted-storefront chrome this gate owns. The pre-boot chrome
// (Header / Footer / Landing / MetricsStrip / BootScreen) is live-gated by
// verify-i18n.mjs; ProductImage renders decorative category echoes (data, shown
// verbatim like category names), and Toast renders a caller-supplied message.
export const AUDITED = [
	"StorageBadge.tsx",
	"Storefront.tsx",
	"ProductGrid.tsx",
	"ProductCard.tsx",
	"ProductDetail.tsx",
	"InstallButton.tsx",
	"RailStack.tsx",
	"RailRow.tsx",
	"RailCard.tsx",
];

// Intentionally-untranslated prose that survives in audited files: the PDP
// rail-label DEFAULTS. Rail labels are engine strategy DATA (rendered verbatim,
// like category names); these mirror the engine's English only when the synced
// strategy map omits a label. Any NEW prose literal not on this list fails.
export const ALLOWLIST = new Set([
	"Similar items",
	"Because you viewed this",
	"Frequently bought together",
	"Customers who bought this also bought",
]);

/**
 * A string is user-facing "prose" if it carries a real word and a space (a
 * phrase), and isn't a URL/path or purely CSS-class / dotted-key / kebab-ident
 * tokens. className values ("card__action card--active") are all-ident tokens,
 * so they fall out here without needing attribute context. Single-word COPY
 * (e.g. "Retry", "why?") is not "prose" but is instead caught as JSX text —
 * which is always rendered.
 */
export function isProse(text) {
	const value = text.trim();
	if (!/[A-Za-z]{2,}/.test(value)) return false;
	if (!/\s/.test(value)) return false;
	if (/^https?:\/\//.test(value) || value.startsWith("/")) return false;
	const identish = (word) =>
		/^[a-z0-9]+([-_]{1,2}[a-z0-9]+)*$/.test(word) ||
		/^[a-z0-9]+(\.[a-z0-9]+)+$/i.test(word);
	return !value.split(/\s+/).every(identish);
}

// Prose is fine when it is a console.* argument (a dev log, never rendered).
function inConsoleCall(codeBefore) {
	return /console\.[a-zA-Z]+\([^)]*$/.test(codeBefore.slice(-200));
}

/**
 * Lex `source` into: `literals` (each string / template literal with the code
 * text that preceded it) and `masked` (source with every string + comment body
 * blanked to spaces, newlines preserved) so JSX text can be scanned separately.
 */
function lex(source) {
	const literals = [];
	let masked = "";
	let code = ""; // running masked code, used as "context before" a literal
	let i = 0;
	const n = source.length;
	const emit = (ch) => {
		masked += ch;
		code += ch;
	};
	const blank = (ch) => {
		masked += ch === "\n" ? "\n" : " ";
	};
	while (i < n) {
		const c = source[i];
		const c2 = source[i + 1];
		if (c === "/" && c2 === "/") {
			while (i < n && source[i] !== "\n") blank(source[i++]);
			continue;
		}
		if (c === "/" && c2 === "*") {
			blank(" ");
			blank(" ");
			i += 2;
			while (i < n && !(source[i] === "*" && source[i + 1] === "/"))
				blank(source[i++]);
			if (i < n) {
				blank(" ");
				blank(" ");
				i += 2;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			const context = code;
			const index = masked.length;
			let value = "";
			blank(" ");
			i++;
			while (i < n && source[i] !== c) {
				if (source[i] === "\\") {
					value += source[i + 1] ?? "";
					blank(" ");
					blank(" ");
					i += 2;
					continue;
				}
				value += source[i];
				blank(source[i]);
				i++;
			}
			blank(" ");
			i++;
			literals.push({ value, context, index });
			continue;
		}
		if (c === "`") {
			const context = code;
			const index = masked.length;
			let value = "";
			blank(" ");
			i++;
			while (i < n && source[i] !== "`") {
				if (source[i] === "\\") {
					value += source[i + 1] ?? "";
					blank(" ");
					blank(" ");
					i += 2;
					continue;
				}
				if (source[i] === "$" && source[i + 1] === "{") {
					// Interpolation: the ${…} is code, not literal text. Keep it in the
					// masked stream so JSX scanning sees the braces (and skips it).
					emit(" ");
					emit(" ");
					i += 2;
					let depth = 1;
					while (i < n && depth > 0) {
						const e = source[i];
						if (e === "{") depth++;
						else if (e === "}") depth--;
						if (depth === 0) emit(" ");
						else emit(e);
						i++;
					}
					continue;
				}
				value += source[i];
				blank(source[i]);
				i++;
			}
			blank(" ");
			i++;
			literals.push({ value, context, index });
			continue;
		}
		emit(c);
		i++;
	}
	return { literals, masked };
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Findings for one source file: `[{ line, text }]` for each bare copy string. */
export function auditSource(_filename, source) {
	const out = [];
	const seen = new Set();
	const { literals, masked } = lex(source);
	const add = (value, index) => {
		const text = value.trim();
		if (ALLOWLIST.has(text)) return;
		const line = lineOf(masked, index);
		const key = `${line}:${text}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ line, text: text.slice(0, 70) });
	};

	// (1) Prose string / template literals that aren't dev-only console logs.
	for (const { value, context, index } of literals) {
		if (isProse(value) && !inConsoleCall(context)) add(value, index);
	}

	// (2) Raw JSX text between tags: rendered copy that never went through t().
	//     Text with code punctuation ({ } ( ) = ; <) is JS, not copy — skipped;
	//     the `(?<!=)` drops the `>` of an arrow `=>` (e.g. `() => Promise<T>`).
	const jsxText = /(?<!=)>([^<>]*)</g;
	for (const match of masked.matchAll(jsxText)) {
		const segment = match[1];
		if (/[A-Za-z]{2,}/.test(segment) && !/[{}()=;]/.test(segment)) {
			add(segment, (match.index ?? 0) + 1);
		}
	}
	return out;
}

/** Audit every file in `AUDITED`, returning `{ file: findings }` for non-empty. */
export function auditAll(dir = COMPONENTS_DIR) {
	const report = {};
	for (const file of AUDITED) {
		const findings = auditSource(file, readFileSync(join(dir, file), "utf8"));
		if (findings.length) report[file] = findings;
	}
	return report;
}

// CLI: print findings and exit non-zero if any audited component has bare copy.
if (import.meta.url === `file://${process.argv[1]}`) {
	const report = auditAll();
	const files = Object.keys(report);
	if (files.length === 0) {
		console.log(
			`✅ i18n static audit PASSED — no bare copy in ${AUDITED.length} booted-storefront components`,
		);
		process.exit(0);
	}
	for (const file of files) {
		console.error(`❌ ${file}`);
		for (const { line, text } of report[file]) {
			console.error(`   L${line}: ${JSON.stringify(text)}`);
		}
	}
	console.error(
		"\ni18n static audit FAILED — extract the strings above via t()",
	);
	process.exit(1);
}
