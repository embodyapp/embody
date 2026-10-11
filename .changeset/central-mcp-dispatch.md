---
"@embody/gateway": minor
"@embody/mcp": minor
---

Route JSON, streaming and MCP execution through one gateway dispatch pipeline. MCP and `/api/execute/stream` calls are now audited and rate-limited like `/api/execute`, and audit records include the org, surface (`http`, `stream`, `mcp`) and error code. MCP tool errors now carry the app's sanitized message, validation issues and retry hint, with `embody/errorCode` and `embody/requestId` in `_meta`, instead of a fixed "Tool execution failed". Unknown or malformed host errors still map to a generic internal error. Adds the `AuditSink` interface, `jsonLineAuditSink()`, `parseErrorEnvelope()` and `mcpErrorResult()`.
