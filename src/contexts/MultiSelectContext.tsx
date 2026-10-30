import { createContext, useContext, useState, useCallback, ReactNode } from "react";

export type SelectedProfile = {
    id: string; // The primary ID (profileId on grid, conversationId in inbox)
    name: string;
    profileId?: string; // Always the raw Profile ID (crucial for blocking/messaging)
};

export type ViewType = "grid" | "inbox" | null;

interface MultiSelectState {
    isActive: boolean;
    viewType: ViewType;
    selectedItems: SelectedProfile[];
    activateMode: (view: ViewType, initialItem?: SelectedProfile) => void;
    deactivateMode: () => void;
    toggleSelection: (item: SelectedProfile) => void;
    isSelected: (id: string) => boolean;
    selectableItems: SelectedProfile[];
    setSelectableItems: (items: SelectedProfile[]) => void;
    setSelectedItems: (items: SelectedProfile[]) => void;
}

const MultiSelectContext = createContext<MultiSelectState | undefined>(undefined);

export function MultiSelectProvider({ children }: { children: ReactNode }) {
    const [isActive, setIsActive] = useState(false);
    const [viewType, setViewType] = useState<ViewType>(null);
    const [selectedItems, setSelectedItems] = useState<SelectedProfile[]>([]);
    const [selectableItems, setSelectableItems] = useState<SelectedProfile[]>([]);

    const activateMode = useCallback((view: ViewType, initialItem?: SelectedProfile) => {
        setIsActive(true);
        setViewType(view);
        if (initialItem) {
            setSelectedItems([initialItem]);
        }
    }, []);

    const deactivateMode = useCallback(() => {
        setIsActive(false);
        setViewType(null);
        setSelectedItems([]);
        setSelectableItems([]);
    }, []);

    const toggleSelection = useCallback((item: SelectedProfile) => {
        setSelectedItems((prev) => {
            const exists = prev.find((p) => p.id === item.id);
            if (exists) return prev.filter((p) => p.id !== item.id);
            return [...prev, item];
        });
    }, []);

    const isSelected = useCallback((id: string) => {
        return selectedItems.some((p) => p.id === id);
    }, [selectedItems]);

    return (
        <MultiSelectContext.Provider
            value={{
                isActive,
                viewType,
                selectedItems,
                activateMode,
                deactivateMode,
                toggleSelection,
                isSelected,
                selectableItems,
                setSelectableItems,
                setSelectedItems,
            }}
        >
            {children}
        </MultiSelectContext.Provider>
    );
}

export function useMultiSelect() {
    const context = useContext(MultiSelectContext);
    if (!context) throw new Error("useMultiSelect must be used within MultiSelectProvider");
    return context;
}