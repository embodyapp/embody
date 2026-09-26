export interface Primitive {
  num: string;
  name: string;
  category: string;
  summary: string;
  codeSnippet: string;
  accentColor: string;
  accentBg: string;
}

export const PRIMITIVES: Primitive[] = [
  {
    num: '01',
    name: 'Entity',
    category: 'Structural',
    summary: 'The business nouns (Order, Customer, Inventory). Pure declared state, auto-migrating and tenant-isolated.',
    codeSnippet: `entity('Customer', { fields: { ... } })`,
    accentColor: '#F27A3D',
    accentBg: '#FFF3EB'
  },
  {
    num: '02',
    name: 'Field',
    category: 'Structural',
    summary: 'Typed attributes with semantic constraints (money, email, enum, ref, geo, encrypted).',
    codeSnippet: `field.money({ currency: 'USD', min: 0 })`,
    accentColor: '#FDB849',
    accentBg: '#FFFBEA'
  },
  {
    num: '03',
    name: 'State',
    category: 'Behavioral',
    summary: 'Deterministic finite state machines governing lifecycle transitions with zero invalid states.',
    codeSnippet: `state.machine({ initial: 'draft', states: [...] })`,
    accentColor: '#7BB8D4',
    accentBg: '#EFF7FA'
  },
  {
    num: '04',
    name: 'Action',
    category: 'Behavioral',
    summary: 'Atomic state transitions and business verbs guarded by role permissions and preconditions.',
    codeSnippet: `action({ from: 'draft', to: 'placed', roles: [...] })`,
    accentColor: '#D66248',
    accentBg: '#FAECE9'
  },
  {
    num: '05',
    name: 'Policy',
    category: 'Governance',
    summary: 'Pure, total, serializable expressions. Evaluated across all surfaces without runtime JS closures.',
    codeSnippet: `policy.expr('actor.tier == "VIP" || total < 1000')`,
    accentColor: '#A084B6',
    accentBg: '#F5F0F8'
  },
  {
    num: '06',
    name: 'Hook',
    category: 'Reactivity',
    summary: 'Deterministic side effects and integrations triggered after atomic state transactions complete.',
    codeSnippet: `hook.after('ship', sendTrackingNotification)`,
    accentColor: '#4E9B8F',
    accentBg: '#EDF7F5'
  },
  {
    num: '07',
    name: 'Event',
    category: 'Reactivity',
    summary: 'Typed, versioned domain events emitted to event buses (Kafka, SQS, Webhooks) with schema guarantees.',
    codeSnippet: `event('order.shipped', { payload: ShippedPayload })`,
    accentColor: '#F27A3D',
    accentBg: '#FFF3EB'
  },
  {
    num: '08',
    name: 'Job',
    category: 'Asynchronous',
    summary: 'Scheduled cron tasks, delayed queue workers, and background reconcilers with idempotency keys.',
    codeSnippet: `job.cron('0 0 * * *', reconcileLedger)`,
    accentColor: '#56486E',
    accentBg: '#ECE9F1'
  },
  {
    num: '09',
    name: 'Extension',
    category: 'Commons',
    summary: 'Widen-only algebraic composition. Downstream apps extend upstream modules without forking.',
    codeSnippet: `extend('@commons/orders', { fields: { ... } })`,
    accentColor: '#4E9B8F',
    accentBg: '#EDF7F5'
  },
  {
    num: '10',
    name: 'Manifest',
    category: 'Compilation',
    summary: 'The single serializable contract JSON that hashes into embody.lock v2 and projects all surfaces.',
    codeSnippet: `compile({ entities: [Order, Customer] })`,
    accentColor: '#FDB849',
    accentBg: '#FFFBEA'
  }
];
