---
"@embody/genui": minor
---

Add an experimental versioned standard document model with 14 journey-oriented node types, bounded schema/event validation, explicit action target allowlisting, immutable/canonical documents, and pure deterministic Markdown/plain-text fallbacks. Sensitive values are redacted; Markdown/HTML are treated as text; terminal control sequences are stripped; plain text wraps by Unicode terminal columns.

Expose document, text and session subpath entry points and add a packed external-consumer smoke. Web, MCP Apps, standalone-browser and native Pi renderers remain unimplemented; these primitives do not claim interactive host support.
