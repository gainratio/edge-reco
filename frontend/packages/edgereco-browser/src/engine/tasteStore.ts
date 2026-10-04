// The shopper's taste log, in the shopper's OWN SQLite database.
//
// SQLite is the only store for app data, and user data never shares a file
// with rebuildable data:
//
//   edgereco-catalogue  disposable: rebuilt from the signed bundle every boot.
//   edgereco-user       the shopper's data. Never rebuilt, never deleted on a
//                       catalogue refresh; the database a future export/import
//                       covers. Opened through the same seam (catalogueSql.ts).
//
//   taste_events  one row per interaction: timestamp, type, product id. No
//                 user id, no session id, nothing that leaves the device.
//                 A rolling window of the newest MAX_TASTE_EVENTS rows.
//
// OWNERSHIP: OPFS gives one tab the database at a time.
//   owner      this tab holds the durable OPFS copy.
//   secondary  another tab owns it; this tab runs on an in-memory copy, so a
//              reset here must be routed to the owner (app resetCoordinator).
//   volatile   OPFS is refused (e.g. private mode); nothing is durable.

import { type CatalogueSql, openUserSql } from "./catalogueSql";
import type { EventType } from "./domain";

/** Rolling window: the table keeps only the newest 500 events. */
export const MAX_TASTE_EVENTS = 500;

/** One logged interaction. */
export interface TasteRecord {
	readonly ts: string;
	readonly type: EventType;
	readonly productId: string;
}

export type TasteOwnership = "owner" | "secondary" | "volatile";

/** A reset that left rows behind. Never reported as success. */
export class TasteResetIncompleteError extends Error {
	public constructor(remaining: number) {
		super(`reset left ${remaining} saved activity rows behind`);
		this.name = "TasteResetIncompleteError";
	}
}

/** The taste-log surface the app uses. */
export interface TasteStore {
	/** True only when this tab holds the durable OPFS copy. */
	readonly durable: boolean;
	readonly ownership: TasteOwnership;
	append(record: TasteRecord): Promise<void>;
	/** All events, oldest first. */
	list(): Promise<ReadonlyArray<TasteRecord>>;
	count(): Promise<number>;
	/** Delete every row, then verify; throws TasteResetIncompleteError. */
	clear(): Promise<void>;
	/**
	 * Copy legacy events in. Idempotent per event: an event already present
	 * (same timestamp, type and product) is skipped, so a crash-and-rerun never
	 * duplicates, and a rollback-then-forward imports only what is new.
	 */
	importLegacy(records: ReadonlyArray<TasteRecord>): Promise<void>;
}

const EVENT_TYPES: ReadonlyArray<EventType> = [
	"click",
	"view",
	"favorite",
	"cart",
];

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS taste_events(
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		ts TEXT NOT NULL,
		type TEXT NOT NULL CHECK (type IN ('click', 'view', 'favorite', 'cart')),
		product_id TEXT NOT NULL CHECK (product_id <> '')
	);
	CREATE INDEX IF NOT EXISTS taste_events_identity
		ON taste_events(ts, type, product_id);
`;

const INSERT_SQL =
	"INSERT INTO taste_events(ts, type, product_id) VALUES (?, ?, ?)";

const TRIM_SQL = `
	DELETE FROM taste_events WHERE seq <= (
		SELECT seq FROM taste_events ORDER BY seq DESC LIMIT 1 OFFSET ?
	)
`;

const IMPORT_SQL = `
	INSERT INTO taste_events(ts, type, product_id)
	SELECT ?1, ?2, ?3 WHERE NOT EXISTS (
		SELECT 1 FROM taste_events WHERE ts = ?1 AND type = ?2 AND product_id = ?3
	)
`;

function isEventType(value: unknown): value is EventType {
	return EVENT_TYPES.some((type) => type === value);
}

function ownershipOf(storage: CatalogueSql["storage"]): TasteOwnership {
	if (storage.persistence === "opfs") {
		return "owner";
	}
	return storage.reason === "pool-in-use" ? "secondary" : "volatile";
}

/** The taste log over one open user database. */
export class SqlTasteStore implements TasteStore {
	readonly #sql: CatalogueSql;
	public readonly ownership: TasteOwnership;
	public readonly durable: boolean;

	private constructor(sql: CatalogueSql) {
		this.#sql = sql;
		this.ownership = ownershipOf(sql.storage);
		this.durable = this.ownership === "owner";
	}

	/** Create the table if missing. Safe to call on every boot. */
	public static async open(sql: CatalogueSql): Promise<SqlTasteStore> {
		await sql.exec(SCHEMA);
		return new SqlTasteStore(sql);
	}

	public async append(record: TasteRecord): Promise<void> {
		await this.#sql.transaction([
			{ sql: INSERT_SQL, bind: [record.ts, record.type, record.productId] },
			{ sql: TRIM_SQL, bind: [MAX_TASTE_EVENTS] },
		]);
	}

	public async list(): Promise<ReadonlyArray<TasteRecord>> {
		const rows = await this.#sql.query(
			"SELECT ts, type, product_id FROM taste_events ORDER BY seq",
		);
		// The CHECK constraint already refuses bad types; this narrows it.
		return rows.flatMap((row) =>
			isEventType(row.type)
				? [
						{
							ts: String(row.ts),
							type: row.type,
							productId: String(row.product_id),
						},
					]
				: [],
		);
	}

	public async count(): Promise<number> {
		const [row] = await this.#sql.query(
			"SELECT count(*) AS n FROM taste_events",
		);
		return Number(row?.n ?? 0);
	}

	public async clear(): Promise<void> {
		await this.#sql.exec("DELETE FROM taste_events");
		const remaining = await this.count();
		if (remaining !== 0) {
			throw new TasteResetIncompleteError(remaining);
		}
	}

	public async importLegacy(
		records: ReadonlyArray<TasteRecord>,
	): Promise<void> {
		if (records.length === 0) {
			return;
		}
		const rows = records.map((r) => [r.ts, r.type, r.productId]);
		await this.#sql.transaction([
			{ sql: IMPORT_SQL, rows },
			{ sql: TRIM_SQL, bind: [MAX_TASTE_EVENTS] },
		]);
	}
}

/** Open the shopper's taste log in the user database. */
export async function openTasteStore(): Promise<TasteStore> {
	return SqlTasteStore.open(await openUserSql());
}
