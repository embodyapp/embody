import posthog from 'posthog-js';

const env = import.meta.env as unknown as Readonly<Record<string, string | undefined>>;
const posthogKey = env['VITE_POSTHOG_KEY'];
const posthogHost = env['VITE_POSTHOG_HOST'];

export const posthogEnabled = Boolean(posthogKey && posthogHost);

if (!posthogKey) {
  if (import.meta.env.DEV) {
    console.info('PostHog analytics disabled: VITE_POSTHOG_KEY is not configured.');
  }
} else if (!posthogHost) {
  if (import.meta.env.DEV) {
    console.info('PostHog analytics disabled: VITE_POSTHOG_HOST is not configured.');
  }
} else {
  posthog.init(posthogKey, {
    api_host: posthogHost,
    defaults: '2026-05-30',
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
  });
}

export default posthog;
