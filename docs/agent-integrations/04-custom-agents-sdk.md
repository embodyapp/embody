# Custom Agent SDKs, Python & LangChain

> Learn how to integrate custom agent runtimes, Python scripts, LangChain, and Node.js applications directly with Embody.

---

## 🐍 Python & LangChain Integration

If you are building custom AI agents in Python using LangChain, LangGraph, or LlamaIndex, you can connect directly to Embody using the official `mcp` Python package.

### 1. Install Dependencies

```bash
pip install mcp langchain-anthropic httpx
```

### 2. Connect to Embody via Streamable HTTP Client

```python
import asyncio
from mcp.client.streamable_http import StreamableHTTPClientSession
from mcp.client.session import ClientSession
import httpx

async def run_agent():
    # Connect to the live Embody server
    async with httpx.AsyncClient() as client:
        session = StreamableHTTPClientSession(
            client=client,
            url="https://gateway.example.com/mcp"
        )
        async with ClientSession(session) as mcp:
            await mcp.initialize()

            # 1. Discover all tools exposed by Embody
            tools = await mcp.list_tools()
            print("Discovered Embody tools:")
            for tool in tools.tools:
                print(f" - {tool.name}: {tool.description}")

            # 2. Call a tool programmatically
            result = await mcp.call_tool(
                name="ops_tasks_task_create",
                arguments={
                    "data": {
                        "title": "Automated security audit",
                        "priority": "high"
                    }
                }
            )
            print("Tool result:", result.content[0].text)

asyncio.run(run_agent())
```

---

## 🟩 TypeScript / Node.js Agent Integration

For Node.js agent runtimes, use the official `@modelcontextprotocol/sdk`:

```bash
pnpm add @modelcontextprotocol/sdk
```

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://gateway.example.com/mcp")
  );

  const client = new Client(
    { name: "custom-agent-worker", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  // List all tools
  const tools = await client.listTools();
  console.log(`Found ${tools.tools.length} tools`);

  // Invoke an action
  const response = await client.callTool({
    name: "ops_tasks_bulk_complete",
    arguments: {
      taskIds: ["c7a4e6b2-1234-4567-89ab-cdef01234567"],
    },
  });

  console.log("Response:", response.content);
}

main().catch(console.error);
```

---

## 🌐 Direct HTTP / REST Execution API

If your agent framework does not support MCP yet, you can invoke any Embody target directly over standard HTTP with JSON payloads:

### Endpoint: `POST /api/execute`

#### Headers
```http
POST /api/execute HTTP/1.1
Host: 127.0.0.1:8080
Content-Type: application/json
Accept: application/json
Authorization: Bearer <YOUR_TOKEN>
```

#### Request Body
```json
{
  "target": "ops.tasks.task.create",
  "input": {
    "data": {
      "title": "Investigate DB latency spike",
      "priority": "urgent"
    }
  }
}
```

#### Response
```json
{
  "status": "success",
  "result": {
    "id": "f4b7a1e0-4321-8765-dcba-9876543210ab",
    "orgId": "default-org",
    "entityType": "task",
    "data": {
      "title": "Investigate DB latency spike",
      "priority": "urgent",
      "status": "todo"
    },
    "createdAt": "2026-09-06T18:30:00.000Z",
    "updatedAt": "2026-09-06T18:30:00.000Z"
  }
}
```

### Streaming Live Progress via `Accept: text/event-stream`

If your action reports progress via `context.progress(...)`, set `Accept: text/event-stream` on the request. Embody will stream SSE frames:

```text
event: progress
data: {"percent": 20, "message": "Analyzing logs"}

event: progress
data: {"percent": 80, "message": "Isolating slow query"}

event: result
data: {"status": "success", "result": {"rootCause": "Missing index on created_at"}}
```

Next: **[CLI Reference →](../developer-tools/01-cli-reference.md)**
