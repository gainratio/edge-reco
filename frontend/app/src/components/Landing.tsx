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
					<div className="landing__hero-grid">
						<div className="landing__hero-copy">
							<div className="landing__eyebrow">{t("eyebrow")}</div>
							<div className="wordmark landing__brand">
								<span className="wordmark__name">
									EdgeReco<span className="wordmark__dot">.</span>
								</span>
								<span className="wordmark__tag">
									On-Device SQLite + Hybrid Vector Engine
								</span>
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
									href="https://github.com/gainratio/edge-reco"
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
								{t("footnote", {
									bundle: BUNDLE_SIZE,
									model: MODEL_DOWNLOAD,
								})}
							</p>
						</div>

						<aside className="landing__specimen" aria-hidden="true">
							<div className="landing__specimen-chrome">
								<div className="landing__specimen-dots">
									<span />
									<span />
									<span />
								</div>
								<span className="landing__specimen-file">
									catalogue.sqlite · OPFS
								</span>
								<span className="landing__specimen-seal">
									Ed25519 VERIFIED ✓
								</span>
							</div>

							<div className="landing__specimen-body">
								<div className="landing__specimen-search">
									<span className="landing__specimen-search-icon">⌕</span>
									<span className="landing__specimen-search-query">
										waterproof alpine shell
									</span>
									<span className="landing__specimen-search-ms">
										15 ms · 0 RPCs
									</span>
								</div>

								<div className="landing__specimen-signals">
									<div className="landing__specimen-signal">
										<div className="landing__specimen-signal-row">
											<span>FTS5 BM25 lexical index</span>
											<span>w = 0.48</span>
										</div>
										<div className="landing__specimen-bar">
											<span style={{ width: "86%" }} />
										</div>
									</div>
									<div className="landing__specimen-signal">
										<div className="landing__specimen-signal-row">
											<span>384-d INT8 cosine scan (WASM)</span>
											<span>w = 0.52</span>
										</div>
										<div className="landing__specimen-bar landing__specimen-bar--hot">
											<span style={{ width: "94%" }} />
										</div>
									</div>
								</div>

								<div className="landing__specimen-section-head">
									<span>Reciprocal Rank Fusion + MMR (λ = 0.7)</span>
									<span>Top 3 / 100k</span>
								</div>

								<div className="landing__specimen-cards">
									<div className="landing__specimen-card landing__specimen-card--top">
										<div className="landing__specimen-swatch landing__specimen-swatch--rust">
											<span>01</span>
										</div>
										<div className="landing__specimen-meta">
											<div className="landing__specimen-cat">
												OUTDOOR · GORE-TEX 3L
											</div>
											<div className="landing__specimen-name">
												Ridgecrest Storm Anorak
											</div>
										</div>
										<div className="landing__specimen-right">
											<span className="landing__specimen-price">$248</span>
											<span className="landing__specimen-score">0.984 RRF</span>
										</div>
									</div>

									<div className="landing__specimen-card">
										<div className="landing__specimen-swatch landing__specimen-swatch--slate">
											<span>02</span>
										</div>
										<div className="landing__specimen-meta">
											<div className="landing__specimen-cat">
												ALPINE · RIPSTOP SHELL
											</div>
											<div className="landing__specimen-name">
												Kestrel Ultralight Parka
											</div>
										</div>
										<div className="landing__specimen-right">
											<span className="landing__specimen-price">$215</span>
											<span className="landing__specimen-score">0.951 RRF</span>
										</div>
									</div>

									<div className="landing__specimen-card">
										<div className="landing__specimen-swatch landing__specimen-swatch--ochre">
											<span>03</span>
										</div>
										<div className="landing__specimen-meta">
											<div className="landing__specimen-cat">
												TRAIL · H2NO HARDSHELL
											</div>
											<div className="landing__specimen-name">
												Solstice Packable Trench
											</div>
										</div>
										<div className="landing__specimen-right">
											<span className="landing__specimen-price">$189</span>
											<span className="landing__specimen-score">0.928 RRF</span>
										</div>
									</div>
								</div>

								<div className="landing__specimen-foot">
									<span>⚡ Gear-CDC delta patch: 2 chunks · 45 KB</span>
									<span>99.9% chunks reused</span>
								</div>
							</div>
						</aside>
					</div>
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
