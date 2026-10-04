// @vitest-environment node
//
// The taste log as SQL tables in the catalogue database, run on the real pinned
// SQLite build (in-process Worker). This replaced the raw OPFS file
// taste/events.jsonl: SQLite is the only store for app data.

import { describe, expect, it } from "vitest";
import { type CatalogueSql, openCatalogueSql } from "./catalogueSql";
import {
	LEGACY_TASTE_MIGRATION,
	MAX_TASTE_EVENTS,
	SqlTasteStore,
	type TasteRecord,
} from "./tasteStore";

function rec(
	productId: string,
	type: TasteRecord["type"] = "click",
): TasteRecord {
	return { ts: "2026-10-04T00:00:00.000Z", type, productId };
}

async function freshStore(): Promise<{
	readonly store: SqlTasteStore;
	readonly sql: CatalogueSql;
}> {
	const sql = await openCatalogueSql();
	return { store: await SqlTasteStore.open(sql), sql };
}

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

	it("reports durability from where the database actually lives", async () => {
		const { store } = await freshStore();
		// Node has no OPFS, so the seam falls back to memory.
		expect(store.durable).toBe(false);
	});

	it("survives a re-open of the same database (schema is idempotent)", async () => {
		const { store, sql } = await freshStore();
		await store.append(rec("P1"));
		const again = await SqlTasteStore.open(sql);
		expect(await again.list()).toEqual([rec("P1")]);
	});
});

describe("SqlTasteStore.importLegacy (copy step of copy-then-retire)", () => {
	it("copies legacy events once and records the migration in the same transaction", async () => {
		const { store, sql } = await freshStore();
		await store.importLegacy([rec("L1"), rec("L2")]);
		expect(await store.list()).toEqual([rec("L1"), rec("L2")]);
		const marks = await sql.query(
			"SELECT name FROM app_migrations WHERE name = ?",
			[LEGACY_TASTE_MIGRATION],
		);
		expect(marks).toHaveLength(1);
	});

	it("is idempotent: a crash-and-rerun never duplicates events", async () => {
		const { store } = await freshStore();
		await store.importLegacy([rec("L1"), rec("L2")]);
		await store.importLegacy([rec("L1"), rec("L2")]);
		expect(await store.list()).toEqual([rec("L1"), rec("L2")]);
	});

	it("never re-imports after a reset (the marker outlives clear())", async () => {
		const { store } = await freshStore();
		await store.importLegacy([rec("L1")]);
		await store.clear();
		await store.importLegacy([rec("L1")]);
		expect(await store.list()).toEqual([]);
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

	it("rolls back the copy when a row is invalid, leaving no marker", async () => {
		const { store, sql } = await freshStore();
		await expect(
			store.importLegacy([rec("L1"), { ...rec(""), productId: "" }]),
		).rejects.toThrow();
		expect(await store.list()).toEqual([]);
		const marks = await sql.query("SELECT name FROM app_migrations");
		expect(marks).toEqual([]);
	});
});
