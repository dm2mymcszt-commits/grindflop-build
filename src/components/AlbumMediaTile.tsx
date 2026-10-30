import { useState } from "react";
import { Film, ImageOff, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AlbumContentItem } from "../types/chat-page";
import { isPictureUrl } from "../utils/mediaMime";

/**
 * What an album grid shows for one item. A picture comes first; a video with
 * no picture shows its own first frame; anything that cannot load becomes a
 * quiet placeholder instead of a broken image with its alt text.
 */
export function AlbumMediaTile({ item }: { item: AlbumContentItem }) {
	const { t } = useTranslation();
	const isVideo = item.contentType?.toLowerCase().startsWith("video/") ?? false;
	const pictures = [...new Set([item.thumbUrl, isVideo ? null : item.url, item.coverUrl].filter(isPictureUrl))];
	const [failedPictures, setFailedPictures] = useState(0);
	const [videoFailed, setVideoFailed] = useState(false);

	const picture = pictures[failedPictures];
	const frameSource = isVideo && !picture && !videoFailed ? item.url : null;

	return (
		<>
			{picture ? (
				<img
					src={picture}
					alt=""
					loading="lazy"
					draggable={false}
					onError={() => setFailedPictures((count) => count + 1)}
					className="h-full w-full object-cover"
				/>
			) : frameSource ? (
				<video
					src={frameSource}
					muted
					playsInline
					preload="metadata"
					onLoadedMetadata={(event) => {
						// Shows the first frame instead of black.
						if (event.currentTarget.currentTime === 0) event.currentTarget.currentTime = 0.001;
					}}
					onError={() => setVideoFailed(true)}
					className="pointer-events-none h-full w-full object-cover"
				/>
			) : (
				<div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-[var(--surface-2)] text-[var(--text-muted)]">
					{isVideo ? <Film className="h-5 w-5 opacity-70" /> : <ImageOff className="h-5 w-5 opacity-70" />}
					<span className="px-2 text-center text-[10px] font-medium leading-tight">
						{t("shared_albums.unavailable")}
					</span>
				</div>
			)}
			{isVideo && (picture || frameSource) ? (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-gradient-to-t from-black/35 via-transparent to-transparent">
					<div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 ring-1 ring-inset ring-white/20 backdrop-blur-sm">
						<Play className="ml-0.5 h-4 w-4 fill-white text-white" />
					</div>
				</div>
			) : null}
		</>
	);
}
