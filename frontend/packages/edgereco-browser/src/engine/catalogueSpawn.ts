// Production wiring: one catalogue Worker per open, behind the per-tab OPFS
// ownership lease (vectorStoreOwnership.ts). Unit tests replace this module with
// an in-process store on the same SQLite build (testSetup.ts).

import { CatalogueClient, type CatalogueStoreFactory } from "./catalogueClient";
import CatalogueWorker from "./catalogueWorker?worker";
import { tabSafeVectorIndexFactory } from "./vectorStoreOwnership";

/** One factory per page, so the owner lease lives exactly as long as the tab. */
export const openCatalogueStore: CatalogueStoreFactory =
	tabSafeVectorIndexFactory({
		locks: globalThis.navigator?.locks,
		open: ({ dimension, persistence }) =>
			CatalogueClient.open(new CatalogueWorker(), dimension, persistence),
	});
