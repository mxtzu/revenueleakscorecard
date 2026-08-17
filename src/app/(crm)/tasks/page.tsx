/**
 * Tasks — everything open, overdue first.
 *
 * Grouped rather than sorted into one list: "overdue" and "due later" call for
 * different responses, and a single sorted list buries the distinction.
 */

import Link from 'next/link';

import { TaskForm } from '@/components/crm/entityForms';
import { ActionError, DeleteForm, Disclosure, ReadOnlyNotice } from '@/components/crm/forms';
import { Badge, Card, Cell, EmptyState, PageHeader, Row, Table } from '@/components/crm/ui';
import { formatDateTime, formatRelative, humanise, isOverdue } from '@/lib/crm/format';
import { canWrite, isAdmin } from '@/lib/crm/permissions';
import { listAssignableProfiles, listOpenTasks } from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import type { Task, TaskPriority } from '@/lib/crm/types';

import { markTask, removeTask, saveTask } from '../_actions/crud';

export const dynamic = 'force-dynamic';

interface Editing {
  writable: boolean;
  deletable: boolean;
  people: { value: string; label: string }[];
}

const PRIORITY_TONE: Record<TaskPriority, 'neutral' | 'warning' | 'danger'> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger'
};

function TaskTable({ tasks, editing }: { tasks: Task[]; editing: Editing }) {
  return (
    <Table head={['Task', 'Lead', 'Due', 'Priority', 'Status', '']}>
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
          <Cell>
            {editing.writable ? (
              <div className="flex flex-col items-start gap-1.5">
                {task.status !== 'completed' ? (
                  <form action={markTask}>
                    <input type="hidden" name="id" value={task.id} />
                    <input type="hidden" name="status" value="completed" />
                    <input type="hidden" name="return_to" value="/tasks" />
                    <button
                      type="submit"
                      className="whitespace-nowrap rounded-lg border border-line px-2.5 py-1 text-xs text-white/70 hover:border-emerald-400/50 hover:text-emerald-200"
                    >
                      Mark done
                    </button>
                  </form>
                ) : (
                  <form action={markTask}>
                    <input type="hidden" name="id" value={task.id} />
                    <input type="hidden" name="status" value="pending" />
                    <input type="hidden" name="return_to" value="/tasks" />
                    <button
                      type="submit"
                      className="whitespace-nowrap rounded-lg border border-line px-2.5 py-1 text-xs text-white/50 hover:text-white/80"
                    >
                      Reopen
                    </button>
                  </form>
                )}
                <Disclosure summary="Edit">
                  <div className="min-w-[280px] py-2">
                    <TaskForm
                      action={saveTask}
                      returnTo="/tasks"
                      task={task}
                      people={editing.people}
                    />
                  </div>
                </Disclosure>
                <DeleteForm
                  action={removeTask}
                  id={task.id}
                  hidden={{ return_to: '/tasks' }}
                  label="Delete"
                  warning="This task will be removed permanently."
                  allowed={editing.deletable}
                />
              </div>
            ) : null}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

export default async function TasksPage({
  searchParams
}: {
  searchParams?: { error?: string };
}) {
  const { client, profile } = await crmSession();
  const [tasks, team] = await Promise.all([
    listOpenTasks(client),
    listAssignableProfiles(client)
  ]);

  const editing: Editing = {
    writable: canWrite(profile),
    deletable: isAdmin(profile),
    people: team.map((member) => ({
      value: member.id,
      label: member.full_name ?? member.email ?? 'Unnamed'
    }))
  };

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

      <ActionError message={searchParams?.error} />

      <Card className="mb-4">
        {editing.writable ? (
          <Disclosure summary="Add a task" tone="primary">
            <TaskForm action={saveTask} returnTo="/tasks" people={editing.people} />
          </Disclosure>
        ) : (
          <ReadOnlyNotice what="create tasks" />
        )}
      </Card>

      {tasks.length === 0 ? (
        <EmptyState
          title="No open tasks"
          description="Tasks are created against a lead or a client as follow-ups get scheduled."
        />
      ) : (
        <div className="space-y-4">
          {overdue.length ? (
            <Card title={`Overdue (${overdue.length})`}>
              <TaskTable tasks={overdue} editing={editing} />
            </Card>
          ) : null}
          {scheduled.length ? (
            <Card title={`Scheduled (${scheduled.length})`}>
              <TaskTable tasks={scheduled} editing={editing} />
            </Card>
          ) : null}
          {undated.length ? (
            <Card title={`No due date (${undated.length})`}>
              <TaskTable tasks={undated} editing={editing} />
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
