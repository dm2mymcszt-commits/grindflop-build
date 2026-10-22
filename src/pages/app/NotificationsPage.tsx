import { useState } from "react";
import { Bell, Eye, Flame, MessageCircle, ShieldAlert } from "lucide-react";
import { BackToSettings } from "../../components/BackToSettings";
import { ToggleRow } from "../../components/ui/toggle-row";
import { useTranslation } from "react-i18next";
import { useSettingsJump } from "../../hooks/useSettingsJump";
import {
	CHAT_NOTIFICATIONS_ENABLED_KEY,
	FOREGROUND_NOTIFICATIONS_ENABLED_KEY,
	TAP_NOTIFICATIONS_ENABLED_KEY,
	isChatNotificationsEnabled,
	isForegroundNotificationsEnabled,
	isTapNotificationsEnabled,
	syncNotificationSettingsToNative,
} from "../../utils/notificationSettings";
import {
	INBOX_AUTOBLOCK_NOTIFICATIONS_STORAGE_KEY,
	INTEREST_VIEW_AUTOBLOCK_NOTIFICATIONS_STORAGE_KEY,
	isInboxAutoBlockNotificationsEnabled,
	isInterestViewAutoBlockNotificationsEnabled,
} from "../../utils/autoblock";

export function NotificationsPage() {
	const { t } = useTranslation();
	useSettingsJump();
	const [chatEnabled, setChatEnabled] = useState(() => isChatNotificationsEnabled());
	const [tapsEnabled, setTapsEnabled] = useState(() => isTapNotificationsEnabled());
	const [foregroundEnabled, setForegroundEnabled] = useState(() => isForegroundNotificationsEnabled());
	const [notifyInboxAutoBlock, setNotifyInboxAutoBlock] = useState(
		() => isInboxAutoBlockNotificationsEnabled(),
	);
	const [notifyInterestViewAutoBlock, setNotifyInterestViewAutoBlock] = useState(
		() => isInterestViewAutoBlockNotificationsEnabled(),
	);

	const setFlag = (key: string, value: boolean) => {
		window.localStorage.setItem(key, String(value));
		syncNotificationSettingsToNative();
	};

	return (
		<section className="app-screen">
			<header className="mb-7">
				<BackToSettings />
				<h1 className="app-title mb-1">{t("settings.notifications")}</h1>
				<p className="app-subtitle">{t("notifications_page.subtitle")}</p>
			</header>

			<div className="grid gap-6">
				<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
					<ToggleRow
						icon={<MessageCircle className="h-5 w-5" />}
						iconClass="bg-blue-500/15 text-blue-400"
						id="notif-chat"
						label={t("notifications_page.chat_enabled")}
						description={t("notifications_page.chat_enabled_desc")}
						checked={chatEnabled}
						onChange={(checked) => {
							setChatEnabled(checked);
							setFlag(CHAT_NOTIFICATIONS_ENABLED_KEY, checked);
						}}
					/>
					<ToggleRow
						icon={<Flame className="h-5 w-5" />}
						iconClass="bg-orange-500/15 text-orange-400"
						id="notif-taps"
						label={t("notifications_page.taps_enabled")}
						description={t("notifications_page.taps_enabled_desc")}
						checked={tapsEnabled}
						onChange={(checked) => {
							setTapsEnabled(checked);
							setFlag(TAP_NOTIFICATIONS_ENABLED_KEY, checked);
						}}
					/>
					<ToggleRow
						icon={<Bell className="h-5 w-5" />}
						iconClass="bg-[var(--surface-2)] text-[var(--text-muted)]"
						id="notif-foreground"
						label={t("notifications_page.foreground")}
						description={t("notifications_page.foreground_desc")}
						checked={foregroundEnabled}
						onChange={(checked) => {
							setForegroundEnabled(checked);
							setFlag(FOREGROUND_NOTIFICATIONS_ENABLED_KEY, checked);
						}}
					/>
					<ToggleRow
						icon={<ShieldAlert className="h-5 w-5" />}
						iconClass="bg-red-500/15 text-red-400"
						id="notif-inbox-autoblock"
						label={t("notifications_page.inbox_autoblock", { defaultValue: "Inbox Auto-Block Alerts" })}
						description={t("notifications_page.inbox_autoblock_desc", { defaultValue: "Get notified when a profile is automatically blocked from your inbox." })}
						checked={notifyInboxAutoBlock}
						onChange={(checked) => {
							setNotifyInboxAutoBlock(checked);
							window.localStorage.setItem(INBOX_AUTOBLOCK_NOTIFICATIONS_STORAGE_KEY, String(checked));
						}}
					/>
					<ToggleRow
						icon={<Eye className="h-5 w-5" />}
						iconClass="bg-violet-500/15 text-violet-400"
						id="notif-interest-autoblock"
						label={t("notifications_page.interest_autoblock", { defaultValue: "Interest Views Auto-Block Alerts" })}
						description={t("notifications_page.interest_autoblock_desc", { defaultValue: "Get notified when a viewer is automatically blocked from Interest Views." })}
						checked={notifyInterestViewAutoBlock}
						onChange={(checked) => {
							setNotifyInterestViewAutoBlock(checked);
							window.localStorage.setItem(INTEREST_VIEW_AUTOBLOCK_NOTIFICATIONS_STORAGE_KEY, String(checked));
						}}
					/>
				</div>
			</div>
		</section>
	);
}
