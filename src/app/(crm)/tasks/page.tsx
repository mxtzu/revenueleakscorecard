/**
 * Tasks — everything open, overdue first.
 *
 * Grouped rather than sorted into one list: "overdue" and "due later" call for
 * different responses, and a single sorted list buries the distinction.
 */

import Link from 'next/link';

import { Badge, Card, Cell, EmptyState, PageHeader, Row, Table } from '@/components/crm/ui';
import { formatDateTime, formatRelative, humanise, isOverdue } from '@/lib/crm/format';
import { listOpenTasks } from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import type { Task, TaskPriority } from '@/lib/crm/types';

export const dynamic = 'force-dynamic';

const PRIORITY_TONE: Record<TaskPriority, 'neutral' | 'warning' | 'danger'> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger'
};

function TaskTable({ tasks }: { tasks: Task[] }) {
  return (
    <Table head={['Task', 'Lead', 'Due', 'Priority', 'Status']}>
      {tasks.map((task) => (
        <Row key={task.id}>
          <Cell>
            <span className="font-medium text-white/90">{task.title}</span>
            {task.description ? (
              <p className="mt-0.5 line-clamp-1 text-xs text-white/35">{task.description}</p>
            ) : null}
          </Cell>
          <Cell>
            {task.crm_lead_id ? (
              <Link href={`/leads/${task.crm_lead_id}`} className="text-electric-300 hover:underline">
                Open lead
              </Link>
            ) : task.client_id ? (
              <Link href={`/clients/${task.client_id}`} className="text-electric-300 hover:underline">
                Open client
              </Link>
            ) : (
              <span className="text-white/30">—</span>
            )}
          </Cell>
          <Cell
            className={`whitespace-nowrap ${isOverdue(task.due_at) ? 'text-rose-300' : 'text-white/50'}`}
            title={formatDateTime(task.due_at)}
          >
            {formatRelative(task.due_at)}
          </Cell>
          <Cell>
            <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
          </Cell>
          <Cell className="text-white/50">{humanise(task.status)}</Cell>
        </Row>
      ))}
    </Table>
  );
}

export default async function TasksPage() {
  const tasks = await listOpenTasks(crmClient());

  const overdue = tasks.filter((task) => isOverdue(task.due_at));
  const scheduled = tasks.filter((task) => task.due_at && !isOverdue(task.due_at));
  const undated = tasks.filter((task) => !task.due_at);

  return (
    <>
      <PageHeader
        eyebrow="Work"
        title="Tasks"
        description="Open and in-progress tasks across every lead and client."
      />

      {tasks.length === 0 ? (
        <EmptyState
          title="No open tasks"
          description="Tasks are created against a lead or a client as follow-ups get scheduled."
        />
      ) : (
        <div className="space-y-4">
          {overdue.length ? (
            <Card title={`Overdue (${overdue.length})`}>
              <TaskTable tasks={overdue} />
            </Card>
          ) : null}
          {scheduled.length ? (
            <Card title={`Scheduled (${scheduled.length})`}>
              <TaskTable tasks={scheduled} />
            </Card>
          ) : null}
          {undated.length ? (
            <Card title={`No due date (${undated.length})`}>
              <TaskTable tasks={undated} />
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
