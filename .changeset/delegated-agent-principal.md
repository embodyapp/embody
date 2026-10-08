---
"@embody/core": minor
"@embody/auth": minor
"@embody/gateway": minor
"@embody/testing": minor
---

MCP calls made with a human or system credential are now attributed to an agent acting on that subject's behalf, so agent-only guardrails apply to chat clients. `Principal` gains an optional `delegation` (`subjectId`, `subjectType`, `client`) that flows through the gateway token to app hosts, handlers and audit records. Only agent principals may carry a delegation. OIDC `azp`/`client_id` claims label the client. The HTTP API and CLI are unchanged. `createGateway({ mcp: { actor: "token" } })` restores the previous attribution for one release and is deprecated. Adds `delegatedAgentPrincipal()`, `isValidDelegation()` and `harness.asDelegatedAgent()`.
