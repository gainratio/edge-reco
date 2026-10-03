/** Verify EdgeReco's static Assay ranking proof under the pinned Avow signer. */

import type { ScoreResult } from "@gainratio/assay";
import {
	contentHash,
	type JsonValue,
	type SignedReceipt,
	verifySignature,
} from "@gainratio/avow";
import { explainScore, type FormulaSignals } from "./formula";
import {
	normalizeRankingConfig,
	type RankingConfig,
	type ScoringWeights,
} from "./rankingConfig";

export const RANKING_RECEIPT_NAME = "ranking_receipt.json";
export const RANKING_PROOF_SCHEMA = "edgereco.ranking-proof/v1";
const AVOW_RECEIPT_SCHEMA = "avow.receipt/v1";
const DECODER = new TextDecoder();

const PROBE_SIGNALS: FormulaSignals = {
	retrieval: 0,
	popularity: 0.7,
	category_match: 0.6,
	tag_match: 0.8,
	brand_match: 0.5,
	freshness: 0.4,
	similarity: 0.9,
	cooccurrence: 0.3,
	repetition_penalty: 1,
};

export interface FormulaProbe {
	readonly id: string;
	readonly result: ScoreResult;
}

export interface RankingProof {
	readonly schema: typeof RANKING_PROOF_SCHEMA;
	readonly ranking_config_hash: string;
	readonly formula_probes: ReadonlyArray<FormulaProbe>;
}

export type RankingProofEvidence =
	| {
			readonly status: "verified";
			readonly publisherSignature: "verified";
			readonly configHash: "match";
			readonly proof: RankingProof;
	  }
	| {
			readonly status: "failed";
			readonly publisherSignature: "not_checked" | "failed" | "verified";
			readonly configHash: "not_checked" | "mismatch" | "match";
			readonly reason:
				| "malformed"
				| "signature_invalid"
				| "config_hash_mismatch"
				| "formula_probe_mismatch";
	  }
	| {
			readonly status: "unavailable";
			readonly publisherSignature: "not_checked";
			readonly configHash: "not_checked";
			readonly reason: "missing" | "legacy" | "key_unavailable";
	  };

type UnknownRecord = Readonly<Record<string, unknown>>;

export function unavailableRankingProof(
	reason: "missing" | "legacy" | "key_unavailable",
): RankingProofEvidence {
	return {
		status: "unavailable",
		publisherSignature: "not_checked",
		configHash: "not_checked",
		reason,
	};
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function bytesHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function probe(id: string, weights: ScoringWeights): FormulaProbe {
	return { id, result: explainScore(PROBE_SIGNALS, weights) };
}

export async function buildRankingProof(
	config: RankingConfig,
): Promise<RankingProof> {
	const normalizedConfig = normalizeRankingConfig(config);
	const strategies = Object.entries(normalizedConfig.strategies ?? {}).sort(
		([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
	);
	return {
		schema: RANKING_PROOF_SCHEMA,
		ranking_config_hash: await contentHash(jsonValue(normalizedConfig)),
		formula_probes: [
			probe("search", normalizedConfig.scoring_weights),
			...strategies.map(([id, strategy]) => probe(id, strategy.weights)),
		],
	};
}

function currentPayload(document: UnknownRecord): UnknownRecord | undefined {
	const payload = document.payload;
	return isRecord(payload) && payload.schema === RANKING_PROOF_SCHEMA
		? payload
		: undefined;
}

function isHistoricalAssayPayload(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		typeof value.assay_version === "string" &&
		value.metric === "weighted_composite" &&
		typeof value.metric_version === "string" &&
		typeof value.inputs_hash === "string" &&
		typeof value.score === "number" &&
		Number.isFinite(value.score) &&
		typeof value.abstained === "boolean"
	);
}

function isLegacyReceipt(document: UnknownRecord): boolean {
	if (document.schema !== undefined) return false;
	return (
		isHistoricalAssayPayload(document.payload) &&
		typeof document.payload_hash === "string" &&
		typeof document.public_key === "string" &&
		typeof document.signature === "string"
	);
}

function signedReceipt(
	document: UnknownRecord,
): SignedReceipt<JsonValue> | undefined {
	if (document.schema !== AVOW_RECEIPT_SCHEMA) return undefined;
	if (!isRecord(document.payload)) return undefined;
	const { payload_hash, public_key, signature } = document;
	if (
		typeof payload_hash !== "string" ||
		typeof public_key !== "string" ||
		typeof signature !== "string"
	) {
		return undefined;
	}
	return {
		schema: AVOW_RECEIPT_SCHEMA,
		payload: jsonValue(document.payload),
		payload_hash,
		public_key,
		signature,
	};
}

function failed(
	publisherSignature: "not_checked" | "failed" | "verified",
	configHash: "not_checked" | "mismatch" | "match",
	reason:
		| "malformed"
		| "signature_invalid"
		| "config_hash_mismatch"
		| "formula_probe_mismatch",
): RankingProofEvidence {
	return { status: "failed", publisherSignature, configHash, reason };
}

function parseDocument(bytes: Uint8Array): UnknownRecord | undefined {
	try {
		const value: unknown = JSON.parse(DECODER.decode(bytes));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function proofMatches(
	payload: JsonValue,
	expected: RankingProof,
): Promise<boolean> {
	return (
		(await contentHash(payload)) === (await contentHash(jsonValue(expected)))
	);
}

/**
 * The pinned key the receipt must verify under: the trusted key whose hex
 * matches the receipt's embedded signer, else the first trusted key (which
 * Avow then refuses as a signer mismatch). `undefined` when nothing is trusted.
 */
function signerFor(
	trusted: Uint8Array | ReadonlyArray<Uint8Array> | undefined,
	receiptPublicKey: string,
): string | undefined {
	if (trusted === undefined) return undefined;
	const keys = trusted instanceof Uint8Array ? [trusted] : trusted;
	const hexKeys = keys.map(bytesHex);
	const wanted = receiptPublicKey.toLowerCase();
	return hexKeys.find((key) => key === wanted) ?? hexKeys[0];
}

/**
 * Verify the bundle's static ranking proof. `trustedKeys` is the pinned signer
 * set — one raw 32-byte key, or every unrevoked key of an `edgeproc.keyring/v1`
 * trust root. A receipt signed by any other key (including a revoked one)
 * fails `signature_invalid`; no trusted key at all is `key_unavailable`.
 */
export async function verifyRankingProof(
	receiptBytes: Uint8Array | undefined,
	config: RankingConfig,
	trustedKeys: Uint8Array | ReadonlyArray<Uint8Array> | undefined,
): Promise<RankingProofEvidence> {
	if (receiptBytes === undefined) return unavailableRankingProof("missing");
	const document = parseDocument(receiptBytes);
	if (document === undefined)
		return failed("not_checked", "not_checked", "malformed");
	const payload = currentPayload(document);
	if (payload === undefined) {
		return isLegacyReceipt(document)
			? unavailableRankingProof("legacy")
			: failed("not_checked", "not_checked", "malformed");
	}
	const receipt = signedReceipt(document);
	if (receipt === undefined)
		return failed("not_checked", "not_checked", "malformed");
	const signer = signerFor(trustedKeys, receipt.public_key);
	if (signer === undefined) {
		return unavailableRankingProof("key_unavailable");
	}
	try {
		await verifySignature(receipt, signer);
	} catch {
		return failed("failed", "not_checked", "signature_invalid");
	}
	const expected = await buildRankingProof(config);
	if (payload.ranking_config_hash !== expected.ranking_config_hash) {
		return failed("verified", "mismatch", "config_hash_mismatch");
	}
	if (!(await proofMatches(receipt.payload, expected))) {
		return failed("verified", "match", "formula_probe_mismatch");
	}
	return {
		status: "verified",
		publisherSignature: "verified",
		configHash: "match",
		proof: expected,
	};
}
