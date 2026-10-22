import { useState } from "react";
import { ArrowDownWideNarrow, Ban, ExternalLink, Images, Search, ShieldOff, Sun, Timer, Trash2, Triangle } from "lucide-react";
import { BackToSettings } from "../../components/BackToSettings";
import { BackgroundExecutionCard } from "../../components/settings/BackgroundExecutionCard";
import { Chip } from "../../components/ui/chip";
import { ToggleRow } from "../../components/ui/toggle-row";
import { useTranslation } from "react-i18next";
import { useSettingsJump } from "../../hooks/useSettingsJump";
import {
	SKIP_BLOCK_CONFIRM_KEY,
	SKIP_UNBLOCK_CONFIRM_KEY,
	SKIP_DELETE_CONVERSATION_CONFIRM_KEY,
	SKIP_LINK_OPEN_CONFIRM_KEY,
	isBlockConfirmSkipped,
	isUnblockConfirmSkipped,
	isDeleteConversationConfirmSkipped,
	isLinkOpenConfirmSkipped,
} from "../../utils/blockConfirm";
import {
	isLocationFinderEnabled,
	setLocationFinderEnabled,
} from "../../utils/locationFinderSettings";
import {
	isLocationSearchAutoFocusEnabled,
	setLocationSearchAutoFocusEnabled,
} from "../../utils/locationSearchSettings";
import {
	isKeepScreenOnEnabled,
	isKeepScreenOnSupported,
	setKeepScreenOnEnabled,
} from "../../utils/keepScreenOn";
import {
	ALBUM_EXPIRATION_TYPES,
	getDefaultAlbumExpiration,
	isDefaultExpiringPhotos,
	isDrawerMostSentFirst,
	setDefaultAlbumExpiration,
	setDefaultExpiringPhotos,
	setDrawerMostSentFirst,
	type AlbumExpirationType,
} from "../../utils/mediaDefaults";

export function BehaviorPage() {
	const { t } = useTranslation();
	useSettingsJump();
	const [confirmBeforeBlock, setConfirmBeforeBlock] = useState(() => !isBlockConfirmSkipped());
	const [confirmBeforeUnblock, setConfirmBeforeUnblock] = useState(() => !isUnblockConfirmSkipped());
	const [confirmBeforeDeleteConversation, setConfirmBeforeDeleteConversation] = useState(
		() => !isDeleteConversationConfirmSkipped(),
	);
	const [confirmBeforeOpenLink, setConfirmBeforeOpenLink] = useState(() => !isLinkOpenConfirmSkipped());
	const [locationFinderEnabled, setLocationFinderEnabledState] = useState(isLocationFinderEnabled);
	const [locationSearchAutoFocus, setLocationSearchAutoFocus] = useState(isLocationSearchAutoFocusEnabled);
	const [keepScreenOn, setKeepScreenOn] = useState(isKeepScreenOnEnabled);
	const [expiringPhotos, setExpiringPhotos] = useState(isDefaultExpiringPhotos);
	const [albumExpiration, setAlbumExpiration] = useState(getDefaultAlbumExpiration);
	const [drawerMostSentFirst, setDrawerMostSentFirstState] = useState(isDrawerMostSentFirst);
	const albumExpirationLabels: Record<AlbumExpirationType, string> = {
		INDEFINITE: t("behavior.album_expiry.unlimited", { defaultValue: "Unlimited" }),
		ONCE: t("behavior.album_expiry.once", { defaultValue: "Once" }),
		TEN_MINUTES: t("behavior.album_expiry.ten_minutes", { defaultValue: "10 minutes" }),
		ONE_HOUR: t("behavior.album_expiry.one_hour", { defaultValue: "1 hour" }),
		ONE_DAY: t("behavior.album_expiry.one_day", { defaultValue: "1 day" }),
	};

	return (
		<section className="app-screen">
			<header className="mb-7">
				<BackToSettings />
				<h1 className="app-title mb-1">{t("settings.behavior")}</h1>
				<p className="app-subtitle">{t("behavior.subtitle")}</p>
			</header>

			<div className="grid gap-6">
				<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
					<ToggleRow
						icon={<Ban className="h-5 w-5" />}
						iconClass="bg-red-500/15 text-red-400"
						id="behavior-confirm-block"
						label={t("customizability.confirm_before_block")}
						description={t("customizability.confirm_before_block_desc")}
						checked={confirmBeforeBlock}
						onChange={(checked) => {
							setConfirmBeforeBlock(checked);
							window.localStorage.setItem(SKIP_BLOCK_CONFIRM_KEY, String(!checked));
						}}
					/>
					<ToggleRow
						icon={<ShieldOff className="h-5 w-5" />}
						iconClass="bg-red-500/15 text-red-400"
						id="behavior-confirm-unblock"
						label={t("customizability.confirm_before_unblock")}
						description={t("customizability.confirm_before_unblock_desc")}
						checked={confirmBeforeUnblock}
						onChange={(checked) => {
							setConfirmBeforeUnblock(checked);
							window.localStorage.setItem(SKIP_UNBLOCK_CONFIRM_KEY, String(!checked));
						}}
					/>
					<ToggleRow
						icon={<Trash2 className="h-5 w-5" />}
						iconClass="bg-red-500/15 text-red-400"
						id="behavior-confirm-delete-conversation"
						label={t("customizability.confirm_before_delete_conversation")}
						description={t("customizability.confirm_before_delete_conversation_desc")}
						checked={confirmBeforeDeleteConversation}
						onChange={(checked) => {
							setConfirmBeforeDeleteConversation(checked);
							window.localStorage.setItem(SKIP_DELETE_CONVERSATION_CONFIRM_KEY, String(!checked));
						}}
					/>
					<ToggleRow
						icon={<ExternalLink className="h-5 w-5" />}
						iconClass="bg-red-500/15 text-red-400"
						id="behavior-confirm-open-link"
						label={t("customizability.confirm_before_open_link", { defaultValue: "Confirm Before Opening Links" })}
						description={t("customizability.confirm_before_open_link_desc", {
							defaultValue:
								"Ask before opening a link tapped in a chat message. Turn this off to open links straight away.",
						})}
						checked={confirmBeforeOpenLink}
						onChange={(checked) => {
							setConfirmBeforeOpenLink(checked);
							window.localStorage.setItem(SKIP_LINK_OPEN_CONFIRM_KEY, String(!checked));
						}}
					/>
				</div>
				<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
					<ToggleRow
						icon={<Triangle className="h-5 w-5" />}
						iconClass="bg-sky-500/15 text-sky-400"
						id="behavior-location-finder"
						label={t("behavior.location_finder", { defaultValue: "Location Finder" })}
						description={t("behavior.location_finder_desc", {
							defaultValue:
								"Show Locate in a profile's menu. It finds roughly where someone is by moving your location on Grindr, which could get your account flagged.",
						})}
						checked={locationFinderEnabled}
						onChange={(checked) => {
							setLocationFinderEnabledState(checked);
							setLocationFinderEnabled(checked);
						}}
					/>
					<ToggleRow
						icon={<Search className="h-5 w-5" />}
						iconClass="bg-sky-500/15 text-sky-400"
						id="behavior-location-search-autofocus"
						label={t("behavior.auto_focus_location_search", { defaultValue: "Auto-Focus Location Search" })}
						description={t("behavior.auto_focus_location_search_desc", {
							defaultValue:
								"Put the cursor in the search field as soon as the location screen opens. Turn off if the keyboard coming up right away bothers you.",
						})}
						checked={locationSearchAutoFocus}
						onChange={(checked) => {
							setLocationSearchAutoFocus(checked);
							setLocationSearchAutoFocusEnabled(checked);
						}}
					/>
				</div>
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
						{t("behavior.disappearing_media", { defaultValue: "Disappearing Media" })}
					</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<ToggleRow
							icon={<Timer className="h-5 w-5" />}
							iconClass="bg-violet-500/15 text-violet-400"
							id="behavior-default-expiring-photos"
							label={t("behavior.default_expiring_photos", { defaultValue: "Send Photos as Expiring" })}
							description={t("behavior.default_expiring_photos_desc", {
								defaultValue:
									"A photo you attach or pick from the drawer starts out set to expire: it can be opened once, for 10 seconds. You can still change that before sending. Videos are not affected.",
							})}
							checked={expiringPhotos}
							onChange={(checked) => {
								setExpiringPhotos(checked);
								setDefaultExpiringPhotos(checked);
							}}
						/>
						<div id="behavior-default-album-expiration" className="flex items-start gap-3 px-4 py-3.5">
							<div className="shrink-0 rounded-2xl bg-violet-500/15 p-2.5 text-violet-400">
								<Images className="h-5 w-5" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="text-sm font-semibold">
									{t("behavior.default_album_expiration", { defaultValue: "Default Album Access" })}
								</p>
								<p className="mt-0.5 text-xs text-[var(--text-muted)]">
									{t("behavior.default_album_expiration_desc", {
										defaultValue:
											"How long someone keeps access to an album you share, unless you pick something else when sharing it.",
									})}
								</p>
								<div className="mt-3 flex flex-wrap gap-2">
									{ALBUM_EXPIRATION_TYPES.map((option) => (
										<Chip
											key={option}
											selected={albumExpiration === option}
											aria-pressed={albumExpiration === option}
											onClick={() => {
												setAlbumExpiration(option);
												setDefaultAlbumExpiration(option);
											}}
										>
											{albumExpirationLabels[option]}
										</Chip>
									))}
								</div>
							</div>
						</div>
					</div>
				</div>
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
						{t("behavior.media_drawer", { defaultValue: "Media Drawer" })}
					</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<ToggleRow
							icon={<ArrowDownWideNarrow className="h-5 w-5" />}
							iconClass="bg-violet-500/15 text-violet-400"
							id="behavior-drawer-most-sent-first"
							label={t("behavior.drawer_most_sent_first", { defaultValue: "Most Sent First" })}
							description={t("behavior.drawer_most_sent_first_desc", {
								defaultValue:
									"Show the photos and videos you send most often at the top of the drawer. Turn off to keep the order Grindr gives them.",
							})}
							checked={drawerMostSentFirst}
							onChange={(checked) => {
								setDrawerMostSentFirstState(checked);
								setDrawerMostSentFirst(checked);
							}}
						/>
					</div>
				</div>
				{isKeepScreenOnSupported() && (
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<ToggleRow
							icon={<Sun className="h-5 w-5" />}
							iconClass="bg-amber-500/15 text-amber-400"
							id="behavior-keep-screen-on"
							label={t("behavior.keep_screen_on", { defaultValue: "Keep Screen On" })}
							description={t("behavior.keep_screen_on_desc", {
								defaultValue:
									"Stop the screen from dimming or locking while the app is open and in front. Uses more battery.",
							})}
							checked={keepScreenOn}
							onChange={(checked) => {
								setKeepScreenOn(checked);
								setKeepScreenOnEnabled(checked);
							}}
						/>
					</div>
				)}
				<BackgroundExecutionCard />
			</div>
		</section>
	);
}
