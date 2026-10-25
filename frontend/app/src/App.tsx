import type { BootStage } from "@edgereco/browser";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { bootstrapApp, clearCatalogCache } from "./api/client";
import { type BootFailure, bootFailure } from "./api/syncErrors";
import { BootScreen } from "./components/BootScreen";
import { Footer } from "./components/Footer";
import { InstallButton } from "./components/InstallButton";
import { Landing } from "./components/Landing";
import { OfflineBadge } from "./components/OfflineBadge";
import { Storefront } from "./components/Storefront";
import { record } from "./metrics/store";

const DEMO_LAUNCHED_KEY = "edgereco-demo-launched";

function launchedInThisTab(): boolean {
	try {
		return sessionStorage.getItem(DEMO_LAUNCHED_KEY) === "1";
	} catch {
		return false;
	}
}

function rememberLaunch(): void {
	try {
		sessionStorage.setItem(DEMO_LAUNCHED_KEY, "1");
	} catch {
		// A locked-down browser can still launch; it just cannot resume after reload.
	}
}

/**
 * App is the launch gate. It first shows the Landing intro and starts NOTHING —
 * the engine stays cold until the user clicks Launch. On launch it spins up the
 * engine Workers, syncs the signed bundle into OPFS (verified ed25519+sha256),
 * and warms the embedder — showing real progress — then mounts the Storefront,
 * which runs entirely in-tab with no backend. A reachable origin makes reloads
 * near-instant + offline-ready (OPFS holds the bundle, the service worker the app shell + model).
 */
export function App() {
	const [launched, setLaunched] = useState(launchedInThisTab);
	const [stage, setStage] = useState<BootStage | null>(null);
	const [ready, setReady] = useState(false);
	const [failure, setFailure] = useState<BootFailure | null>(null);
	const [attempt, setAttempt] = useState(0);
	// Guards StrictMode's double-invoke within a single attempt; reset on retry.
	const ranAttempt = useRef(-1);

	useEffect(() => {
		// Hold the engine cold until the user launches — the Landing never boots it.
		if (!launched) {
			return;
		}
		if (ranAttempt.current === attempt) {
			return;
		}
		ranAttempt.current = attempt;
		setFailure(null);
		setStage(null);
		const t0 = performance.now();
		bootstrapApp(setStage)
			.then(() => {
				record({ coldStartMs: performance.now() - t0 });
				setReady(true);
			})
			.catch((err: unknown) => setFailure(bootFailure(err)));
	}, [launched, attempt]);

	const onRetry = useCallback(() => setAttempt((n) => n + 1), []);
	// The explicit, user-initiated recovery for a stuck fail-closed refusal:
	// clear ONLY the cached signed catalog (and its rollback floor), then boot
	// again. Offered only when `bootFailure` says so — never run automatically.
	const onClearCache = useCallback(() => {
		setFailure(null);
		setStage(null);
		clearCatalogCache()
			.then(() => setAttempt((n) => n + 1))
			.catch((err: unknown) => setFailure(bootFailure(err)));
	}, []);
	const onLaunch = useCallback(() => {
		rememberLaunch();
		setLaunched(true);
	}, []);

	let screen: ReactNode;
	if (!launched) {
		screen = <Landing onLaunch={onLaunch} />;
	} else if (!ready) {
		screen = (
			<BootScreen
				stage={stage}
				error={failure?.message ?? null}
				onRetry={onRetry}
				{...(failure?.offerCacheClear === true
					? {
							cacheClear: {
								onClear: onClearCache,
								confirm: failure.confirmCacheClear,
							},
						}
					: {})}
			/>
		);
	} else {
		screen = <Storefront />;
	}

	return (
		<>
			{screen}
			<Footer />
			<OfflineBadge />
			<InstallButton />
		</>
	);
}
