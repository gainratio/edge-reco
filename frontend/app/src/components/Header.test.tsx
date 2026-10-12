import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header } from "./Header";

afterEach(cleanup);

interface Overrides {
	query?: string;
	categories?: string[];
	activeCategory?: string | null;
	cartCount?: number;
}

function renderHeader(overrides: Overrides = {}) {
	const onQueryChange = vi.fn();
	const onSelectCategory = vi.fn();
	render(
		<Header
			query={overrides.query ?? ""}
			onQueryChange={onQueryChange}
			categories={overrides.categories ?? []}
			activeCategory={overrides.activeCategory ?? null}
			onSelectCategory={onSelectCategory}
			cartCount={overrides.cartCount ?? 0}
		/>,
	);
	return { onQueryChange, onSelectCategory };
}

describe("Header", () => {
	it("reports each keystroke through onQueryChange", async () => {
		const { onQueryChange } = renderHeader();
		await userEvent.type(screen.getByLabelText("Search products"), "mug");
		expect(onQueryChange).toHaveBeenCalledTimes(3);
		expect(onQueryChange).toHaveBeenLastCalledWith("g");
	});

	it("reflects the controlled query value in the input", () => {
		renderHeader({ query: "lamp" });
		expect(screen.getByLabelText("Search products")).toHaveValue("lamp");
	});

	it("hides the category nav when there are no categories", () => {
		renderHeader({ categories: [] });
		expect(
			screen.queryByRole("navigation", { name: "Categories" }),
		).not.toBeInTheDocument();
	});

	it("renders an All chip plus one chip per category", () => {
		renderHeader({ categories: ["Books", "Office"] });
		expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Books" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Office" })).toBeInTheDocument();
	});

	it("marks the active category chip and All otherwise", () => {
		renderHeader({ categories: ["Books"], activeCategory: "Books" });
		expect(screen.getByRole("button", { name: "Books" })).toHaveClass(
			"chip--active",
		);
		expect(screen.getByRole("button", { name: "All" })).not.toHaveClass(
			"chip--active",
		);
	});

	it("selects a category chip and clears it via All", async () => {
		const { onSelectCategory } = renderHeader({ categories: ["Books"] });
		await userEvent.click(screen.getByRole("button", { name: "Books" }));
		expect(onSelectCategory).toHaveBeenCalledWith("Books");
		await userEvent.click(screen.getByRole("button", { name: "All" }));
		expect(onSelectCategory).toHaveBeenCalledWith(null);
	});

	it("offers a discreet open-source link to the edge-reco GitHub repo", () => {
		renderHeader();
		expect(screen.getByRole("link", { name: /open source/i })).toHaveAttribute(
			"href",
			"https://github.com/gainratio/edge-reco",
		);
	});

	it("hides the cart pill at zero and shows the count when items are added", () => {
		const { unmount } = render(
			<Header
				query=""
				onQueryChange={() => {}}
				categories={[]}
				activeCategory={null}
				onSelectCategory={() => {}}
				cartCount={0}
			/>,
		);
		expect(screen.queryByText("3")).not.toBeInTheDocument();
		unmount();
		renderHeader({ cartCount: 3 });
		expect(screen.getByText("3")).toBeInTheDocument();
	});
});
