import type {
  AnswerOption,
  CategoryConfig,
  ResultBand,
  ScorecardQuestion
} from "@/types/scorecard";

export const answerOptions: AnswerOption[] = [
  { value: 0, label: "Not in place" },
  { value: 1, label: "Weak / unclear" },
  { value: 2, label: "Partially in place" },
  { value: 3, label: "Mostly in place" },
  { value: 4, label: "Strong / consistently measured" }
];

export const categories: CategoryConfig[] = [
  {
    id: "acquisition",
    name: "Acquisition Leak",
    shortName: "Acquisition",
    definition:
      "The studio is bringing in players before confirming whether those sources produce retained, monetising users.",
    diagnosis:
      "You may be judging acquisition by volume instead of downstream value. More visits do not automatically mean more retained spenders.",
    recommendedAction:
      "Compare each source by D1 retention, payer conversion, revenue per user, and payback before scaling."
  },
  {
    id: "activation",
    name: "Activation Leak",
    shortName: "Activation",
    definition:
      "Players arrive but fail to understand the loop, feel progress, or reach the first meaningful engagement moment quickly enough.",
    diagnosis:
      "Players may be entering the game before the value loop becomes clear. If the first session fails, monetisation never gets a fair chance.",
    recommendedAction:
      "Map the first 60 seconds and identify where players stall, leave, or fail to understand the next action."
  },
  {
    id: "monetisation",
    name: "Monetisation Leak",
    shortName: "Monetisation",
    definition:
      "Players engage but too few convert, spend again, or understand the value of paid offers.",
    diagnosis:
      "Your offers may exist, but the path from engagement to first purchase may not be clear, timely, or valuable enough.",
    recommendedAction:
      "Review first-purchase timing, store visibility, offer ladder structure, and pricing logic."
  },
  {
    id: "measurement",
    name: "Measurement Leak",
    shortName: "Measurement",
    definition:
      "The team has data, but not enough decision-ready instrumentation to know what to fix first.",
    diagnosis:
      "You may have dashboards without a decision system. Data only helps if it tells the team what to fix next.",
    recommendedAction:
      "Build a KPI tree and experiment backlog tied to retention, payer conversion, ARPPU, ARPDAU, and payback."
  },
  {
    id: "compounding",
    name: "Compounding Leak",
    shortName: "Compounding",
    definition:
      "Growth work happens in fragments, so updates, ads, creators, monetisation, and analytics do not stack into a stronger revenue system.",
    diagnosis:
      "Your team may be working hard in separate lanes, but the gains are not stacking into one revenue system.",
    recommendedAction:
      "Create a shared 30/60/90-day growth roadmap connecting live ops, monetisation, acquisition, and analytics."
  }
];

export const questions: ScorecardQuestion[] = [
  {
    id: 1,
    category: "acquisition",
    text: "Do you know which acquisition sources bring your highest-value players, not just the cheapest visits?",
    helpText:
      "Look for source quality: retained players, payer conversion, revenue per user, and payback."
  },
  {
    id: 2,
    category: "acquisition",
    text: "Do you compare retention and payer behaviour by source/channel?",
    helpText:
      "A channel that looks cheap can become expensive if D1/D7 retention or payer behaviour is weak."
  },
  {
    id: 3,
    category: "acquisition",
    text: "Before increasing spend, do you know whether cold traffic can pay back?",
    helpText:
      "Scale with payback, not guesswork. Cold traffic should be judged against cohort quality."
  },
  {
    id: 4,
    category: "activation",
    text: "Can a new player understand what to do and why it matters within the first 60 seconds?",
    helpText:
      "The first session should make the core loop, progress signal, and next action obvious."
  },
  {
    id: 5,
    category: "activation",
    text: "Do you actively track or review where new players drop off in the first session?",
    helpText:
      "Activation leaks often hide inside spawn flow, tutorial friction, unclear goals, or early confusion."
  },
  {
    id: 6,
    category: "activation",
    text: "Have you tested onboarding, tutorial, spawn flow, or first-session clarity in the last 30-60 days?",
    helpText:
      "Live-service games need repeated activation pressure tests as content and audiences change."
  },
  {
    id: 7,
    category: "monetisation",
    text: "Is your first-purchase path obvious, well-timed, and connected to player motivation?",
    helpText:
      "The first-purchase path should meet a real player desire without damaging retention."
  },
  {
    id: 8,
    category: "monetisation",
    text: "Do your gamepasses, developer products, bundles, or event offers form a clear offer ladder?",
    helpText:
      "A strong offer ladder gives different player segments sensible reasons to spend and spend again."
  },
  {
    id: 9,
    category: "monetisation",
    text: "Have you reviewed pricing, packaging, or store flow based on payer conversion and ARPPU/ARPDAU data?",
    helpText:
      "Retention-safe monetisation needs pricing and packaging decisions grounded in player value data."
  },
  {
    id: 10,
    category: "measurement",
    text: "Do you have a KPI tree connecting acquisition, retention, monetisation, and revenue outcomes?",
    helpText:
      "Decision-ready analytics connect the lifecycle instead of leaving each team with disconnected dashboards."
  },
  {
    id: 11,
    category: "measurement",
    text: "Can your team quickly identify whether a revenue issue comes from traffic quality, onboarding, conversion, pricing, or retention?",
    helpText:
      "A useful measurement layer tells the team what to fix first when revenue moves."
  },
  {
    id: 12,
    category: "measurement",
    text: "Do you run experiments with clear hypotheses, success thresholds, and post-test readouts?",
    helpText:
      "Experiments compound when the hypothesis, metric, threshold, and next action are defined before launch."
  },
  {
    id: 13,
    category: "compounding",
    text: "Do updates and events have clear monetisation, retention, and reactivation goals before launch?",
    helpText:
      "Live ops should be tied to player value, not just update volume or calendar pressure."
  },
  {
    id: 14,
    category: "compounding",
    text: "Do acquisition, live ops, monetisation, and analytics decisions happen from one shared roadmap?",
    helpText:
      "Lifecycle leaks compound when separate teams optimize in separate lanes."
  },
  {
    id: 15,
    category: "compounding",
    text: "After each campaign, event, or update, do you document what improved, what failed, and what should be tested next?",
    helpText:
      "The studio gets stronger when each campaign leaves behind learning, not just a result."
  }
];

export const resultBands: ResultBand[] = [
  {
    min: 0,
    max: 39,
    title: "Critical Revenue Leakage",
    message:
      "Your game may be getting attention, but the player-value system is underbuilt. Scaling traffic harder right now would likely expose the same leaks faster. The priority is diagnosis: identify the biggest constraint before putting more weight on acquisition.",
    cta: "Book a Revenue Leak Audit"
  },
  {
    min: 40,
    max: 59,
    title: "Growth Is Leaking in Multiple Places",
    message:
      "You likely have a working game, but growth is still fragmented. Some parts of the lifecycle may be performing, while others are suppressing retention, payer conversion, or payback. The next move is to rank the leaks by commercial impact and fix the highest-leverage constraint first.",
    cta: "Book a Revenue Leak Audit"
  },
  {
    min: 60,
    max: 74,
    title: "Promising but Not Yet Scale-Ready",
    message:
      "Your studio has several of the right pieces in place, but the system may not be tight enough to scale confidently. Before increasing paid acquisition, creator campaigns, or update cadence, you should pressure-test source quality, first-purchase flow, and experiment discipline.",
    cta: "Book a Revenue Leak Audit"
  },
  {
    min: 75,
    max: 89,
    title: "Strong Foundation, Optimisation Opportunity",
    message:
      "Your game likely has a solid operating base. The next upside is sharper prioritisation, better segmentation, stronger monetisation tests, and cleaner payback visibility. You may not need more tactics; you need a tighter growth operating system.",
    cta: "Book a Revenue Leak Audit"
  },
  {
    min: 90,
    max: 100,
    title: "Revenue System Is Mature",
    message:
      "Your studio appears to have strong revenue operations already. The opportunity is likely advanced optimisation: payer segmentation, cohort-level acquisition strategy, event monetisation, and experiment velocity.",
    cta: "Book a Revenue Leak Audit"
  }
];
