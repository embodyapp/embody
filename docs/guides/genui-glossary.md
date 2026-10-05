# GenUI glossary

These terms describe the standard GenUI contract. Implemented surfaces and support limits are recorded in [the release evidence](genui-release-evidence.md). See [ADR 0005](../adr/0005-generative-ui-presentation.md) and [Phase 14](../implementation-plan/14-generative-ui.md).

| Term | Meaning |
|---|---|
| Presented action | An ordinary Embody action whose validated output is bound to an app-owned view. Presentation failure does not reverse a committed action. |
| View | A versioned, app-owned presentation definition. Trusted static implementation/resources are separated from dynamic action data. |
| Props | The validated action output supplied to the view. Protocol v1 requires the action output and view props to share the same registered Zod schema object. |
| Standard document | A validated, versioned declarative component tree interpreted by supported renderers; nodes contain no executable callbacks. |
| Result-attached view | A view associated with a particular action result. It is not automatically a persistent workspace or durable human-input session. |
| Authoritative domain state | State owned by the app and read or changed through ordinary authorized actions, not inferred from a rendered snapshot. |
| View-local state | Filters, selection, expansion, and unsaved drafts. Local changes do not constitute domain mutations. |
| Consequential interaction | An interaction that changes domain state or causes an external effect. It needs a defined human/agent-visible outcome and reconciliation policy. |
| Conversation visibility | How an interaction outcome becomes available to the agent through a verified host mechanism. Audit storage alone is not conversation visibility; visibility does not guarantee the agent has already consumed an update. |
| Reconciliation | An explicit path, such as an authoritative follow-up read, for the human and agent to reestablish current state after a change, stale snapshot, or uncertain outcome. |
| Ambiguous mutation outcome | A disconnect, cancellation, or lost response where the client cannot tell whether the action committed. Do not assume rollback or blindly retry. |
| Semantic portability | Preservation of relevant information, useful actions, identity, and policy outcomes across surfaces, without requiring identical layout or controls. |
| Degradation | A documented alternative representation for unsupported UI, such as a list, deterministic text summary, or explicit browser handoff. |
| Host capability | A negotiated or verified rendering/interaction feature. A vendor/product name is not evidence of support. |
| Increment release gate | Security, correctness, packaging, compatibility, documentation, and performance evidence for the specific capability being shipped. Unshipped adapters do not block unrelated verified capabilities. |

The accepted lifecycle and event contracts are in [the reference journey](genui-reference-journey.md) and executable fixtures. These definitions do not introduce a new response envelope or bridge protocol.
