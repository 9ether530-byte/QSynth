/**
 * What the workbench does when things go wrong, which is the part that matters.
 *
 * A failed verification is not an error state to be apologised for — it is the product
 * working. These tests pin the two behaviours that make it useful rather than opaque: the
 * page follows the failed job and shows which check failed with its counterexample, and it
 * reports the export gate's refusal as a refusal instead of an empty panel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  const { apiStub } = await import('./stub');
  return { ...actual, api: apiStub };
});

const { apiStub, renderAt, signIn } = await import('./harness');
const { ApiError } = await import('../src/lib/api');
const fixtures = await import('./fixtures');

const failedDetail = {
  ...fixtures.compileDetail,
  job: { ...fixtures.jobSummary, status: 'failed' as const, passed: false },
  verification: {
    passed: false,
    checks: [
      { id: 'type_shape' as const, title: 'Type and shape', status: 'passed' as const, summary: '2 inputs, 1 output.', durationMs: 1 },
      {
        id: 'simulation_equivalence' as const,
        title: 'Simulation equivalence',
        status: 'failed' as const,
        summary: 'The circuit disagrees with the specification on 1 assignment.',
        durationMs: 2,
        coverage: { mode: 'exhaustive' as const, checked: 4, space: 4, dontCare: 0 },
        counterexample: { inputs: { a: 1, b: 1 }, expected: { out: 1 }, observed: { out: 0 } },
      },
    ],
    checksReached: ['type_shape' as const, 'simulation_equivalence' as const],
    stoppedAt: 'simulation_equivalence' as const,
    optimization: null,
  },
};

describe('the workbench', () => {
  beforeEach(() => {
    signIn();
    apiStub.job.mockResolvedValue(fixtures.compileDetail);
  });

  it('follows a failed compile to its job and shows the failing check', async () => {
    apiStub.job.mockResolvedValue(failedDetail);
    apiStub.compile.mockRejectedValue(
      new ApiError(422, 'VERIFICATION_FAILED', 'The circuit disagrees with the specification on 1 assignment.', 'Inspect the failing check.', {
        jobId: 'j1',
        check: { id: 'simulation_equivalence' },
      }),
    );

    renderAt('/p/p1');
    await screen.findByRole('heading', { name: 'Oracles' });
    fireEvent.click(screen.getByRole('button', { name: 'Compile and verify' }));

    // The failing check, its counterexample, and the fact that four checks never ran.
    await screen.findByText('The circuit disagrees with the specification on 1 assignment.', { selector: 'p' });
    expect(screen.getByText(/"a":1/)).toBeTruthy();
    expect(screen.getAllByText('not reached')).toHaveLength(4);
  });

  it('explains the export gate rather than showing an empty diagram', async () => {
    apiStub.job.mockResolvedValue(failedDetail);
    apiStub.artifact.mockRejectedValue(
      new ApiError(
        403,
        'VERIFICATION_REQUIRED',
        'This artifact has not passed verification and cannot be exported.',
        'Fix the failing check and compile again.',
        {},
      ),
    );
    apiStub.compile.mockRejectedValue(
      new ApiError(422, 'VERIFICATION_FAILED', 'Verification did not pass.', 'Inspect the failing check.', { jobId: 'j1' }),
    );

    renderAt('/p/p1');
    await screen.findByRole('heading', { name: 'Oracles' });
    fireEvent.click(screen.getByRole('button', { name: 'Compile and verify' }));

    await waitFor(() =>
      expect(screen.getByText('This artifact has not passed verification and cannot be exported.')).toBeTruthy(),
    );
    expect(screen.getByText(/behind the same export gate as the API/)).toBeTruthy();
  });

  it('puts a compiler error on its source line', async () => {
    apiStub.compile.mockRejectedValue(
      new ApiError(422, 'UNSUPPORTED_CONSTRUCT', 'while loops are not supported.', 'Use a for loop over range().', {
        span: { line: 2, column: 5 },
      }),
    );

    renderAt('/p/p1');
    await screen.findByRole('heading', { name: 'Oracles' });
    fireEvent.click(screen.getByRole('button', { name: 'Compile and verify' }));

    // The code, the hint, and the position — all three, because the code is what a user
    // searches for and the position is what they act on.
    await screen.findByText('while loops are not supported.');
    expect(screen.getByText('Use a for loop over range().')).toBeTruthy();
    expect(screen.getByText(/line 2, column 5/)).toBeTruthy();
  });

  it('shows a verified compile with its coverage', async () => {
    apiStub.compile.mockResolvedValue({ job: fixtures.jobSummary } as never);

    renderAt('/p/p1');
    await screen.findByRole('heading', { name: 'Oracles' });
    fireEvent.click(screen.getByRole('button', { name: 'Compile and verify' }));

    await waitFor(() => expect(screen.getAllByText('verified').length).toBeGreaterThan(0));
    // The check's own coverage line. The optimizer's guard reports its coverage in the
    // same words a row below, which is why this is pinned to the paragraph.
    expect(screen.getByText(/exhaustive · 4\/4 assignments/, { selector: 'p' })).toBeTruthy();
  });
});
