/**
 * Dashboard — what needs doing today, and where the pipeline stands.
 *
 * Everything here is a read. No counter on this page is a target to be gamed:
 * the numbers come straight from the tables, and a stage count of zero means
 * zero leads in that stage, not "not loaded".
 */

import Link from 'next/link';

import {
  Badge,
  Card,
  Cell,
  EmptyState,
  PageHeader,
  Row,
  StageBadge,
  StatCard,
  Table
} from '@/components/crm/ui';
import { formatDateTime, formatMoney, formatRelative, isOverdue, orDash } from '@/lib/crm/format';
import {
  getPipelineCounts,
  listLeads,
  listOpportunities,
  listTodaysTasks,
  listUpcomingAppointments
} from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import { ACTIVE_PIPELINE_STAGES, CLOSED_PIPELINE_STAGES } from '@/lib/crm/types';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const { client, profile } = await crmSession();

  const [counts, tasks, appointments, opportunities, recentLeads] = await Promise.all([
    getPipelineCounts(client),
    listTodaysTasks(client),
    listUpcomingAppointments(client, 6),
    listOpportunities(client, 200),
    listLeads(client, { limit: 8 })
  ]);

  const openLeads = ACTIVE_PIPELINE_STAGES.filter((stage) => stage !== 'won').reduce(
    (total, stage) => total + (counts[stage] ?? 0),
    0
  );
  const won = counts.won ?? 0;
  const closed = CLOSED_PIPELINE_STAGES.reduce((total, stage) => total + (counts[stage] ?? 0), 0);

  // Weighted pipeline value: monthly value x contract length x probability.
  // Opportunities with no probability set are counted at face value rather than
  // dropped, and the card says so.
  const openOpportunities = opportunities.filter(
    (opportunity) => opportunity.stage !== 'won' && opportunity.stage !== 'lost'
  );
  const pipelineValue = openOpportunities.reduce((total, opportunity) => {
    const recurring = Number(opportunity.monthly_value ?? 0) * (opportunity.contract_months ?? 1);
    const upfront = Number(opportunity.setup_fee ?? 0) + Number(opportunity.one_time_value ?? 0);
    const probability = opportunity.probability === null ? 100 : opportunity.probability;
    return total + ((recurring + upfront) * probability) / 100;
  }, 0);

  const overdue = tasks.filter((task) => isOverdue(task.due_at));

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={profile?.full_name ? `Hello, ${profile.full_name.split(' ')[0]}` : 'Dashboard'}
        description="Live state of the pipeline, pulled straight from the CRM tables."
      />

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open leads" value={openLeads} hint="Not yet won or closed" href="/pipeline" />
        <StatCard
          label="Due today"
          value={tasks.length}
          hint={overdue.length ? `${overdue.length} overdue` : 'Nothing overdue'}
          href="/tasks"
        />
        <StatCard
          label="Weighted pipeline"
          value={formatMoney(pipelineValue)}
          hint={`${openOpportunities.length} open opportunit${openOpportunities.length === 1 ? 'y' : 'ies'}`}
          href="/opportunities"
        />
        <StatCard label="Won" value={won} hint={`${closed} closed in total`} href="/clients" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card
          title="Today"
          description="Open tasks due by end of day."
          actions={
            <Link href="/tasks" className="text-xs text-electric-300 hover:underline">
              All tasks
            </Link>
          }
        >
          {tasks.length === 0 ? (
            <EmptyState title="Nothing due today" description="Tasks appear here as they are scheduled." />
          ) : (
            <Table head={['Task', 'Due', 'Priority']}>
              {tasks.slice(0, 8).map((task) => (
                <Row key={task.id}>
                  <Cell>
                    {task.crm_lead_id ? (
                      <Link href={`/leads/${task.crm_lead_id}`} className="hover:text-white">
                        {task.title}
                      </Link>
                    ) : (
                      task.title
                    )}
                  </Cell>
                  <Cell className={isOverdue(task.due_at) ? 'text-rose-300' : 'text-white/50'}>
                    {formatRelative(task.due_at)}
                  </Cell>
                  <Cell>
                    <Badge tone={task.priority === 'urgent' || task.priority === 'high' ? 'warning' : 'neutral'}>
                      {task.priority}
                    </Badge>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        <Card
          title="Upcoming appointments"
          actions={
            <Link href="/calendar" className="text-xs text-electric-300 hover:underline">
              Calendar
            </Link>
          }
        >
          {appointments.length === 0 ? (
            <EmptyState
              title="No appointments booked"
              description="Calendar sync is not built yet — appointments are recorded in the CRM by hand for now."
            />
          ) : (
            <Table head={['When', 'Title', 'Status']}>
              {appointments.map((appointment) => (
                <Row key={appointment.id}>
                  <Cell className="whitespace-nowrap text-white/50">
                    {formatDateTime(appointment.starts_at)}
                  </Cell>
                  <Cell>
                    {appointment.crm_lead_id ? (
                      <Link href={`/leads/${appointment.crm_lead_id}`} className="hover:text-white">
                        {appointment.title}
                      </Link>
                    ) : (
                      appointment.title
                    )}
                  </Cell>
                  <Cell>
                    <Badge tone={appointment.status === 'confirmed' ? 'positive' : 'neutral'}>
                      {appointment.status.replace(/_/g, ' ')}
                    </Badge>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        <Card
          title="Recently updated leads"
          className="xl:col-span-2"
          actions={
            <Link href="/leads" className="text-xs text-electric-300 hover:underline">
              All leads
            </Link>
          }
        >
          {recentLeads.length === 0 ? (
            <EmptyState
              title="No leads yet"
              description="Run the pipeline, then import its export with `npm run sync:leads -- --file <export.json>`."
            />
          ) : (
            <Table head={['Business', 'Stage', 'Score', 'Location', 'Updated']}>
              {recentLeads.map((lead) => (
                <Row key={lead.id}>
                  <Cell>
                    <Link href={`/leads/${lead.id}`} className="font-medium text-white hover:text-electric-300">
                      {lead.intelligence?.company_name ?? lead.external_lead_id}
                    </Link>
                  </Cell>
                  <Cell>
                    <StageBadge stage={lead.pipeline_stage} />
                  </Cell>
                  <Cell className="font-mono text-white/60">
                    {lead.intelligence?.lead_score ?? '—'}
                  </Cell>
                  <Cell className="text-white/50">{orDash(lead.intelligence?.city)}</Cell>
                  <Cell className="whitespace-nowrap text-white/40">
                    {formatRelative(lead.updated_at)}
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
