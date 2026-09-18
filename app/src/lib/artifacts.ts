/**
 * Reading artifacts back out of the API.
 *
 * The diagram and the trace console are drawn from the stored `reversible_ir` and `trace`
 * artifacts rather than from the compile response, which means the workbench reads them
 * through the same export gate as `curl` does. A circuit that failed verification is
 * refused here exactly as it is refused there — the UI has no privileged path, and
 * anything it can show, a reviewer can fetch and check independently.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { ArtifactRef, ReversibleCircuit, TraceEntry } from './types';

function useArtifactJson<T>(ref: ArtifactRef | undefined) {
  return useQuery({
    queryKey: ['artifact', ref?.id],
    enabled: ref !== undefined,
    // Artifacts are content-addressed and immutable, so there is nothing to revalidate.
    staleTime: Infinity,
    queryFn: async (): Promise<T> => {
      const response = await api.artifact(ref!.id);
      return JSON.parse(response.content) as T;
    },
  });
}

export function find(artifacts: readonly ArtifactRef[], kind: ArtifactRef['kind']): ArtifactRef | undefined {
  return artifacts.find((artifact) => artifact.kind === kind);
}

export function useCircuit(artifacts: readonly ArtifactRef[]) {
  return useArtifactJson<ReversibleCircuit>(find(artifacts, 'reversible_ir'));
}

export function useTrace(artifacts: readonly ArtifactRef[]) {
  return useArtifactJson<readonly TraceEntry[]>(find(artifacts, 'trace'));
}

export function useQasm(artifacts: readonly ArtifactRef[]) {
  const ref = find(artifacts, 'qasm3');
  return useQuery({
    queryKey: ['artifact', ref?.id],
    enabled: ref !== undefined,
    staleTime: Infinity,
    queryFn: () => api.artifact(ref!.id),
  });
}
