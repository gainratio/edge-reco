import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the engine boot + the Storefront so the launch gate can be tested in
// isolation: we only care that the engine stays cold until Launch is clicked.
// vi.hoisted keeps the spy available inside the hoisted vi.mock factory.
const { bootstrap, clearCatalogCache } = vi.hoisted(() => ({
	bootstrap: vi.fn(() => new Promise<void>(() => {})),
	clearCatalogCache: vi.fn(() => Promise.resolve()),
}));
vi.mock("./api/client", () => ({ bootstrap, clearCatalogCache }));
vi.mock("./components/Storefront", () => ({
	Storefront: () => <div>storefront</div>,
}));

import { App } from "./App";

afterEach(() => {
	cleanup();
	bootstrap.mockReset();
	bootstrap.mockImplementation(() => new Promise<void>(() => {}));
	clearCatalogCache.mockReset();
	clearCatalogCache.mockImplementation(() => Promise.resolve());
	sessionStorage.clear();
	vi.restoreAllMocks();
});

const CLEAR = "Clear cached catalog and retry";

const CONFIRM = "Yes, clear and retry";

/** A Worker-boundary refusal, shaped like EngineOperationError. */
function workerRefusal(code: string, message: string): Error {
	const err = new Error(message);
	err.name = "EngineOperationError";
	(err as Error & { code: string }).code = code;
	return err;
}

/** The fail-closed anti-rollback refusal (older pointer than the floor). */
function rollbackRefusal(): Error {
	return workerRefusal(
		"rollback",
		"pointer sequence 3 is below the stored floor 5",
	);
}

/** A non-rollback integrity refusal (e.g. the current key can't verify). */
function integrityRefusal(): Error {
	return workerRefusal("integrity", "pointer signature verification failed");
}

describe("App launch gate", () => {
	it("does not show the offline badge while online", () => {
		vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
		render(<App />);
		expect(
			screen.queryByText("Offline — running fully on your device"),
		).not.toBeInTheDocument();
	});

	it("renders the global site footer (with the EdgeProc substrate link) on every view", () => {
		render(<App />);
		// The Landing is shown first; the persistent footer renders beneath it,
		// so the open-source / entity links are reachable from every view.
		expect(
			screen.getByRole("link", { name: /EdgeProc substrate/i }),
		).toHaveAttribute("href", "https://github.com/gainratio/edge-proc");
	});

	it("shows the Landing first and does NOT boot the engine", () => {
		render(<App />);
		expect(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		).toBeInTheDocument();
		expect(bootstrap).not.toHaveBeenCalled();
	});

	it("boots the engine only after Launch is clicked", async () => {
		render(<App />);
		expect(bootstrap).not.toHaveBeenCalled();
		await userEvent.click(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		);
		expect(bootstrap).toHaveBeenCalledTimes(1);
		// engine pending -> boot screen, landing gone
		expect(
			screen.queryByRole("button", { name: /Launch the live demo/i }),
		).not.toBeInTheDocument();
	});

	it("resumes an in-tab launch after a service-worker reload", () => {
		sessionStorage.setItem("edgereco-demo-launched", "1");

		render(<App />);

		expect(bootstrap).toHaveBeenCalledTimes(1);
		expect(
			screen.queryByRole("button", { name: /Launch the live demo/i }),
		).not.toBeInTheDocument();
	});

	it("mounts the Storefront once the engine boot resolves", async () => {
		bootstrap.mockReturnValueOnce(Promise.resolve());
		render(<App />);
		await userEvent.click(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		);
		expect(await screen.findByText("storefront")).toBeInTheDocument();
	});

	it("surfaces a boot failure and recovers when Retry succeeds", async () => {
		bootstrap
			.mockImplementationOnce(() =>
				Promise.reject(new Error("origin unreachable")),
			)
			.mockImplementationOnce(() => Promise.resolve());
		render(<App />);
		await userEvent.click(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		);
		expect(await screen.findByText("origin unreachable")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("storefront")).toBeInTheDocument();
	});

	it("offers the explicit clear on a stuck integrity refusal and never clears on its own", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		bootstrap.mockImplementation(() => Promise.reject(rollbackRefusal()));
		render(<App />);
		await userEvent.click(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		);
		expect(
			await screen.findByRole("button", { name: CLEAR }),
		).toBeInTheDocument();

		// Retry alone re-runs the same fail-closed sync — and still never clears.
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("button", { name: CLEAR }),
		).toBeInTheDocument();
		expect(bootstrap).toHaveBeenCalledTimes(2);
		expect(clearCatalogCache).not.toHaveBeenCalled();
	});

	it("clears the cached catalog, then re-runs bootstrap to the storefront", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		bootstrap
			.mockImplementationOnce(() => Promise.reject(integrityRefusal()))
			.mockImplementationOnce(() => Promise.resolve());
		render(<App />);
		await userEvent.click(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		);
		await userEvent.click(await screen.findByRole("button", { name: CLEAR }));

		expect(await screen.findByText("storefront")).toBeInTheDocument();
		expect(clearCatalogCache).toHaveBeenCalledOnce();
		expect(bootstrap).toHaveBeenCalledTimes(2);
		// The clear finished BEFORE the second bootstrap started.
		expect(clearCatalogCache.mock.invocationCallOrder[0]).toBeLessThan(
			bootstrap.mock.invocationCallOrder[1] ?? 0,
		);
	});

	it("surfaces a failed clear and does not re-run bootstrap", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		bootstrap.mockImplementationOnce(() => Promise.reject(integrityRefusal()));
		clearCatalogCache.mockImplementationOnce(() =>
			Promise.reject(new Error("engine worker could not start")),
		);
		render(<App />);
		await userEvent.click(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		);
		await userEvent.click(await screen.findByRole("button", { name: CLEAR }));

		expect(
			await screen.findByText("engine worker could not start"),
		).toBeInTheDocument();
		expect(bootstrap).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
	});

	it("does not offer the clear for a network failure", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		bootstrap.mockImplementationOnce(() =>
			Promise.reject(new Error("origin unreachable")),
		);
		render(<App />);
		await userEvent.click(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		);
		expect(await screen.findByText("origin unreachable")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: CLEAR }),
		).not.toBeInTheDocument();
	});

	it("a rollback refusal warns and clears only after the inline confirm", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		bootstrap
			.mockImplementationOnce(() => Promise.reject(rollbackRefusal()))
			.mockImplementationOnce(() => Promise.resolve());
		render(<App />);
		await userEvent.click(
			screen.getByRole("button", { name: /Launch the live demo/i }),
		);
		expect(
			await screen.findByText(/someone is tampering/i),
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: CLEAR }));
		expect(clearCatalogCache).not.toHaveBeenCalled();
		expect(bootstrap).toHaveBeenCalledTimes(1);

		await userEvent.click(screen.getByRole("button", { name: CONFIRM }));
		expect(await screen.findByText("storefront")).toBeInTheDocument();
		expect(clearCatalogCache).toHaveBeenCalledOnce();
		expect(bootstrap).toHaveBeenCalledTimes(2);
	});
});
