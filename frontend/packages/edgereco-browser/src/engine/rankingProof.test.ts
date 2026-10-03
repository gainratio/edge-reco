import { signPayload } from "@gainratio/avow";
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/ranking_proof_v1.json" with {
	type: "json",
};
import { DEFAULT_RANKING_CONFIG } from "./rankingConfig";
import { buildRankingProof, verifyRankingProof } from "./rankingProof";

const ENCODER = new TextEncoder();
const FIXTURE_BYTES = ENCODER.encode(JSON.stringify(fixture));
const PINNED_PUBLIC_KEY = hexBytes(
	"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
);

function hexBytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (byte) =>
		Number.parseInt(byte, 16),
	);
}

function encoded(value: unknown): Uint8Array {
	return ENCODER.encode(JSON.stringify(value));
}

describe("ranking proof verification", () => {
	it("verifies Python's signed fixture and every strategy probe", async () => {
		const evidence = await verifyRankingProof(
			FIXTURE_BYTES,
			DEFAULT_RANKING_CONFIG,
			PINNED_PUBLIC_KEY,
		);

		expect(evidence.status).toBe("verified");
		if (evidence.status !== "verified")
			throw new Error("expected verified proof");
		expect(evidence.publisherSignature).toBe("verified");
		expect(evidence.configHash).toBe("match");
		expect(evidence.proof.formula_probes.map((probe) => probe.id)).toEqual([
			"search",
			...Object.keys(DEFAULT_RANKING_CONFIG.strategies ?? {}).sort(),
		]);
		expect(evidence.proof.formula_probes[0]?.result.score).toBe(
			0.3600000000000001,
		);
		expect(
			evidence.proof.formula_probes[0]?.result.components.map((row) => row.id),
		).toEqual([
			"retrieval",
			"popularity",
			"category_match",
			"tag_match",
			"brand_match",
			"freshness",
			"similarity",
			"cooccurrence",
			"repetition_penalty",
		]);
	});

	it("fails when the signed payload is tampered", async () => {
		const tampered = structuredClone(fixture);
		tampered.payload.ranking_config_hash = `sha256:${"0".repeat(64)}`;

		const evidence = await verifyRankingProof(
			encoded(tampered),
			DEFAULT_RANKING_CONFIG,
			PINNED_PUBLIC_KEY,
		);

		expect(evidence).toMatchObject({
			status: "failed",
			publisherSignature: "failed",
			configHash: "not_checked",
			reason: "signature_invalid",
		});
	});

	it("does not let a tampered current payload schema downgrade to legacy", async () => {
		const tampered = {
			...fixture,
			payload: { ...fixture.payload, schema: "assay.score-receipt/v1" },
		};

		const evidence = await verifyRankingProof(
			encoded(tampered),
			DEFAULT_RANKING_CONFIG,
			PINNED_PUBLIC_KEY,
		);

		expect(evidence).toMatchObject({
			status: "failed",
			publisherSignature: "not_checked",
			configHash: "not_checked",
		});
	});

	it("fails when the receipt signer differs from the pinned key", async () => {
		const evidence = await verifyRankingProof(
			FIXTURE_BYTES,
			DEFAULT_RANKING_CONFIG,
			hexBytes("01".repeat(32)),
		);

		expect(evidence).toMatchObject({
			status: "failed",
			publisherSignature: "failed",
			configHash: "not_checked",
			reason: "signature_invalid",
		});
	});

	it("reports a missing receipt as unavailable", async () => {
		const evidence = await verifyRankingProof(
			undefined,
			DEFAULT_RANKING_CONFIG,
			PINNED_PUBLIC_KEY,
		);

		expect(evidence).toEqual({
			status: "unavailable",
			publisherSignature: "not_checked",
			configHash: "not_checked",
			reason: "missing",
		});
	});

	it("reports a persisted legacy receipt as unavailable, never verified", async () => {
		const legacy = {
			payload: {
				assay_version: "0.1.0",
				metric: "weighted_composite",
				metric_version: `sha256:${"1".repeat(64)}`,
				inputs_hash: `sha256:${"2".repeat(64)}`,
				score: 0.65,
				abstained: false,
			},
			payload_hash: `sha256:${"0".repeat(64)}`,
			public_key: fixture.public_key,
			signature: fixture.signature,
		};

		const evidence = await verifyRankingProof(
			encoded(legacy),
			DEFAULT_RANKING_CONFIG,
			PINNED_PUBLIC_KEY,
		);

		expect(evidence).toEqual({
			status: "unavailable",
			publisherSignature: "not_checked",
			configHash: "not_checked",
			reason: "legacy",
		});
	});

	it("classifies an arbitrary parsed object as malformed, not legacy", async () => {
		const evidence = await verifyRankingProof(
			encoded({}),
			DEFAULT_RANKING_CONFIG,
			PINNED_PUBLIC_KEY,
		);

		expect(evidence).toEqual({
			status: "failed",
			publisherSignature: "not_checked",
			configHash: "not_checked",
			reason: "malformed",
		});
	});

	it.each([
		[
			"top-level scoring",
			{
				...DEFAULT_RANKING_CONFIG,
				scoring_weights: {
					...DEFAULT_RANKING_CONFIG.scoring_weights,
					popularity: -0.4,
				},
			},
		],
		[
			"graded interaction",
			{
				...DEFAULT_RANKING_CONFIG,
				interaction_weights: {
					...DEFAULT_RANKING_CONFIG.interaction_weights,
					click: {
						...DEFAULT_RANKING_CONFIG.interaction_weights.click,
						category: -0.1,
					},
				},
			},
		],
	] as const)(
		"rejects %s negative weights before a proof can be signed",
		async (_label, config) => {
			await expect(buildRankingProof(config)).rejects.toThrow(/non-negative/);
		},
	);

	it("rejects a fractional co-occurrence pool limit before proof signing", async () => {
		const strategy =
			DEFAULT_RANKING_CONFIG.strategies?.frequently_bought_together;
		if (strategy === undefined) {
			throw new Error("frequently_bought_together fixture missing");
		}
		const config = {
			...DEFAULT_RANKING_CONFIG,
			strategies: {
				...DEFAULT_RANKING_CONFIG.strategies,
				frequently_bought_together: {
					...strategy,
					co_occurrence_top_k: 1.5,
				},
			},
		};

		await expect(buildRankingProof(config)).rejects.toThrow(
			/co_occurrence_top_k.*integer/,
		);
	});

	it("fails after signature verification when the full config hash differs", async () => {
		const retuned = {
			...DEFAULT_RANKING_CONFIG,
			scoring_weights: {
				...DEFAULT_RANKING_CONFIG.scoring_weights,
				popularity: 0.41,
			},
		};

		const evidence = await verifyRankingProof(
			FIXTURE_BYTES,
			retuned,
			PINNED_PUBLIC_KEY,
		);

		expect(evidence).toMatchObject({
			status: "failed",
			publisherSignature: "verified",
			configHash: "mismatch",
			reason: "config_hash_mismatch",
		});
	});

	it("fails a valid signature when an Assay formula probe does not replay", async () => {
		const alteredPayload = structuredClone(fixture.payload);
		const searchProbe = alteredPayload.formula_probes[0];
		if (searchProbe === undefined)
			throw new Error("fixture missing search probe");
		searchProbe.result.score = 123;
		const signed = await signPayload(alteredPayload, "07".repeat(32));

		const evidence = await verifyRankingProof(
			encoded(signed),
			DEFAULT_RANKING_CONFIG,
			PINNED_PUBLIC_KEY,
		);

		expect(evidence).toMatchObject({
			status: "failed",
			publisherSignature: "verified",
			configHash: "match",
			reason: "formula_probe_mismatch",
		});
	});

	it("sorts numeric-like strategy probe ids identically to Python", async () => {
		const strategy = DEFAULT_RANKING_CONFIG.strategies?.for_you;
		if (strategy === undefined) throw new Error("default strategy missing");
		const proof = await buildRankingProof({
			...DEFAULT_RANKING_CONFIG,
			strategies: { "2": strategy, "10": strategy },
		});

		expect(proof.formula_probes.map((probe) => probe.id)).toEqual([
			"search",
			"10",
			"2",
		]);
	});

	it("sorts non-BMP strategy probe ids identically to Python", async () => {
		const strategy = DEFAULT_RANKING_CONFIG.strategies?.for_you;
		if (strategy === undefined) throw new Error("default strategy missing");
		const proof = await buildRankingProof({
			...DEFAULT_RANKING_CONFIG,
			strategies: { "\ue000": strategy, "\u{10000}": strategy },
		});

		expect(proof.formula_probes.map((probe) => probe.id)).toEqual([
			"search",
			"\u{10000}",
			"\ue000",
		]);
	});
});
