import {
	ArrowDownWideNarrow,
	Ban,
	Bell,
	Bookmark,
	Bug,
	ChartColumn,
	CheckCheck,
	Cloud,
	Crosshair,
	DatabaseBackup,
	Download,
	ExternalLink,
	Eye,
	EyeOff,
	FileDown,
	FileUp,
	Flame,
	Ghost,
	HardDrive,
	ImageIcon,
	ImageOff,
	Images,
	Info,
	Languages,
	LayoutGrid,
	Link2,
	MessageCircle,
	MessageSquare,
	Monitor,
	Palette,
	RotateCcw,
	Ruler,
	ScanSearch,
	Search,
	Shield,
	ShieldAlert,
	ShieldCheck,
	ShieldOff,
	SlidersHorizontal,
	Smile,
	Sparkles,
	Star,
	Sun,
	Tag,
	Timer,
	ToggleRight,
	Trash2,
	Triangle,
	UserCircle,
	UserPlus,
	Users,
	UserX,
	VenetianMask,
	Workflow,
	Zap,
	type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../contexts/PreferencesContext";
import { mayHaveAppDisguise } from "../utils/appDisguise";
import { canChooseEmojiStyle } from "../utils/emojiStyle";
import { isKeepScreenOnSupported } from "../utils/keepScreenOn";
import { mayHaveBackgroundExecution } from "../utils/backgroundExecution";

export type SettingsSearchEntry = {
	id: string;
	route: string;
	/** The id of the row on that page: the page scrolls to it and lights it up. Left out for a whole page. */
	anchor?: string;
	/** Where to land instead when that row is not on the page, because the switch that shows it is off. */
	fallbackAnchor?: string;
	label: string;
	description?: string;
	/** The page the setting is on, shown under the label in the results. */
	section: string;
	icon: LucideIcon;
	iconClass: string;
};

/** The address a result opens: its page, then the row and the row to fall back on. */
export function settingsSearchHref(entry: SettingsSearchEntry): string {
	const anchors = [entry.anchor, entry.fallbackAnchor].filter(Boolean);
	return anchors.length > 0 ? `${entry.route}#${anchors.join(",")}` : entry.route;
}

/**
 * Every setting the search can find: the settings pages, and the switches and
 * choices on them. A row's `anchor` is the `id` it carries on its page (see
 * useSettingsJump). Texts come from the same entries the pages read, so a
 * result is worded exactly like the row it opens; tests/settingsSearchIndex
 * keeps both of those true.
 */
export function useSettingsSearchIndex(): SettingsSearchEntry[] {
	const { t } = useTranslation();
	const { developerMode } = usePreferences();

	return useMemo<SettingsSearchEntry[]>(() => {
		const entries: SettingsSearchEntry[] = [];

		const page = (
			id: string,
			route: string,
			label: string,
			description: string | undefined,
			icon: LucideIcon,
			iconClass: string,
		) => {
			const entry: SettingsSearchEntry = {
				id,
				route,
				label,
				description,
				section: t("settings.title"),
				icon,
				iconClass,
			};
			entries.push(entry);
			return entry;
		};

		const row = (
			parent: SettingsSearchEntry,
			anchor: string,
			label: string,
			description: string | undefined,
			icon: LucideIcon,
			iconClass: string,
			options: { id?: string; fallbackAnchor?: string } = {},
		) => {
			entries.push({
				id: options.id ?? anchor,
				route: parent.route,
				anchor,
				fallbackAnchor: options.fallbackAnchor,
				label,
				description,
				section: parent.label,
				icon,
				iconClass,
			});
		};

		// Profile and accounts
		page(
			"nav-profile-editor",
			"/settings/profile-editor",
			t("settings.profile_editor"),
			t("settings.profile_editor_desc"),
			UserCircle,
			"bg-[var(--surface-2)] text-[var(--text-muted)]",
		);
		page(
			"nav-add-account",
			"/auth/sign-in?mode=add-profile",
			t("settings.add_account"),
			t("settings.add_account_desc"),
			UserPlus,
			"bg-[var(--surface-2)] text-[var(--text-muted)]",
		);

		// Appearance
		const violet = "bg-violet-500/15 text-violet-400";
		const appearance = page(
			"nav-customizability",
			"/settings/customizability",
			t("settings.customizability"),
			t("settings.customizability_desc"),
			Palette,
			violet,
		);
		row(appearance, "cust-color-scheme", t("customizability.color_scheme"), undefined, Monitor, violet);
		row(appearance, "cust-accent-color", t("customizability.accent_color"), undefined, Palette, violet);
		row(
			appearance,
			"cust-browse-grid",
			t("customizability.browse_grid_mobile"),
			t("customizability.browse_grid_mobile_desc"),
			LayoutGrid,
			"bg-blue-500/15 text-blue-400",
		);
		row(
			appearance,
			"cust-reveal-effect",
			t("customizability.reveal_effect.enable"),
			t("customizability.reveal_effect.enable_desc"),
			Sparkles,
			violet,
		);
		if (canChooseEmojiStyle()) {
			row(
				appearance,
				"cust-emoji-style",
				t("customizability.emoji_style"),
				t("customizability.emoji_style_desc"),
				Smile,
				"bg-amber-500/15 text-amber-400",
			);
		}
		row(
			appearance,
			"cust-show-right-now",
			t("customizability.show_right_now"),
			t("customizability.show_right_now_desc"),
			Flame,
			"bg-orange-500/15 text-orange-400",
		);
		row(
			appearance,
			"cust-show-interest",
			t("customizability.show_interest"),
			t("customizability.show_interest_desc"),
			Star,
			"bg-yellow-500/15 text-yellow-400",
		);
		row(
			appearance,
			"cust-default-interest-view",
			t("customizability.default_interest_view"),
			undefined,
			Star,
			"bg-yellow-500/15 text-yellow-400",
			{ fallbackAnchor: "cust-show-interest" },
		);
		row(
			appearance,
			"cust-show-stats",
			t("customizability.show_stats"),
			t("customizability.show_stats_desc"),
			ChartColumn,
			"bg-sky-500/15 text-sky-400",
		);
		row(
			appearance,
			"cust-language",
			t("settings.language"),
			t("settings.language_description"),
			Languages,
			"bg-teal-500/15 text-teal-400",
		);
		row(appearance, "cust-units", t("customizability.units"), undefined, Ruler, "bg-cyan-500/15 text-cyan-400");
		row(
			appearance,
			"cust-reset-warnings",
			t("customizability.reset_warnings"),
			t("customizability.reset_warnings_desc"),
			RotateCcw,
			"bg-red-500/15 text-red-400",
		);

		// Behavior
		const red = "bg-red-500/15 text-red-400";
		const sky = "bg-sky-500/15 text-sky-400";
		const behavior = page(
			"nav-behavior",
			"/settings/behavior",
			t("settings.behavior"),
			t("settings.behavior_desc"),
			SlidersHorizontal,
			"bg-slate-500/15 text-slate-400",
		);
		row(
			behavior,
			"behavior-confirm-block",
			t("customizability.confirm_before_block"),
			t("customizability.confirm_before_block_desc"),
			Ban,
			red,
		);
		row(
			behavior,
			"behavior-confirm-unblock",
			t("customizability.confirm_before_unblock"),
			t("customizability.confirm_before_unblock_desc"),
			ShieldOff,
			red,
		);
		row(
			behavior,
			"behavior-confirm-delete-conversation",
			t("customizability.confirm_before_delete_conversation"),
			t("customizability.confirm_before_delete_conversation_desc"),
			Trash2,
			red,
		);
		row(
			behavior,
			"behavior-confirm-open-link",
			t("customizability.confirm_before_open_link"),
			t("customizability.confirm_before_open_link_desc"),
			ExternalLink,
			red,
		);
		row(
			behavior,
			"behavior-location-finder",
			t("behavior.location_finder"),
			t("behavior.location_finder_desc"),
			Triangle,
			sky,
		);
		row(
			behavior,
			"behavior-location-search-autofocus",
			t("behavior.auto_focus_location_search"),
			t("behavior.auto_focus_location_search_desc"),
			Search,
			sky,
		);
		row(
			behavior,
			"behavior-default-expiring-photos",
			t("behavior.default_expiring_photos"),
			t("behavior.default_expiring_photos_desc"),
			Timer,
			violet,
		);
		row(
			behavior,
			"behavior-default-album-expiration",
			t("behavior.default_album_expiration"),
			t("behavior.default_album_expiration_desc"),
			Images,
			violet,
		);
		row(
			behavior,
			"behavior-drawer-most-sent-first",
			t("behavior.drawer_most_sent_first"),
			t("behavior.drawer_most_sent_first_desc"),
			ArrowDownWideNarrow,
			violet,
		);
		if (isKeepScreenOnSupported()) {
			row(
				behavior,
				"behavior-keep-screen-on",
				t("behavior.keep_screen_on"),
				t("behavior.keep_screen_on_desc"),
				Sun,
				"bg-amber-500/15 text-amber-400",
			);
		}

		if (mayHaveBackgroundExecution()) {
			row(behavior, "behavior-background-execution", t("behavior.background_execution"),
				t("behavior.background_execution_desc"), Zap, "bg-sky-500/15 text-sky-400");
		}

		// Notifications
		const notifications = page(
			"nav-notifications",
			"/settings/notifications",
			t("settings.notifications"),
			t("settings.notifications_desc"),
			Bell,
			"bg-blue-500/15 text-blue-400",
		);
		row(
			notifications,
			"notif-chat",
			t("notifications_page.chat_enabled"),
			t("notifications_page.chat_enabled_desc"),
			MessageCircle,
			"bg-blue-500/15 text-blue-400",
		);
		row(
			notifications,
			"notif-taps",
			t("notifications_page.taps_enabled"),
			t("notifications_page.taps_enabled_desc"),
			Flame,
			"bg-orange-500/15 text-orange-400",
		);
		row(
			notifications,
			"notif-foreground",
			t("notifications_page.foreground"),
			t("notifications_page.foreground_desc"),
			Bell,
			"bg-[var(--surface-2)] text-[var(--text-muted)]",
		);
		row(
			notifications,
			"notif-inbox-autoblock",
			t("notifications_page.inbox_autoblock"),
			t("notifications_page.inbox_autoblock_desc"),
			ShieldAlert,
			red,
		);
		row(
			notifications,
			"notif-interest-autoblock",
			t("notifications_page.interest_autoblock"),
			t("notifications_page.interest_autoblock_desc"),
			Eye,
			violet,
		);

		// Automation
		const amber = "bg-amber-500/15 text-amber-400";
		const rose = "bg-rose-500/15 text-rose-400";
		const automation = page(
			"nav-automation",
			"/settings/automation",
			t("settings.automation"),
			t("settings.automation_desc"),
			Workflow,
			amber,
		);
		row(
			automation,
			"automation-view-sweep",
			t("settings_automation.view_sweep"),
			t("settings_automation.view_sweep_desc"),
			Eye,
			"bg-indigo-500/15 text-indigo-400",
		);
		row(automation, "automation-explicit-cover", t("settings_automation.explicit.cover"), undefined, EyeOff, rose);
		// The four below only show once the one above is on.
		const explicitOff = { fallbackAnchor: "automation-explicit-cover" };
		row(
			automation,
			"automation-explicit-block-sender",
			t("settings_automation.explicit.block_sender"),
			undefined,
			Ban,
			rose,
			explicitOff,
		);
		row(
			automation,
			"automation-explicit-block-profile-photo",
			t("settings_automation.explicit.block_profile_photo"),
			undefined,
			UserX,
			rose,
			explicitOff,
		);
		row(
			automation,
			"automation-explicit-hide-in-albums",
			t("settings_automation.explicit.hide_in_albums"),
			undefined,
			Images,
			rose,
			explicitOff,
		);
		row(
			automation,
			"automation-explicit-hide-profile-photos",
			t("settings_automation.explicit.hide_profile_photos"),
			undefined,
			ImageOff,
			rose,
			explicitOff,
		);
		row(
			automation,
			"automation-inbox-autoblock",
			t("settings_automation.apply_to_inbox"),
			t("settings_automation.apply_to_inbox_desc"),
			Ban,
			red,
		);
		row(
			automation,
			"automation-interest-views",
			t("settings_automation.apply_to_interest_views"),
			t("settings_automation.apply_to_interest_views_desc"),
			Eye,
			violet,
		);
		// The folded sections, and what is inside them, only show while one of
		// the two switches above is on.
		const rulesOff = { fallbackAnchor: "automation-inbox-autoblock" };
		const section = (
			anchor: string,
			label: string,
			icon: LucideIcon,
			iconClass: string,
			inside: Array<[id: string, label: string, icon: LucideIcon]>,
		) => {
			row(automation, anchor, label, undefined, icon, iconClass, rulesOff);
			for (const [id, itemLabel, itemIcon] of inside) {
				row(automation, anchor, itemLabel, label, itemIcon, iconClass, { ...rulesOff, id });
			}
		};
		section("automation-keywords", t("settings_automation.sections.keywords"), Tag, "bg-orange-500/15 text-orange-400", [
			["automation-item-forbidden-keywords", t("settings_automation.forbidden_keywords_title"), Tag],
		]);
		section(
			"automation-message-rules",
			t("settings_automation.sections.message_rules"),
			MessageSquare,
			"bg-blue-500/15 text-blue-400",
			[
				["automation-item-opening-messages", t("settings_automation.items.opening_messages"), MessageSquare],
				["automation-item-bot-evasion", t("settings_automation.items.bot_evasion"), ImageIcon],
				["automation-item-link-bots", t("settings_automation.items.link_bots"), Link2],
				["automation-item-faceless", t("settings_automation.items.faceless"), UserCircle],
			],
		);
		section(
			"automation-profile-filters",
			t("settings_automation.sections.profile_filters"),
			Users,
			"bg-indigo-500/15 text-indigo-400",
			[
				["automation-item-right-now", t("settings_automation.items.right_now"), Zap],
				["automation-item-twitter", t("settings_automation.items.twitter"), ExternalLink],
				["automation-item-looking-for", t("settings_automation.items.looking_for_tags"), Crosshair],
				["automation-item-age-limits", t("settings_automation.age_limits_title"), Users],
			],
		);
		section(
			"automation-scanners",
			t("settings_automation.sections.scanners"),
			ShieldAlert,
			"bg-purple-500/15 text-purple-400",
			[
				["automation-item-inbox-scanner", t("settings_automation.items.inbox_scanner"), ShieldAlert],
				["automation-item-counter-block", t("settings_automation.items.counter_block"), UserX],
			],
		);
		section(
			"automation-exceptions",
			t("settings_automation.sections.exceptions"),
			ShieldCheck,
			"bg-emerald-500/15 text-emerald-400",
			[["automation-item-whitelist", t("settings_automation.items.whitelist"), ShieldCheck]],
		);

		// Chat
		page(
			"nav-saved-phrases",
			"/settings/saved-phrases",
			t("settings.saved_phrases"),
			t("settings.saved_phrases_desc"),
			Bookmark,
			"bg-emerald-500/15 text-emerald-400",
		);
		page(
			"nav-albums",
			"/settings/albums",
			t("settings.my_albums"),
			t("settings.my_albums_desc"),
			Images,
			"bg-pink-500/15 text-pink-400",
		);
		entries.push({
			id: "settings-export-chat",
			route: "/settings",
			anchor: "settings-export-chat",
			label: t("settings.export_chat"),
			description: t("settings.export_chat_desc"),
			section: t("settings.title"),
			icon: Download,
			iconClass: "bg-teal-500/15 text-teal-400",
		});

		// Safety
		page(
			"nav-blocked",
			"/settings/blocked",
			t("settings.blocked_accounts"),
			t("settings.blocked_accounts_desc"),
			UserX,
			red,
		);
		const privacy = page(
			"nav-privacy",
			"/settings/privacy",
			t("settings.privacy"),
			t("settings.privacy_desc"),
			Shield,
			sky,
		);
		row(
			privacy,
			"privacy-incognito",
			t("privacy.incognito_mode"),
			t("privacy.incognito_mode_desc"),
			Ghost,
			"bg-fuchsia-500/15 text-fuchsia-400",
		);
		row(
			privacy,
			"privacy-media-scanner",
			t("privacy.media_scanner"),
			t("privacy.media_scanner_desc"),
			ScanSearch,
			"bg-blue-500/15 text-blue-400",
		);
		row(
			privacy,
			"privacy-read-receipts",
			t("privacy.send_read_receipts"),
			t("privacy.send_read_receipts_desc"),
			CheckCheck,
			"bg-indigo-500/15 text-indigo-400",
		);
		row(
			privacy,
			"privacy-per-chat-read-receipts",
			t("privacy.per_chat_overrides"),
			t("privacy.per_chat_overrides_desc"),
			ToggleRight,
			"bg-blue-500/15 text-blue-400",
		);
		row(
			privacy,
			"privacy-record-profile-views",
			t("privacy.record_profile_views"),
			t("privacy.record_profile_views_desc"),
			Eye,
			amber,
		);
		row(
			privacy,
			"privacy-blur-incoming-media",
			t("customizability.blur_incoming_media"),
			t("customizability.blur_incoming_media_description"),
			ImageOff,
			sky,
		);
		// Only the iPhone app can swap its icon.
		if (mayHaveAppDisguise()) {
			row(
				privacy,
				"privacy-app-disguise",
				t("privacy.app_disguise"),
				t("privacy.app_disguise_desc"),
				VenetianMask,
				"bg-slate-500/15 text-slate-400",
			);
		}

		// Data
		const teal = "bg-teal-500/15 text-teal-400";
		const data = page(
			"nav-data",
			"/settings/data",
			t("settings.data"),
			t("settings.data_desc"),
			DatabaseBackup,
			teal,
		);
		row(
			data,
			"data-auto-download-media",
			t("data_backup.auto_download_media"),
			t("data_backup.auto_download_media_desc"),
			Download,
			"bg-emerald-500/15 text-emerald-400",
		);
		row(data, "data-app-database", t("data_backup.app_database"), undefined, HardDrive, teal);
		row(data, "data-storage-used", t("data_backup.storage_used"), undefined, HardDrive, teal);
		row(
			data,
			"data-copy-settings",
			t("data_backup.copy_settings.title"),
			t("data_backup.copy_settings.section"),
			Users,
			teal,
		);
		row(data, "data-drive-sync", t("data_backup.drive_sync.section"), undefined, Cloud, sky);
		row(data, "data-export", t("data_backup.export"), t("data_backup.export_card_desc"), FileDown, teal);
		row(data, "data-import", t("data_backup.import"), t("data_backup.import_card_desc"), FileUp, violet);
		row(
			data,
			"data-stored",
			t("data_backup.manage_heading"),
			t("data_backup.manage_title"),
			Trash2,
			red,
		);
		row(data, "data-reset", t("data_backup.reset.action"), t("data_backup.reset.desc"), RotateCcw, red);

		// About
		page(
			"nav-about",
			"/settings/about",
			t("settings.about"),
			t("settings.about_desc"),
			Info,
			"bg-slate-500/15 text-slate-400",
		);

		if (developerMode) {
			page(
				"nav-api-inspector",
				"/settings/api-inspector",
				t("settings.api_inspector"),
				t("settings.api_inspector_desc"),
				Bug,
				"bg-slate-500/15 text-slate-400",
			);
		}

		return entries;
	}, [t, developerMode]);
}
