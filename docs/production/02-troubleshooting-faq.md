# Troubleshooting & FAQ

> Answers to common questions, error codes, and debugging techniques for Embody applications.

---

## 🚨 Common Error Codes & Resolutions

### 1. `HookVetoError` (Status: 422)
```text
HookVetoError: Autonomous agents cannot complete cards without a linked PR URL.
  Code: HOOK_VETO
  Target: ops.tasks.card.update
```
- **Cause**: A mechanical safety hook (`beforeCreate`, `beforeUpdate`, `beforeAction`, etc.) detected a policy violation.
- **Resolution**: This is an intended behavior. Inspect the error message. If you are testing as an agent, provide the required field (e.g. `prUrl`) or request approval. If you are an administrator testing in the terminal, ensure you are authenticated with a `human` actor type.

---

### 2. `ValidationError` (Status: 400)
```text
ValidationError: Invalid action input: path 'recipients[2]' must be a valid email address
```
- **Cause**: The input arguments provided by the caller or LLM do not conform to the Zod schema declared on the action or entity.
- **Resolution**: Compare the arguments passed against the schema in `embody apps inspect <appId>`.

---

### 3. `ConflictError` (Status: 409)
```text
ConflictError: The record has been modified by another actor since it was last read.
```
- **Cause**: Optimistic concurrency control rejected the update because `expectedUpdatedAt` does not match the current database timestamp. Another agent modified the record in the meantime.
- **Resolution**: Re-fetch the latest record state using `get`, re-apply your changes, and call `update` again.

---

### 4. `Local development authentication is disabled outside development`
- **Cause**: The application was started with `NODE_ENV=production`, but the configuration is still using `localDevVerifier`.
- **Resolution**: Configure a production-grade verifier like `gatewayJwtVerifier` with a valid JWT secret or JWKS URL.

---

### 5. Claude Desktop Shows No Tools (Hammer Icon Missing)
- **Check 1**: Verify your Embody host is running and healthy:
  ```bash
  curl http://127.0.0.1:8080/health
  ```
- **Check 2**: Ensure `@embody/cli` is reachable in your terminal. Test the bridge command manually:
  ```bash
  npx -y @embody/cli mcp --url http://127.0.0.1:8080/mcp
  ```
- **Check 3**: Completely quit and restart Claude Desktop after editing `claude_desktop_config.json`.
- **Check 4**: Check Claude's MCP log file:
  - macOS: `tail -n 50 ~/Library/Logs/Claude/mcp*.log`

---

## ❓ Frequently Asked Questions (FAQ)

### Can I run Embody without the central Gateway?
**Yes.** The Embody Gateway is an optional control plane for multi-application architectures. A standalone Embody application (`defineApp`) runs its own HTTP and MCP endpoints directly on port 8080 with zero extra infrastructure.

### How does Embody handle database migrations when schemas change?
In development, Embody synchronizes tables and indexes automatically. In production with PostgreSQL, entity records are stored in accelerated JSONB columns alongside structured indexes. Adding optional fields or defaults does not require blocking table locks.

### Does Embody work with LangChain, CrewAI, and AutoGen?
**Yes.** Any agent framework that can make HTTP requests or speak the Model Context Protocol (MCP) can connect to Embody. See the **[Custom Agent SDKs Guide](../agent-integrations/04-custom-agents-sdk.md)** for Python and LangChain examples.

### Is Embody open source?
No. Embody is source-available under the [Elastic License 2.0](../../LICENSE), with separate commercial rights available for providing Embody as a hosted or managed service. You may build and host your own application with Embody as long as the service does not give users access to a substantial set of Embody's features or functionality. See the [commercial preparation record](../commercial/README.md).

---

## 💬 Getting Help

- **GitHub Issues**: [github.com/nimrod4278/embody/issues](https://github.com/nimrod4278/embody/issues)
- **Discussions**: [github.com/nimrod4278/embody/discussions](https://github.com/nimrod4278/embody/discussions)
