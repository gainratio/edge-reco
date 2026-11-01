// One-time recovery for clients stuck on a pre-upgrade service worker.
// Lives outside the app bundle so an old client can always navigate to it.
const status = document.querySelector("#status");

async function reset() {
	try {
		if ("serviceWorker" in navigator) {
			const registrations = await navigator.serviceWorker.getRegistrations();
			await Promise.all(
				registrations.map((registration) => registration.unregister()),
			);
		}
		if ("caches" in window) {
			const names = await caches.keys();
			await Promise.all(names.map((name) => caches.delete(name)));
		}
		// The old OPFS catalogue/delta state is what triggers the iOS memory
		// failure; clear it as part of the reset. This also clears the local
		// taste log — acceptable for a full recovery.
		if (navigator.storage?.getDirectory) {
			const root = await navigator.storage.getDirectory();
			for await (const [name, handle] of root.entries()) {
				if (handle.kind === "directory") {
					await root.removeEntry(name, { recursive: true });
				}
			}
		}
	} finally {
		location.replace("/");
	}
}

void reset().catch(() => {
	if (status)
		status.textContent = "Reset failed. Close the tab and reopen EdgeReco.";
});
