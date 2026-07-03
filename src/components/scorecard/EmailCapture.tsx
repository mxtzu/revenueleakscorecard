"use client";

import { FormEvent, useState } from "react";

type EmailCaptureProps = {
  onSubmit: (input: { email: string; discordUsername: string }) => Promise<void>;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailCapture({ onSubmit }: EmailCaptureProps) {
  const [email, setEmail] = useState("");
  const [discordUsername, setDiscordUsername] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!emailPattern.test(email)) {
      setError("Enter a valid email.");
      return;
    }

    if (!discordUsername.trim()) {
      setError("Enter your Discord username.");
      return;
    }

    setError("");
    setSubmitting(true);

    try {
      await onSubmit({ email: email.trim(), discordUsername: discordUsername.trim() });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="fade-in mx-auto max-w-xl pb-16 pt-12 sm:pt-20">
      <p className="label-mono text-electric-400">Diagnosis Ready</p>
      <h2 className="display mt-4 text-3xl text-white sm:text-4xl">
        Your Leak Is Identified.
      </h2>
      <p className="mt-4 text-sm leading-7 text-slate-300 sm:text-base">
        Enter your email and Discord username to open the diagnosis. We&apos;ll use them
        to follow up on your result — nothing else.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-4" noValidate>
        <div>
          <label htmlFor="email" className="label-mono block text-slate-400">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@studio.gg"
            className="mt-2 block w-full rounded-md border border-line bg-ink-900 px-4 py-3 text-white placeholder:text-slate-600 focus:border-electric-500"
          />
        </div>
        <div>
          <label htmlFor="discord" className="label-mono block text-slate-400">
            Discord Username
          </label>
          <input
            id="discord"
            type="text"
            autoComplete="off"
            value={discordUsername}
            onChange={(event) => setDiscordUsername(event.target.value)}
            placeholder="yourhandle"
            className="mt-2 block w-full rounded-md border border-line bg-ink-900 px-4 py-3 text-white placeholder:text-slate-600 focus:border-electric-500"
          />
        </div>

        {error ? <p className="text-sm text-red-400">{error}</p> : null}

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex min-h-12 w-full items-center justify-center rounded-md bg-electric-500 px-8 text-base font-semibold text-white transition hover:bg-electric-400 disabled:opacity-60"
        >
          {submitting ? "Opening…" : "Show My Diagnosis"}
        </button>
        <p className="label-mono text-slate-500">No List-Blasting · Follow-Up Only</p>
      </form>
    </main>
  );
}
