// Vitest setup: register jest-dom matchers (toBeInTheDocument, etc.) for the
// component specs that render via @testing-library/react under jsdom.
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
// Initialize i18next once (synchronous, bundled catalogs) so components rendered
// WITHOUT an <I18nextProvider> — as the component specs do — still resolve real
// copy via useTranslation() instead of raw keys.
import "./i18n";

// jsdom has no Worker/OPFS. Unit tests open the catalogue through the real
// seam and @edgeproc/browser client, with the library's Worker handler run
// in-process on the same SQLite build; the production-build Playwright suite
// owns the real SQLite WASM + Worker + OPFS proof.
vi.mock(
	"../../packages/edgereco-browser/src/engine/catalogueSql",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../packages/edgereco-browser/src/engine/catalogueSql")
			>();
		const { nodeSqlWorkerFactory } = await import(
			"@edgereco/browser/testing/catalogue"
		);
		return {
			...actual,
			openCatalogueSql: vi.fn(() =>
				actual.openCatalogueSql({ workerFactory: nodeSqlWorkerFactory }),
			),
			retireLegacyVectorPool: vi.fn(async () => "absent"),
		};
	},
);
