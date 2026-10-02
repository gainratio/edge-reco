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
	it("keeps EdgeReco product code separate from @edgeproc/browser", () => {
		expect(manifest.name).toBe("@edgereco/browser");
		expect(manifest.dependencies?.["@edgeproc/browser"]).toBe(
			"github:hseshadr/edgeproc-browser#0749e66b4260ffcd02b1d039eb2eaa26cd970da7",
		);
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

	it("bundles the shared Worker through a consumer-owned one-line entry", () => {
		const engine = join(process.cwd(), "src", "engine");
		const entry = readFileSync(join(engine, "edgeprocWorker.ts"), "utf8");
		const runtime = readFileSync(join(engine, "runtime.ts"), "utf8");

		expect(entry.trim()).toBe('import "@edgeproc/browser/worker";');
		expect(runtime).toContain('from "./edgeprocWorker?worker"');
		expect(runtime).not.toContain("EngineClient.spawn(");
	});
});
