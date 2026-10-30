import { memo } from "react";
import type { BrowseCard } from "../../GridPage.types";
import { MapPin, MessageCircle, Plane, Star, Zap, Droplet } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	formatDistance,
	getOnlineStatusMeta,
	getDisplayName,
} from "../utils";
import { cn } from "../../../../utils/cn";
import { ProfileImage } from "../../../../components/ui/profile-image";
import { isExplicitProfilePhotoUrl } from "../../../../services/explicitProfilePhotos";
import { HIDDEN_MEDIA_PLACEHOLDER } from "../../../../utils/hiddenMediaPlaceholder";
import { usePreferences } from "../../../../contexts/PreferencesContext";
import type { ChatContactIndexRecord } from "../../../../types/chat-contact-index";
import { useExplicitProfilePhotos } from "../../../../hooks/useExplicitProfilePhotos";
import { useRevealOnScroll } from "../../../../hooks/useRevealOnScroll";
import { SelectableItem } from "../../../../components/multi-select/SelectableItem";

type BrowseCardTileProps = {
	card: BrowseCard;
	chatContactStatus?: ChatContactIndexRecord | null;
	localNickname?: string;
	onSelectProfile: (profileId: string) => void;
	onMessageProfile: (profileId: string) => void;
	isDesktop?: boolean;
};

function BrowseCardTileImpl({
	card,
	chatContactStatus,
	localNickname,
	onSelectProfile,
	onMessageProfile: _onMessageProfile,
	isDesktop = false,
}: BrowseCardTileProps) {
	const { t } = useTranslation();
	const { unitsPreset, showDebugInfo } = usePreferences();
	const { ref, revealClass } = useRevealOnScroll();
	// Redrawn when a photo is found explicit or is shown anyway.
	useExplicitProfilePhotos();
	const name = localNickname?.trim() || getDisplayName(card);
	const onlineStatus = getOnlineStatusMeta(card.lastOnline, card.onlineUntil);
	const age = typeof card.age === "number" && card.age > 0 ? card.age : null;
	const isDemoCard = card.profileId.toString().startsWith("demo-");
	const isVisiting = card.isVisiting === true;
	const isPopular = card.isPopular === true;
	const isRightNow = card.rightNow === "HOSTING" || card.rightNow === "NOT_HOSTING";
	const isBoosting = card.isBoosting === true;
	const databaseUnread = chatContactStatus?.unreadCount ?? 0;
	const apiUnread = card.unreadCount ?? 0;
	const unreadCount = Math.max(databaseUnread, apiUnread);
	const hasChatted = Boolean(chatContactStatus?.hasChatted) || card.chatted === true || unreadCount > 0;
	const isFavorite = card.favorite === true;


	return (
		<div ref={ref} className={cn(!isDesktop && "bg-black rounded-[4px] overflow-hidden", revealClass)}>
			<SelectableItem
				id={card.profileId}
				profileId={card.profileId}
				name={name}
				viewType="grid"
				onNormalClick={() => !isDemoCard && onSelectProfile(card.profileId)}
				roundedClassName={isDesktop ? "rounded-xl" : "rounded-[4px]"}
			>
				<button
					type="button"
					key={card.profileId}
					className={cn(
						"surface-card-grid overflow-hidden text-left transition-transform w-full block relative",
						!isDemoCard && "active:scale-95",
						isDesktop
							? "rounded-xl shadow-sm"
							: "rounded-[4px]",
						isBoosting ? "p-[2.5px] z-20" : "p-0",
						isDemoCard && "cursor-default"
					)}
				>
				{/* Animated Gradient Border Layer (Enhanced Glow) */}
				{isBoosting && (
					<div
						className="absolute inset-[-100%] animate-[spin_5s_linear_infinite] z-0 blur-[15px] opacity-100"
						style={{
							background: 'conic-gradient(from 0deg, transparent 0deg, var(--accent) 180deg, transparent 360deg)'
						}}
					/>
				)}

				{/*
					Replace "aspect-[5/5]" with "h-0 pb-[100%]", since "aspect-ratio" collapses tile height to ~0 on
                    pre-iOS-15 WebKit. This triggered an endless pagination loop
                    that crashed the WebView renderer. thank you flo
				*/}
				<div className="relative w-full h-0 pb-[100%] bg-[var(--surface-2)] z-10 rounded-[inherit] overflow-hidden">
					<div className="absolute inset-0">
					<ProfileImage
						// A photo the detector called explicit is drawn as the hidden tile.
						src={isExplicitProfilePhotoUrl(card.primaryImageUrl) ? HIDDEN_MEDIA_PLACEHOLDER : card.primaryImageUrl}
						alt={t("browse_page.profile_photo_alt", { name })}
						className={cn(
							isDemoCard && "blur-xl scale-110",
							"group-data-[hide-images]/grid:blur-xl group-data-[hide-images]/grid:scale-110 group-data-[hide-images]/grid:opacity-60",
						)}
					/>

					{/* Overlay for inner shadow - sits on top of the image - we might want to use this later
					{isBoosting && (
						/* <div className="absolute inset-0 z-10 pointer-events-none shadow-[inset_0_0_10px_var(--accent),inset_0_0_15px_rgba(0,0,0,0.6)] rounded-[inherit]" />
					)}
                     */}

					{/* Top Header: Name, Age & Status Cluster */}
					<div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 via-black/20 to-transparent p-2 text-white">
						<div className="min-w-0 flex-1">
							<p className="text-sm sm:text-base font-bold leading-tight truncate">
								{name}
								{age && <span className="font-semibold text-white/90 ml-1"> {age}</span>}
							</p>
						</div>

						<div className={cn(
							"flex shrink-0 items-center",
							onlineStatus.isOnline ? "gap-1" : "gap-0.5"
						)}>
							{(isRightNow || isVisiting || isPopular) && (
								<div className="flex items-center gap-0.5">
									{isPopular && (
										<span title={t("browse_page.badge_popular")}>
											<Zap
												className="h-4 w-4 text-amber-400 drop-shadow-[0_1px_1.5px_rgba(0,0,0,1)] drop-shadow-[0_0_0.8px_rgba(0,0,0,1)]"
												strokeWidth={2.5}
											/>
										</span>
									)}
									{isRightNow && (
										<span title={t("nav.right_now")}>
											<Droplet
												className="h-4 w-4 text-[var(--right-now)] drop-shadow-[0_1px_1.5px_rgba(0,0,0,1)] drop-shadow-[0_0_0.8px_rgba(0,0,0,1)]"
												strokeWidth={2.5}
											/>
										</span>
									)}
									{isVisiting && (
										<span title={t("profile_details.visiting")}>
											<Plane
												className="h-4 w-4 text-green-500 drop-shadow-[0_1px_1.5px_rgba(0,0,0,1)] drop-shadow-[0_0_0.8px_rgba(0,0,0,1)]"
												strokeWidth={2.5}
											/>
										</span>
									)}
								</div>
							)}
							{onlineStatus.isOnline ? (
								<span className="block h-3 w-3 rounded-full bg-green-500 shadow-lg ring-2 ring-black/30" />
							) : (
								<span className="inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold text-white sm:text-[11px]">
									{t(onlineStatus.labelKey, { count: onlineStatus.count })}
								</span>
							)}
						</div>
					</div>

					{/* Bottom-right: Interaction cluster */}
					<div className="absolute bottom-2 right-2 z-10 flex items-center gap-1">
						{isFavorite && (
							<div className="flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-yellow-500 shadow-lg">
								<Star className="h-3.5 w-3.5 fill-current" />
							</div>
						)}

						{unreadCount > 0 ? (
							<span className="flex h-5 min-w-5 flex-col items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-[var(--accent-contrast)] shadow-lg ring-1 ring-black/20">
								<span>{unreadCount}</span>
								{showDebugInfo && !isDemoCard && (
									<span className="text-[7px] leading-tight opacity-80">
										db:{databaseUnread} a:{apiUnread}
									</span>
								)}
							</span>
						) : hasChatted ? (
							<div className="flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white shadow-lg">
								<MessageCircle className="h-3.5 w-3.5" />
							</div>
						) : null}
					</div>

					{/* Bottom-left: Distance */}
					<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent px-2 py-0 text-white">
						<span className="inline-flex items-center gap-1 text-xs font-semibold">
							<MapPin className="h-3.5 w-3.5" />
							{formatDistance(card.distanceMeters, t, unitsPreset)}
						</span>
					</div>
					</div>
					</div>
				</button>
			</SelectableItem>
		</div>
	);
}

/**
 * Memoised because the grid never unmounts a card once loaded: without this
 * every tile on screen re-renders on any GridPage state change.
 */
export const BrowseCardTile = memo(BrowseCardTileImpl);
