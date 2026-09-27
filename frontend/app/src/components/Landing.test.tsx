import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BUNDLE_SIZE,
	LANDING_MEASURED_ON,
	LANDING_METRICS,
} from "../metrics/landing-figures";
import { Landing } from "./Landing";

afterEach(cleanup);

describe("Landing", () => {
	it("renders the headline and its cost-story accent", () => {
		render(<Landing onLaunch={() => {}} />);
		const heading = screen.getByRole("heading", { level: 1 });
		expect(heading).toHaveTextContent(
			"Your store gets busier. Your recommendation bill shouldn't.",
		);
		// the accent phrase is an <em> styled with --signal
		expect(heading.querySelector("em")).toHaveTextContent("shouldn't");
	});

	it("renders all six representative metric tiles", () => {
		render(<Landing onLaunch={() => {}} />);
		const labels = [
			"per search (median)",
			"backend calls after sync",
			"first visit to first results",
			"JS heap (Chromium)",
			"inference / 1k recs",
			"real products, in-tab",
		];
		for (const label of labels) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
		// honesty labels are present, not scrubbed
		expect(screen.getByText("JS heap (Chromium)")).toBeInTheDocument();
		expect(
			screen.getByText("illustrative · only CDN bandwidth"),
		).toBeInTheDocument();
	});

	it("renders the five why cards and the footnote", () => {
		render(<Landing onLaunch={() => {}} />);
		for (const k of [
			"Private",
			"Offline",
			"Instant",
			"Cheap to run",
			"Always learning",
		]) {
			expect(screen.getByText(k)).toBeInTheDocument();
		}
		// the flywheel is a first-class value prop, framed honestly
		expect(
			screen.getByText(/Switch on an optional loop — off by default/),
		).toBeInTheDocument();
		// the Private card is reframed: shopper activity stays on-device by default,
		// the optional learning loop is off until switched on
		expect(
			screen.getByText(
				/The optional learning loop is off until you switch it on/,
			),
		).toBeInTheDocument();
		// Derived from the constant, never hardcoded. This line used to pin "~2.2 MB"
		// while the bundle on disk was 1.5 MB, so a green suite kept a wrong figure
		// alive in front of users. Split of duties: landing-figures.test.ts asserts
		// the constant is TRUE against the bundle's bytes; this asserts the footnote
		// actually renders it.
		const bundleSize = BUNDLE_SIZE.replaceAll(".", "\\.");
		expect(
			screen.getByText(new RegExp(`~${bundleSize} signed bundle`)),
		).toBeInTheDocument();
	});

	it("renders the measured first-visit time and the date it was measured", () => {
		render(<Landing onLaunch={() => {}} />);
		const cold = LANDING_METRICS.find((m) => m.id === "coldStart");
		expect(screen.getByText(cold?.num ?? "missing")).toBeInTheDocument();
		expect(
			screen.getByText(`measured on edge-reco.com, ${LANDING_MEASURED_ON}`),
		).toBeInTheDocument();
		expect(
			screen.getByText(new RegExp(`${cold?.vars?.warm} on return`)),
		).toBeInTheDocument();
	});

	it("calls onLaunch when the Launch CTA is clicked", async () => {
		const onLaunch = vi.fn();
		render(<Landing onLaunch={onLaunch} />);
		await userEvent.click(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		);
		expect(onLaunch).toHaveBeenCalledTimes(1);
	});
});
