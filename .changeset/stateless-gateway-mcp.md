---
"@embody/mcp": minor
"@embody/gateway": patch
---

Add a stateless Streamable HTTP mode and use it for gateway MCP routes. Each authenticated request owns its server/transport/context, so initialization and tool calls can reach different gateway replicas without losing process-local sessions. Preserve stateful, identity- and endpoint-pinned sessions as the adapter default. Test round-robin replicas and cancellation in both modes.
