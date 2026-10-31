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
	} finally {
		location.replace("/");
	}
}

void reset().catch(() => {
	if (status)
		status.textContent = "Reset failed. Close the tab and reopen EdgeReco.";
});
