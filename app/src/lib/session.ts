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
import { setActiveOrg, setAuthToken } from './api';
import type { Principal, Role, SessionResponse } from './types';

const TOKEN_KEY = 'qsynth.token';
const USER_KEY = 'qsynth.user';
const ORG_KEY = 'qsynth.org';

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
  /**
   * The org every request names, kept separately from `organization` because it is known
   * before the server has confirmed anything about it — on a reload it is the only thing
   * that lets the first `/v1/auth/me` succeed for a multi-org user.
   */
  activeOrgId: string | null;
  /** Every organization this user belongs to, as last reported by the API. */
  organizations: readonly SessionOrg[];
  permissions: readonly string[];
  /** True until the stored token has been checked against the API on first load. */
  loading: boolean;
  signIn: (response: SessionResponse) => void;
  adopt: (principal: Principal) => void;
  /** Null clears the choice, which asks the API to resolve it (or to name the options). */
  chooseOrg: (orgId: string | null) => void;
  signOut: () => void;
  can: (permission: string) => boolean;
}

function readStored(): { token: string | null; user: SessionUser | null; orgId: string | null } {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(USER_KEY);
    return {
      token,
      user: raw ? (JSON.parse(raw) as SessionUser) : null,
      orgId: localStorage.getItem(ORG_KEY),
    };
  } catch {
    // Private-mode browsers throw on storage access. Not being able to remember the
    // session is a worse experience, not a broken one.
    return { token: null, user: null, orgId: null };
  }
}

const stored = readStored();
setAuthToken(stored.token);
setActiveOrg(stored.orgId);

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

/** Set the org for the transport and remember it across reloads, in that order. */
function activate(orgId: string | null): void {
  setActiveOrg(orgId);
  try {
    if (orgId) localStorage.setItem(ORG_KEY, orgId);
    else localStorage.removeItem(ORG_KEY);
  } catch {
    /* see readStored */
  }
}

export const useSession = create<SessionState>((set, get) => ({
  token: stored.token,
  user: stored.user,
  organization: null,
  activeOrgId: stored.orgId,
  organizations: [],
  permissions: [],
  loading: stored.token !== null,

  signIn: (response) => {
    const memberships = (response.organizations ?? (response.organization ? [response.organization] : [])).map((o) => ({
      id: o.id,
      name: o.name,
      role: o.role,
    }));
    // Resolve the org the same way the API would, and refuse to guess for the same
    // reason: the last one this browser used if it is still a membership, the only one
    // when there is only one, and otherwise nothing — the user is asked.
    const remembered = memberships.find((o) => o.id === get().activeOrgId);
    const org = remembered ?? (memberships.length === 1 ? memberships[0]! : null);
    setAuthToken(response.token);
    persist(response.token, response.user);
    activate(org?.id ?? null);
    set({
      token: response.token,
      user: response.user,
      organization: org ?? null,
      activeOrgId: org?.id ?? null,
      organizations: memberships,
      // Filled in by `adopt` once /v1/auth/me answers; until then the interface shows
      // only what everyone can do rather than guessing from the role.
      permissions: [],
      loading: true,
    });
  },

  adopt: (principal) => {
    const active = principal.activeOrganization;
    const known = (principal.organizations ?? []).map((o) => ({ id: o.id, name: o.name, role: o.role }));
    const match = known.find((o) => o.id === active?.id);
    // The server has now said which org this request ran in. For a single-membership
    // user that is the first time the app learns the id at all, so record it: the next
    // reload then names it explicitly instead of relying on the API's default again.
    if (active) activate(active.id);
    set({
      user: principal.user ?? get().user,
      organization: active ? { id: active.id, name: match?.name ?? 'Organization', role: active.role } : null,
      activeOrgId: active?.id ?? get().activeOrgId,
      organizations: known.length > 0 ? known : get().organizations,
      permissions: principal.permissions ?? [],
      loading: false,
    });
    if (principal.user) persist(get().token, principal.user);
  },

  chooseOrg: (orgId) => {
    activate(orgId);
    const known = orgId === null ? null : (get().organizations.find((o) => o.id === orgId) ?? null);
    // `loading` goes back up because nothing about the new org is confirmed yet: the
    // permissions still in the store belong to the org being left.
    set({ activeOrgId: orgId, organization: known, permissions: [], loading: true });
  },

  signOut: () => {
    setAuthToken(null);
    persist(null, null);
    activate(null);
    set({
      token: null,
      user: null,
      organization: null,
      activeOrgId: null,
      organizations: [],
      permissions: [],
      loading: false,
    });
  },

  can: (permission) => get().permissions.includes(permission),
}));

/** Read a permission without subscribing the caller to the whole store. */
export const usePermission = (permission: string): boolean =>
  useSession((s) => s.permissions.includes(permission));
