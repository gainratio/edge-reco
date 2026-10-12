import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Footer } from "./Footer";

afterEach(cleanup);

describe("Footer", () => {
	it("states plainly that Nimbus is a fictional demo store", () => {
		render(<Footer />);
		expect(
			screen.getByText(/Nimbus is a fictional demo store/i),
		).toBeInTheDocument();
	});

	it("links to the edge-reco repo", () => {
		render(<Footer />);
		const link = screen.getByRole("link", { name: "edge-reco" });
		expect(link).toHaveAttribute(
			"href",
			"https://github.com/gainratio/edge-reco",
		);
	});

	it("credits the catalog data source for attribution", () => {
		render(<Footer />);
		expect(screen.getByText(/Product data:/i)).toBeInTheDocument();
	});

	it("states plainly that EdgeReco is open source and runs on the device", () => {
		render(<Footer />);
		expect(screen.getByText(/open source/i)).toBeInTheDocument();
		expect(screen.getByText(/runs on your device/i)).toBeInTheDocument();
	});

	it("links to the EdgeProc substrate repo on GitHub", () => {
		render(<Footer />);
		expect(
			screen.getByRole("link", { name: /EdgeProc substrate/i }),
		).toHaveAttribute("href", "https://github.com/gainratio/edge-proc");
	});

	it("links to the EdgeProc entity page at its clean URL", () => {
		render(<Footer />);
		expect(
			screen.getByRole("link", { name: /What is EdgeProc/i }),
		).toHaveAttribute("href", "/edgeproc");
	});

	it("links to the FAQ entity page at its clean URL", () => {
		render(<Footer />);
		expect(screen.getByRole("link", { name: "FAQ" })).toHaveAttribute(
			"href",
			"/faq",
		);
	});

	// The three live sites used to link only to themselves, so nothing on the
	// open web pointed at edge-reco.com and its pages sat crawled-but-unindexed.
	// A crawler follows an <a href>; it does not follow a sitemap into a domain
	// nobody links to. These are the outbound edges that fix that.
	it("links out to the sibling live sites", () => {
		render(<Footer />);
		expect(screen.getByRole("link", { name: /AML-Filter/i })).toHaveAttribute(
			"href",
			"https://aml-filter.com/",
		);
		expect(screen.getByRole("link", { name: /AlmaMesh/i })).toHaveAttribute(
			"href",
			"https://almamesh.com/",
		);
	});

	it("links to the gainratio org's full repository list", () => {
		render(<Footer />);
		expect(
			screen.getByRole("link", { name: /All repositories/i }),
		).toHaveAttribute("href", "https://github.com/gainratio");
	});
});
