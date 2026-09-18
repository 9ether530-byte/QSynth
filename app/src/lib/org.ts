/**
 * Switching organizations.
 *
 * The one rule: **every cached answer belongs to the organization it was fetched under.**
 * Projects, jobs, members, keys, and the audit log are all org-scoped, and TanStack Query
 * would happily re-render the previous tenant's list while the new request is in flight.
 * That is a cross-tenant disclosure in the interface even though the API behaved — so the
 * cache is cleared before the org changes, not after, and this hook is the only sanctioned
 * way to change it.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from './api';
import { useSession } from './session';
import type { Role } from './types';

export interface OrgOption {
  readonly id: string;
  readonly name: string;
  readonly role?: Role;
}

const ROLES: readonly string[] = ['owner', 'admin', 'developer', 'viewer'];

/**
 * The organizations a `NO_ORG_CONTEXT` refusal offers.
 *
 * Tolerant of two shapes on purpose. The refusal now carries `{id, name, role}` objects,
 * but an older API — including, for a few minutes, the one this build is deployed
 * alongside — sends bare id strings. A chooser listing truncated uuids is a poor screen;
 * a chooser that renders nothing at all is a dead end, and that is the difference here.
 */
export function organizationsFromError(error: unknown): OrgOption[] {
  if (!(error instanceof ApiError)) return [];
  const raw = error.details['organizations'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): OrgOption[] => {
    if (typeof entry === 'string') return [{ id: entry, name: `Organization ${entry.slice(0, 8)}` }];
    if (!entry || typeof entry !== 'object') return [];
    const { id, name, role } = entry as { id?: unknown; name?: unknown; role?: unknown };
    if (typeof id !== 'string') return [];
    return [
      {
        id,
        name: typeof name === 'string' && name.length > 0 ? name : `Organization ${id.slice(0, 8)}`,
        ...(typeof role === 'string' && ROLES.includes(role) ? { role: role as Role } : {}),
      },
    ];
  });
}

export function useChooseOrg(): (orgId: string | null) => void {
  const chooseOrg = useSession((s) => s.chooseOrg);
  const queryClient = useQueryClient();
  return useCallback(
    (orgId: string | null) => {
      if (useSession.getState().activeOrgId === orgId) return;
      queryClient.clear();
      chooseOrg(orgId);
    },
    [chooseOrg, queryClient],
  );
}
