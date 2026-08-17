'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/leads', label: 'Leads' },
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/opportunities', label: 'Opportunities' },
  { href: '/outreach', label: 'Outreach' },
  { href: '/clients', label: 'Clients' },
  { href: '/payments', label: 'Payments' }
];

export function Nav() {
  const pathname = usePathname() ?? '';

  return (
    <nav className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
      {LINKS.map((link) => {
        // `trailingSlash: true` in next.config means the live path is
        // "/leads/", and detail pages live below the section root.
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-electric-500/12 text-white'
                : 'text-white/55 hover:bg-white/5 hover:text-white/85'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
