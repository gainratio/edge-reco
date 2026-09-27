import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Product } from "../api/types";
import { ProductImage } from "./ProductImage";

const product: Product = {
	id: "P1",
	title: "Waterproof Hiking Boot",
	description: "",
	category: "Sports",
	subcategories: [],
	tags: [],
	brand: "Juniperline",
	price: 100,
	currency: "USD",
	popularity_score: 0.8,
	freshness_score: 0.7,
	image_url: "https://m.media-amazon.com/images/P1.jpg",
	url: "",
	attributes: {},
};

afterEach(cleanup);

describe("ProductImage remote (Path A) mode", () => {
	// A bundle published with EDGERECO_IMAGE_MODE=remote keeps the catalog's own CDN
	// urls, and the deployment lists those hosts in img-src. The component has to
	// RENDER them — a CSP that permits the host is useless if `isLocalImage` still
	// refuses the url, which is exactly how this mode shipped as 54 placeholders.
	const hosts = ["https://m.media-amazon.com"];

	it("renders an allowlisted remote host when the build enables remote mode", () => {
		render(<ProductImage product={product} allowedRemoteHosts={hosts} />);

		expect(screen.getByRole("img")).toHaveAttribute(
			"src",
			"https://m.media-amazon.com/images/P1.jpg",
		);
	});

	it("still refuses a host that is NOT on the allowlist", () => {
		// The allowlist is the boundary, not "any remote url is fine now".
		render(
			<ProductImage
				product={{ ...product, image_url: "https://evil.example/P1.jpg" }}
				allowedRemoteHosts={hosts}
			/>,
		);

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});

	it("refuses http even on an allowlisted host", () => {
		render(
			<ProductImage
				product={{
					...product,
					image_url: "http://m.media-amazon.com/images/P1.jpg",
				}}
				allowedRemoteHosts={hosts}
			/>,
		);

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});

	it("refuses a lookalike host that merely ends with the allowed one", () => {
		// `evil-m.media-amazon.com.attacker.test` must not pass a sloppy endsWith check.
		render(
			<ProductImage
				product={{
					...product,
					image_url: "https://m.media-amazon.com.attacker.test/P1.jpg",
				}}
				allowedRemoteHosts={hosts}
			/>,
		);

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});
});

describe("ProductImage egress boundary", () => {
	it("uses the editorial placeholder instead of a remote catalog image", () => {
		render(<ProductImage product={product} />);

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getByText("Sports")).toBeInTheDocument();
	});

	it("rejects a backslash authority form that URL parsing could make remote", () => {
		render(
			<ProductImage
				product={{ ...product, image_url: "/\\evil.example/P1.webp" }}
			/>,
		);

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});

	it("allows a release-owned root-relative image", () => {
		render(
			<ProductImage product={{ ...product, image_url: "/products/P1.webp" }} />,
		);

		expect(screen.getByRole("img", { name: product.title })).toHaveAttribute(
			"src",
			"/products/P1.webp",
		);
	});

	it("renders the baked-in local /images/<id>.svg as a real image, not the tile", () => {
		// The signed bundle rewrites each product's image_url to the root-relative
		// local asset the app ships in public/images. This is the branch that would
		// have caught the shipped-placeholders regression: a real <img>, not a tile.
		render(
			<ProductImage
				product={{ ...product, image_url: `/images/${product.id}.svg` }}
			/>,
		);

		expect(screen.getByRole("img", { name: product.title })).toHaveAttribute(
			"src",
			`/images/${product.id}.svg`,
		);
		expect(screen.queryByText("Sports")).not.toBeInTheDocument();
	});
});

describe("ProductImage tile mapping", () => {
	it("maps a real compound catalog category to its own tile, not the default", () => {
		const { container } = render(
			<ProductImage
				product={{ ...product, category: "Clothing, Shoes & Jewelry" }}
			/>,
		);

		const tile = container.querySelector(".pimg-tile");
		expect(tile).toHaveClass("pimg-tile--clothing");
		expect(tile).not.toHaveClass("pimg-tile--default");
	});

	it("applies the deterministic per-product tone variant", () => {
		// "P1" hashes to a non-base tone; the exact class is pinned by toneClassFor.
		const { container } = render(<ProductImage product={product} />);
		const tile = container.querySelector(".pimg-tile");
		const first = tile?.className;
		cleanup();
		const second = render(
			<ProductImage product={product} />,
		).container.querySelector(".pimg-tile")?.className;
		expect(first).toBe(second);
	});
});
