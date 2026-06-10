"use client";

import { FormEvent, useState } from "react";
import { AtSign, LockKeyhole, Mail } from "lucide-react";

type EmailCaptureProps = {
  onSubmit: (input: { email: string; discordUsername: string }) => Promise<void>;
};

export function EmailCapture({ onSubmit }: EmailCaptureProps) {
  const [email, setEmail] = useState("");
  const [discordUsername, setDiscordUsername] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedDiscordUsername = discordUsername.trim();
    const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);

    if (!isValid) {
      setError("Enter a valid work email to unlock the full breakdown.");
      return;
    }

    if (!trimmedDiscordUsername) {
      setError("Enter your Discord username so ASCEND can match the audit request.");
      return;
    }

    setError("");
    setIsSubmitting(true);

    try {
      await onSubmit({
        email: trimmedEmail,
        discordUsername: trimmedDiscordUsername
      });
    } catch {
      setError("Something blocked the submission. Try again in a moment.");
      setIsSubmitting(false);
    }
  }

  return (
    <section className="mx-auto grid min-h-[calc(100vh-96px)] max-w-2xl place-items-center py-10">
      <div className="print-panel w-full rounded-lg border border-white/10 bg-ink-850 p-6 shadow-blue-glow sm:p-8">
        <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-md border border-electric-400/30 bg-electric-500/10 text-electric-400">
          <LockKeyhole className="h-5 w-5" aria-hidden="true" />
        </div>
        <p className="text-xs uppercase tracking-[0.22em] text-electric-400">
          Score ready
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-white sm:text-4xl">
          Enter your email to unlock the full breakdown.
        </h1>
        <p className="mt-4 leading-7 text-slate-300">
          The full result includes your revenue leak band, category breakdown,
          weakest lifecycle constraints, and recommended next move.
        </p>

        <form className="mt-7 space-y-4" onSubmit={handleSubmit}>
          <label className="block" htmlFor="email">
            <span className="mb-2 block text-sm font-medium text-slate-200">
              Work email
            </span>
            <div className="relative">
              <Mail
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden="true"
              />
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="operator@studio.com"
                className="min-h-12 w-full rounded-md border border-white/10 bg-ink-950 py-3 pl-10 pr-3 text-white placeholder:text-slate-600"
              />
            </div>
          </label>

          <label className="block" htmlFor="discord-username">
            <span className="mb-2 block text-sm font-medium text-slate-200">
              Discord username
            </span>
            <div className="relative">
              <AtSign
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden="true"
              />
              <input
                id="discord-username"
                type="text"
                value={discordUsername}
                onChange={(event) => setDiscordUsername(event.target.value)}
                placeholder="studiolead or studiolead#1234"
                className="min-h-12 w-full rounded-md border border-white/10 bg-ink-950 py-3 pl-10 pr-3 text-white placeholder:text-slate-600"
              />
            </div>
          </label>

          {error ? <p className="text-sm text-rose-300">{error}</p> : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-md bg-electric-500 px-5 py-3 text-sm font-semibold text-ink-950 transition hover:bg-electric-400"
          >
            {isSubmitting ? "Preparing results..." : "Show full results"}
          </button>
        </form>
      </div>
    </section>
  );
}
