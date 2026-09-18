/**
 * Session state: the token, who it belongs to, and what that person may do.
 *
 * The token is kept in `localStorage` so a reload does not log the user out. That is a
 * deliberate trade: `localStorage` is readable by any script on the origin, so it is
 * only defensible because the API treats the token as a bearer credential with a server-
 * side `sessions` row that can be revoked, and because the app ships no third-party
 * scripts. An httpOnly cookie would be stronger, but the API is on a different origin
 * than the site, which makes cookies a CORS and SameSite problem rather than a solution.
 *
 * `permissions` is a *hint for the interface*, never a gate. Every permission is enforced
 * by the API; what this does is avoid showing a button whose only outcome would be a 403.
 */
import { create } from 'zustand';
import { setAuthToken } from './api';
import type { Principal, Role, SessionResponse } from './types';

const TOKEN_KEY = 'qsynth.token';
const USER_KEY = 'qsynth.user';

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface SessionOrg {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
}

interface SessionState {
  token: string | null;
  user: SessionUser | null;
  organization: SessionOrg | null;
  permissions: readonly string[];
  /** True until the stored token has been checked against the API on first load. */
  loading: boolean;
  signIn: (response: SessionResponse) => void;
  adopt: (principal: Principal) => void;
  signOut: () => void;
  can: (permission: string) => boolean;
}

function readStored(): { token: string | null; user: SessionUser | null } {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(USER_KEY);
    return { token, user: raw ? (JSON.parse(raw) as SessionUser) : null };
  } catch {
    // Private-mode browsers throw on storage access. Not being able to remember the
    // session is a worse experience, not a broken one.
    return { token: null, user: null };
  }
}

const stored = readStored();
setAuthToken(stored.token);

function persist(token: string | null, user: SessionUser | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* see readStored */
  }
}

export const useSession = create<SessionState>((set, get) => ({
  token: stored.token,
  user: stored.user,
  organization: null,
  permissions: [],
  loading: stored.token !== null,

  signIn: (response) => {
    const org = response.organization ?? response.organizations?.[0] ?? null;
    setAuthToken(response.token);
    persist(response.token, response.user);
    set({
      token: response.token,
      user: response.user,
      organization: org ? { id: org.id, name: org.name, role: org.role } : null,
      // Filled in by `adopt` once /v1/auth/me answers; until then the interface shows
      // only what everyone can do rather than guessing from the role.
      permissions: [],
      loading: true,
    });
  },

  adopt: (principal) => {
    const active = principal.activeOrganization;
    const match = principal.organizations?.find((o) => o.id === active?.id);
    set({
      user: principal.user ?? get().user,
      organization: active ? { id: active.id, name: match?.name ?? 'Organization', role: active.role } : null,
      permissions: principal.permissions ?? [],
      loading: false,
    });
    if (principal.user) persist(get().token, principal.user);
  },

  signOut: () => {
    setAuthToken(null);
    persist(null, null);
    set({ token: null, user: null, organization: null, permissions: [], loading: false });
  },

  can: (permission) => get().permissions.includes(permission),
}));

/** Read a permission without subscribing the caller to the whole store. */
export const usePermission = (permission: string): boolean =>
  useSession((s) => s.permissions.includes(permission));
