
import toast from "react-hot-toast";
import i18n from "../i18n";

let warningShown = false;

export function showAlbumApiWarning() {
    if (warningShown) return;
    warningShown = true;

    const dismissed = localStorage.getItem("fg-album-api-warning-dismissed");
    if (dismissed === "true") return;

    toast.custom(
        (t) => (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    background: "#1a1a2e",
                    color: "white",
                    padding: "16px",
                    borderRadius: "8px",
                    border: "1px solid #333",
                    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5)",
                    maxWidth: "350px",
                }}
            >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#f59e0b", fontWeight: "bold" }}>
                        <span>⚠️</span>
                        <span>{i18n.t("album_warning.title")}</span>
                    </div>
                    <button
                        onClick={() => toast.dismiss(t.id)}
                        style={{ background: "transparent", border: "none", color: "white", cursor: "pointer", fontSize: "16px", padding: "0 4px" }}
                        aria-label={i18n.t("common.dismiss")}
                    >
                        ✕
                    </button>
                </div>
                <div style={{ fontSize: "14px", marginBottom: "16px", lineHeight: "1.4" }}>
                    {i18n.t("album_warning.body")}
                </div>
                <button
                    onClick={() => {
                        localStorage.setItem("fg-album-api-warning-dismissed", "true");
                        toast.dismiss(t.id);
                    }}
                    style={{
                        background: "#374151",
                        border: "none",
                        color: "white",
                        padding: "8px 12px",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                        alignSelf: "flex-end",
                    }}
                >
                    {i18n.t("common.dont_show_again")}
                </button>
            </div>
        ),
        { duration: 15000, id: "album-api-warning" }
    );
}
