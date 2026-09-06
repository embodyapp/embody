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
    code: `import { entity, field, state, action, policy } from '@embdy/kernel';

export const Deal = entity('Deal', {
  summary: 'B2B Enterprise Deal & Pipeline Opportunity',
  fields: {
    dealNumber: field.string({ unique: true }), // e.g. "DEAL-8402"
    title: field.string({ min: 3, max: 120 }),
    value: field.number({ min: 0 }).default(25000), // USD
    account: field.ref('Account'),
    owner: field.ref('User').optional(),
    discountPct: field.number({ min: 0, max: 100 }).default(0)
  },
  states: state.machine({
    initial: 'lead',
    states: ['lead', 'qualified', 'proposal', 'won', 'lost']
  }),
  actions: {
    assign: action({
      params: { rep: field.ref('User') },
      guard: policy.expr('actor.role in ["admin", "sales_lead", "rep"]'),
      effect: (draft, { rep }) => { draft.owner = rep; }
    }),
    advance: action({
      from: ['lead', 'qualified', 'proposal'],
      to: ['qualified', 'proposal', 'won'],
      guard: policy.expr('draft.discountPct <= 20 || actor.role == "vp_sales"'),
      roles: ['rep', 'sales_lead', 'ai_agent']
    })
  }
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
$ embdy deal create \\
    --title="Acme Corp Global Cloud Migration" \\
    --value=120000 \\
    --account="acc_acme_corp"
✔ Created DEAL-8402 in [lead] (id: del_7e930f1)

# Assign account executive
$ embdy deal assign DEAL-8402 --rep="usr_sarah"
✔ Assigned DEAL-8402 to Sarah Chen (@sarah)

# Advance stage to "proposal" (evaluates discount policy & guards)
$ embdy deal advance DEAL-8402 --to="proposal"
✔ State transitioned: qualified → proposal
✔ Discount guard passed (Discount 15% <= 20% max threshold)

# View active sales pipeline stage
$ embdy pipeline list --stage="proposal"
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
Host: api.embdy.internal
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
