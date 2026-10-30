import {
	ArrowUpDown,
	Database,
	DatabaseBackup,
	EyeOff,
	Eye,
	History,
	LayoutGrid,
	MapPin,
	NotebookPen,
	Reply,
	Share2,
	Sticker,
	Terminal,
	Users,
	Zap,
	type LucideIcon,
} from "lucide-react";

export interface AnnouncementItem {
	icon: LucideIcon;
	/** Keys of the texts, which live in the locale files. */
	titleKey: string;
	descriptionKey: string;
}

export interface VersionAnnouncement {
	version: string;
	headlineKey: string;
	items: AnnouncementItem[];
}

// Add one entry per release that should show a "what's new" screen on launch.
// Only the entry whose `version` matches the running app version (VITE_APP_VERSION,
// i.e. package.json's "version") is ever shown to users.
export const VERSION_ANNOUNCEMENTS: VersionAnnouncement[] = [
	{
		version: "0.5.3",
		headlineKey: "version_announcement.headline",
		items: [
			{
				icon: Database,
				titleKey: "version_announcement.items.local_chat_database.title",
				descriptionKey: "version_announcement.items.local_chat_database.description",
			},
			{
				icon: Terminal,
				titleKey: "version_announcement.items.chat_commands.title",
				descriptionKey: "version_announcement.items.chat_commands.description",
			},
			{
				icon: History,
				titleKey: "version_announcement.items.block_activity.title",
				descriptionKey: "version_announcement.items.block_activity.description",
			},
			{
				icon: Zap,
				titleKey: "version_announcement.items.automation_rules.title",
				descriptionKey: "version_announcement.items.automation_rules.description",
			},
			{
				icon: EyeOff,
				titleKey: "version_announcement.items.hide_conversations.title",
				descriptionKey: "version_announcement.items.hide_conversations.description",
			},
			{
				icon: Reply,
				titleKey: "version_announcement.items.reply_to_media.title",
				descriptionKey: "version_announcement.items.reply_to_media.description",
			},
            {
				icon: Sticker,
				titleKey: "version_announcement.items.send_gifs.title",
				descriptionKey: "version_announcement.items.send_gifs.description",
			},
			{
				icon: Share2,
				titleKey: "version_announcement.items.album_share_management.title",
				descriptionKey: "version_announcement.items.album_share_management.description",
			},
			{
				icon: ArrowUpDown,
				titleKey: "version_announcement.items.reorder_profile_pics.title",
				descriptionKey: "version_announcement.items.reorder_profile_pics.description",
			},
			{
				icon: NotebookPen,
				titleKey: "version_announcement.items.profile_notes.title",
				descriptionKey: "version_announcement.items.profile_notes.description",
			},
			{
				icon: Eye,
				titleKey: "version_announcement.items.profile_views.title",
				descriptionKey: "version_announcement.items.profile_views.description",
			},
			{
				icon: DatabaseBackup,
				titleKey: "version_announcement.items.backup_restore.title",
				descriptionKey: "version_announcement.items.backup_restore.description",
			},
			{
				icon: LayoutGrid,
				titleKey: "version_announcement.items.explore.title",
				descriptionKey: "version_announcement.items.explore.description",
			},
			{
				icon: Users,
				titleKey: "version_announcement.items.profile_switcher.title",
				descriptionKey: "version_announcement.items.profile_switcher.description",
			},
			{
				icon: MapPin,
				titleKey: "version_announcement.items.saved_locations.title",
				descriptionKey: "version_announcement.items.saved_locations.description",
			},
		],
	},
];
