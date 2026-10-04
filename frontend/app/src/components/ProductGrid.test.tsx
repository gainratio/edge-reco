import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Product } from "../api/types";
import { ProductGrid } from "./ProductGrid";

function makeProduct(id: string, title: string): Product {
	return {
		id,
		title,
		description: "",
		category: "Office Products",
		subcategories: [],
		tags: [],
		brand: "Acme",
		price: 10,
		currency: "USD",
		popularity_score: 0.5,
		freshness_score: 0.5,
		image_url: "",
		url: "",
		attributes: {},
	};
}

interface Overrides {
	products?: Product[];
	loading?: boolean;
	favoritedIds?: ReadonlySet<string>;
}

function renderGrid(overrides: Overrides = {}) {
	const result = render(
		<ProductGrid
			products={overrides.products ?? []}
			kicker="Catalog"
			title="Browse"
			loading={overrides.loading ?? false}
			onPick={vi.fn()}
			onFavorite={vi.fn()}
			onAddToCart={vi.fn()}
			favoritedIds={overrides.favoritedIds ?? new Set()}
			registerDwell={() => () => {}}
		/>,
	);
	return result;
}

afterEach(cleanup);

describe("ProductGrid", () => {
	it("renders no kicker line when none is given (search view)", () => {
		const { container } = render(
			<ProductGrid
				products={[]}
				title="Search results"
				loading={false}
				onPick={vi.fn()}
				onFavorite={vi.fn()}
				onAddToCart={vi.fn()}
				favoritedIds={new Set()}
				registerDwell={() => () => {}}
			/>,
		);
		expect(container.querySelector(".section-head__kicker")).toBeNull();
		expect(
			screen.getByRole("heading", { level: 1, name: "Search results" }),
		).toBeInTheDocument();
	});

	it("shows skeleton cards and no count while loading", () => {
		const { container } = renderGrid({ loading: true });
		expect(container.querySelectorAll(".skeleton")).toHaveLength(8);
		expect(screen.queryByText(/item/)).not.toBeInTheDocument();
		// The section head (kicker + title) renders even during load.
		expect(screen.getByText("Catalog")).toBeInTheDocument();
		expect(screen.getByText("Browse")).toBeInTheDocument();
	});

	it("shows an empty-state message when loaded with no products", () => {
		renderGrid({ products: [], loading: false });
		expect(screen.getByText(/Nothing here yet/i)).toBeInTheDocument();
	});

	it("exposes the grid title as the page's h1 (browse/search have no other h1)", () => {
		renderGrid();
		expect(
			screen.getByRole("heading", { level: 1, name: "Browse" }),
		).toBeInTheDocument();
	});

	it("renders a card per product with a pluralized count", () => {
		const { container } = renderGrid({
			products: [makeProduct("P1", "Mug"), makeProduct("P2", "Lamp")],
		});
		expect(container.querySelectorAll(".card")).toHaveLength(2);
		expect(screen.getByText("2 items")).toBeInTheDocument();
	});

	it("uses the singular 'item' for a single product", () => {
		renderGrid({ products: [makeProduct("P1", "Mug")] });
		expect(screen.getByText("1 item")).toBeInTheDocument();
	});

	it("reflects favorited state from favoritedIds", () => {
		renderGrid({
			products: [makeProduct("P1", "Mug")],
			favoritedIds: new Set(["P1"]),
		});
		expect(
			screen.getByRole("button", { name: "Unfavorite “Mug”" }),
		).toHaveAttribute("aria-pressed", "true");
	});
});
