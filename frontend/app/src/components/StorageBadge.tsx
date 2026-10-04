import { useTranslation } from "react-i18next";

interface Props {
	/** True when the on-device SQLite database survives a reload (OPFS). */
	readonly durable: boolean;
}

/**
 * A small status pill that says where the shopper's activity lives: only in
 * this browser's own SQLite database. When the database could not be opened
 * in OPFS (private browsing, or another tab holds it) it runs in memory, and
 * the pill says plainly that this tab's activity resets on reload.
 */
export function StorageBadge({ durable }: Props) {
	const { t } = useTranslation("storefront");
	return (
		<div
			className={`storage-badge${durable ? "" : " storage-badge--memory"}`}
			role="status"
		>
			<span className="storage-badge__dot" />
			{durable ? t("storageBadge.durable") : t("storageBadge.memory")}
		</div>
	);
}
