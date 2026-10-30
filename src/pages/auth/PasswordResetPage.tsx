import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthShell } from "../../components/ui/auth-shell";

export function PasswordResetPage() {
	const { t } = useTranslation();

	return (
		<AuthShell
			title={t("auth.password_reset.title", { defaultValue: "Reset Password" })}
			subtitle={t("auth.password_reset.subtitle", {
				defaultValue:
					"Resetting a password is not built into this app. Reset it in the official Grindr app, then sign in here with the new one.",
			})}
			footer={
				<Link
					to="/auth/sign-in"
					className="text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
				>
					{t("auth.password_reset.back", { defaultValue: "Back to sign in" })}
				</Link>
			}
		>
			{null}
		</AuthShell>
	);
}
