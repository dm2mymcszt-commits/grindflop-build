import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsJump } from "../../hooks/useSettingsJump";
import { CheckCheck, Eye, Ghost, ImageOff, ToggleRight, ScanSearch } from "lucide-react";
import { BackToSettings } from "../../components/BackToSettings";
import { AppDisguiseCard } from "../../components/settings/AppDisguiseCard";
import { ToggleRow } from "../../components/ui/toggle-row";
import { usePreferences } from "../../contexts/PreferencesContext";
import { useAuth } from "../../contexts/useAuth";
import {
	GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
	type GoogleDriveSyncDataAppliedDetail,
} from "../../services/googleDriveSyncRuntime";
import {
	getHideReadReceiptsGlobal,
	getIncognitoMode,
	getShowReadReceiptToggle,
	isRecordProfileViewsEnabled,
	setHideReadReceiptsGlobal,
	setIncognitoMode,
	setRecordProfileViewsEnabled,
	setShowReadReceiptToggle as persistShowReadReceiptToggle,
} from "../../utils/privacy";

export function SettingsPrivacyPage() {
	const { t } = useTranslation();
	useSettingsJump();
	const { blurIncomingMedia, setPreferences } = usePreferences();
	const { userId, settingsReady } = useAuth();

	const [readReceiptsEnabled, setReadReceiptsEnabled] = useState(() => !getHideReadReceiptsGlobal());
	const [showReadReceiptToggle, setShowReadReceiptToggle] = useState(() => getShowReadReceiptToggle());
	const [recordProfileViews, setRecordProfileViews] = useState(() => isRecordProfileViewsEnabled());
	const [incognitoMode, setIncognitoModeState] = useState(() => getIncognitoMode());
	const [imageScannerEnabled, setImageScannerEnabled] = useState(() => window.localStorage.getItem("fg-image-scanner-enabled") === "true");

	useEffect(() => {
		if (!settingsReady || userId == null) return;
		const refreshPrivacySettings = () => {
			setReadReceiptsEnabled(!getHideReadReceiptsGlobal());
			setShowReadReceiptToggle(getShowReadReceiptToggle());
			setRecordProfileViews(isRecordProfileViewsEnabled());
			setIncognitoModeState(getIncognitoMode());
		};
		const handleCloudDataApplied = (event: Event) => {
			const detail = (event as CustomEvent<GoogleDriveSyncDataAppliedDetail>).detail;
			if (detail?.profileId !== userId) return;
			refreshPrivacySettings();
		};

		refreshPrivacySettings();
		window.addEventListener(
			GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
			handleCloudDataApplied,
		);
		return () => {
			window.removeEventListener(
				GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
				handleCloudDataApplied,
			);
		};
	}, [settingsReady, userId]);

	return (
		<section className="app-screen">
			<header className="mb-7">
				<BackToSettings />
				<h1 className="app-title mb-1">{t("settings.privacy")}</h1>
				<p className="app-subtitle">{t("settings.privacy_desc")}</p>
			</header>

			<div className="grid gap-6">

				{/* Incognito mode */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
						{t("privacy.grid_visibility", { defaultValue: "Grid Visibility" })}
					</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<ToggleRow
							icon={<Ghost className="h-5 w-5" />}
							iconClass="bg-fuchsia-500/15 text-fuchsia-400"
							id="privacy-incognito"
							label={t("privacy.incognito_mode", { defaultValue: "Incognito Mode" })}
							description={t("privacy.incognito_mode_desc", {
								defaultValue:
									"Stop the Grid from loading or refreshing, send no read receipts and report no profile views, so you leave fewer traces while you use the app.",
							})}
							checked={incognitoMode}
							onChange={(checked) => {
								setIncognitoModeState(checked);
								void setIncognitoMode(checked);
							}}
						/>
						<div className="px-4 py-3">
							<p className="text-xs leading-relaxed text-[var(--text-muted)]">
								{t("privacy.incognito_mode_note", {
									defaultValue:
										"While this is on, the Grid stays empty, its background refresh stops, nobody is told you read their message, and opening a profile does not count as a view. Loading the Grid is what shows you as online, so this keeps you out of sight there. The rest of the app still talks to Grindr, so it lowers your visibility without promising that you look offline. Turning it off puts everything back at once.",
								})}
							</p>
						</div>
					</div>
				</div>

				{/* Security */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("privacy.security")}</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<ToggleRow
							icon={<ScanSearch className="h-5 w-5" />}
							iconClass="bg-blue-500/15 text-blue-400"
							id="privacy-media-scanner"
							label={t("privacy.media_scanner")}
							description={t("privacy.media_scanner_desc")}
							checked={imageScannerEnabled}
							onChange={(checked) => {
								setImageScannerEnabled(checked);
								window.localStorage.setItem("fg-image-scanner-enabled", String(checked));
							}}
						/>
					</div>
				</div>

				{/* Read Receipts */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("privacy.read_receipts")}</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<ToggleRow
							icon={<CheckCheck className="h-5 w-5" />}
							iconClass="bg-indigo-500/15 text-indigo-400"
							id="privacy-read-receipts"
							label={t("privacy.send_read_receipts")}
							description={t("privacy.send_read_receipts_desc")}
							checked={readReceiptsEnabled}
							onChange={(checked) => {
								setReadReceiptsEnabled(checked);
								void setHideReadReceiptsGlobal(!checked);
							}}
						/>
						<ToggleRow
							icon={<ToggleRight className="h-5 w-5" />}
							iconClass="bg-blue-500/15 text-blue-400"
							id="privacy-per-chat-read-receipts"
							label={t("privacy.per_chat_overrides")}
							description={t("privacy.per_chat_overrides_desc")}
							checked={showReadReceiptToggle}
							onChange={(checked) => {
								setShowReadReceiptToggle(checked);
								void persistShowReadReceiptToggle(checked);
							}}
						/>
						<div className="border-t border-[var(--border)] px-4 py-3">
							<p className="text-xs text-[var(--text-muted)] leading-relaxed">
								{t("privacy.read_receipts_grid_unread_note", {
									defaultValue:
										"With read receipts off, there's no way to tell the server you've read a message — so a chat can still show up as unread on the Grid even after you've read or deleted it.",
								})}
							</p>
						</div>
					</div>
				</div>

				{/* Profile Views */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("privacy.profile_views")}</p>
					<div className="surface-card overflow-hidden">
						<ToggleRow
							icon={<Eye className="h-5 w-5" />}
							iconClass="bg-amber-500/15 text-amber-400"
							id="privacy-record-profile-views"
							label={t("privacy.record_profile_views")}
							description={t("privacy.record_profile_views_desc")}
							checked={recordProfileViews}
							onChange={(checked) => {
								setRecordProfileViews(checked);
								void setRecordProfileViewsEnabled(checked);
							}}
						/>
					</div>
				</div>

				{/* NSFW Content */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("privacy.nsfw_content")}</p>
					<div className="surface-card overflow-hidden">
						<ToggleRow
							icon={<ImageOff className="h-5 w-5" />}
							iconClass="bg-sky-500/15 text-sky-400"
							id="privacy-blur-incoming-media"
							label={t("customizability.blur_incoming_media")}
							description={t("customizability.blur_incoming_media_description")}
							checked={blurIncomingMedia}
							onChange={(checked) => void setPreferences({ blurIncomingMedia: checked })}
						/>
					</div>
				</div>

				{/* iPhone only; draws nothing anywhere else. */}
				<AppDisguiseCard id="privacy-app-disguise" />

			</div>
		</section>
	);
}
