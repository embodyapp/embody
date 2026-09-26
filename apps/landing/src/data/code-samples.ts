export interface CodeSample {
  id: string;
  name: string;
  badge: string;
  filename: string;
  language: string;
  description: string;
  code: string;
}

export const CODE_SAMPLES: CodeSample[] = [
  {
    id: 'declaration',
    name: '01. Declaration',
    badge: 'Single Source of Truth',
    filename: 'crm.decl.ts',
    language: 'typescript',
    description: 'Define deals, pipeline stages, discount policies, and stage guards once in pure typed data.',
    code: `import { definePlugin, HookVetoError, z } from "@embody/core";
import { defineApp } from "@embody/host";

// 1. Declare dynamic entity schema with Zod
export const TaskSchema = z.object({
  title: z.string().min(1),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  prUrl: z.string().url().optional(),
});

export default defineApp({
  appId: "ops",
  version: "1.0.0",
  plugins: [
    definePlugin(
      {
        id: "tasks",
        version: "1.0.0",
        entities: {
          task: {
            description: "Work items and tickets executed by autonomous agents",
            schema: TaskSchema,
            indexes: ["status", "priority"],
          },
        },
      },
      (define) => ({
        // 2. Declare typed business actions
        actions: {
          bulkComplete: define.action({
            description: "Atomically mark multiple tasks as completed",
            input: z.object({ taskIds: z.array(z.string().uuid()) }),
            handler: async ({ taskIds }, context) => {
              const updated = await context.entities.task.updateMany(
                taskIds.map((id) => ({ id, data: { status: "done" } }))
              );
              return { completedCount: updated.length };
            },
          }),
        },

        // 3. Mechanical Safety Guardrail: Prevent AI agents from closing tasks without a PR
        hooks: [
          define.beforeUpdate("task", ({ current, patch }, context) => {
            if (
              context.principal.actorType === "agent" &&
              patch.status === "done" &&
              !current.data.prUrl &&
              !patch.prUrl
            ) {
              throw new HookVetoError("Agents cannot mark a task 'done' without a verified PR URL");
            }
          }),
        ],
      })
    ),
  ],
});`
  },
  {
    id: 'cli',
    name: '02. CLI Interface',
    badge: 'Instant Terminal Surface',
    filename: 'terminal.sh',
    language: 'bash',
    description: 'Generated terminal commands, typed validation, and formatted pipeline table outputs.',
    code: `# Create a new enterprise deal in the CRM
$ embody deal create \\
    --title="Acme Corp Global Cloud Migration" \\
    --value=120000 \\
    --account="acc_acme_corp"
✔ Created DEAL-8402 in [lead] (id: del_7e930f1)

# Assign account executive
$ embody deal assign DEAL-8402 --rep="usr_sarah"
✔ Assigned DEAL-8402 to Sarah Chen (@sarah)

# Advance stage to "proposal" (evaluates discount policy & guards)
$ embody deal advance DEAL-8402 --to="proposal"
✔ State transitioned: qualified → proposal
✔ Discount guard passed (Discount 15% <= 20% max threshold)

# View active sales pipeline stage
$ embody pipeline list --stage="proposal"
┌───────────┬─────────────────────────────────┬──────────┬──────────┬───────────┐
│ DEAL      │ TITLE                           │ VALUE    │ STAGE    │ OWNER     │
├───────────┼─────────────────────────────────┼──────────┼──────────┼───────────┤
│ DEAL-8390 │ Vertex AI Enterprise Pilot      │ $45,000  │ proposal │ @sarah    │
│ DEAL-8398 │ Nordik Bank Core Security Lic   │ $92,000  │ proposal │ @alex     │
│ DEAL-8402 │ Acme Corp Global Cloud Migration│ $120,000 │ proposal │ @sarah    │
└───────────┴─────────────────────────────────┴──────────┴──────────┴───────────┘`
  },
  {
    id: 'mcp',
    name: '03. MCP Agent Tools',
    badge: 'First-Class AI Principal',
    filename: 'crm.mcp.json',
    language: 'json',
    description: 'Auto-derived MCP tools with mechanical guards for Claude, Cursor, and custom sales copilot agents.',
    code: `{
  "tools": [
    {
      "name": "crm_advance_stage",
      "description": "Advance a deal between pipeline stages with discount policy verification",
      "inputSchema": {
        "type": "object",
        "properties": {
          "dealNumber": { "type": "string", "example": "DEAL-8402" },
          "targetStage": { "type": "string", "enum": ["qualified", "proposal", "won", "lost"] },
          "notes": { "type": "string" }
        },
        "required": ["dealNumber", "targetStage"]
      },
      "guardrails": {
        "enforceDiscountCap": true,
        "dryRunSupported": true,
        "maxBudgetPerOperation": 500
      }
    },
    {
      "name": "crm_list_pipeline_deals",
      "description": "Query CRM deals filtered by stage, owner, or minimum ARR value",
      "inputSchema": {
        "type": "object",
        "properties": {
          "stage": { "type": "string" },
          "owner": { "type": "string" },
          "minValue": { "type": "number" }
        }
      }
    }
  ]
}`
  },
  {
    id: 'api',
    name: '04. API & Endpoints',
    badge: 'REST / GraphQL Surface',
    filename: 'crm.api.http',
    language: 'http',
    description: 'Auto-generated REST and GraphQL endpoints with schema validation and audit trails.',
    code: `### 1. Advance Deal Stage via REST API
POST /api/v1/deals/DEAL-8402/actions/advance HTTP/1.1
Host: api.embody.internal
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{
  "to": "proposal",
  "reason": "Executive champion approved technical scope & pricing"
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "dealNumber": "DEAL-8402",
  "title": "Acme Corp Global Cloud Migration",
  "previousStage": "qualified",
  "currentStage": "proposal",
  "value": 120000,
  "owner": "usr_sarah",
  "auditHash": "sha256:8f92a1c0d4e3..."
}

### 2. Peer GraphQL Mutation
mutation AdvanceDealStage {
  advanceDeal(dealNumber: "DEAL-8402", to: PROPOSAL) {
    id
    title
    stage
    value
    auditHash
  }
}`
  },
  {
    id: 'uischema',
    name: '05. Derived UI Schema',
    badge: 'Headless Pipeline UI',
    filename: 'crm.ui.json',
    language: 'json',
    description: 'Reactive layout, form, and validation schemas ready for React, Vue, or Svelte.',
    code: `{
  "component": "PipelineBoard",
  "title": "Enterprise Sales Pipeline",
  "columns": [
    { "id": "lead", "title": "Inbound Lead", "badgeColor": "#7BB8D4" },
    { "id": "qualified", "title": "Discovery & Qualified", "badgeColor": "#FDB849" },
    { "id": "proposal", "title": "Executive Proposal", "badgeColor": "#A084B6" },
    { "id": "won", "title": "Closed Won", "badgeColor": "#4E9B8F" }
  ],
  "cardTemplate": {
    "header": "{dealNumber}",
    "title": "{title}",
    "tags": ["\${value} ARR"],
    "footer": { "avatar": "{owner.avatarUrl}", "badge": "{account.name}" }
  },
  "dragActions": {
    "onDrop": "Deal.actions.advance(dealNumber, targetColumn)"
  }
}`
  }
];
