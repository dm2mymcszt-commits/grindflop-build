import {
	Album,
	Archive,
	Ban,
	Check,
	CheckCheck,
	ChevronLeft,
	CircleCheck,
	Copy,
	Download,
	Ellipsis,
	Eye,
	EyeOff,
	Star,
	GitMerge,
	Hourglass,
	ImagePlus,
	Images,
	Loader2,
	MapPin,
	Mic,
	Square,
	Plus,
	Settings2,
	BookMarked,
	MessageCircleOff,
	MessageCircleX,
	MessageSquarePlus,
	PencilLine,
	Pin,
	Reply,
	RotateCw,
	SendHorizontal,
	ShieldCheck,
	SquareCenterlineDashedHorizontal,
	SquareStack,
	Sticker,
	Trash2,
	Undo2,
	User,
	Volume2,
	X,
	FileAudio,
} from "lucide-react";
import { extractAudioToWav, getAudioFileMetadata } from "../../../utils/audioUtils";
import { createPortal } from "react-dom";
import { SortablePhraseList } from "../../../components/SortablePhraseList";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import type { NavigateFunction } from "react-router-dom";
import toast from "react-hot-toast";
import { appLog } from "../../../utils/logger";
import { isIos, isAndroid, saveMediaToDevice } from "../../../services/saveMedia";
import {
	useModalClose,
} from "../../../hooks/useModalClose";
import type { AlbumListItem, UiMessage } from "../../../types/chat-page";
import type { ConversationEntry, Message } from "../../../types/messages";
import type { ProfileDetail } from "../../../types/grid";
import type { DrawerMedia } from "./ChatDrawerPanel";
import { ChatDrawerPanel } from "./ChatDrawerPanel";
import { decodeGeohash } from "../../../utils/geohash";
import { MapLocationPicker } from "../gridpage/components/MapLocationPicker";
import freegrindLogo from "../../../images/freegrind-logo.webp";
import { usePreferences } from "../../../contexts/PreferencesContext";
import {
	getMessageLocation,
	getMessagePreviewLabel,
	getOtherParticipant,
	getParticipantAvatarUrl,
	getParticipantOnlineMeta,
	getMessageImageUrl,
	getMessageVideoUrl,
	getMessageAudioUrl,
	getMessageAlbumId,
	getMessageAlbumCoverUrl,
} from "./chatUtils";
import { getThumbImageUrl } from "../../../utils/media";
import { formatDistance } from "../gridpage/utils";
import { ProfileImage } from "../../../components/ui/profile-image";
import { ChatThreadMessages } from "./ChatThreadMessages";
import { isSelectableMediaMessage } from "./mediaSelection";
import { AudioMessagePlayer } from "./AudioMessagePlayer";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog";
import { BanWordDialog } from "../../../components/ui/BanWordDialog";
import { banSelectableProps, useBanOnSelect, type BanSelectionKind } from "../../../hooks/useBanOnSelect";

/** Stable identity, so the selection listener is not re-subscribed every render. */
const BAN_SELECT_KINDS: readonly BanSelectionKind[] = ["message", "name"];
import { classifyProfileAccess } from "../../../utils/profileAccessStatus";
import { useApiFunctions } from "../../../hooks/useApiFunctions";
import {
	getShowReadReceiptToggle,
	isReadReceiptsHidden,
	toggleReadReceiptsHidden,
	isProfileAutoblockWhitelisted,
	addToAutoBlockWhitelist,
	removeFromAutoBlockWhitelist,
} from "../../../utils/privacy";
import { ToggleRow } from "../../../components/ui/toggle-row";
import { BottomDrawer } from "../../../components/ui/bottom-drawer";
import { BottomSheet, SheetClose } from "../../../components/ui/bottom-sheet";
import { GiphyPickerSheet } from "./GiphyPickerSheet";
import type { ArchivedReason, BlockState } from "../../../types/chat-db";
import { useAvatarCache } from "../../../hooks/useAvatarCache";
import { resolveAvatarSrc } from "../../../services/avatarStore";
import { matchSlashCommandsByPrefix, type SlashCommandDef } from "./slashCommands";
import {
	getNativeKeyboardHeight,
	isNativeKeyboardResize,
	NATIVE_KEYBOARD_EVENT,
	refreshNativeViewport,
} from "../../../utils/nativeKeyboard";
import {
	SKIP_BLOCK_CONFIRM_KEY,
	SKIP_UNBLOCK_CONFIRM_KEY,
	SKIP_DELETE_CONVERSATION_CONFIRM_KEY,
	isBlockConfirmSkipped,
	isUnblockConfirmSkipped,
	isDeleteConversationConfirmSkipped,
} from "../../../utils/blockConfirm";

async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
	if (!blob.type.includes("webm")) return blob;
	const buf = await blob.arrayBuffer();
	const data = new Uint8Array(buf);
	// Find Matroska Duration element (ID 0x4489) with 8-byte float64 (size VINT 0x88)
	for (let i = 0; i < data.length - 10; i++) {
		if (data[i] === 0x44 && data[i + 1] === 0x89 && data[i + 2] === 0x88) {
			new DataView(buf).setFloat64(i + 3, durationMs, false);
			return new Blob([buf], { type: blob.type });
		}
	}
	return blob;
}
import {
	loadSavedPhrases,
	saveSavedPhrases,

	SAVED_PHRASES_UPDATED_EVENT,
} from "../../../services/savedPhrases";
import { PastContactNote } from "../../../components/PastContactNote";
import { ArchivedBlockExplanation } from "./ArchivedBlockExplanation";
import { getContentCoverForMessage, isExplicitFilterEnabled } from "../../../services/contentCheck";

type ChatThreadPanelProps = {
	navigate: NavigateFunction;
	isDesktop: boolean;
	selectedConversation: ConversationEntry | null;
	targetProfileId: number | null;
	targetProfileDetail?: ProfileDetail | null;
	userId: number | null;
	nowTimestamp: number;
	isUpdatingConversationState: boolean;
	isHeaderActionsMenuOpen: boolean;
	setIsHeaderActionsMenuOpen: (value: ((current: boolean) => boolean) | boolean) => void;
	headerActionsMenuRef: { current: HTMLDivElement | null };
	togglePin: () => void | Promise<void>;
	toggleMute: () => void | Promise<void>;
	isHidden: boolean;
	toggleHide: () => void;
	onDeleteConversation?: (conversationId: string) => void | Promise<void>;
	isDeletingConversation?: boolean;
	onBlockProfile?: (profileId: number) => void | Promise<void>;
	isBlockingProfile?: boolean;
	onUnblockProfile?: (profileId: number) => void | Promise<void>;
	isUnblockingProfile?: boolean;
	isBlockedBySelf?: boolean;
	onToggleFavorite?: (profileId: number, currentlyFavorite: boolean) => void | Promise<void>;
	isFavorite?: boolean;
	isTogglingFavorite?: boolean;
	hasChattedBefore?: boolean;
	lastMessageTimestamp?: number | null;
	localNickname?: string | null;
	onEditLocalNickname?: (profileId: number, defaultName: string) => void | Promise<void>;
	getProfileReturnToChatPath: (profileId: number) => string;
	isLoadingThread: boolean;
	threadConversationId: string | null;
	threadError: string | null;
	loadThread: (args: { conversationId: string; older: boolean }) => void | Promise<void>;
	threadScrollContainerRef: { current: HTMLDivElement | null };
	handleThreadScroll: (event: React.UIEvent<HTMLDivElement>) => void;
	messagePageKey: string | null;
	isLoadingOlderMessages: boolean;
	threadMessages: UiMessage[];
	threadLastReadTimestamp: number | null;
	messageElementRefs: { current: Map<string, HTMLDivElement> };
	handleMessageTap: (message: Message) => void | Promise<void>;
	startMessageLongPress: (messageId: string) => void;
	endMessageLongPress: () => void;
	messageLongPressTriggeredRef: { current: boolean };
	openFullScreenImage: (imageUrl: string, meta?: { takenOnGrindr: boolean; createdAtLabel: string | null; timestamp: number }, mediaType?: "image" | "video") => void;
	openAlbumViewerById: (albumId: number, isOwnAlbum?: boolean) => void | Promise<void>;
	onJumpToMessage: (messageId: string) => void;
	highlightedMessageId: string | null;
	selectedThreadMessageMatches: Array<{ messageId: string }>;
	activeThreadSearchIndex: number;
	openMessageActionId: string | null;
	setOpenMessageActionId: (value: ((current: string | null) => string | null) | string | null) => void;
	isMutatingMessageId: string | null;
	reactionBurstMessageId: string | null;
	handleReact: (message: Message) => void | Promise<void>;
	handleUnsend: (message: Message) => void | Promise<void>;
	handleDelete: (message: Message) => void | Promise<void>;
	handleRetry: (message: Message) => void;
	handleReply: (message: Message) => void | Promise<void>;
	handleStopAlbumShare: (albumId: number) => void | Promise<void>;
	threadBottomRef: { current: HTMLDivElement | null };
	handleSend: (event: React.FormEvent<HTMLFormElement>) => void;
	toggleAlbumPicker: () => void;
	toggleDrawer: () => void;
	attachmentInputRef: { current: HTMLInputElement | null };
	onAttachmentInput: (event: React.ChangeEvent<HTMLInputElement>) => void;
	/** A photo or video that was dropped onto the chat or pasted into the message box. */
	onAttachmentFile: (file: File) => void;
	isUploadingAttachment: boolean;
	pendingAttachmentFile: File | null;
	attachmentLooping: boolean;
	attachmentTakenOnGrindr: boolean;
	attachmentAddToDrawer: boolean;
	attachmentMaxViews: number;
	setAttachmentLooping: (value: boolean) => void;
	setAttachmentTakenOnGrindr: (value: boolean) => void;
	setAttachmentAddToDrawer: (value: boolean) => void;
	setAttachmentMaxViews: (value: number) => void;
	confirmPendingAttachment: () => void;
	confirmAttachmentFile: (file: File) => void | Promise<void>;
	cancelPendingAttachment: () => void;
	isAlbumPickerOpen: boolean;
	isLoadingAlbums: boolean;
	shareableAlbums: AlbumListItem[];
	albumCoverMap?: Map<number, string>;
	ownProfilePhotoUrl?: string | null;
	isSharingAlbum: boolean;
	pendingAlbumShare: {
		albumId: number;
		albumName: string;
	} | null;
	shareAlbumToCurrentConversation: (
		albumId: number,
		albumName?: string | null,
	) => void | Promise<void>;
	confirmPendingAlbumShare: (expirationType: string) => void | Promise<void>;
	closePendingAlbumShare: () => void;
	isDrawerOpen: boolean;
	isLoadingDrawer: boolean;
	drawerError: string | null;
	drawerMedia: DrawerMedia[];
	isSendingDrawerMedia: boolean;
	isAddingDrawerMedia: boolean;
	deletingDrawerMediaId: number | null;
	onLoadDrawerMedia: () => void | Promise<void>;
	onSendDrawerMedia: (mediaIds: number[], maxViews?: number) => Promise<void>;
	onAddDrawerMedia: (file: File, takenOnGrindr: boolean) => Promise<void>;
	onDeleteDrawerMedia: (mediaId: number) => Promise<void>;
	onShareAlbumFromDrawer: (albumId: number, expirationType: string) => Promise<void>;
	onStopAlbumShareFromDrawer: (albumId: number) => Promise<void>;
	onSendLocation: (lat: number, lon: number) => void | Promise<void>;
	onSendGiphy: (gif: { id: string; urlPath: string; stillPath: string; previewPath: string; width: number; height: number }) => void | Promise<void>;
	onAudioRecorded: (blob: Blob, durationMs: number, autoSend?: boolean, waveform?: number[]) => void;
	pendingAudioBlob: Blob | null;
	pendingAudioDuration: number;
	isSendingAudio: boolean;
	confirmAudio: () => void | Promise<void>;
	cancelAudio: () => void;
	uploadProgress: number;
	draft: string;
	setDraft: (value: string) => void;
	replyTargetMessage: UiMessage | null;
	clearReplyTarget: () => void;
	isSending: boolean;
	selectedActionMessage: UiMessage | null;
	selectedActionMessageMine: boolean;
	isAlbumSheetOpen: boolean;
	onOpenMediaSheet?: () => void;
	isPartnerTyping?: boolean;
	isArchived?: boolean;
	archivedReason?: ArchivedReason | null;
	/** Who blocked whom, when the record says. null means it does not. */
	archivedBlockState?: BlockState | null;
	/** Photos and videos being picked, by message id; null when not picking. */
	selectedMediaIds: ReadonlySet<string> | null;
	onStartMediaSelection: (message: UiMessage) => void;
	onToggleMediaSelection: (message: UiMessage) => void;
	onSaveSelectedMedia: () => void | Promise<void>;
	onDeleteSelectedMedia: () => void | Promise<void>;
	/** The usual actions for the one picked message. */
	onOpenSelectedMediaActions: () => void;
	onCancelMediaSelection: () => void;
	isWorkingOnSelectedMedia: boolean;
	/** How many picked ones show "not saved" and cannot be downloaded. */
	unsaveablePickedCount: number;
	/** The message whose actions are open shows "not saved", so it cannot be opened or downloaded. */
	isActionMediaUnavailable: boolean;
	onUnavailableMediaChange: (messageIds: string[]) => void;
	mergeableConversations?: ConversationEntry[];
	onMergeConversation?: (
		sourceConversationId: string,
		targetConversationId: string,
	) => void | Promise<void>;
	isMergingConversation?: boolean;
};


function AudioPreviewPlayer({ blob, durationMs, recordedBars, recordedFraction }: { blob: Blob; durationMs: number; recordedBars: number[]; recordedFraction: number }) {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		const u = URL.createObjectURL(blob);
		setUrl(u);
		return () => { setTimeout(() => URL.revokeObjectURL(u), 3000); };
	}, [blob]);
	if (!url) return null;
	return <AudioMessagePlayer src={url} messageId="preview" mine={false} className="w-full" durationHint={durationMs / 1000} hideSpeed compact initialBars={recordedBars} recordedFraction={recordedFraction} />;
}

export function ChatThreadPanel(props: ChatThreadPanelProps) {
	const { t } = useTranslation();
	useAvatarCache();
	const apiFunctions = useApiFunctions();


	const { unitsPreset, geohash } = usePreferences();
	const [pendingLocationShare, setPendingLocationShare] = useState<{ lat: number; lon: number } | null>(null);
	const [isSavedPhrasesOpen, setIsSavedPhrasesOpen] = useState(false);
	const [phrasesExpanded, setPhrasesExpanded] = useState(false);
	const [isGiphyPickerOpen, setIsGiphyPickerOpen] = useState(false);
	const [newPhraseInput, setNewPhraseInput] = useState("");
	const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
	const [isComposerFocused, setIsComposerFocused] = useState(false);
	// Where the chat is on screen while a file is dragged over it, for the
	// frame that says it can be dropped. Null when no file is over the chat.
	const [fileDropZone, setFileDropZone] = useState<DOMRect | null>(null);
	// A drag crosses many elements on its way over the chat, and each one it
	// enters and leaves reports it. Only when the count is back at zero has it
	// left the chat.
	const dragDepthRef = useRef(0);

	const [isRecording, setIsRecording] = useState(false);
	const [recordingMs, setRecordingMs] = useState(0);
	const [waveformBars, setWaveformBars] = useState<number[]>([]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const waveformBarsRef = useRef<number[]>([]);
	const [recordedWaveform, setRecordedWaveform] = useState<number[]>([]);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const recordingStartRef = useRef(0);
	const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const recordingMaxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const audioCtxRef = useRef<AudioContext | null>(null);
	const waveformRafRef = useRef<number | null>(null);
	const swipeStartXRef = useRef(0);
	const isCapturingRef = useRef(false);
	const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hasVibratedRef = useRef(false);
	const [recordDragX, setRecordDragX] = useState(0);
	const [showRecordCircle, setShowRecordCircle] = useState(false);
	const [trashBounce, setTrashBounce] = useState(false);
	const CANCEL_THRESHOLD = window.innerWidth * 0.35;
	const dragProgress = Math.min(1, Math.abs(Math.min(0, recordDragX)) / CANCEL_THRESHOLD);
	const stopRecordingRef = useRef<(autoSend?: boolean) => void>(() => {});

	// --- AUDIO / VIDEO UPLOAD ---
	const [isMicMenuOpen, setIsMicMenuOpen] = useState(false);
	const audioFileInputRef = useRef<HTMLInputElement>(null);
	const [isProcessingAudioFile, setIsProcessingAudioFile] = useState(false);
	const pointerStartPos = useRef({ x: 0, y: 0 });
	const wasLongPressRef = useRef(false);
	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const micMenuJustOpenedRef = useRef(false);

	useEffect(() => {
		if (!isGiphyPickerOpen && !isMicMenuOpen) return;
		if (isMicMenuOpen) micMenuJustOpenedRef.current = true;
		const handleClickOutside = (_e: MouseEvent) => {
			if (micMenuJustOpenedRef.current) {
				micMenuJustOpenedRef.current = false;
				return;
			}
			setIsGiphyPickerOpen(false);
			setIsMicMenuOpen(false);
		};
		const raf = requestAnimationFrame(() => {
			window.addEventListener("click", handleClickOutside);
		});
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("click", handleClickOutside);
		};
	}, [isGiphyPickerOpen, isMicMenuOpen]);

	const cleanupAnalyser = useCallback(() => {
		if (waveformRafRef.current) { cancelAnimationFrame(waveformRafRef.current); waveformRafRef.current = null; }
		analyserRef.current = null;
		if (audioCtxRef.current) { void audioCtxRef.current.close(); audioCtxRef.current = null; }
		setWaveformBars([]);
	}, []);

	useEffect(() => { waveformBarsRef.current = waveformBars; }, [waveformBars]);

	useEffect(() => {
		return () => {
			if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
			if (waveformRafRef.current) cancelAnimationFrame(waveformRafRef.current);
			mediaRecorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
			void audioCtxRef.current?.close();
		};
	}, []);

	const handleAudioFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		
		setIsMicMenuOpen(false);
		setIsProcessingAudioFile(true);
		
		try {
			let audioBlob: Blob;
			let durationMs: number;
			let waveform: number[] | undefined = undefined;

			const headerSlice = file.slice(0, Math.min(file.size, 1024));
			const headerBuf = await new Promise<ArrayBuffer>((resolve) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as ArrayBuffer);
				reader.onerror = () => resolve(new ArrayBuffer(0));
				reader.readAsArrayBuffer(headerSlice);
			});
			const view = new DataView(headerBuf);
			const bytes = new Uint8Array(headerBuf);
			let isMp4Mov = false;
			let pos = 0;
			const limit = Math.min(headerBuf.byteLength, 1024);
			while (pos + 8 <= limit) {
				const size = view.getUint32(pos);
				const typeBytes = bytes.slice(pos + 4, pos + 8);
				const type = String.fromCharCode(...typeBytes);
				if (["ftyp", "moov", "mdat", "wide", "free", "uuid"].includes(type)) {
					isMp4Mov = true;
					break;
				}
				if (size < 8) break;
				pos += size;
			}
			const isVideo = file.type.startsWith("video/") || isMp4Mov ||
				file.name.endsWith(".mov") || file.name.endsWith(".mp4") ||
				file.name.endsWith(".MOV") || file.name.endsWith(".MP4");
			
			if (isVideo) {
				toast.loading(t("chat.extracting_audio", { defaultValue: "Extracting audio from video..." }), { id: "audio-extract" });
				const result = await extractAudioToWav(file);
				audioBlob = result.blob;
				durationMs = result.durationMs;
				waveform = result.waveform;
				if (result.waveform) {
					setRecordedWaveform(result.waveform);
				}
				toast.success(t("chat.extracted_audio", { defaultValue: "Audio extracted!" }), { id: "audio-extract" });
			} else {
				audioBlob = file;
				toast.loading(t("chat.processing_audio", { defaultValue: "Processing audio..." }), { id: "audio-extract" });
				const result = await getAudioFileMetadata(audioBlob);
				durationMs = result.durationMs;
				waveform = result.waveform;
				if (result.waveform) {
					setRecordedWaveform(result.waveform);
				}
				toast.success(t("chat.processed_audio", { defaultValue: "Audio processed!" }), { id: "audio-extract" });
			}
			
			props.onAudioRecorded(audioBlob, Math.round(durationMs), false, waveform);
			
		} catch (err: any) {
			appLog.error("Error processing audio file:", err);
			const errMsg = err?.message || String(err);
			toast.error(
				t("chat.errors.process_audio_failed", {
					defaultValue: "Failed to process audio file: {{error}}",
					error: errMsg,
				}),
			);
		} finally {
			setIsProcessingAudioFile(false);
			if (audioFileInputRef.current) {
				audioFileInputRef.current.value = "";
			}
		}
	};

	const startRecording = useCallback(async () => {
		if (isRecording) return;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					sampleRate: 22050,
					echoCancellation: true,
					noiseSuppression: true,
				},
			});
			// AAC in an MP4 container first: that is what the official app sends,
			// and Opus in WebM is not something every Grindr client can play back.
			const mimeType = ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
				(t) => MediaRecorder.isTypeSupported(t),
			) ?? "";
			const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
			chunksRef.current = [];
			recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
			recorder.start(100);
			mediaRecorderRef.current = recorder;
			recordingStartRef.current = Date.now();
			setIsRecording(true);
			(window as unknown as { FreeGrindBridge?: { vibrate?: (ms: number) => void } }).FreeGrindBridge?.vibrate?.(30) ?? navigator.vibrate?.(30);
			setRecordingMs(0);
			recordingTimerRef.current = setInterval(() => {
				const elapsed = Date.now() - recordingStartRef.current;
				setRecordingMs(elapsed);
				if (elapsed >= 60_000) stopRecordingRef.current();
			}, 100);
			recordingMaxTimerRef.current = setTimeout(() => stopRecordingRef.current(), 60_000);
			try {
				const audioCtx = new AudioContext();
				const analyser = audioCtx.createAnalyser();
				analyser.fftSize = 64;
				analyser.smoothingTimeConstant = 0.7;
				audioCtx.createMediaStreamSource(stream).connect(analyser);
				audioCtxRef.current = audioCtx;
				analyserRef.current = analyser;
				const data = new Uint8Array(analyser.frequencyBinCount);
				let lastSample = 0;
				const tick = (t: number) => {
					if (t - lastSample >= 80) {
						lastSample = t;
						analyser.getByteFrequencyData(data);
						const amp = data.slice(0, 10).reduce((a, b) => a + b, 0) / 10 / 255;
						setWaveformBars(prev => [...prev, amp]);
					}
					waveformRafRef.current = requestAnimationFrame(tick);
				};
				waveformRafRef.current = requestAnimationFrame(tick);
			} catch { /* analyser failure is non-fatal */ }
		} catch (err) {
			const name = err instanceof DOMException ? err.name : "";
			if (name === "NotFoundError" || name === "DevicesNotFoundError") {
				toast.error(t("chat.errors.microphone_not_found", { defaultValue: "No microphone found." }));
			} else if (name === "NotAllowedError" || name === "PermissionDeniedError") {
				toast.error(t("chat.errors.microphone_denied", { defaultValue: "Microphone access denied." }));
			} else {
				toast.error(t("chat.errors.microphone_access", { defaultValue: "Could not access microphone." }));
			}
		}
	}, [isRecording, t]);

	const stopRecording = useCallback((autoSend?: boolean) => {
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state === "inactive") return;
		if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
		if (recordingMaxTimerRef.current) { clearTimeout(recordingMaxTimerRef.current); recordingMaxTimerRef.current = null; }
		const durationMs = Date.now() - recordingStartRef.current;
		const capturedBars = [...waveformBarsRef.current];
		cleanupAnalyser();
		recorder.onstop = () => {
			recorder.stream.getTracks().forEach((t) => t.stop());
			const rawBlob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
			if (rawBlob.size === 0) {
				console.error("[stopRecording] blob is empty — no audio data from mic");
				toast.error(t("chat.errors.recording_failed", { defaultValue: "No audio data captured." }));
				mediaRecorderRef.current = null;
				return;
			}
			void fixWebmDuration(rawBlob, durationMs).then((blob) => {
				if (durationMs >= 500) {
					if (autoSend) {
						(window as unknown as { FreeGrindBridge?: { vibrate?: (ms: number) => void } }).FreeGrindBridge?.vibrate?.(30) ?? navigator.vibrate?.(30);
					}
					setRecordedWaveform(capturedBars);
					props.onAudioRecorded(blob, durationMs, autoSend);
				} else {
					toast.error(t("chat.errors.recording_too_short", { defaultValue: "Recording too short." }));
				}
				mediaRecorderRef.current = null;
			});
		};
		recorder.stop();
		setIsRecording(false);
		setRecordingMs(0);
	}, [cleanupAnalyser, props, t]);
	useEffect(() => { stopRecordingRef.current = stopRecording; }, [stopRecording]);

	const cancelRecording = useCallback(() => {
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state === "inactive") return;
		if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
		if (recordingMaxTimerRef.current) { clearTimeout(recordingMaxTimerRef.current); recordingMaxTimerRef.current = null; }
		cleanupAnalyser();
		recorder.onstop = () => {
			recorder.stream.getTracks().forEach((t) => t.stop());
			mediaRecorderRef.current = null;
		};
		recorder.stop();
		setIsRecording(false);
		setRecordingMs(0);
	}, [cleanupAnalyser]);

	const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null);
	const [attachmentCrop, setAttachmentCrop] = useState<Crop | undefined>(undefined);
	const [attachmentCompletedCrop, setAttachmentCompletedCrop] = useState<PixelCrop | undefined>(undefined);
	const [isDraggingAttachmentCrop, setIsDraggingAttachmentCrop] = useState(false);
	const attachmentImgRef = useRef<HTMLImageElement | null>(null);
	const [mobileKeyboardInset, setMobileKeyboardInset] = useState(0);
	// On iOS the web view itself is shortened for the keyboard, so the inset
	// stays 0 and this is how the composer knows the keyboard is up.
	const [nativeKeyboardOpen, setNativeKeyboardOpen] = useState(() => (getNativeKeyboardHeight() ?? 0) > 0);
	const keyboardOpen = mobileKeyboardInset > 0 || nativeKeyboardOpen;
	const [composerHeight, setComposerHeight] = useState(88);
	const composerHeightObserverRef = useRef<ResizeObserver | null>(null);
	const composerRef = useCallback((node: HTMLElement | null) => {
		composerHeightObserverRef.current?.disconnect();
		composerHeightObserverRef.current = null;
		if (!node) {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) {
				setComposerHeight(entry.target.getBoundingClientRect().height);
			}
		});
		observer.observe(node);
		composerHeightObserverRef.current = observer;
	}, []);
	const fullLayoutHeightRef = useRef(0);
	const restingOverlapRef = useRef<number | null>(null);
	const [isBlockConfirmOpen, setIsBlockConfirmOpen] = useState(false);
	const [isDeleteConversationConfirmOpen, setIsDeleteConversationConfirmOpen] =
		useState(false);
	const [dontAskDeleteConversationAgain, setDontAskDeleteConversationAgain] = useState(false);
	const [dontAskBlockAgain, setDontAskBlockAgain] = useState(false);
	const [isUnblockConfirmOpen, setIsUnblockConfirmOpen] = useState(false);
	const [dontAskUnblockAgain, setDontAskUnblockAgain] = useState(false);
	const [banWordRequest, setBanWordRequest] = useState<
		{ text: string; title: string; prompt: string; forbiddenOnly: boolean } | null
	>(null);
	const openBanWordForMessage = (text: string) =>
		setBanWordRequest({
			text,
			title: t("ban_word.title"),
			prompt: t("ban_word.prompt_message"),
			forbiddenOnly: false,
		});

	// Highlighting a message opens the same dialog the "Ban word" action does,
	// already trimmed to what was highlighted. Its own request is kept apart
	// from banWordRequest so closing the dialog can also drop the highlight.
	const {
		enabled: banOnSelect,
		selection: banSelection,
		clearSelection: clearBanSelection,
	} = useBanOnSelect(BAN_SELECT_KINDS);
	const activeBanRequest = banWordRequest
		?? (banSelection
			? banSelection.kind === "name"
				? {
						text: banSelection.text,
						title: t("ban_word.title_name"),
						// A name belongs in the keyword list only, exactly like the
						// "Ban Name" menu item it doubles for.
						prompt: t("ban_word.prompt_name"),
						forbiddenOnly: true,
					}
				: {
						text: banSelection.text,
						title: t("ban_word.title"),
						prompt: t("ban_word.prompt_selection"),
						forbiddenOnly: false,
					}
			: null);
	const closeBanWord = () => {
		setBanWordRequest(null);
		clearBanSelection();
	};
	const [isMergeSheetOpen, setIsMergeSheetOpen] = useState(false);
	const [mergeSearchQuery, setMergeSearchQuery] = useState("");
	const [mergeConfirmTarget, setMergeConfirmTarget] = useState<ConversationEntry | null>(null);

	const {
		navigate,
		isDesktop,
		selectedConversation,
		targetProfileId,
		targetProfileDetail = null,
		userId,
		nowTimestamp,
		isUpdatingConversationState,
		isHeaderActionsMenuOpen,
		setIsHeaderActionsMenuOpen,
		headerActionsMenuRef,
		togglePin,
		toggleMute,
		isHidden,
		toggleHide,
		onDeleteConversation,
		isDeletingConversation = false,
		onBlockProfile,
		isBlockingProfile = false,
		onUnblockProfile,
		isUnblockingProfile = false,
		isBlockedBySelf = false,
		onToggleFavorite,
		isFavorite = false,
		isArchived = false,
		archivedReason = null,
		archivedBlockState = null,
		mergeableConversations = [],
		onMergeConversation,
		isMergingConversation = false,
		isTogglingFavorite = false,
		localNickname = null,
		onEditLocalNickname,
		getProfileReturnToChatPath,
		isLoadingThread,
		threadConversationId,
		threadError,
		hasChattedBefore = false,
		lastMessageTimestamp = null,
		loadThread,
		threadScrollContainerRef,
		handleThreadScroll,
		messagePageKey,
		isLoadingOlderMessages,
		threadMessages,
		threadLastReadTimestamp,
		messageElementRefs,
		handleMessageTap,
		startMessageLongPress,
		endMessageLongPress,
		messageLongPressTriggeredRef,
		openFullScreenImage,
		openAlbumViewerById,
		onJumpToMessage,
		highlightedMessageId,
		selectedThreadMessageMatches,
		activeThreadSearchIndex,
		openMessageActionId,
		setOpenMessageActionId,
		isMutatingMessageId,
		reactionBurstMessageId,
		handleReact,
		handleUnsend,
		handleDelete,
		handleRetry,
		handleReply,
		handleStopAlbumShare,
		threadBottomRef,
		handleSend,
		toggleAlbumPicker: _toggleAlbumPicker,
		attachmentInputRef,
		onAttachmentInput,
		onAttachmentFile,
		isUploadingAttachment,
		pendingAttachmentFile,
		attachmentLooping,
		attachmentTakenOnGrindr,
		attachmentAddToDrawer,
		attachmentMaxViews,
		setAttachmentLooping,
		setAttachmentTakenOnGrindr,
		setAttachmentAddToDrawer,
		setAttachmentMaxViews,
		confirmPendingAttachment: _confirmPendingAttachment,
		confirmAttachmentFile,
		cancelPendingAttachment,
		isAlbumPickerOpen: _isAlbumPickerOpen,
		isLoadingAlbums,
		shareableAlbums,
		albumCoverMap: externalAlbumCoverMap,
		ownProfilePhotoUrl,
		isSharingAlbum,
		pendingAlbumShare,
		shareAlbumToCurrentConversation: _shareAlbumToCurrentConversation,
        confirmPendingAlbumShare: _confirmPendingAlbumShare,
        closePendingAlbumShare,
		uploadProgress,
		draft,
		setDraft,
		replyTargetMessage,
		clearReplyTarget,
		isSending,
		selectedActionMessage,
		selectedActionMessageMine,
		isAlbumSheetOpen,
		onOpenMediaSheet,
		isPartnerTyping = false,
		toggleDrawer,
		isDrawerOpen,
		isLoadingDrawer,
		drawerError,
		drawerMedia,
		isSendingDrawerMedia,
		isAddingDrawerMedia,
		deletingDrawerMediaId,
		onLoadDrawerMedia,
		onSendDrawerMedia,
		onAddDrawerMedia,
		onDeleteDrawerMedia,
		onShareAlbumFromDrawer,
		onStopAlbumShareFromDrawer,
		onSendLocation,
		onSendGiphy,
		selectedMediaIds,
		onStartMediaSelection,
		onToggleMediaSelection,
		onSaveSelectedMedia,
		onDeleteSelectedMedia,
		onOpenSelectedMediaActions,
		onCancelMediaSelection,
		isWorkingOnSelectedMedia,
		unsaveablePickedCount,
		isActionMediaUnavailable,
		onUnavailableMediaChange,
	} = props;
	const saveablePickedCount = Math.max(0, (selectedMediaIds?.size ?? 0) - unsaveablePickedCount);

	// Escape leaves picking on a computer.
	useEffect(() => {
		if (!selectedMediaIds) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCancelMediaSelection();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onCancelMediaSelection, selectedMediaIds]);

    const [savedPhrases, setSavedPhrases] = useState<string[]>([]);

	useEffect(() => {
		void loadSavedPhrases().then(setSavedPhrases);
	}, []);

	useEffect(() => {
		if (!pendingAttachmentFile) {
			setAttachmentPreviewUrl(null);
			setAttachmentCrop(undefined);
			setAttachmentCompletedCrop(undefined);
			return;
		}
		const url = URL.createObjectURL(pendingAttachmentFile);
		setAttachmentPreviewUrl(url);
		setAttachmentCrop(undefined);
		setAttachmentCompletedCrop(undefined);
		return () => URL.revokeObjectURL(url);
	}, [pendingAttachmentFile]);

	useEffect(() => {
		if (!attachmentPreviewUrl) return;
		setAttachmentCrop({ unit: "%", x: 0, y: 0, width: 100, height: 100 });
	}, [attachmentPreviewUrl]);

	useEffect(() => {
		if (replyTargetMessage) {
			textareaRef.current?.focus();
		}
	}, [replyTargetMessage]);

	const applyAttachmentTransform = useCallback(async (type: "flipH" | "rotateCw") => {
		const img = attachmentImgRef.current;
		if (!img || !img.complete || img.naturalWidth === 0) return;
		const sw = img.naturalWidth;
		const sh = img.naturalHeight;
		const canvas = document.createElement("canvas");
		canvas.width = type === "rotateCw" ? sh : sw;
		canvas.height = type === "rotateCw" ? sw : sh;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.translate(canvas.width / 2, canvas.height / 2);
		if (type === "flipH") ctx.scale(-1, 1);
		if (type === "rotateCw") ctx.rotate(Math.PI / 2);
		ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/jpeg", 0.95),
		);
		if (!blob) return;
		setAttachmentPreviewUrl((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return URL.createObjectURL(blob);
		});
	}, []);

	const handleConfirmAttachment = useCallback(async () => {
		if (!pendingAttachmentFile) return;
		let fileToUpload: File = pendingAttachmentFile;
		const isFullImage =
			!attachmentCompletedCrop ||
			!attachmentImgRef.current ||
			(attachmentCompletedCrop.x <= 1 &&
				attachmentCompletedCrop.y <= 1 &&
				Math.abs(attachmentCompletedCrop.width - attachmentImgRef.current.width) <= 2 &&
				Math.abs(attachmentCompletedCrop.height - attachmentImgRef.current.height) <= 2);
		if (!isFullImage && attachmentCompletedCrop?.width && attachmentCompletedCrop.height && attachmentImgRef.current) {
			const img = attachmentImgRef.current;
			const scaleX = img.naturalWidth / img.width;
			const scaleY = img.naturalHeight / img.height;
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(attachmentCompletedCrop.width * scaleX);
			canvas.height = Math.round(attachmentCompletedCrop.height * scaleY);
			const ctx = canvas.getContext("2d");
			if (ctx) {
				ctx.drawImage(
					img,
					attachmentCompletedCrop.x * scaleX,
					attachmentCompletedCrop.y * scaleY,
					attachmentCompletedCrop.width * scaleX,
					attachmentCompletedCrop.height * scaleY,
					0,
					0,
					canvas.width,
					canvas.height,
				);
				fileToUpload = await new Promise<File>((resolve) => {
					canvas.toBlob(
						(blob) => {
							if (!blob) { resolve(pendingAttachmentFile); return; }
							resolve(new File([blob], pendingAttachmentFile.name, { type: pendingAttachmentFile.type || "image/jpeg" }));
						},
						pendingAttachmentFile.type || "image/jpeg",
						0.92,
					);
				});
			}
		}
		await confirmAttachmentFile(fileToUpload);
	}, [pendingAttachmentFile, attachmentCompletedCrop, confirmAttachmentFile]);

	const handleUsePhrase = (phrase: string) => {
		setDraft(phrase);
	};

	const handleAddPhrase = async () => {
		const trimmed = newPhraseInput.trim();
		if (!trimmed) return;
		const updated = await saveSavedPhrases([...savedPhrases, trimmed]);
		setSavedPhrases(updated);
		setNewPhraseInput("");
	};

	const handleDeletePhrase = async (index: number) => {
		const updated = await saveSavedPhrases(savedPhrases.filter((_, i) => i !== index));
		setSavedPhrases(updated);
	};

	const handleReorderPhrases = async (reordered: string[]) => {
		// Shown at once, so the phrase stays where it was dropped while it is saved.
		setSavedPhrases(reordered);
		const updated = await saveSavedPhrases(reordered);
		setSavedPhrases(updated);
	};


	useEffect(() => {
		const syncSavedPhrases = (event: Event) => {
			const detail = (event as CustomEvent<string[]>).detail;
			if (Array.isArray(detail)) {
				setSavedPhrases(detail);
				return;
			}
			void loadSavedPhrases().then(setSavedPhrases);
		};

		window.addEventListener(SAVED_PHRASES_UPDATED_EVENT, syncSavedPhrases as EventListener);

		return () => {
			window.removeEventListener(SAVED_PHRASES_UPDATED_EVENT, syncSavedPhrases as EventListener);
		};
	}, []);
    
    const filteredPhrases = savedPhrases.filter((phrase) =>
        draft.trim() === "" || phrase.toLowerCase().startsWith(draft.toLowerCase()),
    );

    const slashMenuMatch = draft.match(/^\/(\w*)$/);
    const slashMatchCandidates = useMemo(
        () => (slashMenuMatch ? matchSlashCommandsByPrefix(slashMenuMatch[1]) : []),
        [draft],
    );
    const slashMatches = isComposerFocused ? slashMatchCandidates : [];

    useEffect(() => {
        setSlashSelectedIndex(0);
    }, [slashMatches.length, slashMenuMatch?.[1]]);

    const selectSlashCommand = (command: SlashCommandDef) => {
        if (command.requiresConversation && !selectedConversation) {
            return;
        }
        if (command.takesArg) {
            setDraft(`/${command.name} `);
            textareaRef.current?.focus();
        } else {
            setDraft(`/${command.name}`);
            requestAnimationFrame(() => textareaRef.current?.form?.requestSubmit());
        }
    };

	const albumCoverMap = useMemo(() => {
		const map = new Map<number, string>();
		for (const msg of threadMessages) {
			const aid = getMessageAlbumId(msg);
			const cover = getMessageAlbumCoverUrl(msg);
			if (aid && cover) map.set(aid, cover);
		}
		if (externalAlbumCoverMap) {
			for (const [aid, cover] of externalAlbumCoverMap) {
				map.set(aid, cover);
			}
		}
		return map;
	}, [threadMessages, externalAlbumCoverMap]);

	const sharedAlbumIds = useMemo(() => {
		const ids = new Set<number>();
		for (const msg of threadMessages) {
			const aid = getMessageAlbumId(msg);
			const body = msg.body as any;
			if (aid && body?.isViewable) ids.add(aid);
		}
		return ids;
	}, [threadMessages]);

    const [showReadReceiptToggle] = useState(() => getShowReadReceiptToggle());
    const [readReceiptsHidden, setReadReceiptsHidden] = useState(true);

    useEffect(() => {
        if (selectedConversation) {
            setReadReceiptsHidden(isReadReceiptsHidden(selectedConversation.data.conversationId));
        }
    }, [selectedConversation]);

	const closeBlockConfirm = () => {
		if (isBlockingProfile) {
			return;
		}
		setIsBlockConfirmOpen(false);
	};

	const closeUnblockConfirm = () => {
		if (isUnblockingProfile) {
			return;
		}
		setIsUnblockConfirmOpen(false);
	};

	const closeDeleteConversationConfirm = () => {
		if (isDeletingConversation) {
			return;
		}
		setIsDeleteConversationConfirmOpen(false);
	};

	const closeMergeConfirm = () => {
		if (isMergingConversation) {
			return;
		}
		setMergeConfirmTarget(null);
	};

	const confirmMergeConversation = () => {
		if (!selectedConversation || !mergeConfirmTarget || !onMergeConversation || isMergingConversation) {
			return;
		}
		void onMergeConversation(
			selectedConversation.data.conversationId,
			mergeConfirmTarget.data.conversationId,
		);
		setMergeConfirmTarget(null);
	};

	const filteredMergeableConversations = useMemo(() => {
		const query = mergeSearchQuery.trim().toLowerCase();
		if (!query) return mergeableConversations;
		return mergeableConversations.filter((conversation) => {
			const other = getOtherParticipant(conversation, userId);
			const name = (conversation.data.name || "").toLowerCase();
			const profileId = other?.profileId != null ? String(other.profileId) : "";
			return name.includes(query) || profileId.includes(query);
		});
	}, [mergeableConversations, mergeSearchQuery, userId]);

	const handleLocationShareRequest = () => {
		if (pendingLocationShare) {
			setPendingLocationShare(null);
			return;
		}
		if (!geohash) {
			toast.error(t("chat.errors.no_location_set", { defaultValue: "No location set in settings" }));
			return;
		}
		try {
			const decoded = decodeGeohash(geohash);
			const lat = (decoded.lat[0] + decoded.lat[1]) / 2;
			const lon = (decoded.lon[0] + decoded.lon[1]) / 2;
			setPendingLocationShare({ lat, lon });
		} catch (error) {
			appLog.error("Failed to decode geohash", error);
			toast.error(t("chat.errors.invalid_location", { defaultValue: "Invalid location format" }));
		}
	};

	const onFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        handleSend(event);
        textareaRef.current?.focus();
    };

	const handleCopy = async (message: UiMessage) => {
		const location = getMessageLocation(message);
		const body = message.body as any;
		const hasRealText = body && typeof body.text === "string" && body.text.trim().length > 0;

		let content = "";
		if (location) {
			content = `${location.lat}, ${location.lon}`;
		} else if (hasRealText) {
			content = body.text;
		}

		if (!content) {
			setOpenMessageActionId(null);
			return;
		}

		try {
			await navigator.clipboard.writeText(content);
			toast.success(t("chat.toasts.copied", { defaultValue: "Copied to clipboard" }));
		} catch (error) {
			appLog.error("Copy failed", error);
		}
		setOpenMessageActionId(null);
	};

	const handleAddMessageToSavedPhrases = async (text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		const updated = await saveSavedPhrases([...savedPhrases, trimmed]);
		setSavedPhrases(updated);
		toast.success(t("chat.actions.added_to_saved_phrases", { defaultValue: "Added to saved phrases" }));
	};

	useModalClose({
		isOpen: pendingAlbumShare !== null,
		onClose: closePendingAlbumShare,
		escapeKey: false,
	});

	useModalClose({
		isOpen: isBlockConfirmOpen,
		onClose: closeBlockConfirm,
		escapeKey: !isBlockingProfile,
	});

	useModalClose({
		isOpen: isUnblockConfirmOpen,
		onClose: closeUnblockConfirm,
		escapeKey: !isUnblockingProfile,
	});

	useModalClose({
		isOpen: isDeleteConversationConfirmOpen,
		onClose: closeDeleteConversationConfirm,
		escapeKey: !isDeletingConversation,
	});

	useModalClose({
		isOpen: isSavedPhrasesOpen,
		onClose: () => setIsSavedPhrasesOpen(false),
		escapeKey: false,
	});

	useEffect(() => {
		setIsBlockConfirmOpen(false);
		setIsDeleteConversationConfirmOpen(false);
		setDontAskBlockAgain(false);
		setIsUnblockConfirmOpen(false);
		setDontAskUnblockAgain(false);
	}, [selectedConversation?.data.conversationId]);

	useEffect(() => {
		if (isDesktop) {
			setMobileKeyboardInset(0);
			return;
		}

		if (typeof window === "undefined" || !window.visualViewport) {
			setMobileKeyboardInset(0);
			return;
		}

		const viewport = window.visualViewport;

		const isEditableFocused = () => {
			const element = document.activeElement as HTMLElement | null;
			if (!element) return false;
			return (
				element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable
			);
		};

		const updateKeyboardInset = () => {
			// The iOS build shortens the web view itself for the keyboard
			// (NativeKeyboardResize.swift), so 100dvh already ends above it and
			// anything subtracted here would count the keyboard twice.
			if (isNativeKeyboardResize()) {
				setMobileKeyboardInset(0);
				return;
			}
			// Nothing focused means no keyboard, whatever the numbers say. This is
			// also where the measurements below get to start over: they drift when
			// the layout viewport changes (rotation, the app returning to the
			// foreground), and without a reset the drift left the composer floating
			// above a gap that never went away.
			if (!isEditableFocused()) {
				fullLayoutHeightRef.current = window.innerHeight;
				restingOverlapRef.current = null;
				setMobileKeyboardInset(0);
				return;
			}
			fullLayoutHeightRef.current = Math.max(fullLayoutHeightRef.current, window.innerHeight);
			const layoutHeight = fullLayoutHeightRef.current;
			const visibleBottom = viewport.height + viewport.offsetTop;
			const overlap = Math.max(0, Math.round(layoutHeight - visibleBottom));
			if (restingOverlapRef.current === null || overlap < restingOverlapRef.current) {
				restingOverlapRef.current = overlap;
			}
			const keyboardOverlap = overlap - restingOverlapRef.current;
			setMobileKeyboardInset(keyboardOverlap >= 60 ? keyboardOverlap : 0);
		};

		// Focus moving between two fields blurs before it focuses, so re-check on
		// the next frame rather than collapsing the inset in between.
		let blurCheck: number | null = null;
		const scheduleBlurCheck = () => {
			if (blurCheck !== null) cancelAnimationFrame(blurCheck);
			blurCheck = requestAnimationFrame(() => {
				blurCheck = null;
				updateKeyboardInset();
			});
		};

		const onNativeKeyboard = (event: Event) => {
			const height = (event as CustomEvent<{ height?: number }>).detail?.height;
			setNativeKeyboardOpen(typeof height === "number" && height > 0);
			updateKeyboardInset();
		};

		updateKeyboardInset();
		viewport.addEventListener("resize", updateKeyboardInset);
		viewport.addEventListener("scroll", updateKeyboardInset);
		window.addEventListener("focusin", updateKeyboardInset);
		window.addEventListener("focusout", scheduleBlurCheck);
		window.addEventListener(NATIVE_KEYBOARD_EVENT, onNativeKeyboard);

		return () => {
			if (blurCheck !== null) cancelAnimationFrame(blurCheck);
			viewport.removeEventListener("resize", updateKeyboardInset);
			viewport.removeEventListener("scroll", updateKeyboardInset);
			window.removeEventListener("focusin", updateKeyboardInset);
			window.removeEventListener("focusout", scheduleBlurCheck);
			window.removeEventListener(NATIVE_KEYBOARD_EVENT, onNativeKeyboard);
		};
	}, [isDesktop]);

	// Android reports the keyboard height natively (MainActivity.kt dispatches
	// this), which beats inferring it from the viewport. Gated on focus all the
	// same, so a missed "keyboard closed" cannot strand the composer.
	useEffect(() => {
		if (isDesktop) return;
		const onKeyboardInset = (event: Event) => {
			const detail = (event as CustomEvent<{ height?: number }>).detail;
			const height = detail?.height;
			if (typeof height !== "number" || !Number.isFinite(height)) return;
			const element = document.activeElement as HTMLElement | null;
			const editableFocused = Boolean(
				element &&
					(element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable),
			);
			setMobileKeyboardInset(editableFocused ? Math.max(0, Math.round(height)) : 0);
		};
		window.addEventListener("fg:keyboard-inset", onKeyboardInset);
		return () => window.removeEventListener("fg:keyboard-inset", onKeyboardInset);
	}, [isDesktop]);

	useEffect(() => {
		if (isDesktop || !(selectedConversation || targetProfileId)) {
			return;
		}
		const { body, documentElement: html } = document;
		const previousBodyPosition = body.style.position;
		const previousBodyTop = body.style.top;
		const previousBodyLeft = body.style.left;
		const previousBodyRight = body.style.right;
		const previousBodyWidth = body.style.width;
		const previousHtmlOverflow = html.style.overflow;
		window.scrollTo(0, 0);
		html.style.overflow = "hidden";
		body.style.position = "fixed";
		body.style.top = "0";
		body.style.left = "0";
		body.style.right = "0";
		body.style.width = "100%";
		refreshNativeViewport();
		return () => {
			html.style.overflow = previousHtmlOverflow;
			body.style.position = previousBodyPosition;
			body.style.top = previousBodyTop;
			body.style.left = previousBodyLeft;
			body.style.right = previousBodyRight;
			body.style.width = previousBodyWidth;
			window.scrollTo(0, 0);
			refreshNativeViewport();
		};
	}, [isDesktop, selectedConversation, targetProfileId]);

	// The frame must never outlive the drag. The enter and leave reports can
	// come up short when the file is carried out of the window or the drag is
	// cancelled, so the end of any drag, anywhere, takes the frame down.
	useEffect(() => {
		if (!fileDropZone) {
			return;
		}
		const endDrag = () => {
			dragDepthRef.current = 0;
			setFileDropZone(null);
		};
		const onWindowDragLeave = (event: DragEvent) => {
			// No element it moved on to: it left the window.
			if (event.relatedTarget === null) {
				endDrag();
			}
		};
		window.addEventListener("drop", endDrag);
		window.addEventListener("dragend", endDrag);
		window.addEventListener("dragleave", onWindowDragLeave);
		return () => {
			window.removeEventListener("drop", endDrag);
			window.removeEventListener("dragend", endDrag);
			window.removeEventListener("dragleave", onWindowDragLeave);
		};
	}, [fileDropZone]);

	// A file can be attached where there is a message box to attach it to:
	// not in an archived chat, and not while media is being picked.
	const acceptsDroppedFiles = !isArchived && !selectedMediaIds && !isUploadingAttachment;

	const isAttachableFileDrag = (event: React.DragEvent<HTMLDivElement>) =>
		acceptsDroppedFiles && event.dataTransfer.types.includes("Files");

	const handleFileDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
		if (!isAttachableFileDrag(event)) {
			return;
		}
		event.preventDefault();
		dragDepthRef.current += 1;
		setFileDropZone(event.currentTarget.getBoundingClientRect());
	};

	const handleFileDragOver = (event: React.DragEvent<HTMLDivElement>) => {
		if (!isAttachableFileDrag(event)) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};

	const handleFileDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
		if (!isAttachableFileDrag(event)) {
			return;
		}
		event.preventDefault();
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) {
			setFileDropZone(null);
		}
	};

	const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
		dragDepthRef.current = 0;
		setFileDropZone(null);
		if (!isAttachableFileDrag(event)) {
			return;
		}
		event.preventDefault();
		const file = Array.from(event.dataTransfer.files).find(
			(candidate) => candidate.type.startsWith("image/") || candidate.type.startsWith("video/"),
		);
		if (file) {
			onAttachmentFile(file);
		} else {
			toast.error(t("chat.errors.attachment_type"));
		}
	};

	const renderThread = (selectedConversation || targetProfileId) ? (
		<div
			className={`flex h-full flex-col ${!isDesktop ? "overflow-hidden p-0" : "overflow-hidden p-3 sm:p-4"} ${
				isDesktop ? "surface-card" : ""
			}`}
			style={
				!isDesktop
					? {
						height: `calc(100dvh - ${mobileKeyboardInset}px)`,
					}
					: undefined
			}
			onDragEnter={handleFileDragEnter}
			onDragOver={handleFileDragOver}
			onDragLeave={handleFileDragLeave}
			onDrop={handleFileDrop}
		>
			{/* Laid over the chat by its place on screen and drawn at the top of
			    the page, so that nothing inside the chat has to change how it is
			    positioned for it, and no moving or blurred parent can put it in
			    the wrong place. */}
			{fileDropZone &&
				createPortal(
					<div
						className="pointer-events-none fixed z-[250] flex items-center justify-center rounded-[18px] border-2 border-dashed border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] backdrop-blur-sm"
						style={{
							top: fileDropZone.top,
							left: fileDropZone.left,
							width: fileDropZone.width,
							height: fileDropZone.height,
						}}
					>
						<div className="flex items-center gap-2 rounded-full bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)] shadow-lg">
							<ImagePlus className="h-4 w-4" />
							{t("chat.drop_to_attach", { defaultValue: "Drop to attach" })}
						</div>
					</div>,
					document.body,
				)}
			{(() => {
				const otherParticipant = selectedConversation
					? getOtherParticipant(selectedConversation, userId)
					: null;
				const profileId = selectedConversation
					? otherParticipant?.profileId ?? null
					: targetProfileId;
				const avatarHash = selectedConversation
					? otherParticipant?.primaryMediaHash
					: targetProfileDetail?.profileImageMediaHash;
				const distanceMetres = selectedConversation
					? otherParticipant?.distanceMetres
					: targetProfileDetail?.distance;
				const onlineMeta = getParticipantOnlineMeta(
					selectedConversation ? otherParticipant?.lastOnline : targetProfileDetail?.seen,
					selectedConversation ? otherParticipant?.onlineUntil : targetProfileDetail?.onlineUntil,
					nowTimestamp,
					t,
				);
				const isOnline = onlineMeta.isOnline;
				const distanceLabel = distanceMetres ? formatDistance(distanceMetres, t, unitsPreset) : null;
				const displayName =
					localNickname ||
					(selectedConversation ? selectedConversation.data.name : targetProfileDetail?.displayName) ||
					t(selectedConversation ? "chat.conversation" : "chat.notifications.someone");
				// What this person is actually called on Grindr. displayName falls
				// back to a nickname this device invented and then to "Conversation",
				// and banning either would add a keyword matching people who have
				// nothing to do with them.
				const realProfileName = (
					(selectedConversation ? selectedConversation.data.name : targetProfileDetail?.displayName) ?? ""
				).trim();
				// Names the app shows but nobody chose, which must never become a
				// keyword: the "3"/"4" access stubs a blocked or deleted profile
				// answers with (utils/profileAccessStatus.ts), which can end up
				// saved as the conversation's name, and the placeholders shown when
				// a conversation has no name at all. Banning any of them would
				// match every person genuinely called that. A nickname invented on
				// this device is excluded already: realProfileName reads the stored
				// name, never localNickname.
				const unbannableNames = [
					"3",
					"4",
					t("chat.conversation"),
					t("chat.unknown"),
					t("chat.notifications.someone"),
				];
				const bannableProfileName = unbannableNames.includes(realProfileName)
					? ""
					: realProfileName;
				// Selecting the header name bans it, but only when the name on
				// screen *is* that bannable name — not a nickname, not a placeholder.
				const isHeaderNameBannable =
					bannableProfileName !== "" && displayName === bannableProfileName;
				// Handed to the profile page, which may only get Grindr's empty
				// stub for someone who is blocked or gone.
				const knownProfileForNavigation = {
					name: bannableProfileName || null,
					imageHash: avatarHash ?? null,
				};

				// Blocking a chat with a live conversation archives it — that's why
				// the existing-conversation case keys off isArchived. There's no
				// conversation to archive yet in the new-chat case, so key off
				// isBlockedBySelf directly there instead.
				const showBlockGroup = selectedConversation ? !isArchived : !isBlockedBySelf;
				const showUnblockButton = selectedConversation
					? isArchived && isBlockedBySelf
					: isBlockedBySelf;

				const requestBlockProfile = () => {
					if (profileId == null || isBlockingProfile || !onBlockProfile) {
						return;
					}

					setIsHeaderActionsMenuOpen(false);
					if (isBlockConfirmSkipped()) {
						void onBlockProfile(profileId);
						return;
					}

					setDontAskBlockAgain(false);
					setIsBlockConfirmOpen(true);
				};

				const confirmBlockProfile = () => {
					if (profileId == null || isBlockingProfile || !onBlockProfile) {
						return;
					}

					if (dontAskBlockAgain && typeof window !== "undefined") {
						localStorage.setItem(SKIP_BLOCK_CONFIRM_KEY, "true");
					}

					setIsBlockConfirmOpen(false);
					void onBlockProfile(profileId);
				};

				const requestUnblockProfile = () => {
					if (profileId == null || isUnblockingProfile || !onUnblockProfile) {
						return;
					}

					setIsHeaderActionsMenuOpen(false);
					if (isUnblockConfirmSkipped()) {
						void onUnblockProfile(profileId);
						return;
					}

					setDontAskUnblockAgain(false);
					setIsUnblockConfirmOpen(true);
				};

				const confirmUnblockProfile = () => {
					if (profileId == null || isUnblockingProfile || !onUnblockProfile) {
						return;
					}

					if (dontAskUnblockAgain && typeof window !== "undefined") {
						localStorage.setItem(SKIP_UNBLOCK_CONFIRM_KEY, "true");
					}

					setIsUnblockConfirmOpen(false);
					void onUnblockProfile(profileId);
				};

				const requestDeleteConversation = () => {
					if (!selectedConversation || !onDeleteConversation || isDeletingConversation) {
						return;
					}
					setIsHeaderActionsMenuOpen(false);
					if (isDeleteConversationConfirmSkipped()) {
						void onDeleteConversation(selectedConversation.data.conversationId);
						return;
					}
					setDontAskDeleteConversationAgain(false);
					setIsDeleteConversationConfirmOpen(true);
				};

				const confirmDeleteConversation = () => {
					if (!selectedConversation || !onDeleteConversation || isDeletingConversation) {
						return;
					}
					if (dontAskDeleteConversationAgain && typeof window !== "undefined") {
						localStorage.setItem(SKIP_DELETE_CONVERSATION_CONFIRM_KEY, "true");
					}
					setIsDeleteConversationConfirmOpen(false);
					void onDeleteConversation(selectedConversation.data.conversationId);
				};

				return (
					<>
						<div
							className={`flex items-center justify-between gap-3 border-b border-[var(--border)] ${!isDesktop ? "shrink-0 bg-[var(--surface)] px-[var(--app-px)] pb-3" : "mb-3 pb-3 -mx-3 sm:-mx-4 px-3 sm:px-4"}`}
							style={
								!isDesktop
									? {
										paddingTop:
											"calc(env(safe-area-inset-top, 0px) + clamp(14px, 2.2vw, 28px))",
									}
									: undefined
							}
						>
							<div
								className={`min-w-0 flex items-center gap-3 ${!isDesktop ? "pl-0" : ""}`}
							>
                                {!isDesktop && (
                                    <button
                                        type="button"
                                        onClick={() => navigate("/chat")}
                                        className="shrink-0 rounded-xl border border-[var(--border)] p-2 text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
                                        aria-label={t("browse_location.back_aria")}
                                    >
                                        <ChevronLeft className="h-4 w-4" />
                                    </button>
                                )}
								<button
									type="button"
									onClick={() => {
										if (profileId == null) {
											return;
										}
										const returnTo = getProfileReturnToChatPath(profileId);
										const nextParams = new URLSearchParams();
										nextParams.set("returnTo", returnTo);
										navigate(
											`/profile/${profileId}?${nextParams.toString()}`,
											{ state: { returnTo, knownProfile: knownProfileForNavigation } },
										);
									}}
									// An archived chat opens too: the profile page shows the
									// saved copy of someone who is blocked or gone.
									disabled={profileId == null}
									aria-label={t("chat.open_profile")}
									title={onlineMeta.label}
									className={`h-10 w-10 shrink-0 overflow-hidden rounded-full border-2 bg-[var(--surface-2)] transition disabled:cursor-default disabled:opacity-80 ${
										isOnline
											? "border-emerald-500 shadow-[0_0_0_2px_color-mix(in_srgb,var(--surface)_70%,transparent)] hover:border-emerald-400"
											: "border-[var(--border)] hover:border-[var(--accent)]"
									}`}
								>
									<ProfileImage
										src={resolveAvatarSrc(
											avatarHash,
											getParticipantAvatarUrl(avatarHash),
										)}
										alt={displayName}
										className={isArchived ? "grayscale" : undefined}
									/>
								</button>
								<div className="min-w-0">
									<div className="flex items-center gap-1.5 min-w-0">
										<p
											className={`truncate text-lg font-semibold${
												banOnSelect && isHeaderNameBannable ? " ban-selectable" : ""
											}`}
											{...(banOnSelect && isHeaderNameBannable
												? banSelectableProps("name")
												: {})}
										>
											{displayName}
										</p>
									</div>
									<p className="truncate text-sm text-[var(--text-muted)]">
										{distanceLabel
											? `${onlineMeta.label} · ${distanceLabel}`
											: onlineMeta.label}
									</p>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								{/* Favorite and block stay one tap away on every screen size; pin
									and received media join them only where there is room. */}
								{showBlockGroup && (
									<button
										type="button"
										onClick={() => {
											if (profileId == null || !onToggleFavorite) return;
											void onToggleFavorite(profileId, isFavorite);
										}}
										disabled={isTogglingFavorite || profileId == null || !onToggleFavorite}
										title={isFavorite ? t("chat.unfavorite") : t("chat.favorite")}
										aria-label={isFavorite ? t("chat.unfavorite") : t("chat.favorite")}
										className={`shrink-0 rounded-xl border p-2 transition disabled:opacity-60 ${
											isFavorite
												? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)] hover:brightness-110"
												: "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
										}`}
									>
										{isTogglingFavorite ? (
											<Loader2 className="h-4 w-4 animate-spin" />
										) : (
											<Star className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
										)}
									</button>
								)}
								{isDesktop && showBlockGroup && (
									<button
										type="button"
										disabled={isUpdatingConversationState || !selectedConversation}
										onClick={togglePin}
										title={selectedConversation?.data.pinned ? t("chat.unpin") : t("chat.pin")}
										className={`rounded-xl border p-2 transition disabled:opacity-40 disabled:cursor-not-allowed ${
											selectedConversation?.data.pinned
												? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)] hover:brightness-110"
												: "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
										}`}
									>
										<Pin className="h-4 w-4" />
									</button>
								)}
								{showBlockGroup && (
									<button
										type="button"
										onClick={requestBlockProfile}
										disabled={isBlockingProfile || profileId == null || !onBlockProfile}
										title={isBlockingProfile ? t("profile_details.block_in_progress") : t("profile_details.block")}
										aria-label={t("profile_details.block")}
										className="shrink-0 rounded-xl border border-red-500/40 bg-red-500/10 p-2 text-red-300 transition hover:bg-red-500/20 disabled:opacity-60"
									>
										{isBlockingProfile ? (
											<Loader2 className="h-4 w-4 animate-spin" />
										) : (
											<Ban className="h-4 w-4" />
										)}
									</button>
								)}
								{showUnblockButton && (
									<button
										type="button"
										onClick={requestUnblockProfile}
										disabled={isUnblockingProfile || profileId == null || !onUnblockProfile}
										title={isUnblockingProfile ? t("profile_details.unblock_in_progress") : t("profile_details.unblock")}
										aria-label={t("profile_details.unblock")}
										className="shrink-0 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-2 text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-60"
									>
										{isUnblockingProfile ? (
											<Loader2 className="h-4 w-4 animate-spin" />
										) : (
											<ShieldCheck className="h-4 w-4" />
										)}
									</button>
								)}

								{isDesktop && onOpenMediaSheet && (
									<button
										type="button"
										onClick={onOpenMediaSheet}
										disabled={!selectedConversation}
										className="rounded-xl border border-[var(--border)] p-2 text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-40 disabled:cursor-not-allowed"
										aria-label={t("chat.received_media")}
									>
										<Images className="h-4 w-4" />
									</button>
								)}

								<div
									ref={headerActionsMenuRef}
									className={`relative ${!isDesktop ? "pr-0" : ""}`}
								>
									<button
										type="button"
										onClick={() =>
											setIsHeaderActionsMenuOpen((current) => !current)
										}
										className="rounded-xl border border-[var(--border)] p-2 text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
										aria-label={t("chat.open_conversation_actions")}
										aria-expanded={isHeaderActionsMenuOpen}
									>
										<Ellipsis className="h-4 w-4" />
									</button>
									{isHeaderActionsMenuOpen ? (
										<div className="absolute right-0 top-full z-30 mt-2 flex min-w-[210px] flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg">
											<button
												type="button"
												onClick={() => {
													setIsHeaderActionsMenuOpen(false);
													if (profileId == null) return;
													const returnTo = getProfileReturnToChatPath(profileId);
													const nextParams = new URLSearchParams();
													nextParams.set("returnTo", returnTo);
													navigate(`/profile/${profileId}?${nextParams.toString()}`, { state: { returnTo, knownProfile: knownProfileForNavigation } });
												}}
												disabled={profileId == null}
												className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--surface-2)] disabled:opacity-60"
											>
												<User className="mr-2 h-4 w-4 opacity-70" />
												{t("chat.view_profile")}
											</button>
											{!isDesktop && onOpenMediaSheet && (
												<button
													type="button"
													onClick={() => {
														setIsHeaderActionsMenuOpen(false);
														onOpenMediaSheet();
													}}
													disabled={!selectedConversation}
													className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
												>
													<Images className="mr-2 h-4 w-4 opacity-70" />
													{t("chat.received_media")}
												</button>
											)}
											{showReadReceiptToggle && !isArchived && (
												<button
													type="button"
													onClick={() => {
														if (!selectedConversation) return;
														setIsHeaderActionsMenuOpen(false);
														const newState = toggleReadReceiptsHidden(selectedConversation.data.conversationId);
														setReadReceiptsHidden(newState);
														if (!newState) {
															const lastMsg = threadMessages[threadMessages.length - 1];
															if (lastMsg) {
																apiFunctions.markRead(selectedConversation.data.conversationId, lastMsg.messageId).catch(() => {});
																loadThread({ conversationId: selectedConversation.data.conversationId, older: false });
															}
														}
														toast.success(newState ? t("chat.read_receipts.turned_off") : t("chat.read_receipts.turned_on"));
													}}
													disabled={!selectedConversation}
													className={`flex items-center rounded-lg px-2 py-2 text-left text-sm transition disabled:opacity-40 disabled:cursor-not-allowed ${
														readReceiptsHidden ? "text-[var(--accent)] hover:bg-[var(--accent)]/10" : "text-[var(--text)] hover:bg-[var(--surface-2)]"
													}`}
												>
													{readReceiptsHidden ? <Check className="mr-2 h-4 w-4 opacity-70" /> : <CheckCheck className="mr-2 h-4 w-4 opacity-70" />}
													{readReceiptsHidden ? t("chat.read_receipts.off") : t("chat.read_receipts.on")}
												</button>
											)}
											<button
												type="button"
												onClick={() => {
													setIsHeaderActionsMenuOpen(false);
													if (profileId == null || !onEditLocalNickname) return;
													void onEditLocalNickname(profileId, displayName);
												}}
												disabled={profileId == null || !onEditLocalNickname}
												className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--surface-2)] disabled:opacity-60"
											>
												<PencilLine className="mr-2 h-4 w-4 opacity-70" />
												{localNickname ? t("chat.nicknames.edit") : t("chat.nicknames.set")}
											</button>
											{isArchived && onMergeConversation && (
												<button
													type="button"
													onClick={() => {
														setIsHeaderActionsMenuOpen(false);
														setMergeSearchQuery("");
														setIsMergeSheetOpen(true);
													}}
													disabled={isMergingConversation || mergeableConversations.length === 0}
													className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-40"
												>
													<GitMerge className="mr-2 h-4 w-4 opacity-70" />
													{isMergingConversation
														? t("chat.merge_conversation_in_progress", { defaultValue: "Merging…" })
														: t("chat.merge_conversation", { defaultValue: "Merge into current chat" })}
												</button>
											)}
											{!isDesktop && (
												<button
													type="button"
													disabled={isUpdatingConversationState || !selectedConversation}
													onClick={() => {
														setIsHeaderActionsMenuOpen(false);
														void togglePin();
													}}
													className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
												>
													<Pin className="mr-2 h-4 w-4 opacity-70" />
													{selectedConversation?.data.pinned ? t("chat.unpin") : t("chat.pin")}
												</button>
											)}
											<button
												type="button"
												disabled={!selectedConversation}
												onClick={() => {
													setIsHeaderActionsMenuOpen(false);
													toggleHide();
												}}
												className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
											>
												{isHidden ? <Eye className="mr-2 h-4 w-4 opacity-70" /> : <EyeOff className="mr-2 h-4 w-4 opacity-70" />}
												{isHidden
													? t("chat.unhide_conversation", { defaultValue: "Unhide" })
													: t("chat.hide_conversation", { defaultValue: "Hide" })}
											</button>
											{!isArchived && (
												<button
													type="button"
													disabled={isUpdatingConversationState || !selectedConversation}
													onClick={() => {
														setIsHeaderActionsMenuOpen(false);
														void toggleMute();
													}}
													className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
												>
													{selectedConversation?.data.muted ? (
														<Volume2 className="mr-2 h-4 w-4 opacity-70" />
													) : (
														<MessageCircleOff className="mr-2 h-4 w-4 opacity-70" />
													)}
													{selectedConversation?.data.muted ? t("chat.unmute") : t("chat.mute")}
												</button>
											)}
											{otherParticipant && (
												<button
													type="button"
													onClick={() => {
														setIsHeaderActionsMenuOpen(false);
														const targetId = String(otherParticipant.profileId);
														if (isProfileAutoblockWhitelisted(targetId)) {
															removeFromAutoBlockWhitelist(targetId);
															toast.success(t("chat.whitelist.removed", { name: displayName }));
														} else {
															addToAutoBlockWhitelist(targetId, displayName, otherParticipant.primaryMediaHash);
															toast.success(t("chat.whitelist.added", { name: displayName }));
														}
													}}
													className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--surface-2)]"
												>
													<ShieldCheck className="mr-2 h-4 w-4 opacity-70" />
													{isProfileAutoblockWhitelisted(String(otherParticipant.profileId))
														? t("chat.whitelist.remove")
														: t("chat.whitelist.add")}
												</button>
											)}
											{/* — Keyword banning —
											   Offered on archived conversations too: the reason
											   someone was blocked is often only obvious afterwards,
											   and the keyword that would have caught them is worth
											   adding whenever you work it out. */}
											<>
													<div className="my-1 h-px bg-[var(--border)]" />
													{bannableProfileName ? (
														<button
															type="button"
															onClick={() => {
																setIsHeaderActionsMenuOpen(false);
																setBanWordRequest({
																	text: bannableProfileName,
																	title: t("ban_word.title_name"),
																	prompt: t("ban_word.prompt_name"),
																	forbiddenOnly: true,
																});
															}}
															className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text-muted)] transition hover:bg-[var(--surface-2)]"
														>
															<Ban className="mr-2 h-4 w-4 opacity-50" />
															{t("chat.ban_name", { name: bannableProfileName })}
														</button>
													) : null}
													<button
														type="button"
														onClick={async () => {
															setIsHeaderActionsMenuOpen(false);
															if (profileId == null) return;
															const loadToast = toast.loading(t("chat.bio.loading"));
															try {
																const profile = await apiFunctions.getProfileDetail(String(profileId));
																toast.dismiss(loadToast);
																// A blocked or deleted profile still answers 200, with
																// every field nulled out — saying "no bio" there would
																// blame the person for something the block is doing.
																const access = classifyProfileAccess(profile);
																if (access === "blocked") {
																	toast.error(t("chat.bio.blocked"));
																	return;
																}
																if (access === "not_found") {
																	toast.error(t("chat.bio.gone"));
																	return;
																}
																const bio = profile.aboutMe || "";
																if (!bio.trim()) { toast.error(t("chat.bio.empty")); return; }
																setBanWordRequest({
																	text: bio.trim(),
																	title: t("ban_word.title_bio"),
																	prompt: t("ban_word.prompt_bio"),
																	forbiddenOnly: true,
																});
															} catch (e) {
																toast.dismiss(loadToast);
																toast.error(t("chat.bio.failed"));
															}
														}}
														className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-[var(--text-muted)] transition hover:bg-[var(--surface-2)]"
													>
														<Ban className="mr-2 h-4 w-4 opacity-50" />
														{t("chat.ban_bio_phrase")}
													</button>
											</>
											{/* — Destructive — */}
											<div className="my-1 h-px bg-[var(--border)]" />
											<button
												type="button"
												onClick={requestDeleteConversation}
												disabled={!selectedConversation || !onDeleteConversation || isDeletingConversation}
												className="flex items-center rounded-lg px-2 py-2 text-left text-sm text-red-400 transition hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
											>
												<MessageCircleX className="mr-2 h-4 w-4 opacity-70" />
												{isDeletingConversation ? t("chat.delete_conversation_in_progress") : t("chat.delete_conversation")}
											</button>
										</div>
									) : null}
								</div>
							</div>
						</div>

						<ConfirmDialog
							isOpen={isBlockConfirmOpen}
							title={t("profile_details.block")}
							message={t("profile_details.block_confirm")}
							confirmLabel={t("profile_details.block")}
							cancelLabel={t("chat.actions.cancel")}
							onConfirm={confirmBlockProfile}
							onCancel={closeBlockConfirm}
							isProcessing={isBlockingProfile}
							confirmTone="danger"
							dontAskAgainLabel={t("profile_details.dont_ask_again")}
							dontAskAgainChecked={dontAskBlockAgain}
							onDontAskAgainChange={setDontAskBlockAgain}
						/>
						<ConfirmDialog
							isOpen={isUnblockConfirmOpen}
							title={t("profile_details.unblock")}
							message={t("profile_details.unblock_confirm")}
							confirmLabel={t("profile_details.unblock")}
							cancelLabel={t("chat.actions.cancel")}
							onConfirm={confirmUnblockProfile}
							onCancel={closeUnblockConfirm}
							isProcessing={isUnblockingProfile}
							confirmTone="default"
							dontAskAgainLabel={t("profile_details.dont_ask_again")}
							dontAskAgainChecked={dontAskUnblockAgain}
							onDontAskAgainChange={setDontAskUnblockAgain}
						/>
						<ConfirmDialog
							isOpen={isDeleteConversationConfirmOpen}
							title={t("chat.delete_conversation")}
							message={t("chat.delete_conversation_confirm")}
							confirmLabel={t("chat.delete_conversation")}
							cancelLabel={t("chat.actions.cancel")}
							onConfirm={confirmDeleteConversation}
							onCancel={closeDeleteConversationConfirm}
							isProcessing={isDeletingConversation}
							confirmTone="danger"
							dontAskAgainLabel={t("profile_details.dont_ask_again")}
							dontAskAgainChecked={dontAskDeleteConversationAgain}
							onDontAskAgainChange={setDontAskDeleteConversationAgain}
						/>
						<ConfirmDialog
							isOpen={mergeConfirmTarget !== null}
							title={t("chat.merge_conversation_confirm_title", { defaultValue: "Merge conversation" })}
							message={t("chat.merge_conversation_confirm_message", {
								defaultValue:
									'Move this conversation\'s messages, photos and albums into "{{name}}"? The archived chat is then closed, and what it held shows in that chat as older history. Its notes about who blocked whom are not carried over. This cannot be undone.',
								name: mergeConfirmTarget?.data.name || t("chat.unknown"),
							})}
							confirmLabel={t("chat.merge_conversation", { defaultValue: "Merge into current chat" })}
							cancelLabel={t("chat.actions.cancel")}
							onConfirm={confirmMergeConversation}
							onCancel={closeMergeConfirm}
							isProcessing={isMergingConversation}
						/>
					</>
				);
			})()}

			{/* Whether this person already met an earlier account: the point is
			    to know before answering, including in a chat started from
			    their profile that has no messages yet. */}
			<PastContactNote
				profileId={
					selectedConversation
						? getOtherParticipant(selectedConversation, userId)?.profileId ?? null
						: targetProfileId
				}
				variant="banner"
				className={isDesktop ? "mb-2 shrink-0" : "mx-[var(--app-px)] my-2 shrink-0"}
			/>

			{selectedConversation ? (
				isLoadingThread &&
				threadConversationId !== selectedConversation.data.conversationId ? (
				<div className="flex flex-1 items-center justify-center text-[var(--text-muted)]">
					<Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("chat.loading_messages")}
				</div>
			) : threadError ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
					<p className="text-sm text-[var(--text-muted)]">{threadError}</p>
					<button
						type="button"
						onClick={() =>
							void loadThread({
								conversationId: selectedConversation.data.conversationId,
								older: false,
							})
						}
						className="btn-accent px-4 py-2 text-sm"
					>
						{t("chat.retry")}
					</button>
				</div>
			) : (
				<ChatThreadMessages
						isDesktop={isDesktop}
						selectedConversation={selectedConversation}
						userId={userId}
						nowTimestamp={nowTimestamp}
						messagePageKey={messagePageKey}
						isLoadingOlderMessages={isLoadingOlderMessages}
						loadThread={loadThread}
						threadScrollContainerRef={threadScrollContainerRef}
						handleThreadScroll={handleThreadScroll}
						threadMessages={threadMessages}
						threadLastReadTimestamp={threadLastReadTimestamp}
						messageElementRefs={messageElementRefs}
						handleMessageTap={handleMessageTap}
						startMessageLongPress={startMessageLongPress}
						endMessageLongPress={endMessageLongPress}
						messageLongPressTriggeredRef={messageLongPressTriggeredRef}
						openFullScreenImage={openFullScreenImage}
						openAlbumViewerById={openAlbumViewerById}
						onJumpToMessage={onJumpToMessage}
						highlightedMessageId={highlightedMessageId}
						selectedThreadMessageMatches={selectedThreadMessageMatches}
						activeThreadSearchIndex={activeThreadSearchIndex}
						openMessageActionId={openMessageActionId}
						setOpenMessageActionId={setOpenMessageActionId}
						isMutatingMessageId={isMutatingMessageId}
						reactionBurstMessageId={reactionBurstMessageId}
						handleReact={handleReact}
						handleUnsend={handleUnsend}
						handleDelete={handleDelete}
						handleRetry={handleRetry}
						handleReply={handleReply}
						handleStopAlbumShare={handleStopAlbumShare}
						onBanWord={openBanWordForMessage}
						threadBottomRef={threadBottomRef}
						isPartnerTyping={isPartnerTyping}
						isArchived={isArchived}
						hasChattedBefore={hasChattedBefore}
						lastMessageTimestamp={lastMessageTimestamp}
						composerHeight={composerHeight}
						selectedMediaIds={selectedMediaIds}
						onStartMediaSelection={onStartMediaSelection}
						onToggleMediaSelection={onToggleMediaSelection}
						onUnavailableMediaChange={onUnavailableMediaChange}
					/>
				)
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
					<div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--surface-2)] text-[var(--text-muted)]">
						<MessageCircleOff className="h-6 w-6 opacity-50" />
					</div>
					<div>
						<p className="text-sm font-medium text-[var(--text-muted)]">{t("chat.new_conversation.no_messages_yet", { defaultValue: "No messages yet" })}</p>
						<p className="mt-1 text-xs text-[var(--text-muted)] opacity-70">{t("chat.new_conversation.send_first_message_hint", { defaultValue: "Send a message below to start the conversation." })}</p>
					</div>
				</div>
			)}

					{selectedMediaIds ? (
						<div
							ref={composerRef}
							className={`${!isDesktop ? "shrink-0 px-[var(--app-px)] py-3" : "mt-3 pt-3 -mx-3 sm:-mx-4 px-3 sm:px-4"} border-t border-[var(--border)] bg-[var(--surface)]`}
							style={
								!isDesktop
									? { paddingBottom: "max(12px, env(safe-area-inset-bottom))" }
									: undefined
							}
						>
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={onCancelMediaSelection}
									aria-label={t("common.cancel", { defaultValue: "Cancel" })}
									className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text)] transition hover:bg-[var(--surface-3)]"
								>
									<X className="h-5 w-5" />
								</button>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-semibold text-[var(--text)]">
										{selectedMediaIds.size === 0
											? t("chat.media_selection.pick_hint", { defaultValue: "Tap photos to select" })
											: t("chat.media_selection.count", { defaultValue: "{{count}} selected", count: selectedMediaIds.size })}
									</p>
									{unsaveablePickedCount > 0 ? (
										<p className="truncate text-xs text-[var(--text-muted)]">
											{t("chat.media_selection.not_saved_count", {
												defaultValue: "{{count}} not saved",
												count: unsaveablePickedCount,
											})}
										</p>
									) : null}
								</div>
								{!isDesktop && selectedMediaIds.size === 1 ? (
									<button
										type="button"
										onClick={onOpenSelectedMediaActions}
										disabled={isWorkingOnSelectedMedia}
										aria-label={t("chat.actions.title")}
										className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text)] transition hover:bg-[var(--surface-3)] disabled:opacity-40"
									>
										<Ellipsis className="h-5 w-5" />
									</button>
								) : null}
								<button
									type="button"
									onClick={() => void onSaveSelectedMedia()}
									disabled={saveablePickedCount === 0 || isWorkingOnSelectedMedia}
									className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-[var(--surface-2)] px-3.5 text-sm font-semibold text-[var(--text)] transition hover:bg-[var(--surface-3)] disabled:opacity-40"
								>
									{isWorkingOnSelectedMedia ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
									<span className="max-[359px]:hidden">
										{unsaveablePickedCount > 0 && saveablePickedCount > 0
											? t("chat.media_selection.save_count", { defaultValue: "Save {{count}}", count: saveablePickedCount })
											: t("chat.media_selection.save", { defaultValue: "Save" })}
									</span>
								</button>
								<button
									type="button"
									onClick={() => void onDeleteSelectedMedia()}
									disabled={selectedMediaIds.size === 0 || isWorkingOnSelectedMedia}
									className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-red-500/10 px-3.5 text-sm font-semibold text-red-400 transition hover:bg-red-500/20 disabled:opacity-40"
								>
									<Trash2 className="h-4 w-4" />
									<span className="max-[359px]:hidden">{t("chat.actions.delete")}</span>
								</button>
							</div>
						</div>
					) : isArchived ? (
						<div
							ref={composerRef}
					className={`${!isDesktop ? "shrink-0 px-[var(--app-px)] py-3" : "mt-3 pt-3 -mx-3 sm:-mx-4 px-3 sm:px-4"} bg-[var(--surface)]`}
							style={
								!isDesktop
									? { paddingBottom: keyboardOpen ? "12px" : "max(12px, env(safe-area-inset-bottom))" }
									: undefined
							}
						>
							<div className="flex items-start gap-3 rounded-2xl bg-[var(--surface-2)] p-3">
								<div className="shrink-0 rounded-xl bg-[var(--surface)] p-2.5">
									<Archive className="h-4 w-4 text-[var(--text-muted)]" />
								</div>
								<div className="grid gap-0.5 pt-0.5">
									<p className="text-sm font-semibold text-[var(--text)]">
										{t("chat.archived.title", { defaultValue: "Conversation archived" })}
									</p>
									{/* Say which of the three archives this is. "Archived" alone
										left the unblock button's absence as the only clue, and
										that clue reads backwards: it is missing precisely when
										this account is *not* the one blocking. The stored
										block_state is used rather than the live block list,
										which is briefly empty while it loads and would flicker
										through "they blocked you". */}
									<p className="text-xs text-[var(--text-muted)]">
										{archivedReason === "not_found"
											? t("chat.archived.not_found", {
													defaultValue: "Their profile is gone — deleted or banned. You can still read the history.",
												})
											: archivedBlockState === "blocked_by_me"
												? t("chat.archived.blocked_by_me", {
														defaultValue: "You blocked this person. Unblock them to write again — the history stays either way.",
													})
												: archivedBlockState === "blocked_by_other"
													? t("chat.archived.blocked_by_other", {
															defaultValue: "This person blocked you, so there is nothing to unblock on your side. You can still read the history.",
														})
													: t("chat.archived.blocked_or_deleted", {
															defaultValue: "This conversation is archived. You can still read the history, but can no longer send messages.",
														})}
									</p>
									{/* How and why, for a block of this account's: an automatic
										one made by mistake should be visible right here. */}
									{archivedReason !== "not_found" && archivedBlockState === "blocked_by_me" && (
										<ArchivedBlockExplanation
											profileId={
												selectedConversation
													? getOtherParticipant(selectedConversation, userId)?.profileId
													: null
											}
											className="mt-1 grid gap-0.5"
										/>
									)}
								</div>
							</div>
						</div>
					) : (
					<form
						ref={composerRef}
						onSubmit={onFormSubmit}
						className={`relative ${!isDesktop ? "shrink-0 px-[var(--app-px)] py-3" : "mt-3 pt-3 -mx-3 sm:-mx-4 px-3 sm:px-4"} border-t border-[var(--border)] bg-[var(--surface)]`}
						style={
							!isDesktop
								? { paddingBottom: keyboardOpen ? "12px" : "max(12px, env(safe-area-inset-bottom))" }
								: undefined
						}
					>
						{(isUploadingAttachment || uploadProgress > 0) && (
							<div
								className="h-0.5 bg-[var(--surface-2)] mb-3"
								style={{ marginTop: "-12px", marginLeft: "calc(-1 * var(--app-px))", marginRight: "calc(-1 * var(--app-px))" }}
							>
								<div
									className="h-0.5 bg-[var(--accent)] transition-all duration-300"
									style={{ width: `${Math.min(100, uploadProgress)}%` }}
								/>
							</div>
						)}
						{/* --- QUICK PHRASE PILLS --- */}
						{!slashMenuMatch && filteredPhrases.length > 0 && (
							<div className="mb-2 flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
								{filteredPhrases.map((phrase, idx) => {
									const isExact = phrase.toLowerCase() === draft.trim().toLowerCase();
									return (
										<button
											key={idx}
											type="button"
											onClick={() => handleUsePhrase(phrase)}
											className={`max-w-[200px] shrink-0 rounded-2xl rounded-br-[3px] border px-3 py-1.5 text-xs font-medium transition active:scale-95 ${
												isExact
													? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]"
													: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
											}`}
										>
											<span className="block truncate">{phrase}</span>
										</button>
									);
								})}
							</div>
						)}
						{/* -------------------------- */}

                        {selectedConversation && replyTargetMessage ? (() => {
							const rtm = replyTargetMessage;
							const rtmBody = rtm.body as Record<string, unknown> | null | undefined;
							const isAudioReply = rtm.type === "Audio" || rtm.chat1Type?.toLowerCase() === "audio";
							const isImageReply = rtm.type === "Image" || rtm.type === "ExpiringImage" || rtm.chat1Type?.toLowerCase() === "image" || rtm.chat1Type?.toLowerCase() === "expiring_image";
							const thumbUrl = (() => {
								// A received photo the explicit-photo filter has not
								// cleared is not shown here either.
								if (
									isImageReply &&
									isExplicitFilterEnabled() &&
									Number(rtm.senderId) !== Number(userId) &&
									getContentCoverForMessage(rtm.messageId) != null
								) {
									return null;
								}
								if (isImageReply) {
									const fromUtil = getMessageImageUrl(rtm);
									if (fromUtil) return fromUtil;
									const hash = typeof rtmBody?.imageHash === "string" ? rtmBody.imageHash : null;
									if (hash) return getThumbImageUrl(hash, "320x320");
									const imgObj = rtmBody?.image as Record<string, unknown> | null | undefined;
									const urlCandidate = imgObj?.url ?? imgObj?.imageUrl ?? rtmBody?.url ?? rtmBody?.imageUrl;
									return typeof urlCandidate === "string" ? urlCandidate : null;
								}
								if (rtm.type === "AlbumContentReaction" || rtm.type === "AlbumContentReply") {
									return typeof rtmBody?.previewUrl === "string" ? rtmBody.previewUrl : null;
								}
								const albumCover = getMessageAlbumCoverUrl(rtm);
								if (albumCover) return albumCover;
								return null;
							})();
							const audioDuration = (() => {
								if (!isAudioReply) return null;
								const rawMs = typeof rtmBody?.length === "number" ? rtmBody.length : null;
								if (rawMs === null) return null;
								const totalSec = Math.floor(rawMs / 1000);
								return `${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, "0")}`;
							})();
							return (
								<div className="relative mb-2 overflow-hidden rounded-xl bg-[var(--surface-2)]">
									<div className="absolute left-0 top-0 h-full w-[3px] bg-[var(--accent)]" />
									<div className="flex items-center gap-2 py-[13px] pl-[13px] pr-2">
										<div className="min-w-0 flex-1">
											<p className="mb-0.5 truncate text-[11px] font-semibold text-[var(--accent)]">
												{(() => {
													if (userId != null && Number(rtm.senderId) === Number(userId)) {
														return t("chat.thread.replying_to_myself");
													}
													// Chats restored from local history can have no name at all.
													const name = localNickname || selectedConversation?.data.name?.trim();
													return name ? t("chat.thread.replying_to_name", { name }) : t("chat.thread.replying");
												})()}
											</p>
											<p className="truncate text-xs text-[var(--text-muted)]">
												{isAudioReply ? t("chat.thread.audio_label") : getMessagePreviewLabel(rtm, t)}
											</p>
										</div>
										{thumbUrl ? (
											<img
												key={thumbUrl}
												src={thumbUrl}
												alt=""
												className="h-10 w-10 shrink-0 rounded object-cover"
												// An album that was never saved has a cover link that no longer
												// opens; a broken-image icon says nothing useful.
												onError={(event) => {
													event.currentTarget.style.display = "none";
												}}
											/>
										) : isAudioReply ? (
											<div className="flex w-10 shrink-0 items-center justify-end py-0.5 text-[var(--text-muted)]">
												<div className="flex flex-col items-center gap-1">
													<Mic className="h-4 w-4" />
													<span className="text-[10px]">{audioDuration ?? "0:00"}</span>
												</div>
											</div>
										) : null}
										<button
											type="button"
											onClick={clearReplyTarget}
											className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:text-[var(--text)]"
											aria-label={t("chat.actions.cancel")}
										>
											<X className="h-3.5 w-3.5" />
										</button>
									</div>
								</div>
							);
						})() : null}

						{props.pendingAudioBlob ? (
							<div className="mb-2 rounded-xl border border-[var(--accent)] bg-[var(--surface-2)] pl-1.5 pr-1 py-1.5 flex items-center gap-1">
								<div className="flex-1 min-w-0">
									<AudioPreviewPlayer blob={props.pendingAudioBlob} durationMs={props.pendingAudioDuration} recordedBars={recordedWaveform} recordedFraction={Math.min(1, props.pendingAudioDuration / 60_000)} />
								</div>
								<button
									type="button"
									onClick={() => { setRecordedWaveform([]); props.cancelAudio(); }}
									className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:text-red-500"
									aria-label={t("chat.actions.cancel")}
								>
									<Trash2 className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									onClick={() => { setRecordedWaveform([]); void props.confirmAudio(); }}
									disabled={props.isSendingAudio}
									className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--accent)] transition hover:opacity-80 disabled:opacity-40"
									aria-label={t("chat.attachments.send")}
								>
									{props.isSendingAudio
										? <Loader2 className="h-3.5 w-3.5 animate-spin" />
										: <SendHorizontal className="h-3.5 w-3.5" />}
								</button>
							</div>
						) : null}
						<div className="relative">
						{slashMatches.length > 0 && (
							<div
								onMouseDown={(event) => event.preventDefault()}
								className="absolute bottom-full left-0 right-0 max-h-64 overflow-hidden rounded-t-2xl border-x border-t border-[var(--accent)] bg-[var(--surface)] shadow-xl z-40">
								<div className="max-h-64 overflow-y-auto p-1.5" data-lenis-prevent>
								<div className="flex flex-col gap-1">
									{slashMatches.map((command, index) => {
										const isSelected = index === slashSelectedIndex;
										const isDisabled = command.requiresConversation && !selectedConversation;
										return (
											<button
												key={command.name}
												type="button"
												disabled={isDisabled}
												onClick={() => selectSlashCommand(command)}
												onMouseEnter={() => setSlashSelectedIndex(index)}
												title={isDisabled ? t("chat.slash_commands.errors.no_conversation", { defaultValue: "Open a chat first" }) : undefined}
												className={`w-full rounded-xl text-left px-3 py-2 transition disabled:cursor-not-allowed disabled:opacity-40 ${
													isSelected
														? "bg-[var(--accent)] text-[var(--accent-contrast)]"
														: "bg-[var(--surface-2)] hover:bg-[color-mix(in_srgb,var(--surface-2)_80%,var(--text)_8%)]"
												}`}
											>
												<div className="flex items-center gap-1.5 text-sm font-semibold">
													/{command.name}
													{command.argHint && (
														<span
															className={`inline-flex items-center leading-none rounded-md px-1.5 py-1 text-[10px] font-normal ${
																isSelected
																	? "bg-black/15 text-[var(--accent-contrast)]"
																	: "bg-[var(--surface)] text-[var(--text-muted)]"
															}`}
														>
															{command.argHint}
														</span>
													)}
													{command.aliases && command.aliases.length > 0 && (
														<span className="flex items-center gap-1">
															{command.aliases.map((alias) => (
																<span
																	key={alias}
																	className={`inline-flex items-center leading-none rounded-full px-1.5 py-1 text-[10px] font-medium ${
																		isSelected
																			? "bg-black/15 text-[var(--accent-contrast)]"
																			: "bg-[var(--surface)] text-[var(--text-muted)]"
																	}`}
																>
																	/{alias}
																</span>
															))}
														</span>
													)}
												</div>
												<div
													className={`mt-0.5 text-xs ${isSelected ? "opacity-90" : "text-[var(--text-muted)]"}`}
												>
													{t(command.descriptionKey, { defaultValue: command.defaultDescription })}
												</div>
											</button>
										);
									})}
								</div>
								</div>
								<div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-black/30 to-transparent" />
								<div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[var(--border)]" />
							</div>
						)}
						{!props.pendingAudioBlob && <div className={`flex ${isRecording ? "items-center" : "items-end"} gap-2 ${slashMatches.length > 0 ? "rounded-b-xl border-t-0" : "rounded-xl"} border py-1.5 mb-2 transition-colors ${isRecording ? `pl-1 pr-1 ${recordingMs >= 50_000 ? "border-red-500" : "border-[var(--accent)]"} bg-[var(--surface-2)]` : "pl-3 pr-1 border-[var(--border)] bg-[var(--surface-2)] focus-within:border-[var(--accent)]"}`}>
							{isRecording ? (
								<>
									<button
										type="button"
										onClick={cancelRecording}
										className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg"
										style={{ color: `color-mix(in srgb, var(--accent) ${Math.round((1 - dragProgress) * 100)}%, #ef4444)` }}
										aria-label={t("chat.cancel_recording", { defaultValue: "Cancel" })}
									>
										<span className="relative h-4 w-4">
											<span className="absolute inset-0" style={{ opacity: Math.max(0, 1 - dragProgress * 2) }}>
											<Mic className="h-4 w-4 animate-pulse" />
										</span>
											<Trash2 className={`absolute inset-0 h-4 w-4 ${trashBounce ? "animate-trash-bounce" : ""}`} style={{ opacity: Math.max(0, (dragProgress - 0.3) / 0.7) }} />
										</span>
									</button>
									<span className={`text-sm font-semibold tabular-nums shrink-0 ${recordingMs >= 50_000 ? "text-red-500 animate-pulse" : "text-[var(--accent)]"}`}>
										{`${Math.floor(Math.floor(recordingMs / 1000) / 60)}:${(Math.floor(recordingMs / 1000) % 60).toString().padStart(2, "0")}`}
									</span>
									<div className="flex-1" />
									{!isDesktop && showRecordCircle && (
									<span
										className="text-xs text-[var(--text-muted)] shrink-0 select-none"
										style={{
											transform: `translateX(${recordDragX * 0.4}px)`,
											opacity: 1 - dragProgress * 1.5,
										}}
									>
										{t("chat.cancel_recording", { defaultValue: "Slide left to cancel" })}
									</span>
								)}
								</>
							) : (
								<textarea
									ref={textareaRef}
									value={draft}
									autoComplete="off"
									onChange={(event) => setDraft(event.target.value)}
									onFocus={() => setIsComposerFocused(true)}
									onBlur={() => setIsComposerFocused(false)}
									onPaste={(event) => {
										// A copied picture or video is attached; anything
										// else is pasted as text, as always.
										for (const item of Array.from(event.clipboardData?.items ?? [])) {
											if (
												item.kind === "file" &&
												(item.type.startsWith("image/") || item.type.startsWith("video/"))
											) {
												const file = item.getAsFile();
												if (file) {
													event.preventDefault();
													onAttachmentFile(file);
													break;
												}
											}
										}
									}}
									onKeyDown={(event) => {
										if (isDesktop && event.key === "Escape" && replyTargetMessage) {
											event.preventDefault();
											clearReplyTarget();
											return;
										}
										if (slashMatches.length > 0) {
											if (event.key === "ArrowDown") {
												event.preventDefault();
												setSlashSelectedIndex((prev) => (prev + 1) % slashMatches.length);
												return;
											}
											if (event.key === "ArrowUp") {
												event.preventDefault();
												setSlashSelectedIndex((prev) => (prev - 1 + slashMatches.length) % slashMatches.length);
												return;
											}
											if (event.key === "Enter" || event.key === "Tab") {
												event.preventDefault();
												selectSlashCommand(slashMatches[slashSelectedIndex]);
												return;
											}
										}
										if (isDesktop && event.key === "Enter" && !event.shiftKey) {
											event.preventDefault();
											event.currentTarget.form?.requestSubmit();
										}
									}}
									rows={1}
									maxLength={1000}
									placeholder={
										selectedConversation
											? t("chat.write_message")
											: t("chat.new_conversation.write_first_message")
									}
									className="flex-1 bg-transparent py-1 text-sm text-[var(--text)] placeholder-[var(--text-muted)] outline-none resize-none disabled:opacity-60"
									style={{ fieldSizing: "content", maxHeight: "115px" } as React.CSSProperties}
								/>
							)}
							{isRecording && (isDesktop || !showRecordCircle) ? (
								<button
									type="button"
									onClick={() => stopRecording()}
									className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:opacity-80 transition"
									aria-label={t("chat.stop_recording", { defaultValue: "Stop recording" })}
								>
									<Square className="h-4 w-4 fill-current" />
								</button>
							) : draft.trim().length > 0 || isSending ? (
								<button
									type="submit"
									disabled={isSending || !!pendingLocationShare || draft.trim().length === 0}
									className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--accent)] transition hover:opacity-80 disabled:opacity-30"
								>
									{isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
								</button>
							) : (
								<div className="relative flex shrink-0">
									<button
										type="button"
										onContextMenu={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setIsMicMenuOpen(true);
										}}
										onPointerDown={(e) => {
											if (e.button !== 0 && e.pointerType === "mouse") return;
											e.preventDefault();
											e.currentTarget.setPointerCapture(e.pointerId);
											pointerStartPos.current = { x: e.clientX, y: e.clientY };
											wasLongPressRef.current = false;
											
											longPressTimerRef.current = setTimeout(() => {
												wasLongPressRef.current = true;
												longPressTimerRef.current = null;
												if (isDesktop) {
													setIsMicMenuOpen(true);
												} else {
													swipeStartXRef.current = e.clientX;
													isCapturingRef.current = true;
													hasVibratedRef.current = false;
													setRecordDragX(0);
													setShowRecordCircle(true);
													void startRecording();
												}
											}, 250);
										}}
										onPointerMove={(e) => {
											if (longPressTimerRef.current) {
												const dx = Math.abs(e.clientX - pointerStartPos.current.x);
												const dy = Math.abs(e.clientY - pointerStartPos.current.y);
												if (dx > 10 || dy > 10) {
													clearTimeout(longPressTimerRef.current);
													longPressTimerRef.current = null;
												}
											}
											if (!isDesktop && isCapturingRef.current) {
												const dx = e.clientX - swipeStartXRef.current;
												setRecordDragX(Math.min(0, dx));
												if (!hasVibratedRef.current && dx < -CANCEL_THRESHOLD) {
													hasVibratedRef.current = true;
													isCapturingRef.current = false;
													e.currentTarget.releasePointerCapture(e.pointerId);
													if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
													(window as unknown as { FreeGrindBridge?: { vibrate?: (ms: number) => void } }).FreeGrindBridge?.vibrate?.(80) ?? navigator.vibrate?.(80);
													setTrashBounce(true);
													setTimeout(() => {
														setTrashBounce(false);
														setRecordDragX(0);
												setShowRecordCircle(false);
														cancelRecording();
													}, 280);
												}
											}
										}}
										onPointerUp={(e) => {
											const isLong = wasLongPressRef.current;
											if (longPressTimerRef.current) {
												clearTimeout(longPressTimerRef.current);
												longPressTimerRef.current = null;
											}
											e.currentTarget.releasePointerCapture(e.pointerId);
											
											if (isDesktop) {
												if (!isLong) {
													void startRecording();
												}
											} else {
												isCapturingRef.current = false;
												setRecordDragX(0);
												if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
												setShowRecordCircle(false);
												if (isLong) {
													stopRecording(true);
												} else {
													setIsMicMenuOpen(true);
												}
											}
										}}
										onPointerCancel={(e) => {
											if (longPressTimerRef.current) {
												clearTimeout(longPressTimerRef.current);
												longPressTimerRef.current = null;
											}
											e.currentTarget.releasePointerCapture(e.pointerId);
											if (!isDesktop) {
												isCapturingRef.current = false;
												setRecordDragX(0);
												if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
												setShowRecordCircle(false);
												cancelRecording();
											}
										}}
										className={`relative shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg transition select-none touch-none ${isRecording ? "text-red-500" : "text-[var(--accent)] hover:opacity-80"}`}
										style={showRecordCircle ? {
											transform: `translateX(${recordDragX}px)`,
											transition: recordDragX === 0 ? "transform 0.3s cubic-bezier(0.34,1.56,0.64,1)" : "none",
										} : undefined}
										disabled={isProcessingAudioFile}
										aria-label={t("chat.record_audio", { defaultValue: "Record audio" })}
									>
										{showRecordCircle && (
											<span
												className="pointer-events-none absolute rounded-full"
												style={{
													inset: "-20px",
													background: `color-mix(in srgb, var(--accent) ${Math.round((1 - dragProgress) * 100)}%, #ef4444)`,
													opacity: 0.2,
													boxShadow: `0 0 0 1.5px color-mix(in srgb, var(--accent) ${Math.round((1 - dragProgress) * 100)}%, #ef4444)`,
												}}
											/>
										)}
										{isProcessingAudioFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
									</button>

									{/* Glassmorphism Popup Menu for Audio/Video Upload */}
									<div 
										className={`absolute bottom-full right-0 mb-3 w-[220px] origin-bottom-right rounded-2xl border border-white/10 bg-[var(--surface)]/80 backdrop-blur-xl p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.3)] transition-all duration-300 ${
											isMicMenuOpen ? "scale-100 opacity-100" : "pointer-events-none scale-90 opacity-0"
										}`}
									>
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												audioFileInputRef.current?.click();
											}}
											className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium text-[var(--text)] transition-colors hover:bg-white/10 active:bg-white/5"
										>
											<div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]">
												<FileAudio className="h-4 w-4" />
											</div>
											<span>{t("chat.upload_audio_video", { defaultValue: "Upload Audio/Video" })}</span>
										</button>
									</div>

									<input
										type="file"
										ref={audioFileInputRef}
										accept="audio/mp4, audio/aac, audio/mpeg, audio/ogg, audio/wav, audio/webm, video/mp4, video/webm, video/quicktime"
										className="hidden"
										onChange={handleAudioFileSelect}
									/>
								</div>
							)}
						</div>}
						</div>

                        <div className="mb-2 mx-5 flex items-center justify-between gap-2">
							<button
								type="button"
								onClick={() => {
									setIsGiphyPickerOpen((prev) => !prev);
									if (isDrawerOpen) toggleDrawer();
								}}
								className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-60"
								aria-label={t("chat.giphy.button_label")}
								title={t("chat.giphy.button_label")}
							>
								<Sticker className="h-5 w-5" />
							</button>
							<button
								type="button"
								onClick={() => {
									attachmentInputRef.current?.click();
									if (isDrawerOpen) toggleDrawer();
									if (pendingLocationShare) handleLocationShareRequest();
								}}
								disabled={isUploadingAttachment}
								className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-60"
								aria-label={t("chat.attach_media")}
								title={t("chat.attach_media")}
							>
								<ImagePlus className="h-5 w-5" />
							</button>
							<button
								type="button"
								onClick={() => {
									toggleDrawer();
									if (pendingLocationShare) handleLocationShareRequest();
								}}
								disabled={!selectedConversation && !targetProfileId}
								className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-40 disabled:cursor-not-allowed"
								aria-label={t("chat.drawer_label")}
								title={t("chat.drawer_label")}
							>
								<SquareStack className="h-5 w-5" />
							</button>
							<button
								type="button"
								onClick={() => {
									handleLocationShareRequest();
									if (isDrawerOpen) toggleDrawer();
								}}
								className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-60"
								aria-label={t("chat.share_location_label", { defaultValue: "Share Location" })}
								title={t("chat.share_location_label", { defaultValue: "Share Location" })}
							>
								<MapPin className="h-5 w-5" />
							</button>
							<button
								type="button"
								onClick={() => setIsSavedPhrasesOpen((prev) => !prev)}
								className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-60"
								aria-label={t("chat.saved_phrases_label", { defaultValue: "Saved Phrases" })}
								title={t("chat.saved_phrases_label", { defaultValue: "Saved Phrases" })}
							>
								<BookMarked className="h-5 w-5" />
							</button>

							<input
								type="file"
								ref={attachmentInputRef}
								onChange={onAttachmentInput}
								accept="image/*,video/*"
								className="hidden"
							/>
						</div>


					</form>
					)}

					{pendingAttachmentFile ? (
						<BottomDrawer
							title={
								pendingAttachmentFile.type.startsWith("video/")
									? t("chat.attachments.upload_video", { defaultValue: "Upload Video" })
									: t("chat.attachments.upload_picture", { defaultValue: "Upload Picture" })
							}
							onClose={cancelPendingAttachment}
							onConfirm={() => void handleConfirmAttachment()}
							confirmLabel={
								attachmentMaxViews !== 2147483647
									? t("chat.attachments.send_expiring")
									: t("chat.attachments.send")
							}
							isProcessing={isUploadingAttachment}
							isDesktop={isDesktop}
							footerLeft={(() => {
								const isVideo = pendingAttachmentFile.type.startsWith("video/");
								return (
									<div className="relative inline-flex h-11 items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] min-w-[120px]">
										<Hourglass className="pointer-events-none absolute left-3 h-4 w-4 shrink-0" />
										<select
											value={attachmentMaxViews}
											onChange={(e) => setAttachmentMaxViews(Number(e.target.value))}
											className="h-full w-full appearance-none rounded-xl bg-transparent pl-9 pr-3 text-sm font-semibold text-[var(--text)] focus:outline-none cursor-pointer text-center"
										>
											{isVideo ? (
												<>
													<option value={2147483647}>{t("chat_drawer.expiry.unlimited", { defaultValue: "Unlimited" })}</option>
													<option value={1}>{t("chat_drawer.expiry.once", { defaultValue: "Once" })}</option>
													<option value={2}>{t("chat_drawer.expiry.repeat", { defaultValue: "Repeat" })}</option>
												</>
											) : (
												<>
													<option value={2147483647}>{t("chat_drawer.expiry.unlimited", { defaultValue: "Unlimited" })}</option>
													<option value={1}>{t("chat_drawer.expiry.ten_seconds", { defaultValue: "10s" })}</option>
												</>
											)}
										</select>
									</div>
								);
							})()}
						>
							<div className="flex min-h-0 flex-1 flex-col">
							{/* Scrollable preview area */}
							<div className="min-h-0 flex-1 overflow-y-auto" data-lenis-prevent>
							{attachmentPreviewUrl && (
								pendingAttachmentFile.type.startsWith("video/") ? (
									<div className="px-3 pb-3">
										<div className="border border-[var(--border)]" style={{ borderRadius: "0.75rem", clipPath: "inset(0 round 0.75rem)" }}>
											<video src={attachmentPreviewUrl} controls className="w-full object-contain" style={{ maxHeight: "40dvh" }} />
										</div>
									</div>
								) : (
									<div className="px-3 pb-3">
										<div className="flex justify-center">
											<style>{`
												@keyframes attach-logo-shine { 0%, 100% { filter: drop-shadow(0 0 2px rgba(255,140,0,0.3)) brightness(1); } 50% { filter: drop-shadow(0 0 7px rgba(255,140,0,0.95)) brightness(1.25); } }
												.attach-logo-shine { animation: attach-logo-shine 2.8s ease-in-out infinite; }
												.attach-crop .ReactCrop__crop-mask { display: none !important; } .attach-crop .ReactCrop__crop-selection { background-image: none !important; animation: none !important; outline: none !important; border: 3px solid rgba(255,255,255,0.6) !important; border-radius: 11px !important; box-shadow: 0 0 0 9999px rgba(0,0,0,0.5) !important; }
												.attach-crop .ord-n, .attach-crop .ord-s, .attach-crop .ord-e, .attach-crop .ord-w { display: none !important; }
												.attach-crop .ReactCrop__drag-handle { background: transparent !important; border: none !important; width: 15px !important; height: 15px !important; }
												.attach-crop .ord-nw { transform: translate(4px, 4px) !important; border-top: 2px solid white !important; border-left: 2px solid white !important; border-top-left-radius: 4px !important; }
												.attach-crop .ord-ne { transform: translate(-4px, 4px) !important; border-top: 2px solid white !important; border-right: 2px solid white !important; border-top-right-radius: 4px !important; }
												.attach-crop .ord-sw { transform: translate(4px, -4px) !important; border-bottom: 2px solid white !important; border-left: 2px solid white !important; border-bottom-left-radius: 4px !important; }
												.attach-crop .ord-se { transform: translate(-4px, -4px) !important; border-bottom: 2px solid white !important; border-right: 2px solid white !important; border-bottom-right-radius: 4px !important; }
											`}</style>
											<div className="relative rounded-xl border border-[var(--border)] overflow-hidden">
											<ReactCrop
												crop={attachmentCrop}
												onChange={(c) => { setIsDraggingAttachmentCrop(true); setAttachmentCrop(c); }}
												onComplete={(c) => { setIsDraggingAttachmentCrop(false); setAttachmentCompletedCrop(c); }}
												ruleOfThirds={isDraggingAttachmentCrop}
												minWidth={150}
												minHeight={150}
												className="attach-crop ReactCrop--no-animate"
												style={{ maxHeight: "45dvh", display: "block" }}
											>
												<img ref={attachmentImgRef} src={attachmentPreviewUrl} alt={t("common.preview")} className="block" style={{ maxHeight: "45dvh" }} />
											</ReactCrop>
											{attachmentTakenOnGrindr && attachmentCrop && (
												<div
													className="absolute inline-flex items-center gap-1.5 pointer-events-none"
													style={{
														left: `calc(${attachmentCrop.unit === "%" ? attachmentCrop.x + "%" : attachmentCrop.x + "px"} + 10px)`,
														top: `calc(${attachmentCrop.unit === "%" ? (attachmentCrop.y + attachmentCrop.height) + "%" : (attachmentCrop.y + attachmentCrop.height) + "px"} - 10px)`,
														transform: "translateY(-100%)",
													}}
												>
													<img src={freegrindLogo} alt="" className="h-5 w-5 rounded-full attach-logo-shine" />
													<span className="inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-1 text-[10px] font-semibold text-white">
														<span>{t("chat.time.just_now", { defaultValue: "just now" })}</span>
													</span>
												</div>
											)}
											</div>
										</div>
										<div className="mt-3 flex items-center justify-center gap-8">
											<button type="button" onClick={() => void applyAttachmentTransform("flipH")} className="text-[var(--text-muted)] transition hover:text-[var(--text)]" aria-label={t("media_edit.flip")}>
												<SquareCenterlineDashedHorizontal className="h-6 w-6" />
											</button>
											<button type="button" onClick={() => void applyAttachmentTransform("rotateCw")} className="text-[var(--text-muted)] transition hover:text-[var(--text)]" aria-label={t("media_edit.rotate")}>
												<RotateCw className="h-6 w-6" />
											</button>
										</div>
									</div>
								)
							)}
							</div>
							{/* Sticky toggle row — always pinned to bottom of sheet */}
							<div className="shrink-0 px-3 pb-3 pt-2">
								<div className="divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
									{pendingAttachmentFile?.type.startsWith("video/") ? (
										<ToggleRow
											checked={attachmentLooping}
											onChange={setAttachmentLooping}
											label={t("chat.attachments.looping")}
											description={t("chat.attachments.looping_description")}
										/>
									) : (
										<ToggleRow
											checked={attachmentTakenOnGrindr}
											onChange={setAttachmentTakenOnGrindr}
											label={t("chat.attachments.taken_on_grindr")}
											description={t("chat.attachments.taken_on_grindr_description")}
										/>
									)}
									<ToggleRow
										checked={attachmentAddToDrawer}
										onChange={setAttachmentAddToDrawer}
										label={t("chat.attachments.add_to_drawer", { defaultValue: "Add to drawer" })}
										description={t("chat.attachments.add_to_drawer_description", {
											defaultValue: "Also save this to your drawer so you can send it again later",
										})}
									/>
								</div>
							</div>
						</div>
						</BottomDrawer>
					) : null}


					{isDrawerOpen ? (
						<ChatDrawerPanel
							media={drawerMedia}
							isLoading={isLoadingDrawer}
							error={drawerError}
							isSending={isSendingDrawerMedia}
							isAdding={isAddingDrawerMedia}
							deletingMediaId={deletingDrawerMediaId}
							onBack={toggleDrawer}
							onLoadMedia={onLoadDrawerMedia}
							onSendMedia={onSendDrawerMedia}
							onAddMedia={onAddDrawerMedia}
							onDeleteMedia={onDeleteDrawerMedia}
							onShareAlbum={onShareAlbumFromDrawer}
							onStopAlbumShare={onStopAlbumShareFromDrawer}
							albums={shareableAlbums}
							isLoadingAlbums={isLoadingAlbums}
							albumCoverMap={albumCoverMap}
							sharedAlbumIds={sharedAlbumIds}
							isSharingAlbum={isSharingAlbum}
							isDesktop={isDesktop}
							noConversation={!selectedConversation && !targetProfileId}
							ownProfilePhotoUrl={ownProfilePhotoUrl}
						/>
					) : null}

                    {pendingLocationShare ? (
						<BottomDrawer
							title={t("chat.share_location_confirm", { defaultValue: "Share this location?" })}
							onClose={() => setPendingLocationShare(null)}
							onConfirm={() => {
								void onSendLocation(pendingLocationShare.lat, pendingLocationShare.lon);
								setPendingLocationShare(null);
							}}
							confirmLabel={t("chat.send")}
							isDesktop={isDesktop}
						>
							<div className="px-3 pb-3">
								<div className="overflow-hidden rounded-xl border border-[var(--border)]" style={{ height: "40dvh" }}>
									<MapLocationPicker
										selectedLocation={pendingLocationShare}
										onPick={(lat, lon) => setPendingLocationShare({ lat, lon })}
										onError={(msg) => toast.error(msg)}
										className="h-full w-full"
										defaultZoom={18}
									/>
								</div>
							</div>
						</BottomDrawer>
                    ) : null}

					{isGiphyPickerOpen ? (
						<GiphyPickerSheet
							onClose={() => setIsGiphyPickerOpen(false)}
							onSelect={(gif) => {
								setIsGiphyPickerOpen(false);
								void onSendGiphy(gif);
							}}
							isDesktop={isDesktop}
							isSending={isSending}
						/>
					) : null}

					{isSavedPhrasesOpen ? (
						<BottomSheet
							onClose={() => {
								setPhrasesExpanded(false);
								setIsSavedPhrasesOpen(false);
							}}
							onExpand={() => setPhrasesExpanded(true)}
							isDesktop={isDesktop}
							bg="bg-[color-mix(in_srgb,var(--surface)_92%,black_8%)]"
						>
							{/* Header */}
							<div className="flex items-center justify-between px-4 pb-3">
									<div className="flex items-center gap-2">
										<p className="text-sm font-semibold text-[var(--text)]">
											{t("chat.saved_phrases_label", { defaultValue: "Saved Phrases" })}
										</p>
										{savedPhrases.length > 0 && (
											<span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[var(--text-muted)]">
												{savedPhrases.length}
											</span>
										)}
									</div>
									<div className="flex items-center gap-1">
										<button
											type="button"
											onClick={() => { setIsSavedPhrasesOpen(false); navigate("/settings/saved-phrases"); }}
											className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
											aria-label={t("chat.saved_phrases_manage", { defaultValue: "Manage" })}
											title={t("chat.saved_phrases_manage", { defaultValue: "Manage" })}
										>
											<Settings2 className="h-4 w-4" />
										</button>
										<SheetClose className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
											<X className="h-4 w-4" />
										</SheetClose>
									</div>
								</div>

								{/* Add input */}
								<div className="px-3 pb-3">
									<div className="flex gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1.5">
										<input
											type="text"
											value={newPhraseInput}
											onChange={(e) => setNewPhraseInput(e.target.value)}
											onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddPhrase(); } }}
											placeholder={t("settings_saved_phrases.add_placeholder", { defaultValue: "Add a new phrase..." })}
											className="min-w-0 flex-1 bg-transparent px-2 text-sm text-[var(--text)] placeholder-[var(--text-muted)] outline-none"
										/>
										<button
											type="button"
											onClick={handleAddPhrase}
											disabled={!newPhraseInput.trim()}
											className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-contrast)] transition hover:brightness-110 disabled:opacity-40"
										>
											<Plus className="h-3.5 w-3.5" />
											{t("settings_saved_phrases.add", { defaultValue: "Add" })}
										</button>
									</div>
								</div>

								<div className="border-t border-[var(--border)]" />

								{/* Phrases list */}
								<div data-lenis-prevent className="overflow-y-auto overflow-x-hidden" style={{ maxHeight: phrasesExpanded ? "72dvh" : "40dvh", transition: "max-height 0.25s ease" }}>
									{savedPhrases.length === 0 ? (
										<div className="flex flex-col items-center justify-center gap-2.5 text-center text-[var(--text-muted)]" style={{ minHeight: "40dvh" }}>
											<div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--surface-2)]">
												<BookMarked className="h-5 w-5 opacity-60" />
											</div>
											<p className="text-sm font-medium">
												{t("settings_saved_phrases.empty", { defaultValue: "No saved phrases yet." })}
											</p>
											<p className="text-xs opacity-60">
												{t("settings_saved_phrases.empty_hint", { defaultValue: "Type above to add your first phrase." })}
											</p>
										</div>
									) : (
										<SortablePhraseList
											phrases={savedPhrases}
											onReorder={(reordered) => void handleReorderPhrases(reordered)}
											onDelete={(index) => void handleDeletePhrase(index)}
											isDesktop={isDesktop}
											renderPhrase={(phrase) => (
												<SheetClose
													onClick={() => handleUsePhrase(phrase)}
													className="min-w-0 flex-1 break-words text-left text-sm leading-relaxed text-[var(--text)] transition hover:text-[var(--accent)]"
												>
													<span className="block break-words">{phrase}</span>
												</SheetClose>
											)}
										/>
									)}
								</div>
						</BottomSheet>
					) : null}

					{isMergeSheetOpen ? (
						<BottomSheet
							onClose={() => setIsMergeSheetOpen(false)}
							isDesktop={isDesktop}
							bg="bg-[color-mix(in_srgb,var(--surface)_92%,black_8%)]"
						>
							<div className="flex items-center justify-between px-4 pb-3">
								<p className="text-sm font-semibold text-[var(--text)]">
									{t("chat.merge_conversation_dialog_title", { defaultValue: "Merge into…" })}
								</p>
								<SheetClose className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
									<X className="h-4 w-4" />
								</SheetClose>
							</div>

							<div className="px-3 pb-3">
								<input
									type="text"
									value={mergeSearchQuery}
									onChange={(e) => setMergeSearchQuery(e.target.value)}
									placeholder={t("chat.merge_conversation_search_placeholder", { defaultValue: "Search chats or profile ID…" })}
									className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--text-muted)] outline-none"
								/>
							</div>

							<div className="border-t border-[var(--border)]" />

							<div data-lenis-prevent className="overflow-y-auto overflow-x-hidden" style={{ maxHeight: "50dvh" }}>
								{filteredMergeableConversations.length === 0 ? (
									<div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-[var(--text-muted)]">
										<GitMerge className="h-6 w-6 opacity-50" />
										<p className="text-sm font-medium">
											{t("chat.merge_conversation_empty", { defaultValue: "No current chats to merge into." })}
										</p>
									</div>
								) : (
									<div className="divide-y divide-[var(--border)]">
										{filteredMergeableConversations.map((conversation) => {
											const other = getOtherParticipant(conversation, userId);
											const name = conversation.data.name || t("chat.unknown");
											return (
												<button
													key={conversation.data.conversationId}
													type="button"
													onClick={() => {
														setIsMergeSheetOpen(false);
														setMergeConfirmTarget(conversation);
													}}
													className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-[var(--surface-2)]"
												>
													<div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-[var(--surface-2)]">
														<ProfileImage
															src={resolveAvatarSrc(
																other?.primaryMediaHash,
																getParticipantAvatarUrl(other?.primaryMediaHash),
															)}
															alt={name}
														/>
													</div>
													<div className="min-w-0 flex-1">
														<p className="truncate text-sm font-medium text-[var(--text)]">
															{name}
														</p>
														{other?.profileId != null && (
															<p className="truncate text-xs text-[var(--text-muted)]">
																{t("chat.profile_id", { id: other.profileId })}
															</p>
														)}
													</div>
												</button>
											);
										})}
									</div>
								)}
							</div>
						</BottomSheet>
					) : null}

					{!isDesktop && selectedActionMessage && !isAlbumSheetOpen ? (
						<BottomSheet
							isDesktop={false}
							onClose={() => setOpenMessageActionId(null)}
							bg="bg-[color-mix(in_srgb,var(--surface)_92%,black_8%)]"
						>
							<div className="flex items-center justify-between px-4 pb-2">
								<p className="text-sm font-semibold text-[var(--text)]">
									{t("chat.actions.title")}
								</p>
								<SheetClose className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
									<X className="h-4 w-4" />
								</SheetClose>
							</div>
							<div className="border-t border-[var(--border)]" />
							<div className="divide-y divide-[var(--border)] pb-1">
								{(() => {
									const message = selectedActionMessage;
									const mine = selectedActionMessageMine;
									const isMutating = isMutatingMessageId === message.messageId;
									const loc = getMessageLocation(message);
									const body = message.body as any;
									const hasText = body && typeof body.text === "string" && body.text.trim().length > 0;
									const imageUrl = getMessageImageUrl(message);
									const videoUrl = getMessageVideoUrl(message);
									const audioUrl = getMessageAudioUrl(message);
									const mediaUrl = imageUrl || videoUrl;
									const albumId = getMessageAlbumId(message);
									const isViewable = (message.body as any)?.isViewable;

									type ActionRow = {
										key: string;
										icon: React.ReactNode;
										label: string;
										onClick: () => void;
										danger?: boolean;
										disabled?: boolean;
									};
									const rows: ActionRow[] = [];

									if (!isArchived) {
										rows.push({
											key: "reply",
											icon: <Reply className="h-3.5 w-3.5" />,
											label: t("chat.actions.reply", { defaultValue: "Reply" }),
											onClick: () => void handleReply(message),
											disabled: isMutating,
										});
									}

									if (hasText || loc) {
										rows.push({
											key: "copy",
											icon: <Copy className="h-3.5 w-3.5" />,
											label: t("chat.actions.copy", { defaultValue: "Copy" }),
											onClick: () => void handleCopy(message),
										});
									}

									if (hasText) {
										rows.push({
											key: "saved-phrase",
											icon: <MessageSquarePlus className="h-3.5 w-3.5" />,
											label: t("chat.actions.add_to_saved_phrases", { defaultValue: "Add to saved phrases" }),
											onClick: () => void handleAddMessageToSavedPhrases(body.text),
										});
									}

									// A photo that was never saved here has nothing to open or download.
									if ((mediaUrl || audioUrl) && !isActionMediaUnavailable) {
										if (mediaUrl && (isIos() || isAndroid())) {
											rows.push({
												key: "open-media",
												icon: <Download className="h-3.5 w-3.5" />,
												label: t("chat.actions.open_media", { defaultValue: "Open Media" }),
												onClick: () => openFullScreenImage(mediaUrl, undefined, videoUrl ? "video" : "image"),
											});
										} else {
											rows.push({
												key: "download-media",
												icon: <Download className="h-3.5 w-3.5" />,
												label: t("chat.actions.download_media", { defaultValue: "Download Media" }),
												onClick: () => {
													if (mediaUrl) {
														void (async () => {
															try {
																const saved = await saveMediaToDevice(
																mediaUrl,
																videoUrl ? "video" : "image",
																selectedConversation?.data.conversationId ?? null,
															);
																if (saved) {
																	toast.success(t("profile_details.save_to_gallery_success"));
																} else {
																	toast.error(t("profile_details.save_to_gallery_unsupported"));
																}
															} catch (e) {
																appLog.error("Failed to save media to gallery", e);
																toast.error(t("profile_details.save_to_gallery_error"));
															}
														})();
														return;
													}
													if (audioUrl) {
														const a = document.createElement("a");
														a.href = audioUrl;
														a.download = `media-${Date.now()}`;
														a.target = "_blank";
														document.body.appendChild(a);
														a.click();
														document.body.removeChild(a);
													}
												},
											});
										}
									}

									if (isSelectableMediaMessage(message)) {
										rows.push({
											key: "select",
											icon: <CircleCheck className="h-3.5 w-3.5" />,
											label: t("chat.media_selection.select_more", { defaultValue: "Select more" }),
											onClick: () => onStartMediaSelection(message),
										});
									}

									if (hasText && !mine) {
										rows.push({
											key: "ban-word",
											icon: <Ban className="h-3.5 w-3.5" />,
											label: t("chat.actions.ban_word", { defaultValue: "Ban word" }),
											onClick: () => {
												openBanWordForMessage(body?.text || "");
											},
										});
									}

									if (!isArchived && mine && !message.unsent) {
										rows.push({
											key: "unsend",
											icon: <Undo2 className="h-3.5 w-3.5" />,
											label: t("chat.actions.unsend"),
											onClick: () => void handleUnsend(message),
											disabled: isMutating,
										});
									}

									if (mine && albumId && isViewable) {
										rows.push({
											key: "stop-sharing",
											icon: <Album className="h-3.5 w-3.5" />,
											label: t("chat.actions.stop_sharing", { defaultValue: "Stop Sharing" }),
											onClick: () => void handleStopAlbumShare(albumId),
											disabled: isMutating,
										});
									}

									rows.push({
										key: "delete",
										icon: <Trash2 className="h-3.5 w-3.5" />,
										label: t("chat.actions.delete"),
										onClick: () => void handleDelete(message),
										disabled: isMutating,
										danger: true,
									});

									return rows.map((row) => (
										<SheetClose
											key={row.key}
											disabled={row.disabled}
											onClick={row.onClick}
											className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium transition disabled:opacity-50 ${
												row.danger ? "text-red-400" : "text-[var(--text)]"
											}`}
										>
											<div
												className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-xl ${
													row.danger ? "bg-red-500/10 text-red-400" : "bg-[var(--surface-2)] text-[var(--accent)]"
												}`}
											>
												{row.icon}
											</div>
											{row.label}
										</SheetClose>
									));
								})()}
							</div>
						</BottomSheet>
					) : null}


			<BanWordDialog
				isOpen={activeBanRequest !== null}
				initialText={activeBanRequest?.text ?? ""}
				title={activeBanRequest?.title}
				prompt={activeBanRequest?.prompt}
				forbiddenOnly={activeBanRequest?.forbiddenOnly ?? false}
				onClose={closeBanWord}
			/>
		</div>
	) : (
		<div
			className={`flex h-full overflow-hidden items-center justify-center p-6 text-center text-[var(--text-muted)] ${
				isDesktop ? "surface-card" : ""
			}`}
		>
			{t("chat.select_conversation")}
		</div>
	);

	return renderThread;
}