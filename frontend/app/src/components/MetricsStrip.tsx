import { useTranslation } from "react-i18next";
import { useMetrics } from "../metrics/store";

/**
 * A compact, honest strip of LIVE engine telemetry, shown in the store header.
 * Every value is measured in-tab and updates as the user searches/clicks:
 *   - latency      — last recommend() (falls back to search()) round-trip, ms
 *   - backend calls — post-sync edge/other requests; the headline 0 of the
 *                     backend-free demo (images excluded upstream)
 *   - cold start    — engine boot → ready, seconds
 *   - JS heap       — main-thread heap (Chromium-only); the tile is HIDDEN when
 *                     unavailable so non-Chromium users never see a blank
 *   - catalog       — number of indexed products
 *
 * Reads the metrics store via useMetrics(); renders nothing it cannot measure.
 */
export function MetricsStrip() {
	const { t } = useTranslation("storefront");
	const m = useMetrics();
	const latencyMs = m.recommendMs ?? m.searchMs;

	return (
		<div
			className="metrics-strip"
			role="status"
			aria-label={t("metrics.ariaLabel")}
		>
			<MetricTile label={t("metrics.latency")} value={msLabel(latencyMs)} />
			<MetricTile
				label={t("metrics.backendCalls")}
				value={String(m.backendCalls)}
				steady
			/>
			<MetricTile
				label={t("metrics.coldStart")}
				value={secondsLabel(m.coldStartMs)}
			/>
			{m.heapMb !== null && (
				<MetricTile label={t("metrics.heap")} value={`${m.heapMb} MB`} />
			)}
			<MetricTile
				label={t("metrics.catalog")}
				value={countLabel(m.productCount)}
			/>
		</div>
	);
}

interface MetricTileProps {
	readonly label: string;
	readonly value: string;
	/** The steady "0" (backend calls) gets the calm --abyss accent. */
	readonly steady?: boolean;
}

function MetricTile({ label, value, steady = false }: MetricTileProps) {
	return (
		<div className="metrics-strip__tile">
			<span
				className={
					steady
						? "metrics-strip__value metrics-strip__value--steady"
						: "metrics-strip__value"
				}
			>
				{value}
			</span>
			<span className="metrics-strip__label">{label}</span>
		</div>
	);
}

function msLabel(ms: number | null): string {
	if (ms === null) {
		return "—";
	}
	return ms < 1 ? "<1 ms" : `${Math.round(ms)} ms`;
}

function secondsLabel(ms: number | null): string {
	return ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

function countLabel(count: number | null): string {
	return count === null ? "—" : count.toLocaleString();
}
