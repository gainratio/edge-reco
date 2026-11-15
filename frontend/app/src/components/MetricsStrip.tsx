import { useTranslation } from "react-i18next";
import { STOREFRONT_QUALITY_SUMMARY } from "../metrics/landing-figures";
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
interface MetricsStripProps {
	readonly onApplyDelta?: () => void;
	readonly applyingDelta?: boolean;
}

export function MetricsStrip({
	onApplyDelta,
	applyingDelta = false,
}: MetricsStripProps = {}) {
	const { t } = useTranslation("storefront");
	const m = useMetrics();
	const latencyMs = m.recommendMs ?? m.searchMs;
	const isPatched = m.syncStats?.version === "v2";

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
			{m.syncStats !== null &&
				m.syncStats !== undefined &&
				(m.syncStats.chunksFetched > 0 || m.syncStats.chunksReused > 0) && (
					<MetricTile
						label={t("metrics.catalogSync")}
						value={
							m.syncStats.chunksFetched > 0 && m.syncStats.chunksReused > 0
								? t("metrics.patchApplied", {
										fetched: m.syncStats.chunksFetched,
										reused: m.syncStats.chunksReused,
									})
								: m.syncStats.chunksFetched === 0
									? t("metrics.patchCached", {
											reused: m.syncStats.chunksReused,
										})
									: t("metrics.patchInitial", {
											fetched: m.syncStats.chunksFetched,
										})
						}
						steady={m.syncStats.chunksFetched === 0}
					/>
				)}
			{onApplyDelta !== undefined && (
				<button
					type="button"
					className="metrics-strip__action"
					onClick={onApplyDelta}
					disabled={applyingDelta}
					title={t("metrics.applyDeltaTitle")}
				>
					{applyingDelta
						? t("metrics.applyingDelta")
						: isPatched
							? t("metrics.replayDelta")
							: t("metrics.applyDelta")}
				</button>
			)}
			<AssayQualityDisclosure />
		</div>
	);
}

interface QualityStatProps {
	readonly value: string;
	readonly label: string;
	readonly sub: string;
	readonly steady?: boolean;
}

function QualityStat({ value, label, sub, steady = false }: QualityStatProps) {
	return (
		<div className="metrics-quality__card">
			<dt className="metrics-quality__label">{label}</dt>
			<dd
				className={
					steady
						? "metrics-quality__val metrics-quality__val--steady"
						: "metrics-quality__val"
				}
			>
				{value}
			</dd>
			<dd className="metrics-quality__sub">{sub}</dd>
		</div>
	);
}

function AssayQualityDisclosure() {
	const { t } = useTranslation("storefront");
	const q = STOREFRONT_QUALITY_SUMMARY;
	return (
		<details className="metrics-quality">
			<summary className="metrics-quality__summary">
				<span className="metrics-strip__value metrics-strip__value--steady">
					{t("metrics.qualityPillValue", {
						p10: q.precision10,
						k: q.k10,
						r24: q.recall24,
						k24: q.k24,
						f1: q.f1At24,
					})}
				</span>
				<span className="metrics-strip__label">
					{t("metrics.qualityPillLabel")}
				</span>
			</summary>
			<div className="metrics-quality__panel">
				<p className="metrics-quality__caption">
					{t("metrics.qualityHeading", {
						queries: q.queryCount,
						scorer: q.scorer,
					})}
				</p>
				<dl className="metrics-quality__grid">
					<QualityStat
						value={q.precision10}
						label={t("metrics.qualityPrecisionLabel", { k: q.k10 })}
						sub={t("metrics.qualityPrecisionSub", {
							p24: q.precision24,
							k24: q.k24,
						})}
						steady
					/>
					<QualityStat
						value={q.recall24}
						label={t("metrics.qualityRecallLabel", { k24: q.k24 })}
						sub={t("metrics.qualityRecallSub", {
							share: q.recallShareOfCeiling,
							ceiling: q.recallCeiling24,
							k24: q.k24,
						})}
					/>
					<QualityStat
						value={q.f1At24}
						label={t("metrics.qualityF1Label", { k24: q.k24 })}
						sub={t("metrics.qualityF1Sub", {
							share: q.f1ShareOfCeiling,
							ceiling: q.f1Ceiling24,
							k24: q.k24,
						})}
					/>
					<QualityStat
						value={q.ndcg10}
						label={t("metrics.qualityNdcgLabel", { k: q.k10 })}
						sub={t("metrics.qualityNdcgSub", {
							ciLow: q.ndcgCiLow,
							ciHigh: q.ndcgCiHigh,
						})}
						steady
					/>
					<QualityStat
						value={q.mrr10}
						label={t("metrics.qualityMrrLabel")}
						sub={t("metrics.qualityMrrSub", { map: q.map10 })}
					/>
					<QualityStat
						value={q.negativeFalsePositives}
						label={t("metrics.qualityNegativesLabel")}
						sub={t("metrics.qualityNegativesSub")}
						steady
					/>
				</dl>
			</div>
		</details>
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
