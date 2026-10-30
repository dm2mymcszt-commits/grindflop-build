import { ChevronDown } from "lucide-react";
import { Button } from "./button";
import { useTranslation } from "react-i18next";

export function LoadMoreButton({
	onClick,
	loading,
	disabled,
	label,
	loadingLabel,
}: {
	onClick?: () => void;
	loading?: boolean;
	disabled?: boolean;
	label?: string;
	loadingLabel?: string;
}) {
	const { t } = useTranslation();
	return (
		<Button
			type="button"
			onClick={onClick}
			loading={Boolean(loading)}
			disabled={disabled}
			leftIcon={loading ? undefined : <ChevronDown className="h-4 w-4" />}
		>
			{loading ? (loadingLabel ?? t("common.loading_more")) : (label ?? t("common.load_more"))}
		</Button>
	);
}
