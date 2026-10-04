// Vitest stand-in for `@gainratio/browser/worker?worker` (aliased in
// vite.config.ts). Vitest has no Worker bundler, so the real import would run
// the library's worker module in the test realm — on `self`, which the node
// environment does not have. Unit tests never start the engine Worker; the
// production-build Playwright lanes do.
export default class EngineWorkerStub {
	public constructor() {
		throw new Error("the engine Worker only runs in a browser build");
	}
}
