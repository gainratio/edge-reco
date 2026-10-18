import { registerSW } from "virtual:pwa-register";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { App } from "./App.tsx";
import i18n from "./i18n";
import "./index.css";

// Auto-update: when a page was already controlled by a previous Service Worker
// at boot and a newer worker takes control (`skipWaiting` + `clientsClaim`),
// reload once onto the newly precached shell so a single browser reload after a
// deploy/rebuild lands cleanly on the new build. No-ops on first install or
// where service workers are unavailable.
const hadControllerAtBoot =
	typeof navigator !== "undefined" &&
	Boolean(navigator.serviceWorker?.controller);
let refreshingOnControllerChange = false;
if (hadControllerAtBoot) {
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (refreshingOnControllerChange) return;
		refreshingOnControllerChange = true;
		window.location.reload();
	});
}
registerSW({
	immediate: true,
	onRegisteredSW(_swUrl, registration) {
		void registration?.update();
	},
});

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Root element #root not found");
createRoot(rootElement).render(
	<StrictMode>
		<I18nextProvider i18n={i18n}>
			<App />
		</I18nextProvider>
	</StrictMode>,
);
