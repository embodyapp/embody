import './styles/experience.css';
import './styles/guided-demo.css';
import './styles/personal-software.css';
import './styles/chat-control.css';
import posthog, { posthogEnabled } from './posthog';

const track = (event: string, properties?: Record<string, unknown>) => {
  if (posthogEnabled) posthog.capture(event, properties);
};

// Native submission goes directly to the existing signup form, including without JS.
// Google shows the actual confirmation; never claim success from an opaque fetch.
// Do not include the submitted address in analytics or browser storage.
document.querySelector<HTMLFormElement>('#waitlist-form')?.addEventListener('submit', () => {
  track('landing_waitlist_submission_started');
});
document.addEventListener('click', event => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="https://"]');
  if (link) track('landing_outbound_click', { destination: link.href, label: link.textContent?.trim() });
});
