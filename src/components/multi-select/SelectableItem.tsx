import React, { useRef } from "react";
import { useMultiSelect, type ViewType } from "../../contexts/MultiSelectContext";
import { useLongPress } from "../../hooks/useLongPress";
import { Check } from "lucide-react";

interface SelectableItemProps {
    id: string;
    name: string;
    profileId?: string; // <-- ADDED
    viewType: ViewType;
    children: React.ReactNode;
    onNormalClick: () => void;
    roundedClassName?: string;
    isDisabled?: boolean;
}

export function SelectableItem({ id, name, profileId, viewType, children, onNormalClick, roundedClassName = "rounded-xl", isDisabled = false }: SelectableItemProps) {
    const { isActive, viewType: activeViewType, activateMode, toggleSelection, isSelected } = useMultiSelect();
    const selected = isSelected(id);
    const wasLongPressedRef = useRef(false);

    const isModeActiveForThisView = isActive && activeViewType === viewType;

    const handleActivate = () => {
        if (isDisabled) return;
        if (!isActive) {
            wasLongPressedRef.current = true;
            activateMode(viewType, { id, name, profileId });
            setTimeout(() => { wasLongPressedRef.current = false; }, 300);
        }
    };

    const longPressGestures = useLongPress(handleActivate, 400);

    const handleContextMenu = (e: React.MouseEvent) => {
        if (isDisabled) return;
        e.preventDefault();
        handleActivate();
    };

    const handleClick = (e: React.MouseEvent | React.TouchEvent) => {
        if (wasLongPressedRef.current) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (isModeActiveForThisView && !isDisabled) {
            e.preventDefault();
            e.stopPropagation();
            toggleSelection({ id, name, profileId });
        } else {
            onNormalClick();
        }
    };

    return (
        <div 
            role="button"
            className="w-full h-full relative group transition-transform duration-200 select-none cursor-pointer"
            onContextMenu={handleContextMenu}
            onClick={handleClick}
            style={{ WebkitTouchCallout: "none" }}
            {...(!isModeActiveForThisView ? longPressGestures : {})}
        >
            <div className="w-full h-full relative">
                <div className={`w-full h-full ${isModeActiveForThisView ? "pointer-events-none" : ""}`}>
                    {children}
                </div>

                <div 
                    className={`absolute inset-0 z-10 pointer-events-none border-2 transition-all duration-300 ${roundedClassName}`}
                    style={{
                        borderColor: selected ? "color-mix(in srgb, var(--accent) 40%, transparent)" : "transparent",
                        backgroundColor: selected ? "color-mix(in srgb, var(--accent) 6%, transparent)" : "transparent",
                        boxShadow: selected ? "0 4px 12px rgba(0, 0, 0, 0.1), inset 0 0 0 1px color-mix(in srgb, var(--accent) 15%, transparent), 0 0 8px color-mix(in srgb, var(--accent) 10%, transparent)" : "none"
                    }}
                >
                    <div 
                        className={`absolute bottom-2 right-2 sm:bottom-3 sm:right-3 h-6 w-6 sm:h-7 sm:w-7 rounded-full border-2 shadow-lg flex items-center justify-center backdrop-blur-md transition-all duration-300 ${
                            selected 
                                ? "border-[var(--accent)] scale-100 opacity-100" 
                                : isModeActiveForThisView 
                                    ? "bg-black/45 border-white/40 scale-100 opacity-100" 
                                    : "scale-50 opacity-0 bg-black/45 border-white/30 pointer-events-none"
                        }`}
                        style={{
                            backgroundColor: selected ? "var(--accent)" : undefined
                        }}
                    >
                        {selected && <Check className="h-3.5 w-3.5 sm:h-4 sm:w-4" style={{ color: "var(--accent-contrast, black)" }} strokeWidth={3.5} />}
                    </div>
                </div>
            </div>
        </div>
    );
}