import { vi } from "vitest";
import { openNodeCatalogueStore } from "./engine/__fixtures__/nodeCatalogue";

// jsdom and Node have no Worker or OPFS. Product tests run the catalogue's real
// SQL on the same SQLite build in-process; the Worker + OPFS path itself is
// exercised by the production-build Playwright lanes.
vi.mock("./engine/catalogueSpawn", () => ({
	openCatalogueStore: vi.fn(openNodeCatalogueStore),
}));
