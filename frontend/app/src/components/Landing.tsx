import { useTranslation } from "react-i18next";
import {
	BUNDLE_SIZE,
	CATALOG_PRODUCTS,
	LANDING_MEASURED_ON,
	LANDING_METRICS,
	MODEL_DOWNLOAD,
	type RepresentativeMetric,
} from "../metrics/landing-figures";

interface LandingProps {
	onLaunch: () => void;
}

/** The five "why" value cards, in display order. Copy lives in the landing ns. */
const WHY_KEYS = [
	"private",
	"offline",
	"instant",
	"cheap",
	"learning",
] as const;

/** The five boot pipeline steps shown under "How it works", in display order. */
const STEP_KEYS = ["sync", "verify", "persist", "load", "search"] as const;

function MetricTile({ metric }: { metric: RepresentativeMetric }) {
	const { t } = useTranslation("landing");
	const toneClass = metric.tone ? ` metric-tile__num--${metric.tone}` : "";
	return (
		<div className="metric-tile">
			<div className={`metric-tile__num${toneClass}`}>
				{metric.num}
				{metric.unit ? (
					<span className="metric-tile__unit">{metric.unit}</span>
				) : null}
			</div>
			<div className="metric-tile__label">
				{t(`metrics.${metric.id}.label`)}
			</div>
			<div className="metric-tile__sub">
				{t(`metrics.${metric.id}.sub`, { ...metric.vars })}
			</div>
		</div>
	);
}

/**
 * Landing is a pure presentational intro shown BEFORE the engine boots. It never
 * imports or starts the engine — the only interactivity is the Launch CTA, which
 * lifts a callback so App can flip into the boot path. The engine isn't running
 * here yet, so the metric band quotes a RECORDED, dated measurement of the live
 * site (see metrics/landing-figures.ts); honesty labels — "JS heap (Chromium)",
 * "illustrative" — keep the rest truthful.
 */
export function Landing({ onLaunch }: LandingProps) {
	const { t } = useTranslation("landing");
	return (
		<main className="landing">
			<div className="landing__wrap">
				<header className="landing__hero">
					<div className="landing__eyebrow">{t("eyebrow")}</div>
					<div className="wordmark">
						<span className="wordmark__name">EdgeReco</span>
					</div>

					<h1 className="section-head__title landing__title">
						{t("hero.titleLead")} <em>{t("hero.titleAccent")}</em>
						{t("hero.titleTrail")}
					</h1>

					<p className="landing__kicker">{t("hero.kicker")}</p>

					<p className="landing__lede">{t("hero.lede")}</p>

					<div className="landing__cta">
						<button
							type="button"
							className="landing__btn landing__btn--primary"
							onClick={onLaunch}
						>
							{t("cta.launch")}
						</button>
						<a
							className="landing__btn landing__btn--ghost"
							href="https://github.com/hseshadr/edge-reco"
							target="_blank"
							rel="noreferrer"
						>
							{t("cta.source")}
						</a>
					</div>
					<p className="landing__demo-note">
						{t("demoNote", { products: CATALOG_PRODUCTS })}
					</p>
					<p className="landing__footnote">
						{t("footnote", { bundle: BUNDLE_SIZE, model: MODEL_DOWNLOAD })}
					</p>
				</header>

				<section className="landing__band" aria-label={t("band.ariaLabel")}>
					<div className="landing__band-head">
						<div className="section-head__title landing__band-title">
							{t("band.titleLead")} <em>{t("band.titleAccent")}</em>{" "}
							{t("band.titleTrail")}
						</div>
						<div className="landing__band-live">
							{t("band.live", { date: LANDING_MEASURED_ON })}
						</div>
					</div>
					<div className="landing__tiles">
						{LANDING_METRICS.map((metric) => (
							<MetricTile key={metric.id} metric={metric} />
						))}
					</div>
				</section>

				<section className="landing__why" aria-label={t("whys.ariaLabel")}>
					{WHY_KEYS.map((key) => (
						<article key={key} className="landing__why-card">
							<div className="landing__why-key">{t(`whys.${key}.title`)}</div>
							<div className="landing__why-desc">{t(`whys.${key}.body`)}</div>
						</article>
					))}
				</section>

				<section className="landing__how" aria-label={t("how.ariaLabel")}>
					<div className="landing__how-title">{t("how.title")}</div>
					<ol className="landing__steps">
						{STEP_KEYS.map((key, i) => (
							<li key={key} className="landing__step-item">
								<span className="landing__step">
									<b>{i + 1}</b>
									{t(`how.steps.${key}`)}
								</span>
								{i < STEP_KEYS.length - 1 ? (
									<span className="landing__arrow" aria-hidden="true">
										→
									</span>
								) : null}
							</li>
						))}
					</ol>
				</section>
			</div>
		</main>
	);
}
