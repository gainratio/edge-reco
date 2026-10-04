// Vitest setup: register jest-dom matchers (toBeInTheDocument, etc.) for the
// component specs that render via @testing-library/react under jsdom.
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
// Initialize i18next once (synchronous, bundled catalogs) so components rendered
// WITHOUT an <I18nextProvider> — as the component specs do — still resolve real
// copy via useTranslation() instead of raw keys.
import "./i18n";

// jsdom has no Worker/OPFS. Unit tests run the catalogue's real SQL on the same
// SQLite build in-process; the production-build Playwright suite owns the real
// SQLite WASM + Worker + OPFS proof.
vi.mock(
	"../../packages/edgereco-browser/src/engine/catalogueSpawn",
	async () => {
		const { openNodeCatalogueStore } = await import(
			"@edgereco/browser/testing/catalogue"
		);
		return { openCatalogueStore: vi.fn(openNodeCatalogueStore) };
	},
);
