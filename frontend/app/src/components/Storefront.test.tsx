// Storefront is the orchestration root: it wires the data layer (engine client),
// the explicit-signal emitter, and the live-metrics observer into the Header /
// rails / grid / PDP view tree. These specs mock those three boundaries so the
// orchestration logic — mount loads, click→PDP→back, error+retry, category
// re-browse, search, cart/favorite signals — is exercised as fast jsdom units.
// The real engine, the IntersectionObserver dwell path, and motion animations
// are intentionally left to the Playwright e2e/offline suites (no jsdom IO; the
// dwell hook already documents its silent no-op under jsdom).

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Product, SearchResult, Strategy } from "../api/types";

const mocks = vi.hoisted(() => ({
	browse: vi.fn(),
	search: vi.fn(),
	recommendStrategy: vi.fn(),
	similar: vi.fn(),
	strategies: vi.fn(),
	catalog: vi.fn(),
	catalogInfo: vi.fn(),
	rankingProofEvidence: vi.fn(),
	resetSession: vi.fn(),
	replayedSignalCount: vi.fn(),
	emitInteraction: vi.fn(),
	resetSignalCaps: vi.fn(),
}));

vi.mock("../api/client", () => ({
	browse: mocks.browse,
	search: mocks.search,
	recommendStrategy: mocks.recommendStrategy,
	similar: mocks.similar,
	strategies: mocks.strategies,
	catalog: mocks.catalog,
	catalogInfo: mocks.catalogInfo,
	rankingProofEvidence: mocks.rankingProofEvidence,
	resetSession: mocks.resetSession,
	replayedSignalCount: mocks.replayedSignalCount,
}));
vi.mock("../signals/emit", () => ({
	emitInteraction: mocks.emitInteraction,
	resetSignalCaps: mocks.resetSignalCaps,
}));
// The live-metrics observer pokes real browser APIs; keep it a no-op here.
vi.mock("../metrics/observe", () => ({
	startMetricsObservers: () => () => {},
}));

import { Storefront } from "./Storefront";

function makeProduct(id: string, title: string): Product {
	return {
		id,
		title,
		description: "",
		category: "Office Products",
		subcategories: [],
		tags: [],
		brand: "Acme",
		price: 12,
		currency: "USD",
		popularity_score: 0.5,
		freshness_score: 0.5,
		// A release-owned image_url makes ProductImage render an <img alt=title>; the
		// fallback tile would otherwise repeat the title as visible text and make
		// findByText ambiguous.
		image_url: `/test-assets/${id}.jpg`,
		url: "",
		attributes: {},
	};
}

function result(id: string, title: string): SearchResult {
	return {
		product: makeProduct(id, title),
		score: 0.9,
		score_components: null,
	};
}

const GRID = [
	makeProduct("G1", "Grid Gadget"),
	makeProduct("G2", "Grid Gizmo"),
];
const RAIL = [result("R1", "Rail Widget")];
const SEARCH_HIT = result("S1", "Lamp Deluxe");

beforeEach(() => {
	// Every case starts on the browse view's canonical URL (no PDP hash).
	window.history.replaceState(null, "", "/");
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	mocks.strategies.mockReturnValue({} as Record<string, Strategy>);
	mocks.catalog.mockReturnValue(GRID);
	mocks.resetSession.mockResolvedValue(undefined);
	mocks.replayedSignalCount.mockReturnValue(0);
	mocks.browse.mockResolvedValue({
		products: GRID,
		total: GRID.length,
		categories: ["Books", "Office"],
	});
	mocks.recommendStrategy.mockResolvedValue({
		results: RAIL,
		session_clicks: 0,
	});
	mocks.similar.mockResolvedValue({ results: [], session_clicks: 0 });
	mocks.search.mockResolvedValue({
		results: [SEARCH_HIT],
		query: "lamp",
		total: 1,
	});
	mocks.catalogInfo.mockResolvedValue({ count: 720 });
	mocks.rankingProofEvidence.mockReturnValue({
		status: "unavailable",
		publisherSignature: "not_checked",
		configHash: "not_checked",
		reason: "legacy",
	});
	mocks.emitInteraction.mockResolvedValue({ emitted: true, message: null });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("Storefront mount", () => {
	it("renders the header search, the For-You rail and the catalog grid", async () => {
		render(<Storefront />);

		expect(screen.getByLabelText("Search products")).toBeInTheDocument();
		// Grid populated from browse().
		expect(await screen.findByText("Grid Gadget")).toBeInTheDocument();
		// Rail populated from recommendStrategy() — v1 bundle degrades to For You.
		expect(
			screen.getByRole("heading", { name: "Recommended for you" }),
		).toBeInTheDocument();
		expect(screen.getByText("Rail Widget")).toBeInTheDocument();
		expect(mocks.browse).toHaveBeenCalledWith({ limit: 24 });
	});

	it("puts the grid h1 before the rail h2s in DOM order (heading outline)", async () => {
		render(<Storefront />);

		// Wait for both the grid (owns the page h1) and a rail (owns an h2).
		expect(await screen.findByText("Grid Gadget")).toBeInTheDocument();
		expect(await screen.findByText("Rail Widget")).toBeInTheDocument();

		const h1 = screen.getByRole("heading", { level: 1 });
		const h2s = screen.getAllByRole("heading", { level: 2 });
		expect(h2s.length).toBeGreaterThan(0);
		for (const h2 of h2s) {
			// A sound outline: the page h1 precedes every rail h2 in DOM order
			// (the visual stack may still show rails first via CSS order).
			expect(
				h1.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		}
	});
});

describe("Storefront product navigation", () => {
	it("opens the PDP on a product click and returns on Back", async () => {
		render(<Storefront />);
		const grid = await screen.findByText("Grid Gadget");
		await userEvent.click(
			grid.closest("article")?.querySelector("button") ?? grid,
		);

		// PDP hero + a seeded rail; the click was recorded as an engine signal.
		expect(
			await screen.findByRole("heading", { level: 1, name: "Grid Gadget" }),
		).toBeInTheDocument();
		expect(mocks.emitInteraction).toHaveBeenCalledWith(
			"click",
			expect.objectContaining({ id: "G1" }),
		);

		await userEvent.click(
			screen.getByRole("button", { name: /Back to browse/i }),
		);
		expect(await screen.findByText("Grid Gadget")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Back to browse/i }),
		).not.toBeInTheDocument();
	});
});

describe("Storefront error handling", () => {
	it("surfaces a rail fetch failure through the error banner, not silently", async () => {
		// A real engine fault on the rails path (e.g. fail-closed malformed bundle)
		// must reach the user via the app's error surface — an empty rail with only
		// a console.warn is a silent degrade.
		mocks.recommendStrategy.mockRejectedValue(new Error("rail engine fault"));
		render(<Storefront />);

		expect(
			await screen.findByText("Couldn’t reach the engine"),
		).toBeInTheDocument();
		expect(screen.getByText("rail engine fault")).toBeInTheDocument();
		// The degrade is preserved: the grid still renders; one bad rail never
		// crashes the page.
		expect(await screen.findByText("Grid Gadget")).toBeInTheDocument();
	});

	it("recovers from a rail failure when Retry succeeds", async () => {
		mocks.recommendStrategy.mockRejectedValueOnce(
			new Error("rail engine fault"),
		);
		render(<Storefront />);
		expect(
			await screen.findByText("Couldn’t reach the engine"),
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Retry" }));

		expect(await screen.findByText("Rail Widget")).toBeInTheDocument();
		await waitFor(() =>
			expect(
				screen.queryByText("Couldn’t reach the engine"),
			).not.toBeInTheDocument(),
		);
	});

	it("shows an error banner and recovers when Retry succeeds", async () => {
		mocks.browse.mockRejectedValueOnce(new Error("engine offline"));
		render(<Storefront />);

		expect(
			await screen.findByText("Couldn’t reach the engine"),
		).toBeInTheDocument();
		expect(screen.getByText("engine offline")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Retry" }));

		expect(await screen.findByText("Grid Gadget")).toBeInTheDocument();
		expect(
			screen.queryByText("Couldn’t reach the engine"),
		).not.toBeInTheDocument();
	});
});

describe("Storefront category + search", () => {
	it("re-browses within a selected category", async () => {
		render(<Storefront />);
		await userEvent.click(await screen.findByRole("button", { name: "Books" }));
		await waitFor(() =>
			expect(mocks.browse).toHaveBeenCalledWith({
				limit: 24,
				category: "Books",
			}),
		);
	});

	it("clears the search box when a category is selected", async () => {
		render(<Storefront />);
		await screen.findByText("Grid Gadget");
		const input = screen.getByLabelText("Search products");
		await userEvent.type(input, "abc");
		expect(input).toHaveValue("abc");

		await userEvent.click(screen.getByRole("button", { name: "Books" }));
		expect(input).toHaveValue("");
	});

	it("runs a hybrid search as the query settles", async () => {
		render(<Storefront />);
		await screen.findByText("Grid Gadget");
		vi.useFakeTimers();
		fireEvent.change(screen.getByLabelText("Search products"), {
			target: { value: "lamp" },
		});
		await act(() => vi.advanceTimersByTimeAsync(300));

		expect(screen.getByText("Lamp Deluxe")).toBeInTheDocument();
		expect(mocks.search).toHaveBeenCalledWith("lamp", { limit: 24 });
	});

	it("surfaces search results above the rails with a labelled cue", async () => {
		render(<Storefront />);
		// Browse view first: the rail sits above the grid before any query.
		await screen.findByText("Grid Gadget");
		vi.useFakeTimers();
		fireEvent.change(screen.getByLabelText("Search products"), {
			target: { value: "lamp" },
		});
		await act(() => vi.advanceTimersByTimeAsync(300));

		// The matched product renders, surfaced beneath a labelled "Results for …"
		// cue that echoes the query.
		const hit = screen.getByText("Lamp Deluxe");
		const cue = screen.getByText("Results for “lamp”");
		const rail = screen.getByRole("heading", { name: "Recommended for you" });
		expect(
			cue.compareDocumentPosition(hit) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			hit.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// Entering search pulled the freshly-surfaced results into view.
		expect(window.scrollTo).toHaveBeenCalled();
	});

	it("shows the query once: in the search box, never echoed by a visible heading", async () => {
		render(<Storefront />);
		await screen.findByText("Grid Gadget");
		vi.useFakeTimers();
		fireEvent.change(screen.getByLabelText("Search products"), {
			target: { value: "lamp" },
		});
		await act(() => vi.advanceTimersByTimeAsync(300));
		expect(screen.getByText("Lamp Deluxe")).toBeInTheDocument();

		// The page h1 is a plain results label, not a second copy of the query.
		const h1 = screen.getByRole("heading", { level: 1 });
		expect(h1).toHaveTextContent("Search results");
		expect(h1.textContent ?? "").not.toMatch(/lamp/i);
		// ...and "Search results" is not stacked as both kicker and title.
		expect(screen.getAllByText("Search results")).toHaveLength(1);
		// The "Results for …" announcement stays for screen readers only: it is a
		// polite live region, visually hidden so sighted users see the query once.
		const cue = screen.getByText("Results for “lamp”");
		expect(cue).toHaveAttribute("role", "status");
		expect(cue).toHaveClass("visually-hidden");
	});
});

describe("Storefront stale-search race (latest-wins)", () => {
	type SearchPayload = {
		results: SearchResult[];
		query: string;
		total: number;
	};

	it("drops a slow older query that resolves after a newer one", async () => {
		const resolvers = new Map<string, (r: SearchPayload) => void>();
		mocks.search.mockImplementation(
			(q: string) =>
				new Promise<SearchPayload>((resolve) => {
					resolvers.set(q, resolve);
				}),
		);

		render(<Storefront />);
		await screen.findByText("Grid Gadget");
		const input = screen.getByLabelText("Search products");

		// The soon-to-be-stale query settles and goes in flight (still pending).
		await userEvent.type(input, "old");
		await waitFor(() => expect(resolvers.has("old")).toBe(true));

		// A newer query supersedes it before the older one resolves.
		await userEvent.clear(input);
		await userEvent.type(input, "new");
		await waitFor(() => expect(resolvers.has("new")).toBe(true));

		// The newer query resolves first and paints…
		resolvers.get("new")?.({
			results: [result("N1", "New Result")],
			query: "new",
			total: 1,
		});
		expect(await screen.findByText("New Result")).toBeInTheDocument();

		// …then the stale older query resolves LATE — it must not overwrite results.
		resolvers.get("old")?.({
			results: [result("O1", "Old Result")],
			query: "old",
			total: 1,
		});
		await waitFor(() =>
			expect(screen.queryByText("Old Result")).not.toBeInTheDocument(),
		);
		expect(screen.getByText("New Result")).toBeInTheDocument();
	});

	it("swallows a stale query that rejects after a newer one succeeds", async () => {
		const controls = new Map<
			string,
			{ resolve: (r: SearchPayload) => void; reject: (e: Error) => void }
		>();
		mocks.search.mockImplementation(
			(q: string) =>
				new Promise<SearchPayload>((resolve, reject) => {
					controls.set(q, { resolve, reject });
				}),
		);

		render(<Storefront />);
		await screen.findByText("Grid Gadget");
		const input = screen.getByLabelText("Search products");

		await userEvent.type(input, "old");
		await waitFor(() => expect(controls.has("old")).toBe(true));
		await userEvent.clear(input);
		await userEvent.type(input, "new");
		await waitFor(() => expect(controls.has("new")).toBe(true));

		controls.get("new")?.resolve({
			results: [result("N1", "New Result")],
			query: "new",
			total: 1,
		});
		expect(await screen.findByText("New Result")).toBeInTheDocument();

		// The stale query fails LATE — a superseded failure is not the current view.
		controls.get("old")?.reject(new Error("stale engine error"));
		await waitFor(() =>
			expect(screen.queryByText("stale engine error")).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByText("Couldn’t reach the engine"),
		).not.toBeInTheDocument();
		expect(screen.getByText("New Result")).toBeInTheDocument();
	});
});

describe("Storefront session signals", () => {
	it("increments the cart pill when a product is added to cart", async () => {
		render(<Storefront />);
		await screen.findByText("Grid Gadget");
		const card = screen.getByText("Grid Gadget").closest("article");
		const cartButton = within(card as HTMLElement).getByRole("button", {
			name: "Add “Grid Gadget” to cart",
		});
		await userEvent.click(cartButton);

		// The cart pill (not the rail rank badge) reflects the running count.
		const pill = await screen.findByTitle(/added to cart this session/i);
		expect(pill).toHaveTextContent("1");
		expect(mocks.emitInteraction).toHaveBeenCalledWith(
			"cart",
			expect.objectContaining({ id: "G1" }),
		);
	});

	it("favorites a product in place without opening the PDP", async () => {
		render(<Storefront />);
		await screen.findByText("Grid Gadget");
		const card = screen.getByText("Grid Gadget").closest("article");
		await userEvent.click(
			within(card as HTMLElement).getByRole("button", {
				name: "Favorite “Grid Gadget”",
			}),
		);

		expect(
			await screen.findByRole("button", { name: "Unfavorite “Grid Gadget”" }),
		).toBeInTheDocument();
		// Still on the browse view — favoriting must not navigate.
		expect(
			screen.queryByRole("button", { name: /Back to browse/i }),
		).not.toBeInTheDocument();
		expect(mocks.emitInteraction).toHaveBeenCalledWith(
			"favorite",
			expect.objectContaining({ id: "G1" }),
		);
	});
});

describe("Storefront in-app history (PDP routing)", () => {
	it("opening a product pushes a #/p/<id> history entry", async () => {
		render(<Storefront />);
		const grid = await screen.findByText("Grid Gadget");
		await userEvent.click(
			grid.closest("article")?.querySelector("button") ?? grid,
		);
		await screen.findByRole("heading", { level: 1, name: "Grid Gadget" });

		expect(window.location.hash).toBe("#/p/G1");
	});

	it("browser Back (popstate) leaves the PDP but stays in-app", async () => {
		render(<Storefront />);
		const grid = await screen.findByText("Grid Gadget");
		await userEvent.click(
			grid.closest("article")?.querySelector("button") ?? grid,
		);
		await screen.findByRole("heading", { level: 1, name: "Grid Gadget" });

		// Simulate the browser's Back: the hash pops to the browse URL and the
		// window fires popstate (no document unload — that is the whole point).
		window.history.replaceState(null, "", "/");
		window.dispatchEvent(new PopStateEvent("popstate"));

		expect(await screen.findByText("Grid Gizmo")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Back to browse/i }),
		).not.toBeInTheDocument();
	});

	it("restores the PDP from a #/p/<id> deep link on mount without re-emitting a click", async () => {
		window.history.replaceState(null, "", "/#/p/G2");
		render(<Storefront />);

		expect(
			await screen.findByRole("heading", { level: 1, name: "Grid Gizmo" }),
		).toBeInTheDocument();
		// A restore is not an interaction — replay already rebuilt the taste.
		expect(mocks.emitInteraction).not.toHaveBeenCalled();
	});
});

describe("Storefront durable taste (badge restore + reset affordance)", () => {
	it("initializes the For-You badge from the replayed log", async () => {
		mocks.replayedSignalCount.mockReturnValue(3);
		render(<Storefront />);
		await screen.findByText("Rail Widget");

		expect(screen.getByTitle(/saved only in this browser/i)).toHaveTextContent(
			"3",
		);
	});

	it("Reset taste clears profile+log+caps, zeroes the badge, and re-ranks to baseline", async () => {
		mocks.replayedSignalCount.mockReturnValue(2);
		render(<Storefront />);
		await screen.findByText("Rail Widget");
		expect(screen.getByTitle(/saved only in this browser/i)).toHaveTextContent(
			"2",
		);
		const railCallsBefore = mocks.recommendStrategy.mock.calls.length;

		await userEvent.click(screen.getByRole("button", { name: /Reset taste/i }));

		await waitFor(() => expect(mocks.resetSession).toHaveBeenCalledTimes(1));
		expect(mocks.resetSignalCaps).toHaveBeenCalledTimes(1);
		// The badge returns to zero…
		await waitFor(() =>
			expect(
				screen.getByTitle(/saved only in this browser/i),
			).toHaveTextContent("0"),
		);
		// …the rails re-rank against the now-empty profile…
		await waitFor(() =>
			expect(mocks.recommendStrategy.mock.calls.length).toBeGreaterThan(
				railCallsBefore,
			),
		);
		// …and the copy tells the truth about where activity lives.
		expect(
			await screen.findByText(/stored only in this browser/i),
		).toBeInTheDocument();
	});
});
