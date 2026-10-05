/**
 * useToast — the app's single toast vocabulary, wrapping vue-sonner.
 *
 * Why this exists (don't inline useSonner in components):
 * 1. One place for timing policy: brief successes, lingering errors.
 * 2. A reliably mockable seam for tests (it's a project composable, so
 *    mockNuxtImport intercepts it — unlike vue-sonner's own auto-import).
 * 3. One place to add defaults later (actions, ids, dedupe).
 */
export function useToast() {
  return {
    success: (title: string, description?: string) =>
      useSonner.success(title, { description, duration: 4000 }),
    error: (title: string, description?: string) =>
      useSonner.error(title, { description, duration: 8000 }),
    warning: (title: string, description?: string) =>
      useSonner.warning(title, { description, duration: 6000 }),
    info: (title: string, description?: string) =>
      useSonner.info(title, { description, duration: 5000 }),
  };
}
