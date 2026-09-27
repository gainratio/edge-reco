import { useTranslation } from "react-i18next";
import attribution from "../catalog-attribution.json";

/**
 * Small, always-visible site footer. Anchors the site's internal links: it states
 * plainly that EdgeReco is open source and runs on-device, points at the GitHub
 * repos and the entity pages (/edgeproc, /faq) so both shoppers and crawlers can
 * follow the link graph, and keeps the honest disclaimers (Nimbus is a fictional
 * demo store; the catalog is synthetic, and says so from catalog-attribution.json).
 *
 * It also carries the only outbound edges this site has: aml-filter.com and
 * almamesh.com are separate domains by the same maintainer, and until these links
 * existed the three sites linked to nothing but themselves — which is why
 * edge-reco.com's pages sat crawled-but-not-indexed. A crawler follows an
 * `<a href>`; it does not follow a sitemap into a domain nobody links to.
 *
 * Brand words (EdgeReco, Nimbus) and the bare repo-slug link text (edge-reco) stay
 * literal — they are not localized — while every surrounding sentence resolves from
 * the `common` i18n namespace.
 */
export function Footer() {
	const { t } = useTranslation("common");
	return (
		<footer className="nimbus-footer">
			<p className="nimbus-footer__line">
				<strong>EdgeReco</strong> {t("footer.thesis")}
			</p>
			<nav className="nimbus-footer__links" aria-label={t("footer.navLabel")}>
				<a
					className="nimbus-footer__link"
					href="https://github.com/hseshadr/edge-reco"
				>
					{t("footer.links.repo")}
				</a>
				<a
					className="nimbus-footer__link"
					href="https://github.com/hseshadr/edge-proc"
				>
					{t("footer.links.substrate")}
				</a>
				<a className="nimbus-footer__link" href="/edgeproc">
					{t("footer.links.whatIs")}
				</a>
				<a className="nimbus-footer__link" href="/faq">
					{t("footer.links.faq")}
				</a>
			</nav>
			<p className="nimbus-footer__line nimbus-footer__line--muted">
				{t("footer.demoBefore")}{" "}
				<a
					className="nimbus-footer__link"
					href="https://github.com/hseshadr/edge-reco"
				>
					edge-reco
				</a>{" "}
				{t("footer.demoAfter")}
			</p>
			<p className="nimbus-footer__line nimbus-footer__line--muted">
				{t("footer.attribution", { statement: attribution.statement })}
			</p>
			<p className="nimbus-footer__line nimbus-footer__line--muted nimbus-footer__line--lead">
				{t("footer.moreLead")}
			</p>
			<nav className="nimbus-footer__links" aria-label={t("footer.moreLabel")}>
				<a className="nimbus-footer__link" href="https://aml-filter.com/">
					{t("footer.links.amlFilter")}
				</a>
				<a className="nimbus-footer__link" href="https://almamesh.com/">
					{t("footer.links.almamesh")}
				</a>
				<a className="nimbus-footer__link" href="https://github.com/hseshadr">
					{t("footer.links.allRepos")}
				</a>
			</nav>
		</footer>
	);
}
