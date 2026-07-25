import type { BadgeTone } from '../ui/primitives';
import type { VipTier, Segment, OrderStatus, TicketStatus, TicketPriority, ReturnStatus } from '../mock/ecom';

export const tierTone: Record<VipTier, BadgeTone> = { Standard: 'gray', Gold: 'amber', Platinum: 'purple' };
export const segmentTone: Record<Segment, BadgeTone> = { New: 'blue', Active: 'green', 'At-Risk': 'amber', Churned: 'rose', VIP: 'purple' };
export const orderStatusTone: Record<OrderStatus, BadgeTone> = { processing: 'amber', fulfilled: 'blue', shipped: 'blue', delivered: 'green', cancelled: 'gray', refunded: 'rose' };
export const ticketStatusTone: Record<TicketStatus, BadgeTone> = { open: 'rose', pending: 'amber', resolved: 'green', closed: 'gray' };
export const priorityTone: Record<TicketPriority, BadgeTone> = { low: 'gray', normal: 'blue', high: 'amber', urgent: 'rose' };
export const returnStatusTone: Record<ReturnStatus, BadgeTone> = { requested: 'amber', approved: 'blue', rejected: 'rose', restocked: 'green' };
