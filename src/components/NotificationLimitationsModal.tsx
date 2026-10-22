import { useState } from "react";
import { Info, X } from "lucide-react";
import { Button } from "./ui/button";
import { useTranslation } from "react-i18next";

const NOTIFICATION_WARNING_KEY = "fg-notification-warning-seen";

type NotificationLimitationsModalProps = {
    isOpen: boolean;
    onClose: () => void;
};

export function NotificationLimitationsModal({ isOpen, onClose }: NotificationLimitationsModalProps) {
    const { t } = useTranslation();
    const [dontShowAgain, setDontShowAgain] = useState(false);

    if (!isOpen) return null;

    const handleClose = () => {
        if (dontShowAgain) {
            window.localStorage.setItem(NOTIFICATION_WARNING_KEY, "true");
        }
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in">
            <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl animate-in zoom-in-95">
                <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-2)] p-4">
                    <div className="flex items-center gap-2 text-[var(--text)]">
                        <Info className="h-5 w-5 text-blue-400" />
                        <h2 className="text-sm font-semibold">{t("notification_limits.title")}</h2>
                    </div>
                    <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-black/10">
                        <X className="h-5 w-5 text-[var(--text-muted)]" />
                    </button>
                </div>
                
                <div className="p-5">
                    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--accent)]">{t("notification_limits.how_title")}</h3>
                    <p className="mb-4 text-xs text-[var(--text-muted)] leading-relaxed">
                        {t("notification_limits.how_desc")}
                    </p>

                    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-red-400">{t("notification_limits.limits_title")}</h3>
                    <p className="mb-3 text-xs text-[var(--text-muted)] leading-relaxed">
                        {t("notification_limits.limits_desc")} 
                    </p>
                    <p className="mb-4 text-xs text-[var(--text-muted)] leading-relaxed">
                        {t("notification_limits.result_lead")} <strong>{t("notification_limits.result_strong")}</strong>{t("notification_limits.result_tail")}
                    </p>

                    <label className="mb-5 flex items-center gap-3 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={dontShowAgain}
                            onChange={(e) => setDontShowAgain(e.target.checked)}
                            className="h-4 w-4 accent-[var(--accent)] cursor-pointer"
                        />
                        <span className="text-sm text-[var(--text)]">{t("notification_limits.dont_show")}</span>
                    </label>

                    <div className="flex gap-3">
                        <Button type="button" onClick={handleClose} className="flex-1 font-bold">
                            {t("common.got_it")}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
