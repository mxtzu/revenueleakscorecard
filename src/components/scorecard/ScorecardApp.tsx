"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type AnswerValue = 0 | 1 | 2 | 3 | 4;
type Answers = Record<number, AnswerValue>;

const answerOptions: { value: AnswerValue; label: string }[] = [
  { value: 0, label: "Not in place" },
  { value: 1, label: "Weak / unclear" },
  { value: 2, label: "Partially in place" },
  { value: 3, label: "Mostly in place" },
  { value: 4, label: "Strong / consistently measured" }
];

const categories = [
  {
    id: "acquisition",
    name: "Acquisition Leak",
    shortName: "Acquisition",
    definition: "The studio is bringing in players before confirming whether those sources produce retained, monetising users.",
    diagnosis: "You may be judging acquisition by volume instead of downstream value. More visits do not automatically mean more retained spenders.",
    action: "Compare each source by D1 retention, payer conversion, revenue per user, and payback before scaling."
  },
  {
    id: "activation",
    name: "Activation Leak",
    shortName: "Activation",
    definition: "Players arrive but fail to understand the loop, feel progress, or reach the first meaningful engagement moment quickly enough.",
    diagnosis: "Players may be entering the game before the value loop becomes clear. If the first session fails, monetisation never gets a fair chance.",
    action: "Map the first 60 seconds and identify where players stall, leave, or fail to understand the next action."
  },
  {
    id: "monetisation",
    name: "Monetisation Leak",
    shortName: "Monetisation",
    definition: "Players engage but too few convert, spend again, or understand the value of paid offers.",
    diagnosis: "Your offers may exist, but the path from engagement to first purchase may not be clear, timely, or valuable enough.",
    action: "Review first-purchase timing, store visibility, offer ladder structure, and pricing logic."
  },
  {
    id: "measurement",
    name: "Measurement Leak",
    shortName: "Measurement",
    definition: "The team has data, but not enough decision-ready instrumentation to know what to fix first.",
    diagnosis: "You may have dashboards without a decision system. Data only helps if it tells the team what to fix next.",
    action: "Build a KPI tree and experiment backlog tied to retention, payer conversion, ARPPU, ARPDAU, and payback."
  },
  {
    id: "compounding",
    name: "Compounding Leak",
    shortName: "Compounding",
    definition: "Growth work happens in fragments, so updates, ads, creators, monetisation, and analytics do not stack into a stronger revenue system.",
    diagnosis: "Your team may be working hard in separate lanes, but the gains are not stacking into one revenue system.",
    action: "Create a shared 30/60/90-day growth roadmap connecting live ops, monetisation, acquisition, and analytics."
  }
];

const questions = [
  [1, "acquisition", "Do you know which acquisition sources bring your highest-value players, not just the cheapest visits?", "Look for source quality: retained players, payer conversion, revenue per user, and payback."],
  [2, "acquisition", "Do you compare retention and payer behaviour by source/channel?", "A channel that looks cheap can become expensive if D1/D7 retention or payer behaviour is weak."],
  [3, "acquisition", "Before increasing spend, do you know whether cold traffic can pay back?", "Scale with payback, not guesswork. Cold traffic should be judged against cohort quality."],
  [4, "activation", "Can a new player understand what to do and why it matters within the first 60 seconds?", "The first session should make the core loop, progress signal, and next action obvious."],
  [5, "activation", "Do you actively track or review where new players drop off in the first session?", "Activation leaks often hide inside spawn flow, tutorial friction, unclear goals, or early confusion."],
  [6, "activation", "Have you tested onboarding, tutorial, spawn flow, or first-session clarity in the last 30-60 days?", "Live-service games need repeated activation pressure tests as content and audiences change."],
  [7, "monetisation", "Is your first-purchase path obvious, well-timed, and connected to player motivation?", "The first-purchase path should meet a real player desire without damaging retention."],
  [8, "monetisation", "Do your gamepasses, developer products, bundles, or event offers form a clear offer ladder?", "A strong offer ladder gives different player segments sensible reasons to spend and spend again."],
  [9, "monetisation", "Have you reviewed pricing, packaging, or store flow based on payer conversion and ARPPU/ARPDAU data?", "Retention-safe monetisation needs pricing and packaging decisions grounded in player value data."],
  [10, "measurement", "Do you have a KPI tree connecting acquisition, retention, monetisation, and revenue outcomes?", "Decision-ready analytics connect the lifecycle instead of leaving each team with disconnected dashboards."],
  [11, "measurement", "Can your team quickly identify whether a revenue issue comes from traffic quality, onboarding, conversion, pricing, or retention?", "A useful measurement layer tells the team what to fix first when revenue moves."],
  [12, "measurement", "Do you run experiments with clear hypotheses, success thresholds, and post-test readouts?", "Experiments compound when the hypothesis, metric, threshold, and next action are defined before launch."],
  [13, "compounding", "Do updates and events have clear monetisation, retention, and reactivation goals before launch?", "Live ops should be tied to player value, not just update volume or calendar pressure."],
  [14, "compounding", "Do acquisition, live ops, monetisation, and analytics decisions happen from one shared roadmap?", "Lifecycle leaks compound when separate teams optimize in separate lanes."],
  [15, "compounding", "After each campaign, event, or update, do you document what improved, what failed, and what should be tested next?", "The studio gets stronger when each campaign leaves behind learning, not just a result."]
].map(([id, category, text, helpText]) => ({ id: Number(id), category: String(category), text: String(text), helpText: String(helpText) }));

const bands = [
  [0, 39, "Critical Revenue Leakage", "Your game may be getting attention, but the player-value system is underbuilt. Scaling traffic harder right now would likely expose the same leaks faster. The priority is diagnosis: identify the biggest constraint before putting more weight on acquisition."],
  [40, 59, "Growth Is Leaking in Multiple Places", "You likely have a working game, but growth is still fragmented. Some parts of the lifecycle may be performing, while others are suppressing retention, payer conversion, or payback. The next move is to rank the leaks by commercial impact and fix the highest-leverage constraint first."],
  [60, 74, "Promising but Not Yet Scale-Ready", "Your studio has several of the right pieces in place, but the system may not be tight enough to scale confidently. Before increasing paid acquisition, creator campaigns, or update cadence, you should pressure-test source quality, first-purchase flow, and experiment discipline."],
  [75, 89, "Strong Foundation, Optimisation Opportunity", "Your game likely has a solid operating base. The next upside is sharper prioritisation, better segmentation, stronger monetisation tests, and cleaner payback visibility. You may not need more tactics; you need a tighter growth operating system."],
  [90, 100, "Revenue System Is Mature", "Your studio appears to have strong revenue operations already. The opportunity is likely advanced optimisation: payer segmentation, cohort-level acquisition strategy, event monetisation, and experiment velocity."]
].map(([min, max, title, message]) => ({ min: Number(min), max: Number(max), title: String(title), message: String(message) }));

function statusFor(percentage: number) {
  if (percentage <= 39) return "Severe leak";
  if (percentage <= 59) return "Active leak";
  if (percentage <= 74) return "Moderate leak";
  if (percentage <= 89) return "Minor leak";
  return "Strong";
}

function statusClasses(status: string) {
  if (status === "Severe leak") return "border-rose-400/35 bg-rose-500/10 text-rose-200";
  if (status === "Active leak") return "border-orange-300/35 bg-orange-400/10 text-orange-100";
  if (status === "Moderate leak") return "border-amber-300/35 bg-amber-300/10 text-amber-100";
  if (status === "Minor leak") return "border-emerald-300/35 bg-emerald-300/10 text-emerald-100";
  return "border-electric-400/35 bg-electric-500/10 text-electric-200";
}

function ScoreBadge({ percentage, label = "Score", small = false }: { percentage: number; label?: string; small?: boolean }) {
  return (
    <div className={`score-ring grid shrink-0 place-items-center rounded-full p-px ${small ? "h-20 w-20" : "h-44 w-44 sm:h-52 sm:w-52"}`} style={{ "--score": percentage } as React.CSSProperties}>
      <div className="grid h-full w-full place-items-center rounded-full bg-ink-950 text-center">
        <div>
          <div className={small ? "text-xl font-semibold" : "text-5xl font-semibold"}>{percentage}%</div>
          <div className="mt-1 text-[0.68rem] uppercase tracking-[0.18em] text-slate-400">{label}</div>
        </div>
      </div>
    </div>
  );
}

export function ScorecardApp() {
  const [view, setView] = useState<"landing" | "questions" | "email" | "results">("landing");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [email, setEmail] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [emailError, setEmailError] = useState("");

  useEffect(() => {
    try {
      setAnswers(JSON.parse(localStorage.getItem("ascend-scorecard-answers") || "{}") as Answers);
      setEmail(localStorage.getItem("ascend-scorecard-email") || "");
      setUnlocked(localStorage.getItem("ascend-scorecard-unlocked") === "true");
    } catch {
      localStorage.removeItem("ascend-scorecard-answers");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("ascend-scorecard-answers", JSON.stringify(answers));
    localStorage.setItem("ascend-scorecard-email", email);
    localStorage.setItem("ascend-scorecard-unlocked", String(unlocked));
  }, [answers, email, unlocked]);

  const isComplete = questions.every((question) => typeof answers[question.id] === "number");
  const current = questions[step];

  const summary = useMemo(() => {
    const raw = questions.reduce((total, question) => total + (answers[question.id] ?? 0), 0);
    const percentage = Math.round((raw / 60) * 100);
    const band = bands.find((item) => percentage >= item.min && percentage <= item.max) ?? bands[0];
    const categoryScores = categories.map((category) => {
      const rawScore = questions.filter((question) => question.category === category.id).reduce((total, question) => total + (answers[question.id] ?? 0), 0);
      const categoryPercentage = Math.round((rawScore / 12) * 100);
      return { ...category, rawScore, percentage: categoryPercentage, status: statusFor(categoryPercentage) };
    });
    const weakest = [...categoryScores].sort((a, b) => a.percentage - b.percentage || a.rawScore - b.rawScore).slice(0, 2);
    return { raw, percentage, band, categoryScores, weakest };
  }, [answers]);

  function start() {
    setView(isComplete ? (unlocked ? "results" : "email") : "questions");
  }

  function restart() {
    setAnswers({});
    setStep(0);
    setEmail("");
    setUnlocked(false);
    setView("landing");
    localStorage.removeItem("ascend-scorecard-answers");
    localStorage.removeItem("ascend-scorecard-email");
    localStorage.removeItem("ascend-scorecard-unlocked");
  }

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError("Enter a valid work email to unlock the full breakdown.");
      return;
    }
    setEmailError("");
    setUnlocked(true);
    setView("results");
  }

  return (
    <div className="audit-shell min-h-screen">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <header className="no-print flex min-h-16 items-center justify-between gap-4 border-b border-white/10">
          <button type="button" onClick={() => setView("landing")} className="text-left text-sm font-semibold uppercase tracking-[0.24em] text-white">ASCEND</button>
          <div className="hidden text-sm text-slate-400 sm:block">Increase the value of every player before you spend more to acquire the next one.</div>
        </header>

        {view === "landing" && (
          <section className="grid min-h-[calc(100vh-64px)] items-center gap-8 py-8 lg:grid-cols-[1.04fr_0.96fr] lg:py-12">
            <div className="max-w-3xl">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-electric-400/30 bg-electric-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-electric-400">ASCEND diagnostic</div>
              <h1 className="text-4xl font-semibold leading-[1.05] text-white sm:text-6xl lg:text-7xl">Roblox Revenue Leak Scorecard</h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">Find where traffic without value capture is suppressing player value: acquisition quality, first-session clarity, payer conversion, measurement, and the growth work that should compound after every update.</p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <button type="button" onClick={start} className="inline-flex min-h-12 items-center justify-center rounded-md bg-electric-500 px-5 py-3 text-sm font-semibold text-ink-950 transition hover:bg-electric-400">Start the scorecard -></button>
                <a href="#audit" className="inline-flex min-h-12 items-center justify-center rounded-md border border-white/12 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.05]">Book a Revenue Leak Audit</a>
              </div>
              <div className="mt-8 grid gap-3 text-sm text-slate-300 sm:grid-cols-3">
                <div className="rounded-md border border-white/10 bg-white/[0.035] p-4">D1/D7/D30, payer conversion, ARPPU, ARPDAU, payback.</div>
                <div className="rounded-md border border-white/10 bg-white/[0.035] p-4">Retention-safe monetisation and first-purchase path clarity.</div>
                <div className="rounded-md border border-white/10 bg-white/[0.035] p-4">A diagnosis-first read on what to fix first.</div>
              </div>
            </div>
            <div className="print-panel rounded-lg border border-white/10 bg-ink-850/90 p-5 shadow-blue-glow sm:p-6">
              <div className="mb-5 flex items-center justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.2em] text-electric-400">Lifecycle leak map</p><h2 className="mt-2 text-xl font-semibold text-white">Player value system</h2></div><div className="rounded-md border border-white/10 px-3 py-2 text-sm text-slate-300">15 signals</div></div>
              <div className="space-y-3">{categories.map((category, index) => <div key={category.id} className="grid grid-cols-[40px_1fr] gap-3 rounded-md border border-white/10 bg-white/[0.035] p-4"><div className="grid h-10 w-10 place-items-center rounded-md border border-electric-400/35 bg-electric-500/10 text-sm font-semibold text-electric-400">{index + 1}</div><div><p className="font-semibold text-white">{category.shortName}</p><p className="mt-1 text-sm leading-6 text-slate-400">{category.definition}</p></div></div>)}</div>
              <p className="mt-5 border-t border-white/10 pt-5 text-sm leading-6 text-slate-300">Built for live Roblox studios with real traffic, real revenue, active updates, and budget to reinvest.</p>
            </div>
          </section>
        )}

        {view === "questions" && (
          <main className="mx-auto max-w-5xl space-y-6 py-8 sm:py-10">
            <div className="space-y-4"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs uppercase tracking-[0.22em] text-electric-400">Diagnostic progress</p><p className="mt-1 text-sm text-slate-300">Question {step + 1} of {questions.length}</p></div><p className="text-sm font-medium text-white">{Math.round((questions.filter((question) => typeof answers[question.id] === "number").length / questions.length) * 100)}% complete</p></div><div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-electric-400" style={{ width: `${Math.round((questions.filter((question) => typeof answers[question.id] === "number").length / questions.length) * 100)}%` }} /></div></div>
            <section className="fade-in print-panel rounded-lg border border-white/10 bg-ink-850/95 p-5 shadow-blue-glow sm:p-7">
              <p className="text-xs uppercase tracking-[0.22em] text-electric-400">{categories.find((category) => category.id === current.category)?.name}</p>
              <h2 className="mt-3 max-w-3xl text-2xl font-semibold leading-tight text-white sm:text-3xl">{current.text}</h2>
              <p className="mb-6 mt-4 max-w-3xl text-base leading-7 text-slate-300">{current.helpText}</p>
              <div className="grid gap-3" role="radiogroup" aria-label={current.text}>{answerOptions.map((option) => <button key={option.value} type="button" role="radio" aria-checked={answers[current.id] === option.value} onClick={() => setAnswers((value) => ({ ...value, [current.id]: option.value }))} className={`flex min-h-16 w-full items-center gap-4 rounded-md border px-4 py-3 text-left transition ${answers[current.id] === option.value ? "border-electric-400 bg-electric-500/12 text-white" : "border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/25 hover:bg-white/[0.06]"}`}><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border text-sm font-semibold ${answers[current.id] === option.value ? "border-electric-400 bg-electric-500 text-white" : "border-white/15 bg-ink-900 text-slate-300"}`}>{option.value}</span><span className="text-sm font-medium sm:text-base">{option.label}</span></button>)}</div>
              <div className="mt-7 flex items-center justify-between gap-3"><button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0} className="no-print inline-flex min-h-11 items-center gap-2 rounded-md border border-white/10 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-white/25 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40">Back</button><button type="button" onClick={() => step < questions.length - 1 ? setStep((value) => value + 1) : isComplete && setView(unlocked ? "results" : "email")} disabled={typeof answers[current.id] !== "number"} className="no-print inline-flex min-h-11 items-center gap-2 rounded-md bg-electric-500 px-5 py-2 text-sm font-semibold text-ink-950 transition hover:bg-electric-400 disabled:cursor-not-allowed disabled:opacity-45">{step === questions.length - 1 ? "Unlock results" : "Next"} -></button></div>
            </section>
          </main>
        )}

        {view === "email" && (
          <section className="mx-auto grid min-h-[calc(100vh-96px)] max-w-2xl place-items-center py-10"><form onSubmit={submitEmail} className="print-panel w-full rounded-lg border border-white/10 bg-ink-850 p-6 shadow-blue-glow sm:p-8"><p className="text-xs uppercase tracking-[0.22em] text-electric-400">Score ready</p><h1 className="mt-3 text-3xl font-semibold leading-tight text-white sm:text-4xl">Enter your email to unlock the full breakdown.</h1><p className="mt-4 leading-7 text-slate-300">The full result includes your revenue leak band, category breakdown, weakest lifecycle constraints, and recommended next move.</p><label className="mt-7 block" htmlFor="email"><span className="mb-2 block text-sm font-medium text-slate-200">Work email</span><input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="operator@studio.com" className="min-h-12 w-full rounded-md border border-white/10 bg-ink-950 px-3 py-3 text-white placeholder:text-slate-600" /></label>{emailError ? <p className="mt-3 text-sm text-rose-300">{emailError}</p> : null}<button type="submit" className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-md bg-electric-500 px-5 py-3 text-sm font-semibold text-ink-950 transition hover:bg-electric-400">Show full results</button></form></section>
        )}

        {view === "results" && (
          <main className="fade-in space-y-8 py-8 sm:py-10">
            <section className="print-panel rounded-lg border border-white/10 bg-ink-850 p-6 shadow-blue-glow sm:p-8"><div className="grid gap-8 lg:grid-cols-[auto_1fr] lg:items-center"><ScoreBadge percentage={summary.percentage} /><div><div className="mb-3 flex flex-wrap items-center gap-3"><p className="text-xs uppercase tracking-[0.22em] text-electric-400">Roblox Revenue Leak Scorecard</p><span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-slate-300">{summary.raw}/60 raw score</span></div><h1 className="max-w-4xl text-3xl font-semibold leading-tight text-white sm:text-5xl">{summary.band.title}</h1><p className="mt-5 max-w-4xl text-base leading-7 text-slate-300 print-muted sm:text-lg sm:leading-8">{summary.band.message}</p><div className="no-print mt-6 flex flex-col gap-3 sm:flex-row"><button type="button" onClick={() => window.print()} className="inline-flex min-h-11 items-center justify-center rounded-md border border-white/12 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.05]">Print summary</button><button type="button" onClick={restart} className="inline-flex min-h-11 items-center justify-center rounded-md border border-white/12 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.05]">Restart</button></div></div></div></section>
            <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]"><div className="print-panel rounded-lg border border-white/10 bg-ink-850 p-5"><p className="text-xs uppercase tracking-[0.22em] text-electric-400">Top 2 weakest categories</p><div className="mt-5 space-y-4">{summary.weakest.map((category, index) => <div key={category.id} className="rounded-md border border-white/10 bg-white/[0.035] p-4"><div className="flex items-center justify-between gap-4"><p className="font-semibold text-white">{index + 1}. {category.name}</p><span className="text-sm font-semibold text-electric-300">{category.percentage}%</span></div><p className="mt-2 text-sm leading-6 text-slate-400 print-muted">{category.action}</p></div>)}</div></div><div className="print-panel rounded-lg border border-white/10 bg-ink-850 p-5"><p className="text-xs uppercase tracking-[0.22em] text-electric-400">What this means</p><h2 className="mt-3 text-2xl font-semibold text-white">Your next growth constraint is probably not another isolated tactic.</h2><p className="mt-4 text-sm leading-7 text-slate-300 print-muted">Treat the lowest categories as lifecycle leaks that are limiting player value. If source quality, first-purchase path, retention-safe monetisation, and experiment discipline are not connected, more traffic can make the same revenue problem louder instead of more profitable.</p><div className="mt-5 rounded-md border border-electric-400/25 bg-electric-500/10 p-4"><p className="text-sm font-semibold text-white">Recommended next move</p><p className="mt-2 text-sm leading-6 text-slate-300 print-muted">Run a Revenue Leak Audit around {summary.weakest[0].shortName.toLowerCase()} and {summary.weakest[1].shortName.toLowerCase()}, then turn the findings into a 30/60/90 roadmap for what to fix first.</p></div></div></section>
            <section><div className="mb-5"><p className="text-xs uppercase tracking-[0.22em] text-electric-400">Category breakdown</p><h2 className="mt-3 text-3xl font-semibold text-white">Lifecycle leak analysis</h2></div><div className="grid gap-4 lg:grid-cols-2">{summary.categoryScores.map((category) => { const weak = summary.weakest.some((item) => item.id === category.id); return <article key={category.id} className={`print-panel rounded-lg border bg-ink-850 p-5 ${weak ? "border-electric-400/55 shadow-blue-glow" : "border-white/10"}`}><div className="mb-5 flex items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-xl font-semibold text-white">{category.name}</h3>{weak ? <span className="rounded-full border border-electric-400/35 bg-electric-500/10 px-2 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-electric-300">Top constraint</span> : null}</div><p className="mt-2 text-sm leading-6 text-slate-400 print-muted">{category.definition}</p></div><ScoreBadge percentage={category.percentage} label="Leak" small /></div><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClasses(category.status)}`}>{category.status}</span><span className="ml-2 text-sm text-slate-400">{category.rawScore}/12 category score</span><div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-electric-400" style={{ width: `${category.percentage}%` }} /></div><div className="mt-5 space-y-4 text-sm leading-6"><div><p className="font-semibold text-white">Diagnosis</p><p className="mt-1 text-slate-300 print-muted">{category.diagnosis}</p></div><div><p className="font-semibold text-white">Recommended next action</p><p className="mt-1 text-slate-300 print-muted">{category.action}</p></div></div></article>; })}</div></section>
            <section id="audit" className="print-panel rounded-lg border border-electric-400/30 bg-electric-500/10 p-6 shadow-blue-glow sm:p-8"><div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center"><div><p className="text-xs uppercase tracking-[0.22em] text-electric-300">ASCEND Revenue Leak Audit</p><h2 className="mt-3 max-w-3xl text-3xl font-semibold leading-tight text-white">Know your score. Now find the leak costing you the most revenue.</h2><p className="mt-4 max-w-4xl text-base leading-7 text-slate-300">The scorecard gives you the surface diagnosis. The Revenue Leak Audit maps the lifecycle properly: acquisition quality, first-session clarity, payer conversion, offer ladder, analytics, and the 30/60/90 roadmap for what to fix first.</p><p className="mt-4 text-sm font-medium text-slate-200">Built for live Roblox studios with real traffic, real revenue, and budget to reinvest.</p></div><div className="no-print flex flex-col gap-3 sm:flex-row lg:flex-col"><a href="mailto:hello@ascendops.com?subject=Revenue%20Leak%20Audit" className="inline-flex min-h-12 items-center justify-center rounded-md bg-electric-500 px-5 py-3 text-sm font-semibold text-ink-950 transition hover:bg-electric-400">Book a Revenue Leak Audit</a><a href="mailto:hello@ascendops.com?subject=30%2F60%2F90%20Revenue%20Roadmap" className="inline-flex min-h-12 items-center justify-center rounded-md border border-white/12 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.05]">Get the 30/60/90 Revenue Roadmap</a></div></div></section>
            <p className="pb-8 text-center text-sm text-slate-500 print-muted">This scorecard is a diagnostic starting point, not a guarantee of results.</p>
          </main>
        )}
      </div>
    </div>
  );
}
