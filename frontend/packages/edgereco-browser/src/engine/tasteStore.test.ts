// @vitest-environment node
//
// The taste log in the shopper's OWN SQLite database (edgereco-user), run on
// the real pinned SQLite build (in-process Worker). User data never shares a
// file with the disposable catalogue database.

import { describe, expect, it } from "vitest";
import { CatalogueDb } from "./catalogueDb";
import {
	type CatalogueSql,
	openCatalogueSql,
	openUserSql,
	USER_DATABASE,
} from "./catalogueSql";
import {
	MAX_TASTE_EVENTS,
	openTasteStore,
	SqlTasteStore,
	type TasteRecord,
	TasteResetIncompleteError,
} from "./tasteStore";

function rec(
	productId: string,
	type: TasteRecord["type"] = "click",
	ts = "2026-10-04T00:00:00.000Z",
): TasteRecord {
	return { ts, type, productId };
}

async function freshStore(): Promise<{
	readonly store: SqlTasteStore;
	readonly sql: CatalogueSql;
}> {
	const sql = await openUserSql();
	return { store: await SqlTasteStore.open(sql), sql };
}

/** The same connection, reporting a different storage. */
function withStorage(
	sql: CatalogueSql,
	storage: CatalogueSql["storage"],
): CatalogueSql {
	return {
		storage,
		exec: (text, bind) => sql.exec(text, bind),
		query: (text, bind) => sql.query(text, bind),
		transaction: (statements) => sql.transaction(statements),
		close: () => sql.close(),
	};
}

describe("the user database is its own database", () => {
	it("is named separately from the catalogue", () => {
		expect(USER_DATABASE).toBe("edgereco-user");
	});

	it("openTasteStore opens the user database, and a catalogue rebuild never touches it", async () => {
		const store = await openTasteStore();
		await store.append(rec("P1"));
		const catalogue = await CatalogueDb.open(await openCatalogueSql(), 2);
		await catalogue.replace({ products: [], vectors: new Float32Array() });
		await catalogue.dispose();
		expect(await store.list()).toEqual([rec("P1")]);
		const tables = await (await openCatalogueSql()).query(
			"SELECT name FROM sqlite_master WHERE name = 'taste_events'",
		);
		expect(tables).toEqual([]);
	});
});

describe("SqlTasteStore", () => {
	it("pins the rolling window at 500 events", () => {
		expect(MAX_TASTE_EVENTS).toBe(500);
	});

	it("round-trips appended events in order", async () => {
		const { store } = await freshStore();
		await store.append(rec("P1"));
		await store.append(rec("P2", "favorite"));
		await store.append(rec("P3", "view"));
		expect(await store.list()).toEqual([
			rec("P1"),
			rec("P2", "favorite"),
			rec("P3", "view"),
		]);
		expect(await store.count()).toBe(3);
	});

	it("keeps only the newest MAX_TASTE_EVENTS rows on disk", async () => {
		const { store, sql } = await freshStore();
		for (let i = 0; i < MAX_TASTE_EVENTS + 3; i += 1) {
			await store.append(rec(`P${i}`));
		}
		const events = await store.list();
		expect(events).toHaveLength(MAX_TASTE_EVENTS);
		expect(events[0]?.productId).toBe("P3");
		const [row] = await sql.query("SELECT count(*) AS n FROM taste_events");
		expect(Number(row?.n)).toBe(MAX_TASTE_EVENTS);
	});

	it("clear() empties the table", async () => {
		const { store } = await freshStore();
		await store.append(rec("P1"));
		await store.clear();
		expect(await store.list()).toEqual([]);
	});

	it("clear() fails loudly when rows survive the delete", async () => {
		const { sql } = await freshStore();
		const stuck: CatalogueSql = {
			...withStorage(sql, sql.storage),
			exec: (text, bind) =>
				text.startsWith("DELETE") ? Promise.resolve() : sql.exec(text, bind),
		};
		const store = await SqlTasteStore.open(stuck);
		await store.append(rec("P1"));
		await expect(store.clear()).rejects.toBeInstanceOf(
			TasteResetIncompleteError,
		);
	});

	it("refuses an unknown event type or an empty product id at the schema", async () => {
		const { sql } = await freshStore();
		await expect(
			sql.exec(
				"INSERT INTO taste_events(ts, type, product_id) VALUES ('t', 'hack', 'P')",
			),
		).rejects.toThrow();
		await expect(
			sql.exec(
				"INSERT INTO taste_events(ts, type, product_id) VALUES ('t', 'click', '')",
			),
		).rejects.toThrow();
	});

	it("derives ownership from where the database lives", async () => {
		const { sql } = await freshStore();
		const owner = await SqlTasteStore.open(
			withStorage(sql, { persistence: "opfs", pool: "p", file: "f" }),
		);
		const secondary = await SqlTasteStore.open(
			withStorage(sql, { persistence: "memory", reason: "pool-in-use" }),
		);
		const volatile = await SqlTasteStore.open(
			withStorage(sql, { persistence: "memory", reason: "opfs-unavailable" }),
		);
		expect([owner.ownership, owner.durable]).toEqual(["owner", true]);
		expect([secondary.ownership, secondary.durable]).toEqual([
			"secondary",
			false,
		]);
		expect([volatile.ownership, volatile.durable]).toEqual(["volatile", false]);
	});

	it("survives a re-open of the same database (schema is idempotent)", async () => {
		const { store, sql } = await freshStore();
		await store.append(rec("P1"));
		const again = await SqlTasteStore.open(sql);
		expect(await again.list()).toEqual([rec("P1")]);
	});
});

describe("SqlTasteStore.importLegacy (copy step of copy-then-retire)", () => {
	it("copies legacy events", async () => {
		const { store } = await freshStore();
		await store.importLegacy([rec("L1"), rec("L2")]);
		expect(await store.list()).toEqual([rec("L1"), rec("L2")]);
	});

	it("is idempotent: a crash-and-rerun never duplicates events", async () => {
		const { store } = await freshStore();
		await store.importLegacy([rec("L1"), rec("L2")]);
		await store.importLegacy([rec("L1"), rec("L2")]);
		expect(await store.list()).toEqual([rec("L1"), rec("L2")]);
	});

	it("rollback-then-forward keeps the events the old build logged in between", async () => {
		const { store } = await freshStore();
		const t0 = "2026-10-01T00:00:00.000Z";
		const t1 = "2026-10-02T00:00:00.000Z";
		await store.importLegacy([rec("OLD", "click", t0)]); // first upgrade
		await store.append(rec("NEW", "click", t1)); // new build, then rollback
		// The old build writes a fresh file; it holds only what it saw.
		const rollbackWindow = rec("RB", "cart", "2026-10-03T00:00:00.000Z");
		await store.importLegacy([rollbackWindow]); // forward again
		expect((await store.list()).map((e) => e.productId)).toEqual([
			"OLD",
			"NEW",
			"RB",
		]);
	});

	it("caps an oversized legacy log to the rolling window", async () => {
		const { store } = await freshStore();
		const many = Array.from({ length: MAX_TASTE_EVENTS + 2 }, (_, i) =>
			rec(`L${i}`),
		);
		await store.importLegacy(many);
		const events = await store.list();
		expect(events).toHaveLength(MAX_TASTE_EVENTS);
		expect(events[0]?.productId).toBe("L2");
	});

	it("rolls back the whole copy when a row is invalid", async () => {
		const { store } = await freshStore();
		await expect(
			store.importLegacy([rec("L1"), { ...rec(""), productId: "" }]),
		).rejects.toThrow();
		expect(await store.list()).toEqual([]);
	});

	it("an empty legacy file imports nothing", async () => {
		const { store } = await freshStore();
		await store.importLegacy([]);
		expect(await store.count()).toBe(0);
	});
});
