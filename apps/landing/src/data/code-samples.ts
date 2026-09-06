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
    description: 'Declare entities, FSM lifecycles, and policy guardrails that autonomous AI agents execute safely.',
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
      guard: policy.expr('actor.role in ["admin", "sales_lead", "rep", "ai_copilot"]'),
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
    id: 'mcp',
    name: '02. Agent MCP Tools',
    badge: 'First-Class AI Principal',
    filename: 'crm.mcp.json',
    language: 'json',
    description: 'Auto-derived Model Context Protocol tools with mechanical guards for Claude, Cursor, and custom agents.',
    code: `{
  "server": { "name": "embdy-crm-agent", "version": "1.0.0" },
  "tools": [
    {
      "name": "crm_advance_stage",
      "description": "Advance a deal between pipeline stages with mechanical policy verification",
      "inputSchema": {
        "type": "object",
        "properties": {
          "dealNumber": { "type": "string", "example": "DEAL-8402" },
          "targetStage": { "type": "string", "enum": ["qualified", "proposal", "won", "lost"] },
          "notes": { "type": "string" }
        },
        "required": ["dealNumber", "targetStage"]
      },
      "attenuation": {
        "maxBudgetPerOperation": 500,
        "dryRunSupported": true,
        "enforceFsmTransitions": true,
        "requireHumanSignoffAboveDiscount": 20
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
    id: 'uischema',
    name: '03. Human Supervisory UI',
    badge: 'Supervisory Dashboard',
    filename: 'crm.ui.json',
    language: 'json',
    description: 'Reactive layout and approval views so human operators can inspect, verify, and intervene in agent workflows.',
    code: `{
  "component": "AgentSupervisoryBoard",
  "title": "Enterprise Sales Pipeline (Agent + Human)",
  "columns": [
    { "id": "lead", "title": "Inbound Lead", "badgeColor": "#7BB8D4" },
    { "id": "qualified", "title": "Agent Discovery & Qualified", "badgeColor": "#FDB849" },
    { "id": "proposal", "title": "Executive Proposal", "badgeColor": "#A084B6" },
    { "id": "won", "title": "Closed Won", "badgeColor": "#4E9B8F" }
  ],
  "cardTemplate": {
    "header": "{dealNumber}",
    "title": "{title}",
    "tags": ["\${value} ARR", "Agent: {lastAgentActor}"],
    "supervision": {
      "requiresHumanOverrideIf": "discountPct > 20",
      "auditHash": "{auditHash}"
    }
  },
  "actions": {
    "approveAgentProposal": "Deal.actions.advance(dealNumber, 'won')"
  }
}`
  },
  {
    id: 'cli',
    name: '04. Developer & Agent CLI',
    badge: 'Instant Terminal Surface',
    filename: 'terminal.sh',
    language: 'bash',
    description: 'Generated terminal commands, typed validation, and formatted outputs for developers or CLI-driven agents.',
    code: `# Create a new enterprise deal in the CRM
$ embdy deal create \\
    --title="Acme Corp Global Cloud Migration" \\
    --value=120000 \\
    --account="acc_acme_corp"
✔ Created DEAL-8402 in [lead] (id: del_7e930f1)

# Autonomous Agent advances stage to "proposal" (evaluates discount policy & guards)
$ embdy deal advance DEAL-8402 --to="proposal" --actor="agent:deal-desk:rex"
✔ Agent credential authenticated (role: ai_agent)
✔ State transitioned: qualified → proposal
✔ Mechanical policy passed (Discount 15% <= 20% max threshold)
✔ Audit ledger recorded (hash: sha256:8f92a1c...)

# View active sales pipeline stage
$ embdy pipeline list --stage="proposal"
┌───────────┬─────────────────────────────────┬──────────┬──────────┬───────────┐
│ DEAL      │ TITLE                           │ VALUE    │ STAGE    │ OPERATOR  │
├───────────┼─────────────────────────────────┼──────────┼──────────┼───────────┤
│ DEAL-8390 │ Vertex AI Enterprise Pilot      │ $45,000  │ proposal │ @sarah    │
│ DEAL-8398 │ Nordik Bank Core Security Lic   │ $92,000  │ proposal │ agent:rex │
│ DEAL-8402 │ Acme Corp Global Cloud Migration│ $120,000 │ proposal │ agent:rex │
└───────────┴─────────────────────────────────┴──────────┴──────────┴───────────┘`
  },
  {
    id: 'api',
    name: '05. REST & GraphQL API',
    badge: 'Typed Gateway Surface',
    filename: 'crm.api.http',
    language: 'http',
    description: 'Auto-generated REST and GraphQL endpoints with schema validation and cryptographic audit trails.',
    code: `### 1. Agent Advances Deal Stage via REST API
POST /api/v1/deals/DEAL-8402/actions/advance HTTP/1.1
Host: api.embdy.internal
Authorization: Bearer agent_token_sec_9942
Content-Type: application/json

{
  "to": "proposal",
  "actor": "agent:deal-desk:rex",
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
  "operator": "agent:deal-desk:rex",
  "auditHash": "sha256:8f92a1c0d4e3...",
  "guardStatus": "passed"
}

### 2. Peer GraphQL Mutation
mutation AdvanceDealStage {
  advanceDeal(dealNumber: "DEAL-8402", to: PROPOSAL, actor: "agent:deal-desk:rex") {
    id
    title
    stage
    value
    auditHash
  }
}`
  }
];
