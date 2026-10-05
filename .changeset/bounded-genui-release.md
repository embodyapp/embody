---
"@embody/gateway": patch
"@embody/host": patch
"@embody/genui": patch
"@embody/genui-pi": patch
---

Harden the standard GenUI reference-host candidate: apply resource deadlines and cancellation through response-body reads, close MCP/SSE sessions before gateway shutdown, suppress late mutation props and require reconciliation after cancellation, visibly block stale/unreconciled action controls, and confirm unsaved native/browser drafts before user-controlled closure. Web integrations can mark a failed-read snapshot stale through `view.markStale()`. Refresh vulnerable HTTP runtime dependencies without changing the MCP Apps 1.7.5/MCP SDK 1.30.0 pins.

Add reproducible performance budgets, real Pi CLI pseudo-terminal checks, reference journeys and packed-asset/attribution checks. The verified subset is standard MCP Apps reference-host and Pi 1.0.0 behavior plus temporary development-loopback browser sessions; no vendor certification, production browser sessions, custom HTML runtime, or legal/publication approval is implied.
