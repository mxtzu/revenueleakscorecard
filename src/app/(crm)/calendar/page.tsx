/**
 * Calendar — upcoming appointments, grouped by day.
 *
 * Manual entries only. Google Calendar OAuth and Meet link generation are
 * explicitly out of scope for this build, so the page says so rather than
 * showing an empty grid that looks broken.
 */

import Link from 'next/link';

import { Badge, Card, EmptyState, PageHeader } from '@/components/crm/ui';
import { formatTime, humanise, orDash } from '@/lib/crm/format';
import { listUpcomingAppointments } from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import type { Appointment, AppointmentStatus } from '@/lib/crm/types';

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

export default async function CalendarPage() {
  const appointments = await listUpcomingAppointments(crmClient(), 100);

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
