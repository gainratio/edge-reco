/** Assay's exact ordered representation of EdgeReco's runtime score. */

import {
	type AdditiveRequest,
	type AdditiveTerm,
	additive,
	type Operation,
	type ScoreResult,
} from "@gainratio/assay";
import type { ScoringWeights } from "./rankingConfig";

export const FORMULA_METHOD_VERSION = "edgereco.recommendation-v3";

export interface FormulaSignals {
	readonly retrieval: number;
	readonly popularity: number;
	readonly category_match: number;
	readonly tag_match: number;
	readonly brand_match: number;
	readonly freshness: number;
	readonly similarity: number;
	readonly cooccurrence: number;
	readonly repetition_penalty: number;
}

interface TermIdentity {
	readonly id: keyof FormulaSignals;
	readonly label: string;
	readonly operation: Operation;
}

const TERM_IDENTITIES: ReadonlyArray<TermIdentity> = [
	{ id: "retrieval", label: "Retrieval", operation: "add" },
	{ id: "popularity", label: "Popularity", operation: "add" },
	{ id: "category_match", label: "Category match", operation: "add" },
	{ id: "tag_match", label: "Tag match", operation: "add" },
	{ id: "brand_match", label: "Brand match", operation: "add" },
	{ id: "freshness", label: "Freshness", operation: "add" },
	{ id: "similarity", label: "Similarity", operation: "add" },
	{ id: "cooccurrence", label: "Cooccurrence", operation: "add" },
	{
		id: "repetition_penalty",
		label: "Repetition penalty",
		operation: "subtract",
	},
];

function coefficients(weights: ScoringWeights): ReadonlyArray<number> {
	return [
		1,
		weights.popularity,
		weights.category,
		weights.tag,
		weights.brand,
		weights.freshness,
		weights.similarity,
		weights.cooccurrence,
		weights.repetition_penalty,
	];
}

function term(
	identity: TermIdentity,
	signals: FormulaSignals,
	coefficient: number,
): AdditiveTerm {
	return {
		id: identity.id,
		label: identity.label,
		value: signals[identity.id],
		coefficient,
		operation: identity.operation,
		interval: null,
	};
}

export function formulaRequest(
	signals: FormulaSignals,
	weights: ScoringWeights,
): AdditiveRequest {
	const values = coefficients(weights);
	return {
		method: "additive",
		method_version: FORMULA_METHOD_VERSION,
		terms: TERM_IDENTITIES.map((identity, index) =>
			term(identity, signals, values[index] ?? 0),
		),
		clamp: null,
		intercept: 0,
	};
}

export function explainScore(
	signals: FormulaSignals,
	weights: ScoringWeights,
): ScoreResult {
	return additive(formulaRequest(signals, weights));
}
