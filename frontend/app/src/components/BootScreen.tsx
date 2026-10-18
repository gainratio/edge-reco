import type { BootStage } from "@edgereco/browser";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface BootScreenProps {
	stage: BootStage | null;
	error: string | null;
	onRetry: () => void;
	/**
	 * The explicit "Clear cached catalog and retry" recovery. Passed ONLY when
	 * the classified failure calls for it (`bootFailure().offerCacheClear`);
	 * absent, the error panel offers Retry alone.
	 */
	cacheClear?: CacheClearAction;
}

/** The user-initiated catalog-cache clear offered on the error panel. */
export interface CacheClearAction {
	readonly onClear: () => void;
	/**
	 * A rollback refusal: show the tampering warning and require an inline
	 * second click ("Yes, clear and retry") before `onClear` runs.
	 */
	readonly confirm: boolean;
}

const ORDER: ReadonlyArray<BootStage["kind"]> = [
	"syncing",
	"reassembling",
	"loading-model",
	"ready",
];

/** The three visible boot steps, in order. Copy lives in `errors:boot.steps`. */
const STEP_KEYS = ["syncing", "reassembling", "loading"] as const;

/** Map a live stage to the index of the currently-active step (0-based). */
function activeStep(stage: BootStage | null): number {
	if (stage === null) {
		return 0;
	}
	if (stage.kind === "synced") {
		return ORDER.indexOf("reassembling");
	}
	const index = ORDER.indexOf(stage.kind);
	return index < 0 ? 0 : index;
}

/**
 * Full-screen bootstrap UX. Shows the real stages — syncing the signed bundle,
 * reassembling the index, loading the model — so the first-load work is honest,
 * and an error+retry path if the origin is unreachable. After the first load
 * the bundle lives in OPFS and the model in the HTTP cache, so this screen is
 * near-instant offline.
 */
export function BootScreen({
	stage,
	error,
	onRetry,
	cacheClear,
}: BootScreenProps) {
	const { t } = useTranslation("errors");
	const current = activeStep(stage);
	return (
		<div className="boot" role="status" aria-live="polite">
			<div className="boot__card">
				<div className="wordmark boot__mark">
					<span className="wordmark__name">
						EdgeReco<span className="wordmark__dot">.</span>
					</span>
					<span className="wordmark__tag">{t("boot.tagline")}</span>
				</div>

				{error === null ? (
					<>
						<p className="boot__lede">{t("boot.lede")}</p>
						<ol className="boot__steps">
							{STEP_KEYS.map((key, index) => {
								const state =
									index < current
										? "boot__step--done"
										: index === current
											? "boot__step--active"
											: "boot__step--pending";
								return (
									<li key={key} className={`boot__step ${state}`}>
										<span className="boot__dot" aria-hidden="true" />
										<span className="boot__step-text">
											<span className="boot__step-label">
												{t(`boot.steps.${key}.label`)}
											</span>
											<span className="boot__step-detail">
												{t(`boot.steps.${key}.detail`)}
											</span>
										</span>
									</li>
								);
							})}
						</ol>
					</>
				) : (
					<div className="boot__error">
						<div className="boot__error-title">{t("boot.errorTitle")}</div>
						<p className="boot__error-copy">{error}</p>
						{cacheClear === undefined ? (
							<div className="boot__error-actions">
								<RetryButton onRetry={onRetry} />
							</div>
						) : (
							<CacheClearPanel action={cacheClear} onRetry={onRetry} />
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function RetryButton({ onRetry }: { readonly onRetry: () => void }) {
	const { t } = useTranslation("errors");
	return (
		<button type="button" className="banner__retry" onClick={onRetry}>
			{t("boot.retry")}
		</button>
	);
}

/**
 * The explanation + actions for the explicit catalog-cache clear. A rollback
 * shows the tampering warning up front and arms an inline confirm on the first
 * click; `onClear` runs only on "Yes, clear and retry". Every other offered
 * clear is a single click.
 */
function CacheClearPanel({
	action,
	onRetry,
}: {
	readonly action: CacheClearAction;
	readonly onRetry: () => void;
}) {
	const { t } = useTranslation("errors");
	const [armed, setArmed] = useState(false);
	const explain = action.confirm
		? t("boot.clearCache.rollbackWarning")
		: t("boot.clearCache.explain");
	const onFirstClick = action.confirm
		? () => setArmed(true)
		: () => action.onClear();
	return (
		<>
			<p className="boot__error-copy">{explain}</p>
			<div className="boot__error-actions">
				<RetryButton onRetry={onRetry} />
				{armed ? (
					<>
						<button
							type="button"
							className="banner__retry"
							onClick={action.onClear}
						>
							{t("boot.clearCache.confirm")}
						</button>
						<button
							type="button"
							className="banner__retry"
							onClick={() => setArmed(false)}
						>
							{t("boot.clearCache.cancel")}
						</button>
					</>
				) : (
					<button
						type="button"
						className="banner__retry"
						onClick={onFirstClick}
					>
						{t("boot.clearCache.action")}
					</button>
				)}
			</div>
		</>
	);
}
