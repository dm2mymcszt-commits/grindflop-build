import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useApiFunctions } from "../hooks/useApiFunctions";
import { useAuth } from "../contexts/useAuth";
import { attachBlockImportRunner, type BlockImportEvent } from "../services/blockListImport";

/**
 * Keeps the signed-in account's block list import going on every page, not
 * just the Blocked page it was started from. Renders nothing.
 */
export function BlockListImportRunner() {
	const api = useApiFunctions();
	const { userId, isLoading } = useAuth();
	const queryClient = useQueryClient();
	const { t } = useTranslation();

	const onEventRef = useRef<(event: BlockImportEvent) => void>(() => {});
	onEventRef.current = (event) => {
		void queryClient.invalidateQueries({ queryKey: ["blocked-profile-ids"] });
		if (event.type === "finished") {
			toast.success(
				t("settings_blocked.import_done_toast", {
					defaultValue: "Block list import finished: {{count}} blocked.",
					count: event.job.blocked,
				}),
			);
		} else {
			toast.error(
				t("settings_blocked.import_stopped_toast", {
					defaultValue: "Block list import paused. Open Blocked Accounts to see why.",
				}),
			);
		}
	};

	useEffect(() => {
		// isLoading turns on before an account switch reaches the backend, so
		// the runner is gone before any request could go out as the next account.
		if (userId == null || isLoading) return;
		return attachBlockImportRunner(String(userId), api, (event) => onEventRef.current(event));
	}, [api, userId, isLoading]);

	return null;
}
