import { useEffect, useState } from "react";

/**
 * Hook to detect if the current device is a desktop (has a mouse/pointer and hover).
 * This is more reliable for scrolling behavior than screen width.
 */
export function useDesktopBreakpoint() {
	const [isDesktop, setIsDesktop] = useState(() => {
		if (typeof window === "undefined") return false;
		const isMobilePlatform = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		const hasDesktopQuery = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
		return !isMobilePlatform && window.innerWidth >= 768 && hasDesktopQuery;
	});

	useEffect(() => {
		if (typeof window === "undefined") return;

		const query = window.matchMedia("(hover: hover) and (pointer: fine)");
		const handleResize = () => {
			const isMobilePlatform = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
				(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
			setIsDesktop(!isMobilePlatform && window.innerWidth >= 768 && query.matches);
		};

		handleResize();
		window.addEventListener("resize", handleResize);
		query.addEventListener("change", handleResize);

		return () => {
			window.removeEventListener("resize", handleResize);
			query.removeEventListener("change", handleResize);
		};
	}, []);

	return isDesktop;
}
