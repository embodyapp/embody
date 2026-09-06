export interface ArchitectureNode {
  id: string;
  primitive: string;
  num: string;
  layer: 'Data' | 'State & Logic' | 'Reactivity' | 'Compilation';
  roleInCrm: string;
  codeSnippet: string;
  accentColor: string;
  accentBg: string;
  badge: string;
}

export const CRM_ARCHITECTURE_LAYERS = [
  {
    layerName: '1. Data Foundation',
    layerSubtitle: 'Schema & Tenant Isolation',
    layerColor: '#F27A3D',
    nodes: [
      {
        id: 'entity',
        primitive: 'Entity',
        num: '01',
        layer: 'Data',
        badge: 'Domain Noun',
        roleInCrm: 'Defines Deal, Account & Contact models with auto-generated PostgreSQL tables and RLS.',
        codeSnippet: `entity('Deal', { fields: { ... } })`,
        accentColor: '#F27A3D',
        accentBg: '#FFF3EB'
      },
      {
        id: 'field',
        primitive: 'Field',
        num: '02',
        layer: 'Data',
        badge: 'Typed Attributes',
        roleInCrm: 'Enforces deal amount, currency, stage enum, and account foreign key constraints.',
        codeSnippet: `field.enum(['lead', 'qualified', 'proposal', 'won'])`,
        accentColor: '#FDB849',
        accentBg: '#FFFBEA'
      }
    ]
  },
  {
    layerName: '2. State & Business Logic',
    layerSubtitle: 'Transitions & Business Rules',
    layerColor: '#7BB8D4',
    nodes: [
      {
        id: 'state',
        primitive: 'State',
        num: '03',
        layer: 'State & Logic',
        badge: 'FSM Lifecycles',
        roleInCrm: 'Deterministic 4-stage pipeline machine (lead → qualified → proposal → won). Zero invalid states.',
        codeSnippet: `state.machine({ states: ['lead', 'qualified', 'proposal', 'won'] })`,
        accentColor: '#7BB8D4',
        accentBg: '#EFF7FA'
      },
      {
        id: 'action',
        primitive: 'Action',
        num: '04',
        layer: 'State & Logic',
        badge: 'Atomic Verbs',
        roleInCrm: 'Executes stage transitions with ACID safety, dry runs, and hash-chained audit logs.',
        codeSnippet: `action({ from: 'qualified', to: 'proposal', guard: ... })`,
        accentColor: '#D66248',
        accentBg: '#FAECE9'
      },
      {
        id: 'policy',
        primitive: 'Policy',
        num: '05',
        layer: 'State & Logic',
        badge: 'Discount Guard Engine',
        roleInCrm: 'Pure rule enforcing max 20% discount without VP Sales approval.',
        codeSnippet: `policy.expr('discountPct <= 20 || actor.role == "vp_sales"')`,
        accentColor: '#A084B6',
        accentBg: '#F5F0F8'
      }
    ]
  },
  {
    layerName: '3. Reactivity & Automations',
    layerSubtitle: 'Hooks, Events & Background Jobs',
    layerColor: '#4E9B8F',
    nodes: [
      {
        id: 'hook',
        primitive: 'Hook',
        num: '06',
        layer: 'Reactivity',
        badge: 'Post-Commit Trigger',
        roleInCrm: 'Dispatches Slack alerts when enterprise deals (> $50k) enter contract proposal.',
        codeSnippet: `hook.after('advance', notifySlackOnEnterpriseDeal)`,
        accentColor: '#4E9B8F',
        accentBg: '#EDF7F5'
      },
      {
        id: 'event',
        primitive: 'Event',
        num: '07',
        layer: 'Reactivity',
        badge: 'Domain Event Bus',
        roleInCrm: 'Broadcasts versioned "deal.won" events to billing webhooks and ERP message queues.',
        codeSnippet: `event('deal.won', { payload: DealWonPayload })`,
        accentColor: '#F27A3D',
        accentBg: '#FFF3EB'
      },
      {
        id: 'job',
        primitive: 'Job',
        num: '08',
        layer: 'Reactivity',
        badge: 'Scheduled Reconciler',
        roleInCrm: 'Nightly background cron worker that recalculates ARR pipeline velocity & flags stalled deals.',
        codeSnippet: `job.cron('0 0 * * *', recalculatePipelineHealth)`,
        accentColor: '#56486E',
        accentBg: '#ECE9F1'
      }
    ]
  },
  {
    layerName: '4. Kernel & Projections',
    layerSubtitle: 'Extensions & Anti-Rot Lock',
    layerColor: '#A084B6',
    nodes: [
      {
        id: 'extension',
        primitive: 'Extension',
        num: '09',
        layer: 'Compilation',
        badge: 'Widen-Only Algebra',
        roleInCrm: 'Adds custom Salesforce sync IDs and churn risk metrics without modifying upstream core code.',
        codeSnippet: `extend('@commons/crm', { fields: { sfdcSyncId: field.string() } })`,
        accentColor: '#4E9B8F',
        accentBg: '#EDF7F5'
      },
      {
        id: 'manifest',
        primitive: 'Manifest',
        num: '10',
        layer: 'Compilation',
        badge: 'Anti-Rot Hash Lock',
        roleInCrm: 'Compiles the CRM contract into embdy.lock v2 for database, CLI, MCP agents & UI.',
        codeSnippet: `compile({ entities: [Deal, Account, Contact] })`,
        accentColor: '#FDB849',
        accentBg: '#FFFBEA'
      }
    ]
  }
];
