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
		// Clear only the disposable OPFS catalogue and sync chunk stores while
		// preserving the user's on-device taste database (`edgereco-user`).
		if (navigator.storage?.getDirectory) {
			const root = await navigator.storage.getDirectory();
			const userPool = ".edgeproc-sql-52599d7379eb37c73d8f1de4886b1cd0";
			for await (const [name, handle] of root.entries()) {
				if (handle.kind === "directory" && name !== userPool) {
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
