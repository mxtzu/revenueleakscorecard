/**
 * Calendar — upcoming appointments, grouped by day.
 *
 * Manual entries only. Google Calendar OAuth and Meet link generation are
 * explicitly out of scope for this build, so the page says so rather than
 * showing an empty grid that looks broken.
 */

import Link from 'next/link';

import { AppointmentForm } from '@/components/crm/entityForms';
import { ActionError, DeleteForm, Disclosure, ReadOnlyNotice } from '@/components/crm/forms';
import { Badge, Card, EmptyState, PageHeader } from '@/components/crm/ui';
import { formatTime, humanise, orDash } from '@/lib/crm/format';
import { canWrite, isAdmin } from '@/lib/crm/permissions';
import { listUpcomingAppointments } from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import { APPOINTMENT_STATUSES, type Appointment, type AppointmentStatus } from '@/lib/crm/types';

import { markAppointment, removeAppointment, saveAppointment } from '../_actions/crud';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<AppointmentStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  scheduled: 'neutral',
  confirmed: 'positive',
  completed: 'positive',
  no_show: 'danger',
  cancelled: 'danger',
  rescheduled: 'warning'
};

function dayKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function dayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
  }).format(date);
}

export default async function CalendarPage({
  searchParams
}: {
  searchParams?: { error?: string };
}) {
  const { client, profile } = await crmSession();
  const appointments = await listUpcomingAppointments(client, 100);
  const writable = canWrite(profile);
  const deletable = isAdmin(profile);

  const byDay = new Map<string, Appointment[]>();
  for (const appointment of appointments) {
    const key = dayKey(appointment.starts_at);
    const bucket = byDay.get(key) ?? [];
    bucket.push(appointment);
    byDay.set(key, bucket);
  }
  const days = Array.from(byDay.keys()).sort();

  return (
    <>
      <PageHeader
        eyebrow="Schedule"
        title="Calendar"
        description="Upcoming appointments recorded in the CRM."
      />

      <ActionError message={searchParams?.error} />

      <Card className="mb-4">
        {writable ? (
          <Disclosure summary="Book an appointment" tone="primary">
            <AppointmentForm action={saveAppointment} returnTo="/calendar" />
          </Disclosure>
        ) : (
          <ReadOnlyNotice what="book appointments" />
        )}
      </Card>

      {days.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          description="Appointments are entered against a lead. Google Calendar and Meet integration are not part of this build."
        />
      ) : (
        <div className="space-y-4">
          {days.map((day) => (
            <Card key={day} title={dayLabel(day)}>
              <ul className="space-y-2">
                {(byDay.get(day) ?? []).map((appointment) => (
                  <li
                    key={appointment.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft px-3 py-2.5"
                  >
                    <span className="font-mono text-sm text-electric-300">
                      {formatTime(appointment.starts_at)}
                      {appointment.ends_at ? `–${formatTime(appointment.ends_at)}` : ''}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-white/85">
                      {appointment.crm_lead_id ? (
                        <Link href={`/leads/${appointment.crm_lead_id}`} className="hover:text-white">
                          {appointment.title}
                        </Link>
                      ) : (
                        appointment.title
                      )}
                    </span>
                    <span className="text-xs text-white/30">{orDash(appointment.timezone)}</span>
                    <Badge tone={STATUS_TONE[appointment.status]}>
                      {humanise(appointment.status)}
                    </Badge>

                    {writable ? (
                      <div className="w-full space-y-2 border-t border-line-soft pt-2">
                        <div className="flex flex-wrap gap-1.5">
                          {APPOINTMENT_STATUSES.filter(
                            (status) => status !== appointment.status
                          ).map((status) => (
                            <form action={markAppointment} key={status}>
                              <input type="hidden" name="id" value={appointment.id} />
                              <input type="hidden" name="status" value={status} />
                              <input type="hidden" name="return_to" value="/calendar" />
                              <button
                                type="submit"
                                className="rounded-lg border border-line px-2 py-0.5 text-[11px] text-white/55 hover:border-electric-500/50 hover:text-white/85"
                              >
                                {humanise(status)}
                              </button>
                            </form>
                          ))}
                        </div>
                        <Disclosure summary="Edit">
                          <AppointmentForm
                            action={saveAppointment}
                            returnTo="/calendar"
                            appointment={appointment}
                          />
                        </Disclosure>
                        <DeleteForm
                          action={removeAppointment}
                          id={appointment.id}
                          hidden={{ return_to: '/calendar' }}
                          label="Delete"
                          warning="Prefer cancelled or no-show above — a meeting that did not happen is a fact worth keeping."
                          allowed={deletable}
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
