import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Toast } from "./Toast";

afterEach(cleanup);

describe("Toast", () => {
	it("renders nothing when there is no message", () => {
		render(<Toast message={null} />);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("renders the message as a polite status when present", () => {
		render(<Toast message="Favorited “Walnut Desk”" />);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("Favorited “Walnut Desk”");
	});

	it("wraps the message in the clamped element so long titles cannot overflow", () => {
		// Long product titles ("Added ... to your taste") must be width-capped and
		// line-clamped; the CSS clamp binds to .toast__msg, so the message text must
		// render inside that element rather than as a bare text node.
		const long =
			"Added “Crafthollow Portable Craft Caddy, Clear, With Handle, Single” to your taste";
		render(<Toast message={long} />);
		const message = screen.getByText(long);
		expect(message).toHaveClass("toast__msg");
		expect(message.closest(".toast")).not.toBeNull();
	});
});
