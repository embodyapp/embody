# Gateway & Control Plane

> Learn how the Embody Gateway aggregates multiple applications, routes MCP tool requests, and provides centralized reverse proxying.

---

## 🌐 The Role of the Gateway

In a modern AI workforce, different teams build specialized applications:
- The **Support App** manages customer tickets and SLA escalations.
- The **Engineering Ops App** manages repositories, deployments, and PRs.
- The **Billing App** manages invoices and subscriptions.

Connecting an AI agent to multiple distinct backend servers creates configuration friction and security risks.

The **Embody Gateway** solves this by acting as a unified control plane and reverse proxy:

```
                      ┌──────────────────────────────────────┐
                      │        Autonomous AI Agents          │
                      │  (Claude Desktop, Cursor, LangChain) │
                      └──────────────────┬───────────────────┘
                                         │ Single MCP Connection
                                         ▼
                      ┌──────────────────────────────────────┐
                      │            Embody Gateway            │
                      │  • /mcp (Global Aggregated Tools)    │
                      │  • /mcp/:app (Scoped Tools)          │
                      │  • Central Auth & Token Validation   │
                      └───────┬──────────────────────┬───────┘
                              │                      │
                   Forwarded  │                      │  Forwarded
                   Requests   │                      │  Requests
                              ▼                      ▼
               ┌───────────────────────┐    ┌───────────────────────┐
               │    Engineering App    │    │      Support App      │
               │  (http://eng:8080)    │    │  (http://sup:8081)    │
               └───────────────────────┘    └───────────────────────┘
```

---

## 🎯 Key Gateway Capabilities

### 1. Global Aggregated MCP (`/mcp`)
Agents connect to a single endpoint (`https://gateway.company.com/mcp`). The Gateway dynamically aggregates all tools registered across all active applications into a single introspectable MCP catalog.

### 2. App-Scoped MCP (`/mcp/:app`)
When an agent is dedicated to a specific domain (for example, an agent that only works on customer support), you can point it to `/mcp/support`. The Gateway filters the tool manifest to only expose tools belonging to the `support` application. This prevents **tool bloating** and reduces context window consumption for the LLM.

### 3. Centralized Reverse Proxy
The Gateway proxies incoming HTTP and SSE calls directly to the respective application host without exposing individual microservice hosts to the public internet:
- `GET /api/catalog`: Returns the compiled tool manifests of all registered applications.
- `POST /api/execute`: Dispatches an action or entity mutation to the responsible downstream host.

---

## 🤝 The Dynamic Registration Protocol

Downstream application hosts register themselves with the Gateway using a shared secret (`GATEWAY_REGISTRATION_SECRET`):

1. **Boot**: App host boots and reads its configuration.
2. **Handshake**: App sends a registration request to `GATEWAY_URL/api/gateway/register`, passing its `appId`, version, public URL, and compiled manifest.
3. **Heartbeat**: The app periodically sends heartbeat pings to verify liveness.
4. **Tool Discovery**: The Gateway updates its internal routing table and notifies connected agents of tool catalog changes.

---

## 🚀 Deployment Topologies

Depending on your organization's scale, Embody supports two operational topologies:

| Topology | Best For | Description |
| :--- | :--- | :--- |
| **Standalone Mode** | Local dev, single-service apps | App runs as its own HTTP and MCP server on port 8080. No gateway needed. |
| **Federated Gateway** | Production, multi-app teams | Central Gateway routes to multiple independent app hosts running in Docker/Kubernetes. |

Next: **[Model Context Protocol (MCP) →](../agent-integrations/01-model-context-protocol.md)**
