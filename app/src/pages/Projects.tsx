/**
 * The project list, and the one form that creates a project.
 *
 * The "New project" form is only rendered when the session carries `project:write`. That
 * is a courtesy — the API refuses regardless — but showing a button whose only possible
 * outcome is a 403 is worse than not showing it.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { usePermission } from '../lib/session';
import { Panel, Empty } from '../components/Panel';
import { ErrorNotice } from '../components/ErrorNotice';

export default function ProjectsPage() {
  const queryClient = useQueryClient();
  const canWrite = usePermission('project:write');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  const create = useMutation({
    mutationFn: () => api.createProject({ name, description }),
    onSuccess: () => {
      setName('');
      setDescription('');
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <h1 className="font-display text-xl font-semibold tracking-tight">Projects</h1>
      <p className="mt-1 text-sm text-ink-dim">
        A project holds specifications, their compile jobs, and the verified artifacts those jobs produced.
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-[2fr_1fr]">
        <Panel title="All projects">
          {projects.isPending ? (
            <Empty>Loading…</Empty>
          ) : projects.error ? (
            <div className="p-3">
              <ErrorNotice error={projects.error} />
            </div>
          ) : projects.data && projects.data.projects.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {projects.data.projects.map((project) => (
                <li key={project.id} className="border-b border-rule last:border-b-0">
                  <Link
                    to={`/p/${project.id}`}
                    className="flex items-baseline justify-between gap-4 px-3 py-3 no-underline hover:bg-raised"
                  >
                    <span>
                      <span className="text-ink">{project.name}</span>
                      {project.description ? (
                        <span className="ml-2 text-sm text-ink-dim">{project.description}</span>
                      ) : null}
                    </span>
                    <span className="font-mono text-xs text-ink-faint">
                      {new Date(project.updatedAt).toISOString().slice(0, 10)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No projects yet.</Empty>
          )}
        </Panel>

        {canWrite ? (
          <Panel title="New project">
            <form className="flex flex-col gap-3 p-3" onSubmit={submit}>
              <div className="flex flex-col gap-1">
                <label className="qs-label" htmlFor="project-name">
                  Name
                </label>
                <input
                  id="project-name"
                  className="qs-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="qs-label" htmlFor="project-description">
                  Description
                </label>
                <input
                  id="project-description"
                  className="qs-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              {create.error ? <ErrorNotice error={create.error} /> : null}
              <button type="submit" className="qs-btn qs-btn-primary" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create project'}
              </button>
            </form>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
