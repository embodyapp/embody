# Embody landing experience

## Local preview

```sh
pnpm --filter @app/landing dev --host 127.0.0.1 --port 5173
pnpm --filter @app/landing build
```

Vite prints its actual port. Building or merging this page does not deploy it. The preview Hosting site and any production custom domain must be released explicitly after verifying the intended target.

## Process comparison

Both columns begin with the same finished AI-built app. Static ordered paths show the work between building and team use:

- **Without a shared platform:** open a DevOps ticket, work through production setup, complete security review and remediation, get IT/data-owner sign-off, and prepare release and operations before sharing. Handoff labels identify the teams involved; a warning connects bypassing the process to shadow-AI risk. The long dashed path makes successive queues and responsibilities visible.
- **With Embody:** configure data, audience, and owner on a shared runtime, complete app-specific security/access/release checks, then deploy and share. The shorter green path illustrates less repeated setup, not bypassing enterprise controls. The next app reuses the operating foundation. Maintenance and support responsibilities remain.

This is a qualitative illustration, not a benchmark or claim of guaranteed deployment times. The cloud is explicitly a preview. App-specific configuration, review, and maintenance remain necessary; arbitrary code is not automatically secured or repaired. Other tools can provide shared foundations too.

No mode switches, walkthrough buttons, clocks, forced delays, or deployment simulation.

## One-glance personalization

The former ten detailed CRM cards are replaced with one minimal diagram:

**One gray CRM screen for three people → three colored, person-specific tools.**

Maya has a pipeline board, Sam has an onboarding checklist, and Alex has a forecast chart. Each has a name and one short app title. Abstract shapes replace records, metrics, legends, and detailed text. A single caption ties them to one shared CRM, rather than disconnected databases. The figure stacks on mobile while keeping all three personal tools in a single row.

The main comparison, personalization diagram, logos, and testimonials are static HTML and remain readable without JavaScript.

## Agent logos and testimonials

Original assets are reused for Claude Code, Codex, Antigravity, Pi, Cursor, and MCP. The strip distinguishes building with the Embody skill from connecting MCP-compatible clients. It does not imply partnerships or endorsements.

All four attributed quotes, names, profile links, and available photos come unchanged from `fb9a211:apps/landing/index.html`. Editorial headings outside the blockquotes relate them to personal fit, adaptability, connected agents, and human control. Testimonials describe framework experiences, not the managed-cloud preview. There is no carousel or autoplay.

## All your business apps. One chat.

A static chat window shows a right-aligned user request—close the Acme deal, start onboarding, and draft the invoice—and a left-aligned Embody reply with three inline action rows: CRM, Tasks, and Billing. A visually styled approval label and message-composer illustration use non-interactive spans, not buttons or inputs. Nothing executes; no fake typing, sending, or approval occurs. The window header and caption explicitly label the chat preview and limit it to configured apps and permitted actions.

The explorer shell, sample workspaces, reset, foundation expander, and journey section have been removed, along with their JavaScript state and event handlers. The page does not call an LLM, connect a real CRM, deploy apps, send messages, or schedule automation. The admin illustration remains labeled as a preview. Workflow-interest buttons update a GitHub discussion link; there is no fake signup form.

## Files

- `index.html`: narrative, ordered comparison paths, personalization diagram, logos, testimonials, optional explorer, and static illustrations.
- `src/main.ts`: workflow-interest link and optional analytics; no sample-workspace state remains.
- `src/styles/chat-control.css`: single-request/multiple-app chat illustration and responsive layout.
- `src/styles/guided-demo.css`: comparison shell, testimonials, logos, explorer, and conversation styling. Historical filename retained.
- `src/styles/personal-software.css`: simplified personalization figure and process paths, including responsive layouts.
- `src/styles/experience.css`: overall landing and workspace styles with original brand tokens.
- `public/integrations/`, `public/testimonials/`: original image assets.

The old interactive comparison state machine (`src/guided-demo.ts`) is removed. Analytics capture only the remaining interactions and outbound links, and stay disabled without the existing PostHog configuration.

## Regression checks

1. Both process columns are immediately visible with identical starting labels, six long-path items and three short-path items. No timing claims or main-comparison buttons.
2. The shadow-AI warning and cloud-preview disclosure are present. Configuration is explicit on the shorter path.
3. Exactly three personal tools, each with a different visual interface, connect conceptually to one shared CRM. No detailed records or ten-card grid remain.
4. Test desktop and 1024/800/768/760/390/320 widths for overflow. Columns and the diagram stack on small screens; the three personal tools stay in a row.
5. With JavaScript disabled, process paths, personalization, logos, and testimonials remain visible.
6. Check original logo/photo assets and unchanged testimonial quotations.
7. Verify the explorer and journey sections are absent and their removed event handlers cause no errors. Chat must show user and assistant messages, three named app/action rows, an approval illustration, and preview disclosures, including without JavaScript. The illustrative composer and approval label must not enter the keyboard tab order.
8. Test chat navigation anchor, skip link, reduced-motion behavior, and workflow-interest link.

## Isolated preview deployment

Previous preview: https://embody-future-of-work.web.app in Firebase project `nimrod-experiments`.

To update the isolated preview after authentication, use:

```sh
pnpm --filter @app/landing deploy:preview
```

`firebase.preview.json` explicitly selects the separate `embody-future-of-work` site. Do not use `deploy` or root `deploy:landing`, which target the original site. Earlier deployments used Hosting REST APIs with authorized Google Cloud credentials because the Firebase CLI was not logged in, and verified all five original site releases stayed unchanged.
