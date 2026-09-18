/**
 * jsdom does not implement layout, and it is missing a handful of APIs that CodeMirror and
 * TanStack Query expect to exist. Stubbing them here keeps the stubs in one place rather
 * than scattered through the tests.
 *
 * Note what is *not* stubbed: `fetch`. Every test mocks `lib/api`, so a test that reaches
 * the network fails loudly instead of silently hitting the deployed API.
 */
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// CodeMirror measures ranges on mount; jsdom returns nothing useful, which is fine as long
// as the call does not throw.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});
