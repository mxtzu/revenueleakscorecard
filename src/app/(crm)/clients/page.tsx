/**
 * Clients — leads that became paying accounts.
 */

import Link from 'next/link';

import { Badge, Card, Cell, EmptyState, PageHeader, Row, StatCard, Table } from '@/components/crm/ui';
import { formatDate, formatRelative } from '@/lib/crm/format';
import { listClients } from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import type { ClientStatus } from '@/lib/crm/types';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<ClientStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  onboarding: 'warning',
  active: 'positive',
  paused: 'warning',
  cancelled: 'danger',
  churned: 'danger'
};

export default async function ClientsPage() {
  const clients = await listClients(crmClient());

  const active = clients.filter((client) => client.status === 'active').length;
  const onboarding = clients.filter((client) => client.status === 'onboarding').length;
  const churned = clients.filter(
    (client) => client.status === 'churned' || client.status === 'cancelled'
  ).length;

  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="Clients"
        description="Won deals, once delivery starts."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active" value={active} />
        <StatCard label="Onboarding" value={onboarding} />
        <StatCard label="Churned" value={churned} />
        <StatCard label="Total" value={clients.length} />
      </div>

      <Card title={`${clients.length} client${clients.length === 1 ? '' : 's'}`}>
        {clients.length === 0 ? (
          <EmptyState
            title="No clients yet"
            description="A client record is created when an opportunity is won and delivery begins."
          />
        ) : (
          <Table head={['Client', 'Status', 'Started', 'Renews', 'Added']}>
            {clients.map((client) => (
              <Row key={client.id}>
                <Cell>
                  <Link
                    href={`/clients/${client.id}`}
                    className="font-medium text-white hover:text-electric-300"
                  >
                    {client.company_name}
                  </Link>
                </Cell>
                <Cell>
                  <Badge tone={STATUS_TONE[client.status]}>{client.status}</Badge>
                </Cell>
                <Cell className="whitespace-nowrap text-white/50">{formatDate(client.start_date)}</Cell>
                <Cell className="whitespace-nowrap text-white/50">
                  {formatDate(client.renewal_date)}
                </Cell>
                <Cell className="whitespace-nowrap text-white/35">
                  {formatRelative(client.created_at)}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
