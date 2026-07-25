import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronRight, Send, User, ShoppingBag, DollarSign } from 'lucide-react';
import { useEcom } from '../../data/ecomStore';
import { useToast } from '../../ui/Toast';
import { Badge, Panel, EmptyState, Avatar } from '../../ui/primitives';
import { currency, dateTime } from '../../lib/format';
import { ticketStatusTone, priorityTone, tierTone } from '../meta';
import type { TicketStatus } from '../../mock/ecom';

export function TicketDetail() {
  const { id = '' } = useParams();
  const { ticketById, customerById, orderById, replyTicket, setTicketStatus } = useEcom();
  const toast = useToast();
  const [reply, setReply] = useState('');

  const ticket = ticketById(id);
  if (!ticket) return <EmptyState title="Ticket not found" action={<Link to="/ecom/support" className="btn btn-secondary">Back to support</Link>} />;
  const cust = customerById(ticket.customerId);
  const order = ticket.orderId ? orderById(ticket.orderId) : undefined;

  const send = () => {
    if (!reply.trim()) return;
    replyTicket(ticket.id, reply.trim(), ticket.assignee);
    setReply('');
    toast.success('Reply sent');
  };
  const changeStatus = (s: TicketStatus) => { setTicketStatus(ticket.id, s); toast.info(`Ticket marked ${s}`); };

  return (
    <>
      <div className="breadcrumb"><Link to="/ecom/support">Support</Link> <ChevronRight size={13} /> <span>{ticket.number}</span></div>
      <div className="page-head">
        <div><h1 className="page-title">{ticket.subject}</h1><p className="page-sub">{ticket.number} · {ticket.category} · assigned to {ticket.assignee}</p></div>
        <div className="row"><Badge tone={priorityTone[ticket.priority]}>{ticket.priority}</Badge><Badge tone={ticketStatusTone[ticket.status]}>{ticket.status}</Badge></div>
      </div>

      <div className="grid-2">
        <Panel title="Conversation">
          <div className="thread">
            {ticket.messages.map((m) => (
              <div key={m.id} className={`msg ${m.fromCustomer ? 'customer' : 'agent'}`}>
                <div className="msg-meta">{m.author} · {dateTime(m.at)}</div>
                {m.body}
              </div>
            ))}
          </div>
          <div className="mt-16">
            <div className="field"><textarea rows={3} placeholder="Write a reply…" value={reply} onChange={(e) => setReply(e.target.value)} /></div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row gap-8">
                {ticket.status !== 'resolved' && <button className="btn btn-secondary btn-sm" onClick={() => changeStatus('resolved')}>Mark resolved</button>}
                {ticket.status !== 'closed' && <button className="btn btn-ghost btn-sm" onClick={() => changeStatus('closed')}>Close</button>}
              </div>
              <button className="btn btn-ecom" disabled={!reply.trim()} onClick={send}><Send size={15} /> Send reply</button>
            </div>
          </div>
        </Panel>

        <Panel title="Customer context">
          {cust ? (
            <>
              <div className="list-item">
                <Avatar name={cust.name} size={40} />
                <div style={{ flex: 1 }}><div className="fw-600">{cust.name}</div><div className="text-xs text-dim">{cust.email}</div></div>
                <Badge tone={tierTone[cust.vipTier]}>{cust.vipTier}</Badge>
              </div>
              <div className="prop-row"><span className="prop-label"><DollarSign size={13} /> Lifetime value</span><span className="prop-value text-emerald">{currency(cust.ltv)}</span></div>
              <div className="prop-row"><span className="prop-label"><ShoppingBag size={13} /> Orders</span><span className="prop-value">{cust.orderCount}</span></div>
              <div className="prop-row"><span className="prop-label">Segment</span><span className="prop-value">{cust.segment}</span></div>
              {order && (
                <div className="mt-16">
                  <div className="text-xs text-dim mb-8">Linked order</div>
                  <Link to={`/ecom/orders/${order.id}`} className="list-item" style={{ color: 'inherit' }}>
                    <ShoppingBag size={16} className="text-dim" />
                    <div style={{ flex: 1 }}><div className="text-sm fw-600 cell-mono">{order.number}</div><div className="text-xs text-dim">{order.items.map((i) => i.name).join(', ')}</div></div>
                    <span className="cell-mono text-emerald">{currency(order.total)}</span>
                  </Link>
                </div>
              )}
              <Link to={`/ecom/customers/${cust.id}`} className="btn btn-secondary full-width mt-16"><User size={15} /> View customer 360</Link>
            </>
          ) : <EmptyState title="Customer unavailable" />}
        </Panel>
      </div>
    </>
  );
}
