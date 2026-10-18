import './styles/experience.css';
import './styles/guided-demo.css';
import './styles/personal-software.css';
import './styles/chat-control.css';
import posthog, { posthogEnabled } from './posthog';

const track = (event: string, properties?: Record<string, unknown>) => {
  if (posthogEnabled) posthog.capture(event, properties);
};

const workflowCta = document.querySelector<HTMLAnchorElement>('#workflow-cta');
document.querySelectorAll<HTMLButtonElement>('[data-interest]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-interest]').forEach(el => el.setAttribute('aria-pressed', String(el === button)));
    if (workflowCta) {
      workflowCta.href = `https://github.com/embodyapp/embody/discussions/new?category=ideas&title=${encodeURIComponent(`Workflow idea: ${button.dataset.interest}`)}`;
    }
    track('landing_workflow_interest', { interest: button.dataset.interest });
  });
});
document.addEventListener('click', event => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="https://"]');
  if (link) track('landing_outbound_click', { destination: link.href, label: link.textContent?.trim() });
});
