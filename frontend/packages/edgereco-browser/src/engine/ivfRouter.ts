// Coarse IVF shard router and 2-bit TurboQuant seed-vector decoder for
// sharded and pre-quantized `catalogue.sqlite` tables (`vector0_products_embedding`).

const SIGN_SEED_MASK = 0xa5a5a5a55a5a5a5an;
const ROUND_SEED_MASK = 0xd1b54a32d192ed03n;
const U64_MASK = 0xffffffffffffffffn;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const SPLITMIX_M1 = 0xbf58476d1ce4e5b9n;
const SPLITMIX_M2 = 0x94d049bb133111ebn;
const ANGLE_SCALE = 6.283185307179586 / 9007199254740992.0;
const TURBO_ROUNDS = 12;
const TURBO_HEADER_BYTES = 12;
const TURBO_2BIT_UNIT_LEVELS = new Float32Array([
	-1.5104, -0.4528, 0.4528, 1.5104,
]);

interface SplitMixState {
	value: bigint;
}

interface RotationPlan {
	readonly signs: Uint8Array;
	readonly pairsA: Int32Array;
	readonly pairsB: Int32Array;
	readonly sines: Float32Array;
	readonly cosines: Float32Array;
}

const PLAN_CACHE = new Map<number, RotationPlan>();

function splitmix64(state: SplitMixState): bigint {
	state.value = (state.value + SPLITMIX_GAMMA) & U64_MASK;
	let z = state.value;
	z = ((z ^ (z >> 30n)) * SPLITMIX_M1) & U64_MASK;
	z = ((z ^ (z >> 27n)) * SPLITMIX_M2) & U64_MASK;
	return (z ^ (z >> 31n)) & U64_MASK;
}

function shufflePermutation(perm: Int32Array, state: SplitMixState): void {
	for (let i = 0; i < perm.length; i++) {
		perm[i] = i;
	}
	for (let i = perm.length - 1; i > 0; i--) {
		const j = Number(splitmix64(state) % BigInt(i + 1));
		const tmp = perm[i] as number;
		perm[i] = perm[j] as number;
		perm[j] = tmp;
	}
}

function buildRoundPairs(
	dimension: number,
	round: number,
	perm: Int32Array,
	plan: RotationPlan,
	offset: number,
): number {
	const state: SplitMixState = {
		value:
			(ROUND_SEED_MASK ^ (BigInt(dimension) << 32n) ^ BigInt(round)) & U64_MASK,
	};
	shufflePermutation(perm, state);
	let idx = offset;
	for (let i = 0; i + 1 < dimension; i += 2) {
		const angle = Math.fround(Number(splitmix64(state) >> 11n) * ANGLE_SCALE);
		plan.pairsA[idx] = perm[i] as number;
		plan.pairsB[idx] = perm[i + 1] as number;
		plan.sines[idx] = Math.fround(Math.sin(angle));
		plan.cosines[idx] = Math.fround(Math.cos(angle));
		idx++;
	}
	return idx;
}

function buildInitialSigns(dimension: number): Uint8Array {
	const signs = new Uint8Array(dimension);
	const signState: SplitMixState = {
		value: SIGN_SEED_MASK ^ BigInt(dimension),
	};
	for (let i = 0; i < dimension; i++) {
		signs[i] = Number(splitmix64(signState) & 1n);
	}
	return signs;
}

function getRotationPlan(dimension: number): RotationPlan {
	const cached = PLAN_CACHE.get(dimension);
	if (cached !== undefined) {
		return cached;
	}
	const pairCount = (dimension >> 1) * TURBO_ROUNDS;
	const plan: RotationPlan = {
		signs: buildInitialSigns(dimension),
		pairsA: new Int32Array(pairCount),
		pairsB: new Int32Array(pairCount),
		sines: new Float32Array(pairCount),
		cosines: new Float32Array(pairCount),
	};
	const perm = new Int32Array(dimension);
	let offset = 0;
	for (let r = 0; r < TURBO_ROUNDS; r++) {
		offset = buildRoundPairs(dimension, r, perm, plan, offset);
	}
	PLAN_CACHE.set(dimension, plan);
	return plan;
}

function unpackUnitCoords(
	blockData: Uint8Array,
	codesStart: number,
	dimension: number,
): Float32Array {
	const invSqrtDim = 1 / Math.sqrt(dimension);
	const vec = new Float32Array(dimension);
	for (let d = 0; d < dimension; d++) {
		const byte = blockData[codesStart + (d >> 2)] as number;
		const code = (byte >> ((d & 3) * 2)) & 3;
		vec[d] = (TURBO_2BIT_UNIT_LEVELS[code] as number) * invSqrtDim;
	}
	return vec;
}

function applyInverseRotation(vec: Float32Array, plan: RotationPlan): void {
	for (let idx = plan.pairsA.length - 1; idx >= 0; idx--) {
		const aIdx = plan.pairsA[idx] as number;
		const bIdx = plan.pairsB[idx] as number;
		const s = plan.sines[idx] as number;
		const c = plan.cosines[idx] as number;
		const x = vec[aIdx] as number;
		const y = vec[bIdx] as number;
		vec[aIdx] = Math.fround(c * x + s * y);
		vec[bIdx] = Math.fround(-s * x + c * y);
	}
	for (let d = 0; d < vec.length; d++) {
		if (plan.signs[d] === 1) {
			vec[d] = -(vec[d] as number);
		}
	}
}

/**
 * Reconstruct a float32 query vector for `targetRowid` from a
 * `vector0_products_embedding` block BLOB so `nearest(id, k)` works when
 * `products.embedding` is `zeroblob(0)`.
 */
export function decodeTurboQuantRow(
	blockData: Uint8Array,
	rowid1: number,
	targetRowid: number,
	dimension: number,
): Float32Array | null {
	const recordBytes = TURBO_HEADER_BYTES + Math.ceil((dimension * 2) / 8);
	const recordOffset = (targetRowid - rowid1) * recordBytes;
	if (
		recordOffset < 0 ||
		recordOffset + recordBytes > blockData.byteLength ||
		dimension < 2
	) {
		return null;
	}
	const vec = unpackUnitCoords(
		blockData,
		recordOffset + TURBO_HEADER_BYTES,
		dimension,
	);
	applyInverseRotation(vec, getRotationPlan(dimension));
	return vec;
}

function dotProductAt(
	queryVector: Float32Array,
	centroids: Float32Array,
	base: number,
	dimension: number,
): number {
	let dot = 0;
	for (let d = 0; d < dimension; d++) {
		dot += (queryVector[d] as number) * (centroids[base + d] as number);
	}
	return dot;
}

/**
 * Rank coarse IVF shard centroids by cosine similarity to `queryVector` and
 * return up to `nprobe` shard indices (`0 .. numShards - 1`). When
 * `cosineMargin` is provided, always includes the nearest centroid and keeps
 * additional centroids up to `nprobe` only if they fall within `cosineMargin`
 * of the top centroid score (adaptive Voronoi boundary probing).
 */
export function rankIvfCentroids(
	queryVector: Float32Array,
	centroids: Float32Array,
	dimension: number,
	nprobe: number,
	cosineMargin?: number,
): number[] {
	if (!Number.isInteger(dimension) || dimension < 1) {
		throw new RangeError("IVF dimension must be a positive integer");
	}
	if (
		queryVector.length !== dimension ||
		centroids.length === 0 ||
		centroids.length % dimension !== 0
	) {
		throw new RangeError("IVF queryVector or centroids length mismatch");
	}
	const numShards = centroids.length / dimension;
	const take = Math.max(1, Math.min(Math.trunc(nprobe), numShards));
	const scored = Array.from({ length: numShards }, (_, shard) => ({
		shard,
		score: dotProductAt(queryVector, centroids, shard * dimension, dimension),
	}));
	scored.sort((a, b) => b.score - a.score || a.shard - b.shard);
	const top = scored.slice(0, take);
	if (cosineMargin === undefined || top.length <= 1) {
		return top.map((entry) => entry.shard);
	}
	const floor = (top[0]?.score ?? 0) - cosineMargin;
	return top
		.filter((entry, idx) => idx === 0 || entry.score >= floor)
		.map((entry) => entry.shard);
}

const SHARD_ID_RE = /^S(\d{2})-/u;

/**
 * Resolve the owning IVF shard index (`0 .. numShards - 1`) in `O(1)` from a
 * product ID (`NB-*` -> shard `0`, `S{s:02d}-*` -> shard `s`).
 */
export function shardForProductId(productId: string, numShards = 64): number {
	if (numShards <= 1 || productId.startsWith("NB-")) {
		return 0;
	}
	const match = SHARD_ID_RE.exec(productId);
	if (match === null) {
		return 0;
	}
	const idx = Number(match[1]);
	return idx >= 0 && idx < numShards ? idx : 0;
}
