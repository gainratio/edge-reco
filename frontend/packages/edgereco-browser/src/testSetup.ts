import { vi } from "vitest";

// jsdom and Node have no Worker or OPFS. Every spec opens the catalogue through
// the real seam and the real @gainratio/browser client; only the far side of the
// Worker channel runs in-process (nodeSqlWorker.ts), on the same SQLite build.
// The Worker + OPFS path itself is exercised by the production-build Playwright
// lanes. The legacy-pool cleanup needs OPFS, so it is a no-op here and is
// tested directly in catalogueSql.test.ts.
vi.mock("./engine/catalogueSql", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./engine/catalogueSql")>();
	const { nodeSqlWorkerFactory } = await import(
		"./engine/__fixtures__/nodeSqlWorker"
	);
	return {
		...actual,
		openCatalogueSql: vi.fn(() =>
			actual.openCatalogueSql({ workerFactory: nodeSqlWorkerFactory }),
		),
		retireLegacyVectorPool: vi.fn(async () => "absent"),
	};
});
