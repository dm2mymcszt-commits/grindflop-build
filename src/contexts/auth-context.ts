import { createContext } from "react";
import type { AccountStatus } from "../utils/accountStatus";

export interface AuthState {
	userId: number | null;
	isLoading: boolean;
	error: string | null;
	/**
	 * True once the per-profile db (chatDb) is pointed at the active user's
	 * own file and the one-time legacy-settings migration has been checked.
	 * Anything reading profile-scoped settings (preferences, automation,
	 * saved phrases/locations) must wait for this before loading — otherwise
	 * it risks reading the previous profile's connection during the switch.
	 */
	settingsReady: boolean;
}

export interface SavedAccountMeta {
	profileId: string;
	email: string;
	lastUsedAt: number;
}

/** Something Grindr said about an account that the user has to be told. */
export interface AccountNotice {
	status: AccountStatus;
	/**
	 * "session": about the account that is signed in.
	 * "signIn": about a sign-in Grindr has just refused. That says nothing
	 * about whoever is signed in, since an account can be added while another
	 * one is active.
	 */
	about: "session" | "signIn";
}

export interface AuthContextType extends AuthState {
	/** What to tell the user about an account's standing right now, if anything. */
	accountNotice: AccountNotice | null;
	/** Puts the notice away. The same answer is not shown again until it changes. */
	dismissAccountNotice: () => void;
	login: (email: string, password: string) => Promise<void>;
	loginWithJwt: (token: string) => Promise<void>;
	logout: () => Promise<void>;
	checkAuth: () => Promise<void>;
	savedAccounts: SavedAccountMeta[];
	switchAccount: (profileId: string) => Promise<void>;
	removeSavedAccount: (profileId: string) => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);