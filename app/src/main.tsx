/**
 * The entry point. Three providers and nothing else.
 *
 * `basename="/app"` matches Vite's `base` and the `spa` rewrite in `openkbs.json`: the
 * landing page owns `/`, the workbench owns everything under `/app`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ApiError } from './lib/api';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401/403/404 will not become a 200 by asking again, and retrying a rejected
      // compile would burn the user's rate limit for nothing.
      retry: (attempt, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return attempt < 2;
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/app">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
