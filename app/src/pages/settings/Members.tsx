/**
 * Members and roles.
 *
 * The role column states what each role can do, because "developer" and "admin" are not
 * self-explanatory and the person changing someone's role is deciding whether they can
 * issue API keys. Saying so at the point of the decision beats documenting it elsewhere.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { usePermission, useSession } from '../../lib/session';
import type { Role } from '../../lib/types';
import { Panel, Empty } from '../../components/Panel';
import { ErrorNotice } from '../../components/ErrorNotice';

const ROLES: readonly { value: Role; summary: string }[] = [
  { value: 'viewer', summary: 'Reads projects, compiles, and verified artifacts.' },
  { value: 'developer', summary: 'Also creates projects and runs compiles.' },
  { value: 'admin', summary: 'Also manages members, API keys, and the audit log.' },
  { value: 'owner', summary: 'Also changes organization settings.' },
];

export default function MembersPage() {
  const queryClient = useQueryClient();
  const canWrite = usePermission('member:write');
  const me = useSession((s) => s.user);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('developer');

  const members = useQuery({ queryKey: ['members'], queryFn: api.members });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['members'] });

  const add = useMutation({
    mutationFn: () => api.addMember({ email, role }),
    onSuccess: () => {
      setEmail('');
      invalidate();
    },
  });
  const change = useMutation({
    mutationFn: (input: { userId: string; role: Role }) => api.changeRole(input.userId, input.role),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (userId: string) => api.removeMember(userId), onSuccess: invalidate });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };

  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <h1 className="font-display text-xl font-semibold tracking-tight">Members</h1>
      <p className="mt-1 text-sm text-ink-dim">
        Roles are enforced by the API on every request; this page only decides what to show.
      </p>

      <div className="mt-6 flex flex-col gap-6">
        <Panel title="Members of this organization">
          {members.isPending ? (
            <Empty>Loading…</Empty>
          ) : members.error ? (
            <div className="p-3">
              <ErrorNotice error={members.error} />
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Members, their role, and when they joined</caption>
              <thead>
                <tr className="border-b border-rule text-left">
                  <th scope="col" className="qs-label px-3 py-2">
                    Name
                  </th>
                  <th scope="col" className="qs-label px-3 py-2">
                    Email
                  </th>
                  <th scope="col" className="qs-label px-3 py-2">
                    Role
                  </th>
                  <th scope="col" className="qs-label px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.data?.members.map((member) => (
                  <tr key={member.userId} className="border-b border-rule/60 last:border-b-0">
                    <td className="px-3 py-2">{member.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-dim">{member.email}</td>
                    <td className="px-3 py-2">
                      {canWrite && member.userId !== me?.id ? (
                        <>
                          <label className="sr-only" htmlFor={`role-${member.userId}`}>
                            Role for {member.name}
                          </label>
                          <select
                            id={`role-${member.userId}`}
                            className="qs-input py-0.5 text-xs"
                            value={member.role}
                            onChange={(event) =>
                              change.mutate({ userId: member.userId, role: event.target.value as Role })
                            }
                          >
                            {ROLES.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.value}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <span className="font-mono text-xs">{member.role}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canWrite && member.userId !== me?.id ? (
                        <button type="button" className="qs-btn" onClick={() => remove.mutate(member.userId)}>
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {change.error ? (
            <div className="p-3">
              <ErrorNotice error={change.error} />
            </div>
          ) : null}
          {remove.error ? (
            <div className="p-3">
              <ErrorNotice error={remove.error} />
            </div>
          ) : null}
        </Panel>

        {canWrite ? (
          <Panel title="Add a member">
            <form className="flex flex-col gap-3 p-3" onSubmit={submit}>
              <div className="flex flex-col gap-1">
                <label className="qs-label" htmlFor="member-email">
                  Email of an existing user
                </label>
                <input
                  id="member-email"
                  type="email"
                  className="qs-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <fieldset className="flex flex-col gap-2 border border-rule p-3">
                <legend className="qs-label px-1">Role</legend>
                {ROLES.map((option) => (
                  <label key={option.value} className="flex items-baseline gap-2 text-sm">
                    <input
                      type="radio"
                      name="role"
                      value={option.value}
                      checked={role === option.value}
                      onChange={() => setRole(option.value)}
                    />
                    <span>
                      <span className="font-mono text-xs">{option.value}</span>{' '}
                      <span className="text-ink-dim">{option.summary}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {add.error ? <ErrorNotice error={add.error} /> : null}
              <button type="submit" className="qs-btn qs-btn-primary" disabled={add.isPending}>
                {add.isPending ? 'Adding…' : 'Add member'}
              </button>
            </form>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
