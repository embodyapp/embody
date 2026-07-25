/**
 * B2B SaaS CRM — mock data fixtures (single source of truth).
 *
 * Rich, interlinked demo records for the B2B Sales CRM. Consumed by the client-side
 * fallback in the demo-ui and (later) by the backend `seed:demo` script so the wired
 * app and the offline app show identical data. Everything is deterministic — no
 * Math.random — so IDs are stable across reloads and the seed.
 */

export type DealStage =
  | 'lead'
  | 'discovery'
  | 'proposal'
  | 'negotiation'
  | 'closed_won'
  | 'closed_lost';

export type AccountHealth = 'healthy' | 'watch' | 'at_risk';

export type BuyerRole =
  | 'Champion'
  | 'Economic Buyer'
  | 'InfoSec'
  | 'Procurement'
  | 'Technical Evaluator'
  | 'End User';

export type ActivityType = 'call' | 'email' | 'meeting' | 'note' | 'task';

export interface B2bAccount {
  id: string;
  name: string;
  domain: string;
  industry: string;
  employees: number;
  location: string;
  owner: string;
  health: AccountHealth;
  arr: number; // active recurring revenue from won deals
  renewalDate: string | null; // ISO date
  createdAt: string;
}

export interface B2bContact {
  id: string;
  accountId: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  buyerRole: BuyerRole;
  engagement: number; // 0-100
  primary: boolean;
}

export interface B2bDeal {
  id: string;
  name: string;
  accountId: string;
  stage: DealStage;
  amount: number; // ARR
  seats: number;
  termMonths: number;
  probability: number; // 0-100
  owner: string;
  closeDate: string; // ISO date
  nextStep: string;
  securityReviewPassed: boolean;
  dpaSigned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface B2bActivity {
  id: string;
  type: ActivityType;
  subject: string;
  body: string;
  accountId: string;
  dealId: string | null;
  contactId: string | null;
  actor: string;
  at: string; // ISO datetime — when it happened / is due
  done: boolean; // for tasks
  dueAt: string | null;
}

export interface B2bProduct {
  id: string;
  name: string;
  unit: string;
  listPrice: number; // per unit / year
  category: string;
}

const now = new Date('2026-07-24T09:00:00Z');
const iso = (daysFromNow: number, hours = 9): string => {
  const d = new Date(now);
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hours, 0, 0, 0);
  return d.toISOString();
};
const date = (daysFromNow: number): string => iso(daysFromNow).slice(0, 10);

export const REPS = [
  'Alex Rivera',
  'Sarah Jenkins',
  'Michael Chen',
  'Priya Nair',
] as const;

export const DEAL_STAGES: { key: DealStage; label: string; color: string }[] = [
  { key: 'lead', label: 'Lead', color: '#64748b' },
  { key: 'discovery', label: 'Discovery', color: '#3b82f6' },
  { key: 'proposal', label: 'Proposal', color: '#8b5cf6' },
  { key: 'negotiation', label: 'Negotiation', color: '#f59e0b' },
  { key: 'closed_won', label: 'Closed Won', color: '#10b981' },
  { key: 'closed_lost', label: 'Closed Lost', color: '#ef4444' },
];

export const b2bAccounts: B2bAccount[] = [
  { id: 'acc-01', name: 'Acme Corporation', domain: 'acme.com', industry: 'Manufacturing', employees: 4200, location: 'Chicago, IL', owner: 'Sarah Jenkins', health: 'watch', arr: 0, renewalDate: null, createdAt: iso(-120) },
  { id: 'acc-02', name: 'Starlight Technologies', domain: 'starlight.io', industry: 'Software', employees: 640, location: 'Austin, TX', owner: 'Alex Rivera', health: 'healthy', arr: 35000, renewalDate: date(300), createdAt: iso(-210) },
  { id: 'acc-03', name: 'Vanguard Systems', domain: 'vanguard.io', industry: 'Financial Services', employees: 9800, location: 'New York, NY', owner: 'Sarah Jenkins', health: 'healthy', arr: 0, renewalDate: null, createdAt: iso(-95) },
  { id: 'acc-04', name: 'Nexus Data Corp', domain: 'nexusdata.com', industry: 'Data & Analytics', employees: 1200, location: 'Seattle, WA', owner: 'Michael Chen', health: 'watch', arr: 0, renewalDate: null, createdAt: iso(-64) },
  { id: 'acc-05', name: 'OmniGlobal Inc', domain: 'omniglobal.com', industry: 'Logistics', employees: 22000, location: 'Atlanta, GA', owner: 'Alex Rivera', health: 'healthy', arr: 480000, renewalDate: date(360), createdAt: iso(-320) },
  { id: 'acc-06', name: 'Brightpath Health', domain: 'brightpath.health', industry: 'Healthcare', employees: 3100, location: 'Boston, MA', owner: 'Priya Nair', health: 'at_risk', arr: 0, renewalDate: null, createdAt: iso(-48) },
  { id: 'acc-07', name: 'Meridian Retail Group', domain: 'meridianretail.com', industry: 'Retail', employees: 15400, location: 'Columbus, OH', owner: 'Priya Nair', health: 'healthy', arr: 72000, renewalDate: date(210), createdAt: iso(-260) },
  { id: 'acc-08', name: 'Ironclad Security', domain: 'ironclad.sec', industry: 'Cybersecurity', employees: 480, location: 'Reston, VA', owner: 'Michael Chen', health: 'watch', arr: 0, renewalDate: null, createdAt: iso(-33) },
  { id: 'acc-09', name: 'Cascade Logistics', domain: 'cascadelog.com', industry: 'Transportation', employees: 6700, location: 'Portland, OR', owner: 'Sarah Jenkins', health: 'healthy', arr: 0, renewalDate: null, createdAt: iso(-52) },
  { id: 'acc-10', name: 'Helio Energy', domain: 'helioenergy.com', industry: 'Energy', employees: 2900, location: 'Denver, CO', owner: 'Alex Rivera', health: 'healthy', arr: 0, renewalDate: null, createdAt: iso(-41) },
  { id: 'acc-11', name: 'Quantum Labs', domain: 'quantumlabs.ai', industry: 'Research', employees: 220, location: 'Palo Alto, CA', owner: 'Michael Chen', health: 'healthy', arr: 24000, renewalDate: date(150), createdAt: iso(-190) },
  { id: 'acc-12', name: 'Northwind Traders', domain: 'northwind.com', industry: 'Wholesale', employees: 1800, location: 'Minneapolis, MN', owner: 'Priya Nair', health: 'watch', arr: 0, renewalDate: null, createdAt: iso(-27) },
  { id: 'acc-13', name: 'Pinnacle Media', domain: 'pinnaclemedia.tv', industry: 'Media', employees: 3400, location: 'Los Angeles, CA', owner: 'Alex Rivera', health: 'healthy', arr: 0, renewalDate: null, createdAt: iso(-19) },
  { id: 'acc-14', name: 'Fjord Manufacturing', domain: 'fjordmfg.com', industry: 'Manufacturing', employees: 5600, location: 'Milwaukee, WI', owner: 'Sarah Jenkins', health: 'at_risk', arr: 0, renewalDate: null, createdAt: iso(-14) },
  { id: 'acc-15', name: 'Aurora Biotech', domain: 'aurorabio.com', industry: 'Biotech', employees: 940, location: 'San Diego, CA', owner: 'Michael Chen', health: 'healthy', arr: 0, renewalDate: null, createdAt: iso(-9) },
];

export const b2bContacts: B2bContact[] = [
  // Acme
  { id: 'con-01', accountId: 'acc-01', name: 'Eleanor Vance', title: 'VP Operations', email: 'e.vance@acme.com', phone: '+1 312-555-0192', buyerRole: 'Economic Buyer', engagement: 92, primary: true },
  { id: 'con-02', accountId: 'acc-01', name: 'David Kim', title: 'CISO', email: 'd.kim@acme.com', phone: '+1 312-555-0177', buyerRole: 'InfoSec', engagement: 61, primary: false },
  { id: 'con-03', accountId: 'acc-01', name: 'Sarah Jenkins', title: 'Director of IT', email: 's.jenkins@acme.com', phone: '+1 312-555-0148', buyerRole: 'Champion', engagement: 88, primary: false },
  // Starlight
  { id: 'con-04', accountId: 'acc-02', name: 'Rachel Green', title: 'Head of Platform', email: 'rachel@starlight.io', phone: '+1 512-555-0144', buyerRole: 'Champion', engagement: 96, primary: true },
  { id: 'con-05', accountId: 'acc-02', name: 'Tom Alvarez', title: 'CFO', email: 'tom@starlight.io', phone: '+1 512-555-0130', buyerRole: 'Economic Buyer', engagement: 70, primary: false },
  // Vanguard
  { id: 'con-06', accountId: 'acc-03', name: 'Marcus Brody', title: 'Procurement Lead', email: 'brody@vanguard.io', phone: '+1 212-555-0166', buyerRole: 'Procurement', engagement: 85, primary: true },
  { id: 'con-07', accountId: 'acc-03', name: 'Lena Patterson', title: 'SVP Technology', email: 'l.patterson@vanguard.io', phone: '+1 212-555-0151', buyerRole: 'Economic Buyer', engagement: 79, primary: false },
  { id: 'con-08', accountId: 'acc-03', name: 'Raj Malhotra', title: 'Security Architect', email: 'raj@vanguard.io', phone: '+1 212-555-0122', buyerRole: 'InfoSec', engagement: 74, primary: false },
  // Nexus
  { id: 'con-09', accountId: 'acc-04', name: 'Elena Rostova', title: 'Data Engineering Manager', email: 'elena@nexusdata.com', phone: '+1 206-555-0111', buyerRole: 'Technical Evaluator', engagement: 68, primary: true },
  { id: 'con-10', accountId: 'acc-04', name: 'Greg Foster', title: 'VP Engineering', email: 'greg@nexusdata.com', phone: '+1 206-555-0109', buyerRole: 'Economic Buyer', engagement: 55, primary: false },
  // OmniGlobal
  { id: 'con-11', accountId: 'acc-05', name: 'Diana Cortez', title: 'COO', email: 'd.cortez@omniglobal.com', phone: '+1 404-555-0188', buyerRole: 'Economic Buyer', engagement: 90, primary: true },
  { id: 'con-12', accountId: 'acc-05', name: 'Paul Nguyen', title: 'IT Director', email: 'p.nguyen@omniglobal.com', phone: '+1 404-555-0175', buyerRole: 'Champion', engagement: 84, primary: false },
  // Brightpath
  { id: 'con-13', accountId: 'acc-06', name: 'Nora Adeyemi', title: 'Chief Medical Info Officer', email: 'nora@brightpath.health', phone: '+1 617-555-0143', buyerRole: 'Economic Buyer', engagement: 48, primary: true },
  { id: 'con-14', accountId: 'acc-06', name: 'Wesley Cho', title: 'Compliance Officer', email: 'wesley@brightpath.health', phone: '+1 617-555-0128', buyerRole: 'InfoSec', engagement: 40, primary: false },
  // Meridian
  { id: 'con-15', accountId: 'acc-07', name: 'Grace Liu', title: 'VP Digital', email: 'grace@meridianretail.com', phone: '+1 614-555-0119', buyerRole: 'Champion', engagement: 87, primary: true },
  // Ironclad
  { id: 'con-16', accountId: 'acc-08', name: 'Victor Hale', title: 'CTO', email: 'victor@ironclad.sec', phone: '+1 703-555-0102', buyerRole: 'Technical Evaluator', engagement: 72, primary: true },
  // Cascade
  { id: 'con-17', accountId: 'acc-09', name: 'Marta Silva', title: 'Ops Director', email: 'marta@cascadelog.com', phone: '+1 503-555-0166', buyerRole: 'Champion', engagement: 81, primary: true },
  // Helio
  { id: 'con-18', accountId: 'acc-10', name: 'Owen Brooks', title: 'VP Infrastructure', email: 'owen@helioenergy.com', phone: '+1 303-555-0155', buyerRole: 'Economic Buyer', engagement: 76, primary: true },
  // Quantum
  { id: 'con-19', accountId: 'acc-11', name: 'Dr. Amara Okoye', title: 'Head of Research', email: 'amara@quantumlabs.ai', phone: '+1 650-555-0144', buyerRole: 'Champion', engagement: 93, primary: true },
  // Northwind
  { id: 'con-20', accountId: 'acc-12', name: 'Hank Morrison', title: 'Operations Manager', email: 'hank@northwind.com', phone: '+1 612-555-0133', buyerRole: 'End User', engagement: 58, primary: true },
  // Pinnacle
  { id: 'con-21', accountId: 'acc-13', name: 'Zoe Bennett', title: 'Head of Product', email: 'zoe@pinnaclemedia.tv', phone: '+1 310-555-0121', buyerRole: 'Champion', engagement: 82, primary: true },
  // Fjord
  { id: 'con-22', accountId: 'acc-14', name: 'Karl Berg', title: 'Plant IT Lead', email: 'karl@fjordmfg.com', phone: '+1 414-555-0110', buyerRole: 'Technical Evaluator', engagement: 44, primary: true },
  // Aurora
  { id: 'con-23', accountId: 'acc-15', name: 'Yuki Tanaka', title: 'VP R&D', email: 'yuki@aurorabio.com', phone: '+1 858-555-0177', buyerRole: 'Economic Buyer', engagement: 80, primary: true },
];

export const b2bDeals: B2bDeal[] = [
  { id: 'deal-01', name: 'Acme Corp — 500 Enterprise Seats', accountId: 'acc-01', stage: 'negotiation', amount: 120000, seats: 500, termMonths: 24, probability: 80, owner: 'Sarah Jenkins', closeDate: date(22), nextStep: 'Close security review with David Kim (CISO)', securityReviewPassed: false, dpaSigned: false, createdAt: iso(-40), updatedAt: iso(-1) },
  { id: 'deal-02', name: 'Starlight Tech — 150 Pro Seats', accountId: 'acc-02', stage: 'proposal', amount: 35000, seats: 150, termMonths: 12, probability: 60, owner: 'Alex Rivera', closeDate: date(8), nextStep: 'Send revised proposal after CFO review', securityReviewPassed: true, dpaSigned: true, createdAt: iso(-28), updatedAt: iso(-2) },
  { id: 'deal-03', name: 'Vanguard Systems — 1,000 Global Seats', accountId: 'acc-03', stage: 'negotiation', amount: 240000, seats: 1000, termMonths: 36, probability: 75, owner: 'Sarah Jenkins', closeDate: date(37), nextStep: 'Legal redlines with procurement', securityReviewPassed: true, dpaSigned: true, createdAt: iso(-35), updatedAt: iso(-3) },
  { id: 'deal-04', name: 'Nexus Data — 250 Security Seats', accountId: 'acc-04', stage: 'discovery', amount: 60000, seats: 250, termMonths: 12, probability: 30, owner: 'Michael Chen', closeDate: date(48), nextStep: 'Technical deep-dive with data eng team', securityReviewPassed: false, dpaSigned: false, createdAt: iso(-20), updatedAt: iso(-4) },
  { id: 'deal-05', name: 'OmniGlobal — 2,000 Enterprise Seats', accountId: 'acc-05', stage: 'closed_won', amount: 480000, seats: 2000, termMonths: 24, probability: 100, owner: 'Alex Rivera', closeDate: date(-4), nextStep: 'Kickoff onboarding', securityReviewPassed: true, dpaSigned: true, createdAt: iso(-90), updatedAt: iso(-4) },
  { id: 'deal-06', name: 'Brightpath Health — 300 Clinical Seats', accountId: 'acc-06', stage: 'discovery', amount: 84000, seats: 300, termMonths: 24, probability: 25, owner: 'Priya Nair', closeDate: date(60), nextStep: 'HIPAA + compliance walkthrough', securityReviewPassed: false, dpaSigned: false, createdAt: iso(-16), updatedAt: iso(-5) },
  { id: 'deal-07', name: 'Meridian Retail — Expansion 400 Seats', accountId: 'acc-07', stage: 'proposal', amount: 96000, seats: 400, termMonths: 24, probability: 55, owner: 'Priya Nair', closeDate: date(29), nextStep: 'Present expansion ROI to VP Digital', securityReviewPassed: true, dpaSigned: true, createdAt: iso(-25), updatedAt: iso(-2) },
  { id: 'deal-08', name: 'Ironclad Security — 120 Seats', accountId: 'acc-08', stage: 'lead', amount: 30000, seats: 120, termMonths: 12, probability: 15, owner: 'Michael Chen', closeDate: date(75), nextStep: 'Qualify budget with CTO', securityReviewPassed: false, dpaSigned: false, createdAt: iso(-10), updatedAt: iso(-6) },
  { id: 'deal-09', name: 'Cascade Logistics — 600 Seats', accountId: 'acc-09', stage: 'negotiation', amount: 132000, seats: 600, termMonths: 24, probability: 70, owner: 'Sarah Jenkins', closeDate: date(18), nextStep: 'Finalize multi-year discount terms', securityReviewPassed: true, dpaSigned: false, createdAt: iso(-30), updatedAt: iso(-1) },
  { id: 'deal-10', name: 'Helio Energy — 200 Seats', accountId: 'acc-10', stage: 'proposal', amount: 48000, seats: 200, termMonths: 12, probability: 50, owner: 'Alex Rivera', closeDate: date(33), nextStep: 'Proposal review call', securityReviewPassed: false, dpaSigned: false, createdAt: iso(-22), updatedAt: iso(-3) },
  { id: 'deal-11', name: 'Quantum Labs — Renewal + 80 Seats', accountId: 'acc-11', stage: 'closed_won', amount: 24000, seats: 80, termMonths: 12, probability: 100, owner: 'Michael Chen', closeDate: date(-12), nextStep: 'Renewal booked', securityReviewPassed: true, dpaSigned: true, createdAt: iso(-45), updatedAt: iso(-12) },
  { id: 'deal-12', name: 'Northwind Traders — 150 Seats', accountId: 'acc-12', stage: 'lead', amount: 27000, seats: 150, termMonths: 12, probability: 10, owner: 'Priya Nair', closeDate: date(90), nextStep: 'Discovery call scheduling', securityReviewPassed: false, dpaSigned: false, createdAt: iso(-8), updatedAt: iso(-7) },
  { id: 'deal-13', name: 'Pinnacle Media — 350 Seats', accountId: 'acc-13', stage: 'discovery', amount: 70000, seats: 350, termMonths: 24, probability: 35, owner: 'Alex Rivera', closeDate: date(52), nextStep: 'Map creative team workflows', securityReviewPassed: false, dpaSigned: false, createdAt: iso(-14), updatedAt: iso(-2) },
  { id: 'deal-14', name: 'Fjord Manufacturing — 500 Seats', accountId: 'acc-14', stage: 'closed_lost', amount: 105000, seats: 500, termMonths: 24, probability: 0, owner: 'Sarah Jenkins', closeDate: date(-6), nextStep: 'Lost to incumbent — revisit Q4', securityReviewPassed: false, dpaSigned: false, createdAt: iso(-38), updatedAt: iso(-6) },
  { id: 'deal-15', name: 'Aurora Biotech — 180 Seats', accountId: 'acc-15', stage: 'proposal', amount: 43000, seats: 180, termMonths: 24, probability: 55, owner: 'Michael Chen', closeDate: date(26), nextStep: 'Send security questionnaire responses', securityReviewPassed: false, dpaSigned: false, createdAt: iso(-9), updatedAt: iso(-1) },
  { id: 'deal-16', name: 'Starlight Tech — Add-on Analytics', accountId: 'acc-02', stage: 'lead', amount: 12000, seats: 0, termMonths: 12, probability: 20, owner: 'Alex Rivera', closeDate: date(44), nextStep: 'Gauge interest in analytics module', securityReviewPassed: true, dpaSigned: true, createdAt: iso(-5), updatedAt: iso(-5) },
];

export const b2bActivities: B2bActivity[] = [
  { id: 'act-01', type: 'meeting', subject: 'Security architecture assessment', body: 'Submitted vendor security questionnaire. Awaiting DPA signature approval from CISO.', accountId: 'acc-01', dealId: 'deal-01', contactId: 'con-02', actor: 'Sarah Jenkins', at: iso(0, 14), done: true, dueAt: null },
  { id: 'act-02', type: 'call', subject: 'Executive alignment & multi-year pricing', body: 'Agreed on 36-month term with 15% commitment discount. Procurement reviewing legal terms.', accountId: 'acc-03', dealId: 'deal-03', contactId: 'con-06', actor: 'Sarah Jenkins', at: iso(-1, 11), done: true, dueAt: null },
  { id: 'act-03', type: 'meeting', subject: 'Platform capabilities walkthrough', body: 'Demonstrated custom entities and REST API extensions to data engineering leads.', accountId: 'acc-04', dealId: 'deal-04', contactId: 'con-09', actor: 'Michael Chen', at: iso(-2, 16), done: true, dueAt: null },
  { id: 'act-04', type: 'task', subject: 'Send revised proposal to Starlight CFO', body: 'Incorporate 12-month pricing and analytics add-on option.', accountId: 'acc-02', dealId: 'deal-02', contactId: 'con-05', actor: 'Alex Rivera', at: iso(1, 10), done: false, dueAt: iso(1, 10) },
  { id: 'act-05', type: 'task', subject: 'Follow up on Cascade discount terms', body: 'Confirm CFO sign-off on multi-year discount.', accountId: 'acc-09', dealId: 'deal-09', contactId: 'con-17', actor: 'Sarah Jenkins', at: iso(0, 9), done: false, dueAt: iso(0, 15) },
  { id: 'act-06', type: 'email', subject: 'Meridian expansion ROI deck', body: 'Sent ROI analysis for 400-seat expansion. Grace to review with finance.', accountId: 'acc-07', dealId: 'deal-07', contactId: 'con-15', actor: 'Priya Nair', at: iso(-2, 13), done: true, dueAt: null },
  { id: 'act-07', type: 'task', subject: 'HIPAA compliance walkthrough — Brightpath', body: 'Prepare compliance & BAA materials for clinical rollout.', accountId: 'acc-06', dealId: 'deal-06', contactId: 'con-14', actor: 'Priya Nair', at: iso(2, 11), done: false, dueAt: iso(2, 11) },
  { id: 'act-08', type: 'note', subject: 'OmniGlobal kickoff scheduled', body: 'Onboarding kickoff set. Diana requested dedicated CSM.', accountId: 'acc-05', dealId: 'deal-05', contactId: 'con-11', actor: 'Alex Rivera', at: iso(-3, 10), done: true, dueAt: null },
  { id: 'act-09', type: 'call', subject: 'Qualify Ironclad budget', body: 'CTO interested but budget not yet approved for this quarter.', accountId: 'acc-08', dealId: 'deal-08', contactId: 'con-16', actor: 'Michael Chen', at: iso(-1, 15), done: true, dueAt: null },
  { id: 'act-10', type: 'task', subject: 'Aurora security questionnaire responses', body: 'Return completed SIG-lite questionnaire.', accountId: 'acc-15', dealId: 'deal-15', contactId: 'con-23', actor: 'Michael Chen', at: iso(1, 14), done: false, dueAt: iso(1, 14) },
  { id: 'act-11', type: 'meeting', subject: 'Pinnacle creative workflow mapping', body: 'Walked through creative approval workflows; strong fit for custom stages.', accountId: 'acc-13', dealId: 'deal-13', contactId: 'con-21', actor: 'Alex Rivera', at: iso(-2, 12), done: true, dueAt: null },
  { id: 'act-12', type: 'task', subject: 'Schedule Northwind discovery call', body: 'Coordinate with Hank on ops team availability.', accountId: 'acc-12', dealId: 'deal-12', contactId: 'con-20', actor: 'Priya Nair', at: iso(3, 10), done: false, dueAt: iso(3, 10) },
  { id: 'act-13', type: 'email', subject: 'Helio proposal review call invite', body: 'Proposed times for proposal review with VP Infrastructure.', accountId: 'acc-10', dealId: 'deal-10', contactId: 'con-18', actor: 'Alex Rivera', at: iso(-1, 9), done: true, dueAt: null },
  { id: 'act-14', type: 'note', subject: 'Fjord lost — competitive', body: 'Chose incumbent on price. Relationship warm; revisit at renewal.', accountId: 'acc-14', dealId: 'deal-14', contactId: 'con-22', actor: 'Sarah Jenkins', at: iso(-6, 16), done: true, dueAt: null },
  { id: 'act-15', type: 'task', subject: 'Vanguard legal redline turnaround', body: 'Review procurement redlines and route to legal.', accountId: 'acc-03', dealId: 'deal-03', contactId: 'con-06', actor: 'Sarah Jenkins', at: iso(0, 12), done: false, dueAt: iso(0, 17) },
];

export const b2bProducts: B2bProduct[] = [
  { id: 'prd-01', name: 'Platform — Enterprise Seat', unit: 'seat/yr', listPrice: 240, category: 'Core' },
  { id: 'prd-02', name: 'Platform — Pro Seat', unit: 'seat/yr', listPrice: 180, category: 'Core' },
  { id: 'prd-03', name: 'Advanced Analytics Module', unit: 'org/yr', listPrice: 15000, category: 'Add-on' },
  { id: 'prd-04', name: 'Dedicated Customer Success Manager', unit: 'org/yr', listPrice: 15000, category: 'Service' },
  { id: 'prd-05', name: 'Premium Support (Platinum SLA)', unit: 'org/yr', listPrice: 24000, category: 'Service' },
  { id: 'prd-06', name: 'SSO & SCIM Provisioning', unit: 'org/yr', listPrice: 6000, category: 'Add-on' },
];

export interface B2bDataset {
  accounts: B2bAccount[];
  contacts: B2bContact[];
  deals: B2bDeal[];
  activities: B2bActivity[];
  products: B2bProduct[];
}

export const b2bDataset: B2bDataset = {
  accounts: b2bAccounts,
  contacts: b2bContacts,
  deals: b2bDeals,
  activities: b2bActivities,
  products: b2bProducts,
};
