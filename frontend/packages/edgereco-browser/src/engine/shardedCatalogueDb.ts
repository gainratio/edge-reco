// Multi-shard IVF-TurboQuant CatalogueStore over K self-contained SQLite shards.
// Cold boot imports only anchor `shard_00` (`edgereco-catalogue`) into OPFS and
// pre-warms `DEFAULT_NPROBE` reusable in-memory SQLite Workers; queries route
// via `rankIvfCentroids` (`nprobe = 2` + shard `0`) and swap extra shard images
// in-place via `sqlite3_deserialize` with zero Worker respawn or OPFS churn.

import { NetworkError } from "../gainratio";
import {
	type CatalogueBrowseOptions,
	CatalogueDb,
	type CatalogueImport,
	type CatalogueStore,
	type CatalogueStoreFactory,
	type CatalogueSwapOptions,
	DEFAULT_LEXICAL_WEIGHTS,
	type HybridRow,
	RRF_K,
	type ScoredId,
	type ShardedSqliteInput,
} from "./catalogueDb";
import {
	importCatalogueSqlFromChunks,
	openCatalogueShardSql,
	openCatalogueSql,
	retireLegacyVectorPool,
} from "./catalogueSql";
import type { BrowseResponse, Product, SearchResult } from "./domain";
import { rankIvfCentroids, shardForProductId } from "./ivfRouter";
import type { ScoringWeights } from "./rankingConfig";
import type { SessionProfile } from "./session";

const DEFAULT_NPROBE = 2;
const MAX_EXTRA_OPEN_SHARDS = 4;
const SHARD_SWAP_TIMEOUT_MS = 30_000;

export type OpenShardDb = (
	shardIndex: number,
	dimension: number,
) => Promise<CatalogueDb>;

const defaultOpenShardDb: OpenShardDb = async (shardIndex, dimension) =>
	shardIndex === 0
		? CatalogueDb.open(
				await openCatalogueSql(),
				dimension,
				DEFAULT_LEXICAL_WEIGHTS,
				{
					openSql: openCatalogueSql,
					importStream: importCatalogueSqlFromChunks,
					forceStreamImport: false,
				},
			)
		: CatalogueDb.open(
				await openCatalogueShardSql(shardIndex),
				dimension,
				DEFAULT_LEXICAL_WEIGHTS,
				{
					openSql: () => openCatalogueShardSql(shardIndex),
					forceStreamImport: false,
				},
			);

function shardRevKey(revisionKey: string, shardIndex: number): string {
	return revisionKey.length > 0 ? `${revisionKey}:s${shardIndex}` : "";
}

async function assembleChunks(
	chunks: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of chunks) {
		parts.push(chunk);
		total += chunk.byteLength;
	}
	if (parts.length === 1) {
		return parts[0] as Uint8Array;
	}
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		combined.set(part, offset);
		offset += part.byteLength;
	}
	return combined;
}

function rankSublist(
	rows: ReadonlyArray<HybridRow>,
	pick: (r: HybridRow) => number | null,
): Map<string, { readonly score: number; readonly rank: number }> {
	const best = new Map<string, number>();
	for (const r of rows) {
		const val = pick(r);
		if (val !== null && val > (best.get(r.id) ?? Number.NEGATIVE_INFINITY)) {
			best.set(r.id, val);
		}
	}
	const sorted = [...best.entries()].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
	);
	return new Map(
		sorted.map(([id, score], idx) => [id, { score, rank: idx + 1 }]),
	);
}

function fuseShardResults(
	lists: ReadonlyArray<ReadonlyArray<HybridRow>>,
): ReadonlyArray<HybridRow> {
	if (lists.length === 1) {
		return lists[0] as ReadonlyArray<HybridRow>;
	}
	const flat = lists.flat();
	const lex = rankSublist(flat, (r) => r.lexicalScore);
	const sem = rankSublist(flat, (r) => r.semanticScore);
	const ids = new Set<string>([...lex.keys(), ...sem.keys()]);
	const fused: HybridRow[] = [...ids].map((id) => {
		const l = lex.get(id);
		const s = sem.get(id);
		return {
			id,
			fused:
				(l !== undefined ? 1 / (RRF_K + l.rank) : 0) +
				(s !== undefined ? 1 / (RRF_K + s.rank) : 0),
			lexicalScore: l?.score ?? null,
			lexicalRank: l?.rank ?? null,
			semanticScore: s?.score ?? null,
			semanticRank: s?.rank ?? null,
		};
	});
	return fused.sort((a, b) => b.fused - a.fused || a.id.localeCompare(b.id));
}

export const openShardedCatalogueStore: CatalogueStoreFactory = async ({
	dimension,
}) => {
	await retireLegacyVectorPool();
	return ShardedCatalogueDb.open(dimension);
};

export class ShardedCatalogueDb implements CatalogueStore {
	readonly #shard0: CatalogueDb;
	readonly #dimension: number;
	readonly #openShardDb: OpenShardDb;
	readonly #extra = new Map<number, CatalogueDb>();
	readonly #idleSlots: CatalogueDb[] = [];
	readonly #inflight = new Map<number, Promise<CatalogueDb>>();
	#allocatedSlots = 0;
	#nextSlotId = 1;
	#sharded: ShardedSqliteInput | null = null;
	#revisionKey = "";
	#globalCounts: ReadonlyMap<string, number> | null = null;

	private constructor(
		shard0: CatalogueDb,
		dimension: number,
		openShardDb: OpenShardDb,
	) {
		this.#shard0 = shard0;
		this.#dimension = dimension;
		this.#openShardDb = openShardDb;
	}

	public static async open(
		dimension: number,
		openShardDb: OpenShardDb = defaultOpenShardDb,
	): Promise<ShardedCatalogueDb> {
		return new ShardedCatalogueDb(
			await openShardDb(0, dimension),
			dimension,
			openShardDb,
		);
	}

	public replace(
		revision: CatalogueImport,
		options?: CatalogueSwapOptions,
	): Promise<void> {
		return this.#shard0.replace(revision, options);
	}

	public async activateShardedRevision(
		revisionKey: string,
		expectedCount: number,
		sharded: ShardedSqliteInput,
	): Promise<boolean> {
		const n0 = await this.#shard0.count();
		if (
			n0 <= 0 ||
			!(await this.#shard0.activateRevision(shardRevKey(revisionKey, 0), n0))
		) {
			return false;
		}
		const counts = await this.#shard0.globalCounts();
		if (counts?.get("") !== expectedCount) {
			return false;
		}
		this.#sharded = sharded;
		this.#revisionKey = revisionKey;
		this.#globalCounts = counts;
		await this.#prewarmSlots(sharded.shardCount);
		return true;
	}

	public async importShardedSqlite(
		sharded: ShardedSqliteInput,
		options?: CatalogueSwapOptions,
	): Promise<void> {
		if (sharded.centroids.length !== sharded.shardCount * this.#dimension) {
			throw new RangeError("IVF centroids byte length mismatch");
		}
		this.#recycleExtraShards();
		const rev = options?.revisionKey ?? "";
		await Promise.all([
			this.#shard0.importSqliteFromChunks(sharded.shardChunks(0), {
				...options,
				revisionKey: shardRevKey(rev, 0),
			}),
			this.#prewarmSlots(sharded.shardCount),
		]);
		this.#sharded = sharded;
		this.#revisionKey = rev;
		this.#globalCounts = await this.#shard0.globalCounts();
	}

	public async browseSql(
		options?: CatalogueBrowseOptions,
	): Promise<BrowseResponse> {
		const base = await this.#shard0.browseSql(options);
		const total = this.#globalCounts?.get(options?.category ?? "");
		return total !== undefined ? { ...base, total } : base;
	}

	public candidatePoolSql(
		policy: "popularity" | "freshness" | "affinity_first",
		limit: number,
		profile: SessionProfile,
		weights: ScoringWeights,
	): Promise<SearchResult[]> {
		return this.#shard0.candidatePoolSql(policy, limit, profile, weights);
	}

	public async hybrid(
		query: string,
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<HybridRow>> {
		const shards = this.#probeShards(vector);
		const lists = await Promise.all(
			shards.map((s) =>
				this.#withShardOrOfflineEmpty(s, (db) => db.hybrid(query, vector, k)),
			),
		);
		return fuseShardResults(lists);
	}

	public async vectorSearch(
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<ScoredId>> {
		const lists = await Promise.all(
			this.#probeShards(vector).map((s) =>
				this.#withShardOrOfflineEmpty(s, (db) => db.vectorSearch(vector, k)),
			),
		);
		return lists
			.flat()
			.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
			.slice(0, Math.max(0, k));
	}

	public async nearest(
		id: string,
		k: number,
	): Promise<ReadonlyArray<ScoredId>> {
		const s = shardForProductId(id, this.#sharded?.shardCount ?? 1);
		return (await this.#getShard(s)).nearest(id, k);
	}

	public async productsByIds(
		ids: ReadonlyArray<string>,
	): Promise<ReadonlyMap<string, Product>> {
		const groups = new Map<number, string[]>();
		const totalShards = this.#sharded?.shardCount ?? 1;
		for (const id of ids) {
			const s = shardForProductId(id, totalShards);
			const list = groups.get(s) ?? [];
			list.push(id);
			groups.set(s, list);
		}
		const maps = await Promise.all(
			[...groups.entries()].map(async ([s, group]) =>
				(await this.#getShard(s)).productsByIds(group),
			),
		);
		const out = new Map<string, Product>();
		for (const m of maps) {
			for (const [k, v] of m) out.set(k, v);
		}
		return out;
	}

	public async dispose(): Promise<void> {
		await this.#disposeExtraShards();
		await this.#shard0.dispose();
	}

	#probeShards(vector: Float32Array): number[] {
		const sharded = this.#sharded;
		if (
			sharded === null ||
			sharded.shardCount <= 1 ||
			vector.every((v) => v === 0)
		) {
			return [0];
		}
		const top = rankIvfCentroids(
			vector,
			sharded.centroids,
			this.#dimension,
			DEFAULT_NPROBE,
		);
		return [...new Set([0, ...top])];
	}

	async #withShardOrOfflineEmpty<T>(
		shardIndex: number,
		run: (db: CatalogueDb) => Promise<ReadonlyArray<T>>,
	): Promise<ReadonlyArray<T>> {
		try {
			return await run(await this.#getShard(shardIndex));
		} catch (error) {
			if (shardIndex > 0 && error instanceof NetworkError) {
				return [];
			}
			throw error;
		}
	}

	async #getShard(shardIndex: number): Promise<CatalogueDb> {
		const sharded = this.#sharded;
		if (shardIndex === 0 || sharded === null) return this.#shard0;
		const cached = this.#extra.get(shardIndex);
		if (cached !== undefined) {
			this.#extra.delete(shardIndex);
			this.#extra.set(shardIndex, cached);
			return cached;
		}
		const existing = this.#inflight.get(shardIndex);
		if (existing !== undefined) return existing;
		const pending = this.#openAndImportExtra(shardIndex, sharded).finally(
			() => {
				this.#inflight.delete(shardIndex);
			},
		);
		this.#inflight.set(shardIndex, pending);
		return pending;
	}

	async #prewarmSlots(shardCount: number): Promise<void> {
		const target = Math.min(Math.max(0, shardCount - 1), DEFAULT_NPROBE);
		const needed = Math.max(0, target - this.#allocatedSlots);
		if (needed === 0) return;
		this.#allocatedSlots += needed;
		const opened = await Promise.all(
			Array.from({ length: needed }, () =>
				this.#openShardDb(this.#nextSlotId++, this.#dimension),
			),
		);
		this.#idleSlots.push(...opened);
	}

	async #acquireSlot(): Promise<CatalogueDb> {
		const idle = this.#idleSlots.pop();
		if (idle !== undefined) return idle;
		if (this.#allocatedSlots < MAX_EXTRA_OPEN_SHARDS) {
			this.#allocatedSlots += 1;
			return this.#openShardDb(this.#nextSlotId++, this.#dimension);
		}
		if (this.#extra.size > 0) {
			const [oldest, evicted] = this.#extra.entries().next().value as [
				number,
				CatalogueDb,
			];
			this.#extra.delete(oldest);
			return evicted;
		}
		this.#allocatedSlots += 1;
		return this.#openShardDb(this.#nextSlotId++, this.#dimension);
	}

	async #openAndImportExtra(
		shardIndex: number,
		sharded: ShardedSqliteInput,
	): Promise<CatalogueDb> {
		const bytes = await assembleChunks(sharded.shardChunks(shardIndex));
		const db = await this.#acquireSlot();
		try {
			await db.importSqlite(bytes, {
				revisionKey: shardRevKey(this.#revisionKey, shardIndex),
				swapTimeoutMs: SHARD_SWAP_TIMEOUT_MS,
			});
		} catch (error) {
			this.#allocatedSlots = Math.max(0, this.#allocatedSlots - 1);
			await db.dispose();
			throw error;
		}
		while (this.#extra.size >= MAX_EXTRA_OPEN_SHARDS) {
			const [oldest, overflow] = this.#extra.entries().next().value as [
				number,
				CatalogueDb,
			];
			this.#extra.delete(oldest);
			this.#allocatedSlots = Math.max(0, this.#allocatedSlots - 1);
			await overflow.dispose();
		}
		this.#extra.set(shardIndex, db);
		return db;
	}

	#recycleExtraShards(): void {
		for (const db of this.#extra.values()) {
			this.#idleSlots.push(db);
		}
		this.#extra.clear();
	}

	async #disposeExtraShards(): Promise<void> {
		const dbs = [...this.#extra.values(), ...this.#idleSlots];
		this.#extra.clear();
		this.#idleSlots.length = 0;
		this.#allocatedSlots = 0;
		await Promise.all(dbs.map((db) => db.dispose()));
	}
}
