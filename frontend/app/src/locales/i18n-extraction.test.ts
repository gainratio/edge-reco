import { describe, expect, it } from "vitest";
import i18n from "../i18n";

// Byte-identical extraction guard. Every string moved out of a storefront
// component into the catalog MUST resolve — via t() with its real interpolation
// vars — to the EXACT English it replaced. This is the regression net for the
// i18n retrofit of the booted storefront: if a future edit changes the rendered
// English, this fails alongside the component specs that pin the same copy.
const t = i18n.getFixedT("en", "storefront");

describe("storefront i18n extraction — byte-identical English", () => {
	it("StorageBadge chrome resolves verbatim", () => {
		expect(t("storageBadge.durable")).toBe(
			"Running fully on-device · your activity is saved only in this browser",
		);
		expect(t("storageBadge.memory")).toBe(
			"Running fully on-device · this tab can’t save your activity, so it resets on reload",
		);
	});

	it("error banner + install chrome resolves verbatim", () => {
		expect(t("banner.title")).toBe("Couldn’t reach the engine");
		expect(t("banner.retry")).toBe("Retry");
		expect(t("banner.unexpectedError")).toBe("Unexpected error");
		expect(t("install.cta")).toBe("Install app");
	});

	it("grid chrome resolves verbatim (incl. pluralized count)", () => {
		expect(t("grid.kickerCatalog")).toBe("Catalog");
		expect(t("grid.titleSearch")).toBe("Search results");
		expect(t("grid.titleBrowse")).toBe("Browse");
		expect(t("grid.empty")).toBe(
			"Nothing here yet. Try another search or category.",
		);
		expect(t("grid.count", { count: 1 })).toBe("1 item");
		expect(t("grid.count", { count: 2 })).toBe("2 items");
		expect(t("grid.count", { count: 0 })).toBe("0 items");
	});

	it("product card chrome + aria-labels resolve verbatim (with title interp)", () => {
		expect(t("card.addToTaste")).toBe("Add to taste →");
		expect(t("card.addToTasteAria", { title: "Walnut Desk Organizer" })).toBe(
			"Add “Walnut Desk Organizer” to your taste",
		);
		expect(t("card.favoriteAria", { title: "Mug" })).toBe("Favorite “Mug”");
		expect(t("card.unfavoriteAria", { title: "Mug" })).toBe("Unfavorite “Mug”");
		expect(t("card.addToCartAria", { title: "Grid Gadget" })).toBe(
			"Add “Grid Gadget” to cart",
		);
	});

	it("pdp + rail chrome resolves verbatim", () => {
		expect(t("pdp.back")).toBe("← Back to browse");
		expect(t("rail.personalizing")).toBe("personalizing…");
		expect(t("rail.taglineForYou")).toBe("live re-ranking");
		expect(t("rail.taglineTrending")).toBe("by popularity");
		expect(t("rail.taglineNewArrivals")).toBe("freshest first");
		expect(t("rail.taglineDefault")).toBe("in-tab ranking");
		expect(t("rail.signals", { n: 3 })).toBe(
			"3 signals — saved only in this browser",
		);
		expect(t("rail.scrollable", { label: "Trending now" })).toBe(
			"Trending now, scrollable",
		);
		expect(t("rail.why")).toBe("why?");
		expect(t("rail.hide")).toBe("hide");
	});
});
