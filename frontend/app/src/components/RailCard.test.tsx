import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Product, RankingProofEvidence, SearchResult } from "../api/types";
import { RailCard } from "./RailCard";
import { WhyPopover } from "./WhyPopover";

const product: Product = {
	id: "P1",
	title: "Aero Mug",
	description: "",
	category: "Home & Kitchen",
	subcategories: [],
	tags: [],
	brand: "Homemo",
	price: 18,
	currency: "USD",
	popularity_score: 0.5,
	freshness_score: 0.5,
	image_url: "/test-assets/p1.jpg",
	url: "",
	attributes: {},
};

const explanation: NonNullable<SearchResult["score_explanation"]> = {
	schema: "assay.result/v1",
	method: { id: "additive", version: "edgereco.recommendation-v3" },
	score: 0.11,
	interval: null,
	clamp: null,
	intercept: 0,
	weight_total: null,
	components: [
		["retrieval", "Retrieval", 0.2, 1, "add"],
		["popularity", "Popularity", 0.7, 0.4, "add"],
		["category_match", "Category match", 0.6, 0.2, "add"],
		["tag_match", "Tag match", 0.8, 0.15, "add"],
		["brand_match", "Brand match", 0.5, 0.1, "add"],
		["freshness", "Freshness", 0.4, 0.1, "add"],
		["similarity", "Similarity", 0.9, 0.2, "add"],
		["cooccurrence", "Cooccurrence", 0.3, 0.7, "add"],
		["repetition_penalty", "Repetition penalty", 1, 0.25, "subtract"],
	].map(([id, label, raw, coefficient, operation]) => ({
		id: String(id),
		label: String(label),
		raw: Number(raw),
		normalized: null,
		declared_weight: null,
		operation: operation === "subtract" ? "subtract" : "add",
		coefficient: Number(coefficient),
		contribution: Number(raw) * Number(coefficient),
		contribution_interval: null,
	})),
	inputs_hash: `sha256:${"1".repeat(64)}`,
	selected_component_id: null,
};

const verified: RankingProofEvidence = {
	status: "verified",
	publisherSignature: "verified",
	configHash: "match",
	proof: {
		schema: "edgereco.ranking-proof/v1",
		ranking_config_hash: `sha256:${"2".repeat(64)}`,
		formula_probes: [{ id: "search", result: explanation }],
	},
};

afterEach(cleanup);

describe("RailCard", () => {
	it("never presents a persisted legacy receipt as verified", () => {
		render(
			<WhyPopover
				open
				explanation={explanation}
				proofEvidence={{
					status: "unavailable",
					publisherSignature: "not_checked",
					configHash: "not_checked",
					reason: "legacy",
				}}
			/>,
		);

		expect(screen.getByText(/legacy receipt/)).toBeInTheDocument();
		expect(
			screen.queryByText("Ranking config signed by publisher"),
		).not.toBeInTheDocument();
	});

	it("distinguishes a verified signer from a mismatched ranking config", () => {
		render(
			<WhyPopover
				open
				explanation={explanation}
				proofEvidence={{
					status: "failed",
					publisherSignature: "verified",
					configHash: "mismatch",
					reason: "config_hash_mismatch",
				}}
			/>,
		);

		expect(
			screen.getByText("Ranking config signed by publisher"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Full ranking-config hash does not match"),
		).toBeInTheDocument();
	});

	it("does not call an uncheckable malformed proof a failed signature", () => {
		render(
			<WhyPopover
				open
				explanation={explanation}
				proofEvidence={{
					status: "failed",
					publisherSignature: "not_checked",
					configHash: "not_checked",
					reason: "malformed",
				}}
			/>,
		);

		expect(
			screen.getByText("Publisher signature not checked"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Publisher signature failed"),
		).not.toBeInTheDocument();
	});

	it("shows small live values without rounding the equation to zero", () => {
		const precise = {
			...explanation,
			score: 0.004,
			components: explanation.components.map((row, index) =>
				index === 0
					? { ...row, raw: 0.004, coefficient: 1, contribution: 0.004 }
					: row,
			),
		};

		render(<WhyPopover open explanation={precise} proofEvidence={verified} />);

		expect(screen.getByText("0.004 × 1 = +0.004")).toBeInTheDocument();
		expect(
			screen.getByText("0.004", { selector: "strong" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Retrieval quality — Assay" }),
		).toBeInTheDocument();
		expect(screen.getByText("Precision@10")).toBeInTheDocument();
		expect(screen.getByText("97.4% (92.3% @ k=24)")).toBeInTheDocument();
		expect(screen.getByText("50.8% (94.0% of 54.1% max)")).toBeInTheDocument();
		expect(screen.getByText("0.64 (93.6% of 0.68 max)")).toBeInTheDocument();
	});

	it("renders the rank, title and rounded score and picks on click", async () => {
		const onPick = vi.fn();
		render(
			<RailCard product={product} rank={3} score={0.876} onPick={onPick} />,
		);
		expect(screen.getByText("3")).toBeInTheDocument();
		expect(screen.getByText("Aero Mug")).toBeInTheDocument();
		expect(screen.getByText("0.88")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /Aero Mug/i }));
		expect(onPick).toHaveBeenCalledExactlyOnceWith(product);
	});

	it("omits the why-toggle when there is no component breakdown", () => {
		render(
			<RailCard product={product} rank={1} score={0.9} onPick={vi.fn()} />,
		);
		expect(
			screen.queryByRole("button", { name: "why?" }),
		).not.toBeInTheDocument();
	});

	it("toggles the score breakdown popover open and closed", async () => {
		render(
			<RailCard
				product={product}
				rank={1}
				score={0.9}
				explanation={explanation}
				proofEvidence={verified}
				onPick={vi.fn()}
			/>,
		);
		const why = screen.getByRole("button", { name: "why?" });
		expect(why).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByText("How calculated — Assay"),
		).not.toBeInTheDocument();

		await userEvent.click(why);

		const hide = screen.getByRole("button", { name: "hide" });
		expect(hide).toHaveAttribute("aria-expanded", "true");
		// The popover renders sibling calculation and verification contracts.
		expect(screen.getByText("How calculated — Assay")).toBeInTheDocument();
		expect(screen.getByText("Config provenance — Avow")).toBeInTheDocument();
		expect(screen.getByText("Retrieval")).toBeInTheDocument();
		expect(screen.getByText("Popularity")).toBeInTheDocument();
		expect(screen.getByText("Similarity")).toBeInTheDocument();
		expect(screen.getByText("Cooccurrence")).toBeInTheDocument();
		expect(screen.getByText("Repetition penalty")).toBeInTheDocument();
		expect(
			screen.getByText("0.7 × 0.4 = +0.27999999999999997"),
		).toBeInTheDocument();
		expect(screen.getByText("1 × 0.25 = −0.25")).toBeInTheDocument();
		expect(
			screen.getByText("Ranking config signed by publisher"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Full ranking-config hash matches"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/This personalized result is not signed/),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/input truth, freshness, fairness, or recommendation quality/,
			),
		).toBeInTheDocument();

		await userEvent.click(hide);
		expect(screen.getByRole("button", { name: "why?" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});
});
