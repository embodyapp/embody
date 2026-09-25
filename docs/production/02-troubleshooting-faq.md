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
- **Cause**: An entity lifecycle hook or custom-action policy check detected a policy violation.
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
- **Cause**: The entity engine's internal optimistic commit check found that another operation changed the record during the transaction.
- **Resolution**: Re-fetch the latest record state using `get`, reconsider and re-apply the intended change, and call `update` again. The public accessor does not accept an `expectedUpdatedAt` argument.

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
  EMBODY_TOKEN="$TOKEN" npx -y @embody/cli mcp --url https://gateway.example.com/mcp
  ```
- **Check 3**: Completely quit and restart Claude Desktop after editing `claude_desktop_config.json`.
- **Check 4**: Check Claude's MCP log file:
  - macOS: `tail -n 50 ~/Library/Logs/Claude/mcp*.log`

---

## ❓ Frequently Asked Questions (FAQ)

### Can I run Embody without a gateway?

For local development, yes: the application host provides a loopback inspector without additional infrastructure. The inspector is not a production MCP or authentication boundary.

For production CLI and MCP access, use either the paid managed Embody Gateway or operate your own compatible control plane with `@embody/gateway`. See the [gateway guide](../guides/07-gateway-and-control-plane.md) and [self-hosting guide](./07-self-hosting-the-gateway.md).

### How does Embody handle database migrations when schemas change?
In development, Embody synchronizes tables and indexes automatically. In production with PostgreSQL, entity records are stored in accelerated JSONB columns alongside structured indexes. Adding optional fields or defaults does not require blocking table locks.

### Does Embody work with LangChain, CrewAI, and AutoGen?
**Yes.** Any agent framework that can make HTTP requests or speak the Model Context Protocol (MCP) can connect to Embody. See the **[Custom Agent SDKs Guide](../agent-integrations/04-custom-agents-sdk.md)** for Python and LangChain examples.

### Is Embody open source?
No. Embody is source-available under the [Elastic License 2.0](../../LICENSE), with separate commercial rights available for providing Embody as a hosted or managed service. You may build and host your own application with Embody as long as the service does not give users access to a substantial set of Embody's features or functionality. See the [commercial preparation record](../commercial/README.md).

---

## 💬 Getting Help

- **GitHub Issues**: [github.com/embodyapp/embody/issues](https://github.com/embodyapp/embody/issues)
- **Discussions**: [github.com/embodyapp/embody/discussions](https://github.com/embodyapp/embody/discussions)
