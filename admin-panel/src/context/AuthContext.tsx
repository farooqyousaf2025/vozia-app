// ---------------------------------------------------------------------------
// Auth state: token + admin identity persisted in localStorage (via lib/api),
// exposed through context. The API layer clears the session itself on 401;
// `syncFromStorage` lets the UI re-read that state.
// ---------------------------------------------------------------------------
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  getStoredAdmin,
  getToken,
  setStoredAdmin,
  setToken,
} from '../lib/api';
import type { AdminIdentity } from '../types';

interface AuthContextValue {
  admin: AdminIdentity | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** Navigation only — the server decides access again on every request. */
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminIdentity | null>(() => {
    return getToken() ? getStoredAdmin() : null;
  });

  // A twelve-hour token outlives a role change, so the panel re-reads the operator from the
  // database when it opens. Nothing here grants anything.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    api
      .whoami()
      .then((result) => {
        if (cancelled) return;
        const identity: AdminIdentity = { ...result.admin, permissions: result.permissions ?? [] };
        setStoredAdmin(identity);
        setAdmin(identity);
      })
      .catch(() => {
        /* a failed refresh leaves the cached identity in place; routes still check server-side */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const response = await api.login(username, password);
    setToken(response.token);
    // The permission list is navigation advice from the server. It is never the check: each
    // route re-reads the operator's role from the database on every call.
    const identity: AdminIdentity = { ...response.admin, permissions: response.permissions ?? [] };
    setStoredAdmin(identity);
    setAdmin(identity);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setStoredAdmin(null);
    setAdmin(null);
  }, []);

  const can = useCallback(
    (permission: string) => (admin?.permissions ?? []).includes(permission),
    [admin],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      admin,
      isAuthenticated: Boolean(admin && getToken()),
      login,
      logout,
      can,
    }),
    [admin, login, logout, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}
