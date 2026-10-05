import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StorageBadge } from "./StorageBadge";

afterEach(cleanup);

describe("StorageBadge", () => {
	it("says activity stays in this browser when the database is durable", () => {
		render(<StorageBadge durable={true} />);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Running fully on-device · your activity is saved only in this browser",
		);
	});

	it("says plainly when this tab cannot save activity", () => {
		render(<StorageBadge durable={false} />);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Running fully on-device · this tab can’t save your activity, so it resets on reload",
		);
	});

	it("never mentions a cloud or an uplink", () => {
		for (const durable of [true, false]) {
			render(<StorageBadge durable={durable} />);
		}
		const text = screen
			.getAllByRole("status")
			.map((el) => el.textContent ?? "")
			.join(" ");
		expect(text).not.toMatch(/cloud|uplink|sync/i);
	});
});
