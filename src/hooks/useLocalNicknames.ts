import { useEffect, useState } from "react";
import { useAuth } from "../contexts/useAuth";
import { getAllLocalNicknames } from "../services/chatContactIndex";
import { appLog } from "../utils/logger";

const NONE: Record<string, string> = {};

/**
 * The nicknames given on this account, by profile id. Read once per visit to
 * a screen: there are only as many as people the user chose to rename, and
 * they are changed on other screens.
 */
export function useLocalNicknames(): Record<string, string> {
	const { userId, settingsReady } = useAuth();
	const [nicknames, setNicknames] = useState<Record<string, string>>(NONE);

	useEffect(() => {
		if (!settingsReady) {
			setNicknames(NONE);
			return;
		}
		let cancelled = false;
		void getAllLocalNicknames()
			.then((found) => {
				if (!cancelled) setNicknames(found);
			})
			.catch((error) => {
				appLog.warn("[chat-index] failed to load local nicknames", error);
			});
		return () => {
			cancelled = true;
		};
	}, [settingsReady, userId]);

	return nicknames;
}
