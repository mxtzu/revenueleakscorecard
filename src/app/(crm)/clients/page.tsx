/**
 * Clients — leads that became paying accounts.
 */

import Link from 'next/link';

import { ClientForm } from '@/components/crm/entityForms';
import { ActionError, Disclosure, ReadOnlyNotice } from '@/components/crm/forms';
import { Badge, Card, Cell, EmptyState, PageHeader, Row, StatCard, Table } from '@/components/crm/ui';
import { formatDate, formatRelative } from '@/lib/crm/format';
import { canWrite } from '@/lib/crm/permissions';
import { listAssignableProfiles, listClients, listLeads } from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import type { ClientStatus } from '@/lib/crm/types';

import { saveClient } from '../_actions/crud';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<ClientStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  onboarding: 'warning',
  active: 'positive',
  paused: 'warning',
  cancelled: 'danger',
  churned: 'danger'
};

export default async function ClientsPage({
  searchParams
}: {
  searchParams?: { error?: string };
}) {
  const { client, profile } = await crmSession();
  const [clients, team, leads] = await Promise.all([
    listClients(client),
    listAssignableProfiles(client),
    listLeads(client, { limit: 300 })
  ]);

  const writable = canWrite(profile);
  const people = team.map((member) => ({
    value: member.id,
    label: member.full_name ?? member.email ?? 'Unnamed'
  }));
  const leadOptions = leads.map((lead) => ({
    value: lead.id,
    label: lead.intelligence?.company_name ?? lead.external_lead_id
  }));

  const active = clients.filter((account) => account.status === 'active').length;
  const onboarding = clients.filter((account) => account.status === 'onboarding').length;
  const churned = clients.filter(
    (account) => account.status === 'churned' || account.status === 'cancelled'
  ).length;

  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="Clients"
        description="Won deals, once delivery starts."
      />

      <ActionError message={searchParams?.error} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active" value={active} />
        <StatCard label="Onboarding" value={onboarding} />
        <StatCard label="Churned" value={churned} />
        <StatCard label="Total" value={clients.length} />
      </div>

      <Card className="mb-4">
        {writable ? (
          <Disclosure summary="Create a client" tone="primary">
            <ClientForm
              action={saveClient}
              returnTo="/clients"
              people={people}
              leads={leadOptions}
            />
          </Disclosure>
        ) : (
          <ReadOnlyNotice what="create clients" />
        )}
      </Card>

      <Card title={`${clients.length} client${clients.length === 1 ? '' : 's'}`}>
        {clients.length === 0 ? (
          <EmptyState
            title="No clients yet"
            description="A client record is created when an opportunity is won and delivery begins."
          />
        ) : (
          <Table head={['Client', 'Status', 'Started', 'Renews', 'Added']}>
            {clients.map((account) => (
              <Row key={account.id}>
                <Cell>
                  <Link
                    href={`/clients/${account.id}`}
                    className="font-medium text-white hover:text-electric-300"
                  >
                    {account.company_name}
                  </Link>
                </Cell>
                <Cell>
                  <Badge tone={STATUS_TONE[account.status]}>{account.status}</Badge>
                </Cell>
                <Cell className="whitespace-nowrap text-white/50">{formatDate(account.start_date)}</Cell>
                <Cell className="whitespace-nowrap text-white/50">
                  {formatDate(account.renewal_date)}
                </Cell>
                <Cell className="whitespace-nowrap text-white/35">
                  {formatRelative(account.created_at)}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
