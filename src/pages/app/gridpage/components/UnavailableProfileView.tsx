import { Ban, ChevronLeft, Loader2, MessageCircle, RotateCw, ShieldCheck, UserX, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ProfileImage } from "../../../../components/ui/profile-image";
import { ShowAnywayButton } from "../../../../components/ui/ShowAnywayButton";
import { useExplicitProfilePhotos } from "../../../../hooks/useExplicitProfilePhotos";
import {
	isExplicitProfilePhotoUrl,
	showProfilePhotoUrlAnyway,
} from "../../../../services/explicitProfilePhotos";
import { HIDDEN_MEDIA_PLACEHOLDER } from "../../../../utils/hiddenMediaPlaceholder";
import {
	createBackdropCloseHandler,
	useModalClose,
} from "../../../../hooks/useModalClose";
import type { UnavailableProfile } from "../../../../hooks/useUnavailableProfile";
import type { ChatContactIndexRecord } from "../../../../types/chat-contact-index";
import { validateMediaHash } from "../../../../utils/media";
import { prepareProfileCopyForDisplay } from "../../../../utils/profileCopyRules";
import type { UnavailableProfileState } from "../../../../utils/unavailableProfile";
import { formatDateTime24 } from "../../chat/chatUtils";
import type { ManagedOption, ProfileDetail } from "../../GridPage.types";
import { BlockExplanationLines } from "./BlockExplanationLines";
import { ProfileDetailsModal } from "./ProfileDetailsModal";

type UnavailableProfileViewProps = {
	variant?: "modal" | "page";
	profileId: string;
	profile: UnavailableProfile;
	onClose: () => void;
	/** Offered only when the block is this account's own. */
	onUnblock?: (profileId: string) => void;
	isUnblocking?: boolean;
	/** Offered, next to a saved copy, for someone this account does not block. */
	onBlock?: (profileId: string) => void;
	isBlocking?: boolean;
	/** Offered only when there is a chat with them on this device. */
	onOpenChat?: (conversationId: string) => void;
	/** Asks Grindr again; offered while nothing says whose block it is. */
	onRetry?: () => void;
	isRetrying?: boolean;
	onTagClick?: (tag: string) => void;
	chatContactStatus?: ChatContactIndexRecord | null;
	genderOptions: ManagedOption[];
	pronounOptions: ManagedOption[];
};

function describeState(
	t: TFunction,
	state: UnavailableProfileState,
): { title: string; detail: string } {
	if (state === "you_blocked") {
		return {
			title: t("profile_unavailable.you_blocked", {
				defaultValue: "You blocked this person",
			}),
			detail: t("profile_unavailable.you_blocked_detail", {
				defaultValue: "Their profile stays hidden while your block is in place.",
			}),
		};
	}
	if (state === "blocked_you") {
		return {
			title: t("profile_unavailable.blocked_you", {
				defaultValue: "This person blocked you",
			}),
			detail: t("profile_unavailable.blocked_you_detail", {
				defaultValue: "Their profile can't be opened while their block is in place.",
			}),
		};
	}
	if (state === "deleted") {
		return {
			title: t("profile_unavailable.deleted", {
				defaultValue: "This profile no longer exists",
			}),
			detail: t("profile_unavailable.deleted_detail", {
				defaultValue: "Grindr no longer has a profile for this person.",
			}),
		};
	}
	return {
		title: t("profile_unavailable.blocked_unknown", {
			defaultValue: "This profile can't be opened right now",
		}),
		detail: t("profile_unavailable.blocked_unknown_detail", {
			defaultValue:
				"There is a block between you and this person, and the app can't tell yet which side set it.",
		}),
	};
}

/** Same order as the profile page builds it: the main photo first. */
function collectPhotoHashes(profile: ProfileDetail): string[] {
	const hashes = profile.medias
		.map((item) => item.mediaHash ?? "")
		.filter((hash) => validateMediaHash(hash));
	const main = profile.profileImageMediaHash;
	if (main && validateMediaHash(main) && !hashes.includes(main)) {
		hashes.unshift(main);
	}
	return hashes;
}

const PRIMARY_ACTION =
	"inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-contrast)] transition hover:opacity-90 disabled:opacity-60";
const SECONDARY_ACTION =
	"inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5 text-sm font-medium text-[var(--text)] transition hover:border-[var(--accent)] disabled:opacity-60";
/** The same button sitting on a card that is itself the secondary surface. */
const SECONDARY_ACTION_ON_CARD =
	"inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium text-[var(--text)] transition hover:border-[var(--accent)] disabled:opacity-60";

/** What can still be done about them; null when there is nothing. */
function UnavailableProfileActions({
	profileId,
	profile,
	onUnblock,
	isUnblocking = false,
	onOpenChat,
	onRetry,
	isRetrying = false,
	className,
	secondaryClassName = SECONDARY_ACTION,
}: Pick<
	UnavailableProfileViewProps,
	"profileId" | "profile" | "onUnblock" | "isUnblocking" | "onOpenChat" | "onRetry" | "isRetrying"
> & { className: string; secondaryClassName?: string }) {
	const { t } = useTranslation();
	const conversationId = profile.conversationId;
	const showUnblock = profile.state === "you_blocked" && onUnblock;
	const showChat = conversationId && onOpenChat;
	const showRetry = profile.state === "blocked_unknown" && onRetry;
	if (!showUnblock && !showChat && !showRetry) return null;

	return (
		<div className={className}>
			{showUnblock && (
				<button
					type="button"
					onClick={() => onUnblock(profileId)}
					disabled={isUnblocking}
					className={PRIMARY_ACTION}
				>
					{isUnblocking ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : (
						<ShieldCheck className="h-4 w-4" />
					)}
					{isUnblocking
						? t("profile_details.unblock_in_progress")
						: t("profile_details.unblock")}
				</button>
			)}
			{showChat && (
				<button
					type="button"
					onClick={() => onOpenChat(conversationId)}
					className={secondaryClassName}
				>
					<MessageCircle className="h-4 w-4" />
					{t("profile_unavailable.open_chat", { defaultValue: "Open your chat" })}
				</button>
			)}
			{showRetry && (
				<button
					type="button"
					onClick={onRetry}
					disabled={isRetrying}
					className={secondaryClassName}
				>
					<RotateCw className={`h-4 w-4 ${isRetrying ? "animate-spin" : ""}`} />
					{t("profile_unavailable.retry", { defaultValue: "Check again" })}
				</button>
			)}
		</div>
	);
}

/**
 * The plain screen, for someone this device has no saved profile of: the name
 * and picture it does have, what happened, and what can still be done.
 */
function UnavailableProfileCard({
	variant = "modal",
	profileId,
	profile,
	onClose,
	onUnblock,
	isUnblocking,
	onOpenChat,
	onRetry,
	isRetrying,
}: Pick<
	UnavailableProfileViewProps,
	| "variant"
	| "profileId"
	| "profile"
	| "onClose"
	| "onUnblock"
	| "isUnblocking"
	| "onOpenChat"
	| "onRetry"
	| "isRetrying"
>) {
	const { t } = useTranslation();
	useModalClose({ isOpen: true, onClose });
	const handleBackdropClose = useMemo(() => createBackdropCloseHandler(onClose), [onClose]);

	const name =
		profile.name ?? t("profile_details.profile_fallback", { id: profileId });
	const description = describeState(t, profile.state);
	const BadgeIcon = profile.state === "deleted" ? UserX : Ban;
	// A photo the detector called explicit is drawn as the hidden tile.
	useExplicitProfilePhotos();
	const photoHidden = isExplicitProfilePhotoUrl(profile.photoUrl);

	const body = (
		<div className="flex w-full max-w-sm flex-col items-center text-center">
			<div className="relative">
				<div className="h-28 w-28 squircle bg-[var(--surface-2)] opacity-80 grayscale-[0.4]">
					<ProfileImage
						src={photoHidden ? HIDDEN_MEDIA_PLACEHOLDER : profile.photoUrl}
						alt={name}
						loading="eager"
					/>
				</div>
				<div className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)] ring-2 ring-[var(--surface)]">
					<BadgeIcon className="h-4 w-4" />
				</div>
			</div>

			{photoHidden ? (
				<div className="mt-3">
					<ShowAnywayButton onShow={() => showProfilePhotoUrlAnyway(profile.photoUrl)} />
				</div>
			) : null}
			<p className="mt-4 max-w-full truncate text-lg font-semibold text-[var(--text)]">{name}</p>
			<p className="mt-3 text-base font-semibold text-[var(--text)]">{description.title}</p>
			{profile.blockExplanation && (
				<BlockExplanationLines explanation={profile.blockExplanation} className="mt-2" />
			)}
			<p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">{description.detail}</p>

			<UnavailableProfileActions
				profileId={profileId}
				profile={profile}
				onUnblock={onUnblock}
				isUnblocking={isUnblocking}
				onOpenChat={onOpenChat}
				onRetry={onRetry}
				isRetrying={isRetrying}
				className="mt-6 flex w-full flex-col gap-2"
			/>
		</div>
	);

	if (variant === "page") {
		return (
			<div className="app-screen relative flex h-dvh w-full flex-col overflow-x-hidden bg-[var(--bg)] !px-0 !pb-0 !pt-0">
				<div
					className="flex items-center px-4 sm:px-5"
					style={{
						paddingTop: "calc(env(safe-area-inset-top,0px) + 10px)",
						paddingBottom: "0.75rem",
					}}
				>
					<button
						type="button"
						onClick={onClose}
						className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2 text-[var(--text)] transition-colors"
						aria-label={t("settings.back_to_browse")}
					>
						<ChevronLeft className="h-4 w-4" />
					</button>
				</div>
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-[calc(env(safe-area-inset-bottom,0px)+6rem)]">
					{body}
				</div>
			</div>
		);
	}

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
			onClick={handleBackdropClose}
		>
			<div
				className="surface-card relative flex w-full max-w-md flex-col items-center rounded-2xl px-6 pb-8 pt-12"
				onClick={(event) => event.stopPropagation()}
			>
				<button
					type="button"
					onClick={onClose}
					className="absolute left-4 top-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2 text-[var(--text-muted)] transition hover:text-[var(--text)]"
					aria-label={t("profile_details.close_profile_details")}
				>
					<X className="h-4 w-4" />
				</button>
				{body}
			</div>
		</div>
	);
}

/**
 * Shown in place of the profile when Grindr only returns its empty stub — a
 * block in either direction, or a profile that is gone.
 *
 * When this device saved their profile while it could still be read, that
 * copy is shown in the usual profile layout, under a notice saying what
 * happened and how old the copy is. Otherwise the plain screen above.
 */
export function UnavailableProfileView(props: UnavailableProfileViewProps) {
	const {
		variant = "modal",
		profileId,
		profile,
		onClose,
		onUnblock,
		isUnblocking = false,
		onBlock,
		isBlocking = false,
		onTagClick,
		chatContactStatus,
		genderOptions,
		pronounOptions,
	} = props;
	const { t } = useTranslation();
	const savedCopy = profile.savedCopy;
	const copyProfile = useMemo(
		() => (savedCopy ? prepareProfileCopyForDisplay(savedCopy.profile) : null),
		[savedCopy],
	);
	const copyPhotoHashes = useMemo(
		() => (copyProfile ? collectPhotoHashes(copyProfile) : []),
		[copyProfile],
	);

	// Still reading what this device has on them: the same placeholder a
	// profile shows while it loads, so neither screen flashes up by mistake.
	if (profile.isResolving) {
		return (
			<ProfileDetailsModal
				variant={variant}
				isOpen
				onClose={onClose}
				activeProfile={null}
				selectedBrowseCard={null}
				isLoadingActiveProfile
				activeProfileError={null}
				activeProfilePhotoHashes={[]}
				genderOptions={genderOptions}
				pronounOptions={pronounOptions}
			/>
		);
	}

	if (!savedCopy || !copyProfile) {
		return <UnavailableProfileCard {...props} />;
	}

	const description = describeState(t, profile.state);
	const BadgeIcon = profile.state === "deleted" ? UserX : Ban;
	const isBlockedByMe = profile.state === "you_blocked";
	const notice = (
		<div className="px-3">
			<div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
				<div className="flex items-start gap-3">
					<div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--text-muted)]">
						<BadgeIcon className="h-4 w-4" />
					</div>
					<div className="min-w-0 flex-1">
						<p className="text-sm font-semibold text-[var(--text)]">{description.title}</p>
						{profile.blockExplanation && (
							<BlockExplanationLines
								explanation={profile.blockExplanation}
								className="mt-1"
							/>
						)}
						<p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
							{t("profile_unavailable.saved_copy", {
								defaultValue:
									"This is their profile as it was on {{date}}. It is no longer updated.",
								date: formatDateTime24(savedCopy.savedAt),
							})}
						</p>
					</div>
				</div>
				<UnavailableProfileActions
					profileId={profileId}
					profile={profile}
					onUnblock={onUnblock}
					isUnblocking={isUnblocking}
					onOpenChat={props.onOpenChat}
					onRetry={props.onRetry}
					isRetrying={props.isRetrying}
					className="mt-3 flex flex-wrap gap-2"
					secondaryClassName={SECONDARY_ACTION_ON_CARD}
				/>
			</div>
		</div>
	);

	return (
		<ProfileDetailsModal
			variant={variant}
			isOpen
			onClose={onClose}
			onTagClick={onTagClick}
			// The header's block button: Unblock for this account's own block,
			// Block for someone it does not block. Nothing for a deleted profile.
			onUnblockProfile={isBlockedByMe ? onUnblock : undefined}
			onBlockProfile={
				!isBlockedByMe && profile.state !== "deleted" ? onBlock : undefined
			}
			isBlocked={isBlockedByMe}
			isBlockingProfile={isBlocking || isUnblocking}
			activeProfile={copyProfile}
			selectedBrowseCard={null}
			isLoadingActiveProfile={false}
			activeProfileError={null}
			activeProfilePhotoHashes={copyPhotoHashes}
			chatContactStatus={chatContactStatus}
			genderOptions={genderOptions}
			pronounOptions={pronounOptions}
			savedCopyNotice={notice}
		/>
	);
}
