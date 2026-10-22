import {
	useReducer,
	useEffect,
	useRef,
	useState,
	ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import i18n from "../i18n";
import { useApi } from "../hooks/useApi";
import { useApiFunctions } from "../hooks/useApiFunctions";
import type { AppError } from "../types/api";
import toast from "react-hot-toast";
import {
	AuthContext,
	type AccountNotice,
	type AuthContextType,
	type AuthState,
	type SavedAccountMeta,
} from "./auth-context";
import {
	ACCOUNT_STATUS_EVENT,
	accountStatusKey,
	parseAccountStatus,
	restrictionStatus,
	type AccountStatus,
	type BanInfo,
} from "../utils/accountStatus";
import { appLog } from "../utils/logger";
import {
	getActiveChatDbUser,
	migrateLegacySettingsIfNeeded,
	setActiveChatDbUser,
} from "../services/chatDb";
import {
	getActiveChatContactIndexUser,
	setActiveChatContactIndexUser,
} from "../services/chatContactIndex";
import {
	getActiveInterestViewsAccount,
	getInterestViewsAccountForUser,
	setActiveInterestViewsUser,
} from "../services/interestViewsStore";
import { clearAllCaches } from "../pages/app/gridpage/cache";
import { clearChatSearchIndex } from "../pages/app/chat/cache";
import { loadAutomationCache } from "../utils/autoblock";
import { loadAutomationRulesCache } from "../utils/automationRules";
import { loadMediaSettingsCache } from "../utils/mediaSettings";
import { loadPrivacyCache } from "../utils/privacy";
import { loadSeenCache } from "../services/seenStore";
import { loadStatsSettingsCache } from "../services/statsLog";
import { runInboxSync } from "../services/inboxSync";
import { runTapsAutomationSync } from "../services/tapsSync";
import { syncSavedPhrasesFromServer } from "../services/savedPhrases";
import {
	closeGoogleDriveSyncProfilesExcept,
	invalidateGoogleDriveSyncProfile,
} from "../services/googleDriveSyncRuntime";

const AUTH_USER_ID_STORAGE_KEY = "fg-user-id";
const PUSH_TOKEN_STORAGE_KEY = "fg-fcm-token";
const PUSH_TOKEN_SYNCED_STORAGE_KEY = "fg-fcm-token-synced";

// Grindr's API returns this generic validation error for several rejected-login
// cases (wrong credentials, malformed/expired token) rather than a specific one,
// so its raw "Error 4: invalid input parameters" text is meaningless to users.
const INVALID_INPUT_PARAMETERS_CODE = 4;

// Grindr answered a sign-in through Google, Apple or Facebook with this code
// when the account had to confirm a phone number before it got a session.
// That sign-in is gone from the app; whether the password route means the
// same by it is not known, so the message below says "usually".
const PHONE_VERIFICATION_REQUIRED_CODE = 30;

function describeLoginError(
	appError: AppError | null,
	fallback: string,
	invalidCredentialsMessage: string,
): string {
	if (appError?.ban) {
		return i18n.t("auth.sign_in.refused", {
			code: appError.ban.code,
			message: appError.ban.message || "?",
			defaultValue: "Grindr refused the sign-in ({{message}}, code {{code}}).",
		});
	}
	if (appError?.kind === "Api" && typeof appError.message === "object") {
		if (appError.message.code === INVALID_INPUT_PARAMETERS_CODE) {
			return invalidCredentialsMessage;
		}
		if (appError.message.code === PHONE_VERIFICATION_REQUIRED_CODE) {
			return i18n.t("auth.sign_in.phone_verification_required", {
				defaultValue:
					"Grindr refused the sign-in (code 30). This usually means the account has to confirm a phone number first, which is done in the official Grindr app.",
			});
		}
	}
	return appError?.prettyMessage || fallback;
}

type AuthAction =
	| { type: "SET_USER"; payload: number }
	| { type: "CLEAR_USER" }
	| { type: "SET_LOADING"; payload: boolean }
	| { type: "SET_ERROR"; payload: string | null }
	| { type: "SET_SETTINGS_READY"; payload: boolean };

function authReducer(state: AuthState, action: AuthAction): AuthState {
	switch (action.type) {
		case "SET_USER":
			return {
				...state,
				// The sign-in commands answer with the profile id as a string
				// (only auth_state sends a number) and nothing parses it on the
				// way in. Left as a string, every `=== userId` check against a
				// numeric id fails until the next launch: Drive sync refuses
				// the id, and the signed-in account is listed as another one.
				userId: Number(action.payload),
				error: null,
				settingsReady: false,
			};
		case "CLEAR_USER":
			return { ...state, userId: null, settingsReady: false };
		case "SET_LOADING":
			return { ...state, isLoading: action.payload };
		case "SET_ERROR":
			return { ...state, error: action.payload };
		case "SET_SETTINGS_READY":
			return { ...state, settingsReady: action.payload };
		default:
			return state;
	}
}

export function AuthProvider({ children }: { children: ReactNode }) {
	const [state, dispatch] = useReducer(authReducer, {
		userId: null,
		isLoading: true,
		error: null,
		settingsReady: false,
	});

	const { callMethod, asAppError } = useApi();
	const apiFunctions = useApiFunctions();
	const queryClient = useQueryClient();
	const [savedAccounts, setSavedAccounts] = useState<SavedAccountMeta[]>([]);
	// What Grindr last said about the account that is signed in, as the Rust
	// side reports it, and which answer the user has already put away.
	const [sessionStatus, setSessionStatus] = useState<AccountStatus | null>(null);
	const [dismissedStatusKey, setDismissedStatusKey] = useState<string | null>(null);
	// A sign-in Grindr has just refused with one of its ban codes. Kept apart
	// from the above: an account can be added while another one is signed in,
	// and that refusal says nothing about the one that is.
	const [signInRefusal, setSignInRefusal] = useState<BanInfo | null>(null);
	// undefined = not yet resolved once; distinguishes "app boot" (nothing to
	// clear, just point the chat db at whatever account is already logged
	// in) from an actual account change (switch/logout) afterwards.
	const previousUserIdRef = useRef<number | null | undefined>(undefined);
	// Live mirror of state.userId for the background inbox sync's staleness
	// check below — a plain closure over state.userId would only ever see
	// the value from the render that kicked the sync off.
	const currentUserIdRef = useRef<number | null>(state.userId);
	// Invalidates asynchronous account setup from an older render. Without this,
	// a slow cache/database setup for profile A can mark profile B ready after a
	// rapid switch, which is an unsafe point to start account-scoped background work.
	const profileSetupGenerationRef = useRef(0);
	const completedProfileSetupRef = useRef<number | null | undefined>(undefined);
	// Database switches share module-level connections, so serialize profile
	// setup as well as invalidating stale work. The newest setup always runs
	// after an older in-flight close/migration has settled and therefore wins.
	const profileSetupQueueRef = useRef<Promise<void>>(Promise.resolve());
	useEffect(() => {
		currentUserIdRef.current = state.userId;
	}, [state.userId]);

	// A dismissal covers the answer it was given for. Signing in, switching
	// account, or the answer going away starts over, so the same answer coming
	// back later is shown again.
	const reportSessionStatus = (status: AccountStatus | null, startOver: boolean) => {
		setSessionStatus(status);
		if (startOver || status === null) {
			setDismissedStatusKey(null);
		}
	};

	const refreshSavedAccounts = async () => {
		try {
			const accounts = await callMethod("list_saved_accounts");
			setSavedAccounts(accounts);
		} catch (error) {
			appLog.warn("[Auth] refreshSavedAccounts failed", asAppError(error) ?? error);
		}
	};

	const checkAuth = async () => {
		try {
			appLog.debug("[Auth] checkAuth: starting");
			dispatch({ type: "SET_LOADING", payload: true });
			const result = await callMethod("auth_state");
			if (result !== null) {
				appLog.info("[Auth] checkAuth: active session found");
				dispatch({ type: "SET_USER", payload: result });
				void refreshSavedAccounts();
			} else {
				appLog.info("[Auth] checkAuth: no active session");
				dispatch({ type: "CLEAR_USER" });
			}
		} catch (error) {
			const appError = asAppError(error);
			if (appError?.kind === "NotInitialized") {
				appLog.warn("[Auth] checkAuth: client NotInitialized, clearing user");
				dispatch({ type: "CLEAR_USER" });
			} else {
				appLog.error("[Auth] checkAuth failed", appError ?? error);
				dispatch({
					type: "SET_ERROR",
					payload: appError?.prettyMessage || i18n.t("auth.errors.check_failed"),
				});
			}
		} finally {
			dispatch({ type: "SET_LOADING", payload: false });
		}
	};

	const login = async (email: string, password: string) => {
		try {
			appLog.info("[Auth] login: attempting email/password login");
			dispatch({ type: "SET_LOADING", payload: true });
			dispatch({ type: "SET_ERROR", payload: null });
			setSignInRefusal(null);

			const result = await callMethod("login", { email, password });
			appLog.info("[Auth] login: succeeded");
			dispatch({ type: "SET_USER", payload: result.profileId });
			reportSessionStatus(restrictionStatus(result.restriction), true);
			void refreshSavedAccounts();
			toast.success(i18n.t("auth.toasts.login_success"));
		} catch (error) {
			const appError = asAppError(error);
			const message = describeLoginError(
				appError,
				i18n.t("auth.errors.login_failed"),
				i18n.t("auth.errors.invalid_credentials"),
			);
			appLog.error("[Auth] login failed", { kind: appError?.kind, message });
			dispatch({ type: "SET_ERROR", payload: message });
			if (appError?.ban) {
				// The refusal gets a screen of its own, which says more than a toast can.
				setSignInRefusal(appError.ban);
			} else {
				toast.error(message);
			}
			throw error;
		} finally {
			dispatch({ type: "SET_LOADING", payload: false });
		}
	};

	const loginWithJwt = async (token: string) => {
		try {
			appLog.info("[Auth] loginWithJwt: attempting token login");
			dispatch({ type: "SET_LOADING", payload: true });
			dispatch({ type: "SET_ERROR", payload: null });
			setSignInRefusal(null);

			const result = await callMethod("login_with_jwt", { token });
			appLog.info("[Auth] loginWithJwt: succeeded");
			dispatch({ type: "SET_USER", payload: result.profileId });
			reportSessionStatus(restrictionStatus(result.restriction), true);
			void refreshSavedAccounts();
			toast.success(i18n.t("auth.toasts.token_login_success"));
		} catch (error) {
			const appError = asAppError(error);
			const message = describeLoginError(
				appError,
				i18n.t("auth.errors.token_login_failed"),
				i18n.t("auth.errors.invalid_token"),
			);
			appLog.error("[Auth] loginWithJwt failed", { kind: appError?.kind, message });
			dispatch({ type: "SET_ERROR", payload: message });
			if (appError?.ban) {
				setSignInRefusal(appError.ban);
			} else {
				toast.error(message);
			}
			throw error;
		} finally {
			dispatch({ type: "SET_LOADING", payload: false });
		}
	};

	const logout = async () => {
		try {
			dispatch({ type: "SET_LOADING", payload: true });
			await callMethod("logout");
			dispatch({ type: "CLEAR_USER" });
			setSignInRefusal(null);
			reportSessionStatus(null, true);
			toast.success(i18n.t("auth.toasts.logged_out"));
		} catch (error) {
			const appError = asAppError(error);
			const message = appError?.prettyMessage || i18n.t("auth.errors.logout_failed");
			toast.error(message);
			throw error;
		} finally {
			dispatch({ type: "SET_LOADING", payload: false });
		}
	};

	// Makes a previously saved account active without re-entering a
	// password — the account-change effect above (watching state.userId)
	// handles pointing the chat db and clearing caches once this resolves.
	const switchAccount = async (profileId: string) => {
		try {
			appLog.info("[Auth] switchAccount: attempting", { profileId });
			dispatch({ type: "SET_LOADING", payload: true });
			dispatch({ type: "SET_ERROR", payload: null });

			const result = await callMethod("switch_account", { profileId });
			appLog.info("[Auth] switchAccount: succeeded");
			dispatch({ type: "SET_USER", payload: result.profileId });
			reportSessionStatus(restrictionStatus(result.restriction), true);
			void refreshSavedAccounts();
			toast.success(i18n.t("auth.toasts.switched_account"));
		} catch (error) {
			const appError = asAppError(error);
			const message = appError?.prettyMessage || i18n.t("auth.errors.switch_failed");
			appLog.error("[Auth] switchAccount failed", { kind: appError?.kind, message });
			dispatch({ type: "SET_ERROR", payload: message });
			toast.error(message);
			throw error;
		} finally {
			dispatch({ type: "SET_LOADING", payload: false });
		}
	};

	const removeSavedAccount = async (profileId: string) => {
		try {
			await callMethod("remove_saved_account", { profileId });
			setSavedAccounts((accounts) => accounts.filter((account) => account.profileId !== profileId));
		} catch (error) {
			const appError = asAppError(error);
			const message = appError?.prettyMessage || i18n.t("auth.errors.remove_failed");
			appLog.error("[Auth] removeSavedAccount failed", { kind: appError?.kind, message });
			toast.error(message);
			throw error;
		}
	};

	// Check auth on mount
	useEffect(() => {
		checkAuth();
	}, []);

	// The account's standing, as the Rust side knows it: a session renewal
	// Grindr refused, a restriction written into the session token, a token
	// sign-in that has run out. Listening comes first and asking second, so a
	// change that lands between the two is heard, where the other order could
	// miss it.
	useEffect(() => {
		let cancelled = false;
		let heardChange = false;
		let stopListening: (() => void) | undefined;

		const apply = (payload: unknown) => {
			const status = parseAccountStatus(payload);
			setSessionStatus(status);
			if (status === null) {
				setDismissedStatusKey(null);
			}
		};

		void (async () => {
			try {
				const stop = await listen<unknown>(ACCOUNT_STATUS_EVENT, (event) => {
					heardChange = true;
					apply(event.payload);
				});
				if (cancelled) {
					stop();
					return;
				}
				stopListening = stop;

				const current = await callMethod("account_status");
				// A change heard while that answer was on its way is the newer one.
				if (!cancelled && !heardChange) {
					apply(current);
				}
			} catch (error) {
				appLog.warn("[Auth] account status unavailable", asAppError(error) ?? error);
			}
		})();

		return () => {
			cancelled = true;
			stopListening?.();
		};
	}, [callMethod, asAppError]);

	// Points the chat db at the active account's own file, and on an actual
	// account change (not the initial boot resolution) clears every other
	// account-scoped cache — otherwise the previous account's chats/profile
	// data/blocked list would still show through until something happened
	// to overwrite them.
	useEffect(() => {
		if (state.isLoading) {
			return;
		}

		const profileId = state.userId;
		const previousUserId = previousUserIdRef.current;
		previousUserIdRef.current = profileId;

		if (
			previousUserId === profileId &&
			completedProfileSetupRef.current === profileId &&
			state.settingsReady
		) {
			return;
		}
		if (previousUserId != null && previousUserId !== profileId) {
			// Stop old-profile cloud work immediately. The serialized setup task
			// below then drains and closes it before chat/contact stores are swapped.
			invalidateGoogleDriveSyncProfile(previousUserId);
		}

		const isActualAccountChange = previousUserId !== undefined && previousUserId != null;
		if (isActualAccountChange) {
			clearAllCaches();
			clearChatSearchIndex();
			queryClient.clear();
		}

		dispatch({ type: "SET_SETTINGS_READY", payload: false });
		completedProfileSetupRef.current = undefined;
		const setupGeneration = ++profileSetupGenerationRef.current;
		const isCurrentSetup = () =>
			profileSetupGenerationRef.current === setupGeneration &&
			currentUserIdRef.current === profileId;
		const activeStoresMatch = () =>
			getActiveChatDbUser() === profileId &&
			getActiveChatContactIndexUser() === profileId &&
			getActiveInterestViewsAccount() === getInterestViewsAccountForUser(profileId);

		// Viewer history is account-scoped for the same reason chats are: its
		// own IndexedDB per account, so a profile that viewed the previous
		// account can't surface as one of this account's viewers. Repointed
		// here rather than inside the async chain below because the protected
		// layout remounts as soon as loading clears — the view scanner and the
		// Interest query can both be fetching before `setActiveChatDbUser`
		// resolves, and every one of those reads/writes has to already be
		// aimed at the new account. The call itself switches synchronously;
		// only the one-time legacy adoption is async, and store operations
		// await that internally.
		const interestViewsReady = setActiveInterestViewsUser(profileId);

		const setupTask = profileSetupQueueRef.current.catch(() => undefined).then(async () => {
			await closeGoogleDriveSyncProfilesExcept(profileId);
			if (!isCurrentSetup()) return;
			await Promise.all([
				setActiveChatDbUser(profileId),
				setActiveChatContactIndexUser(profileId),
				interestViewsReady,
			]);
			if (!isCurrentSetup() || !activeStoresMatch()) return;
			if (profileId != null) {
				await migrateLegacySettingsIfNeeded(profileId);
				if (!isCurrentSetup() || !activeStoresMatch()) return;
			}

			// Fire-and-forget: throttled background sync of the chat list and
			// each changed conversation's latest messages, run on every profile
			// load. Deliberately started only *after* setActiveChatDbUser has
			// fully resolved above — that call both migrates the legacy db file
			// (a rename) and opens the actual per-profile connection, so kicking
			// the sync off any earlier races it against that migration/open and
			// can leave it stuck waiting on a half-migrated db. Kicked off here
			// rather than after the cache loads below on purpose: it has no
			// dependency on automation/media/privacy/seen settings, and
			// chaining it behind them would mean any slowness (or a stuck
			// chatDb connection) in loading those silently delays the sync
			// starting too, even though the two are otherwise unrelated. Not
			// awaited itself, so it never gates the UI. Only the first-ever
			// run per profile walks the whole inbox — every run after that
			// stops as soon as it hits unchanged conversations (see
			// inboxSync.ts).
			if (profileId != null) {
				const userId = profileId;
				void runInboxSync(apiFunctions, userId, () => currentUserIdRef.current === userId);
				// Fire-and-forget: pulls this account's saved phrases from Grindr and
				// unions them into the local list. Guarded by the same "still the
				// active profile" check as the inbox sync above, since chatDb (and so
				// where the merged list gets written) already points at whichever
				// profile is active by the time this resolves.
				void syncSavedPhrasesFromServer(
					apiFunctions.getSavedPhrases,
					() => currentUserIdRef.current === userId,
				);
				// Fire-and-forget: reconciles taps received while the app was closed
				// against the "tap_received" automation trigger — guarded the same
				// way, and safe to start before the automation cache below finishes
				// loading (runAutomationRulesForSender no-ops until it has).
				void runTapsAutomationSync(
					apiFunctions,
					() => currentUserIdRef.current === userId,
					userId,
				);
			}

			await Promise.all([
				loadAutomationCache(),
				loadAutomationRulesCache(),
				loadMediaSettingsCache(),
				loadPrivacyCache(),
				loadSeenCache(),
				loadStatsSettingsCache(),
			]);
			if (!isCurrentSetup() || !activeStoresMatch()) return;
			completedProfileSetupRef.current = profileId;
			dispatch({ type: "SET_SETTINGS_READY", payload: true });
		});
		profileSetupQueueRef.current = setupTask.then(
			() => undefined,
			() => undefined,
		);
		void setupTask.catch((error) => {
			if (isCurrentSetup()) {
				appLog.error("[Auth] account-scoped store setup failed", error);
			}
		});

		return () => {
			if (profileSetupGenerationRef.current === setupGeneration) {
				profileSetupGenerationRef.current += 1;
			}
		};
	}, [state.userId, state.isLoading, state.settingsReady, queryClient, apiFunctions]);


	// Receive Android native FCM token and sync it to Grindr once authenticated.
	useEffect(() => {
		const onFcmToken = (event: Event) => {
			const token =
				typeof (event as CustomEvent).detail?.token === "string"
					? (event as CustomEvent<{ token: string }>).detail.token
					: null;

			if (!token) {
				appLog.debug("[PUSH_SYNC] Received fg:fcm-token event without token payload");
				return;
			}

			appLog.debug(`[PUSH_SYNC] Received native FCM token event (len=${token.length})`);

			window.localStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);

			if (!state.userId || state.isLoading) {
				appLog.debug("[PUSH_SYNC] Token cached; waiting for authenticated session before sync");
				return;
			}

			appLog.debug("[PUSH_SYNC] Syncing FCM token to Grindr");
			void callMethod("sync_push_token", { token }).catch((error) => {
				const appError = asAppError(error);
				appLog.warn(
					"[PUSH_SYNC] Failed to sync push token",
					appError?.prettyMessage || error,
				);
			}).then(() => {
				appLog.debug("[PUSH_SYNC] Push token sync succeeded");
			});
		};

		window.addEventListener("fg:fcm-token", onFcmToken as EventListener);
		return () => {
			window.removeEventListener("fg:fcm-token", onFcmToken as EventListener);
		};
	}, [callMethod, asAppError, state.userId, state.isLoading]);

	// Retry sync after login if we already captured a token from native code.
	useEffect(() => {
		if (state.isLoading || !state.userId) {
			return;
		}

		let cancelled = false;

		const trySync = () => {
			if (cancelled) {
				return;
			}

			const token = window.localStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
			const fallbackToken =
				typeof (window as Window & { __FG_FCM_TOKEN?: unknown }).__FG_FCM_TOKEN ===
				"string"
					? ((window as Window & { __FG_FCM_TOKEN?: string }).__FG_FCM_TOKEN ?? null)
					: null;
			const effectiveToken = token || fallbackToken;

			if (!effectiveToken) {
				appLog.debug("[PUSH_SYNC] No cached token found while logged in");
				return;
			}

			if (!token && fallbackToken) {
				window.localStorage.setItem(PUSH_TOKEN_STORAGE_KEY, fallbackToken);
			}

			// Keyed by token *and* account: the device's FCM token doesn't change
			// when switching between saved accounts, but the backend association
			// is per-account, so a stale "already synced" marker from the
			// previous account would otherwise skip re-syncing for the new one.
			const syncMarker = `${effectiveToken}::${state.userId}`;
			const lastSyncedMarker = window.localStorage.getItem(PUSH_TOKEN_SYNCED_STORAGE_KEY);
			if (lastSyncedMarker === syncMarker) {
				return;
			}

			appLog.debug("[PUSH_SYNC] Syncing cached push token (retry loop)");
			void callMethod("sync_push_token", { token: effectiveToken })
				.then(() => {
					window.localStorage.setItem(PUSH_TOKEN_SYNCED_STORAGE_KEY, syncMarker);
					appLog.debug("[PUSH_SYNC] Cached push token sync succeeded");
				})
				.catch((error) => {
					const appError = asAppError(error);
					appLog.warn(
						"[PUSH_SYNC] Failed to sync push token in retry loop",
						appError?.prettyMessage || error,
					);
				});
		};

		trySync();
		const interval = window.setInterval(trySync, 5000);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [callMethod, asAppError, state.userId, state.isLoading]);

	// Persist current user id so non-React services can read the active account
	// synchronously (see interestViewsStore, chatService).
	useEffect(() => {
		if (state.isLoading) {
			return;
		}

		if (state.userId) {
			window.localStorage.setItem(AUTH_USER_ID_STORAGE_KEY, String(state.userId));
		} else {
			window.localStorage.removeItem(AUTH_USER_ID_STORAGE_KEY);
		}
	}, [state.userId, state.isLoading]);

	const accountNotice: AccountNotice | null = signInRefusal
		? { about: "signIn", status: { kind: "banned", info: signInRefusal } }
		: sessionStatus !== null &&
			  state.userId !== null &&
			  accountStatusKey(sessionStatus) !== dismissedStatusKey
			? { about: "session", status: sessionStatus }
			: null;

	const dismissAccountNotice = () => {
		if (signInRefusal) {
			setSignInRefusal(null);
		} else if (sessionStatus) {
			setDismissedStatusKey(accountStatusKey(sessionStatus));
		}
	};

	const value: AuthContextType = {
		...state,
		accountNotice,
		dismissAccountNotice,
		login,
		loginWithJwt,
		logout,
		checkAuth,
		savedAccounts,
		switchAccount,
		removeSavedAccount,
	};

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
