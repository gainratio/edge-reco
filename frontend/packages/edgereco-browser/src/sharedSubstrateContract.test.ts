/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
	readonly name?: string;
	readonly dependencies?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(
	readFileSync(`${process.cwd()}/package.json`, "utf8"),
) as PackageManifest;

describe("shared browser substrate dependency", () => {
	it("keeps EdgeReco product code separate from @gainratio/browser", () => {
		expect(manifest.name).toBe("@edgereco/browser");
		// From npm with a caret range (tracks the latest release, no upper cap),
		// never a git-sha alias or the old @edgeproc scope.
		expect(manifest.dependencies?.["@gainratio/browser"]).toMatch(
			/^\^\d+\.\d+\.\d+$/u,
		);
		expect(manifest.dependencies?.["@edgeproc/browser"]).toBeUndefined();
	});

	it("takes Assay and Avow from the renamed @gainratio scope", () => {
		// @edgeproc/assay and @edgeproc/avow are frozen at their last release
		// (0.5.0-dev.3 / 0.5.1); new releases ship only as @gainratio/*.
		expect(manifest.dependencies?.["@gainratio/assay"]).toBe("0.5.0-dev.6");
		expect(manifest.dependencies?.["@gainratio/avow"]).toBe("^0.5.2");
		expect(manifest.dependencies?.["@edgeproc/assay"]).toBeUndefined();
		expect(manifest.dependencies?.["@edgeproc/avow"]).toBeUndefined();
	});

	it("does not vendor generic sync, storage, crypto, or Worker modules", () => {
		const engine = join(process.cwd(), "src", "engine");
		for (const filename of [
			"canonical.ts",
			"client.ts",
			"crypto.ts",
			"fetchBytes.ts",
			"integrity.ts",
			"memoryStore.ts",
			"networkSentinel.ts",
			"opfsStore.ts",
			"protocol.ts",
			"sync.ts",
			"worker.ts",
			"workerFault.ts",
			"zstd.ts",
		]) {
			expect(existsSync(join(engine, filename)), filename).toBe(false);
		}
	});

	it("bundles the shared Worker as this app's own chunk, through the seam", () => {
		const src = join(process.cwd(), "src");
		const seam = readFileSync(join(src, "gainratio.ts"), "utf8");
		const runtime = readFileSync(join(src, "engine", "runtime.ts"), "utf8");

		expect(seam).toContain(
			'export { default as EngineWorker } from "@gainratio/browser/worker?worker";',
		);
		expect(runtime).toContain("new EngineClient(new EngineWorker())");
		expect(runtime).not.toContain("EngineClient.spawn(");
	});
});
