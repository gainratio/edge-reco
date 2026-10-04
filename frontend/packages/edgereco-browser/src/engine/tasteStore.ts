// The shopper's taste log, as tables in the catalogue database.
//
// SQLite is the only store for app data. The taste log used to be a raw OPFS
// file (taste/events.jsonl); it now lives next to the catalogue in the same
// SQLite database, reached through the same seam (catalogueSql.ts), so reset,
// durability and the storage report all cover it.
//
//   taste_events    one row per interaction: timestamp, type, product id.
//                   No user id, no session id, nothing that leaves the device.
//                   A rolling window of the newest MAX_TASTE_EVENTS rows.
//   app_migrations  one row per finished one-time migration (copy-then-retire
//                   markers), written in the SAME transaction as the copy.
//
// `durable` says where the database actually lives. When OPFS is refused or
// another tab owns the database, the seam opens it in memory: the log still
// works for this tab but is gone on reload, and the app tells the shopper.

import type { CatalogueSql } from "./catalogueSql";
import type { EventType } from "./domain";

/** Rolling window: the table keeps only the newest 500 events. */
export const MAX_TASTE_EVENTS = 500;

/** The migration marker for the old OPFS file taste/events.jsonl. */
export const LEGACY_TASTE_MIGRATION = "taste-log-opfs-jsonl-v1";

/** One logged interaction. */
export interface TasteRecord {
	readonly ts: string;
	readonly type: EventType;
	readonly productId: string;
}

/** The taste-log surface the app uses. */
export interface TasteStore {
	/** True only when the database is in OPFS (survives a reload). */
	readonly durable: boolean;
	append(record: TasteRecord): Promise<void>;
	/** All events, oldest first. */
	list(): Promise<ReadonlyArray<TasteRecord>>;
	clear(): Promise<void>;
	/**
	 * Copy legacy events in, once. Rows and the migration marker commit in one
	 * transaction, so a crash either leaves nothing or everything, and a rerun
	 * after the marker is a no-op.
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
	CREATE TABLE IF NOT EXISTS app_migrations(
		name TEXT PRIMARY KEY,
		done_at TEXT NOT NULL
	);
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
	SELECT ?, ?, ? WHERE NOT EXISTS (
		SELECT 1 FROM app_migrations WHERE name = ?
	)
`;

const MARK_SQL =
	"INSERT OR IGNORE INTO app_migrations(name, done_at) VALUES (?, ?)";

function isEventType(value: unknown): value is EventType {
	return EVENT_TYPES.some((type) => type === value);
}

/** The taste log over one open catalogue database. */
export class SqlTasteStore implements TasteStore {
	readonly #sql: CatalogueSql;
	public readonly durable: boolean;

	private constructor(sql: CatalogueSql) {
		this.#sql = sql;
		this.durable = sql.storage.persistence === "opfs";
	}

	/** Create the tables if missing. Safe to call on every boot. */
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
		const out: TasteRecord[] = [];
		for (const row of rows) {
			// The CHECK constraints already refuse bad rows; this narrows the type.
			if (isEventType(row.type)) {
				out.push({
					ts: String(row.ts),
					type: row.type,
					productId: String(row.product_id),
				});
			}
		}
		return out;
	}

	public async clear(): Promise<void> {
		await this.#sql.exec("DELETE FROM taste_events");
	}

	public async importLegacy(
		records: ReadonlyArray<TasteRecord>,
	): Promise<void> {
		const name = LEGACY_TASTE_MIGRATION;
		const rows = records.map((r) => [r.ts, r.type, r.productId, name]);
		await this.#sql.transaction([
			...(rows.length > 0 ? [{ sql: IMPORT_SQL, rows }] : []),
			{ sql: MARK_SQL, bind: [name, new Date().toISOString()] },
			{ sql: TRIM_SQL, bind: [MAX_TASTE_EVENTS] },
		]);
	}
}
