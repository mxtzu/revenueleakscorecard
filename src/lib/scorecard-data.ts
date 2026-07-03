import type {
  CategoryConfig,
  ContextQuestion,
  Question,
  ScoredQuestion
} from "@/types/scorecard";

/**
 * Canonical category order. Also the display order everywhere.
 */
export const categories: CategoryConfig[] = [
  {
    id: "acquisition",
    name: "Acquisition",
    definition: "Paying for traffic you can't price.",
    leak: {
      headline:
        "Your Acquisition Leak Is Likely Funding Sources That Never Pay Back — While Your Best One Goes Unfunded",
      mechanism:
        "When retained payers can't be tied back to a source, every scaling decision is priced on visit volume. That cuts both ways: spend keeps flowing to sources that never produce a payer, and the one source quietly producing them never gets doubled down on. Leaks compound — any activation or monetization gain you ship next gets judged against traffic you can't price, so you won't know if it worked."
    }
  },
  {
    id: "activation",
    name: "Activation",
    definition: "Losing players before the game gets a fair shot.",
    leak: {
      headline:
        "Your Activation Leak Is Likely Costing You Day-7 Payers Before They Ever See a Purchase Surface",
      mechanism:
        "Most Roblox spend doesn't happen in session one — it happens after a player has come back enough times to care. If the first session doesn't lock in a reason to return, the players who would have paid are gone before any offer gets a chance. That's why an activation leak reads as a monetization problem in the dashboard: revenue looks flat, but the loss is upstream, and more acquisition just pours players into the same hole faster."
    }
  },
  {
    id: "monetization",
    name: "Monetization",
    definition: "Engagement that never becomes a first purchase.",
    leak: {
      headline:
        "Your Monetization Leak Is Likely Sitting in the Gap Between Engagement and the First Purchase",
      mechanism:
        "Players who stay but never cross into a first purchase are the most expensive audience you have — you already paid, in spend or in effort, to acquire and activate them. When the first spend moment is left to chance, payer conversion becomes a function of who happens to wander into the store. Every acquisition and activation win upstream just feeds more players into the same gap, which is how a monetization leak turns growth work into a bigger loss."
    }
  },
  {
    id: "measurement",
    name: "Measurement",
    definition: "Revenue moves and nobody knows why.",
    leak: {
      headline:
        "Your Measurement Leak Means the Other Four Leaks Stay Invisible Until They Hit Revenue",
      mechanism:
        "Right now a revenue drop reaches you as a number, not a cause. Without instrumentation that separates source quality from retention from spend behaviour, every fix is a guess and every internal debate is unwinnable. Measurement is the leak that hides the others — acquisition, activation, monetization, and compounding losses all run silently behind it, which is why it's usually the most expensive one to leave open."
    }
  },
  {
    id: "compounding",
    name: "Compounding",
    definition: "Updates that ship but never stack.",
    leak: {
      headline:
        "Your Compounding Leak Is Why Hard Updates Keep Producing Flat Revenue",
      mechanism:
        "When updates, offers, creators, and analytics run in separate lanes, each one can individually 'work' while revenue stays flat — the gains never stack. A compounding leak doesn't show up in any single dashboard, and no single specialist owns it. It shows up over quarters, as real effort that never converts into a steeper curve."
    }
  }
];

export const contextQuestion: ContextQuestion = {
  kind: "context",
  id: "revenue_band",
  text: "Roughly what does the game gross per month, all sources?",
  helpText: "Robux earnings at DevEx rates plus brand deals. A rough band is fine.",
  options: [
    { value: "under_5k", label: "Under $5K" },
    { value: "5k_25k", label: "$5K – $25K" },
    { value: "25k_100k", label: "$25K – $100K" },
    { value: "over_100k", label: "$100K+" }
  ]
};

export const scoredQuestions: ScoredQuestion[] = [
  {
    kind: "scored",
    id: "acquisition",
    category: "acquisition",
    text: "Your last real traffic spike — do you know which source sent the players who stayed and paid?",
    helpText: "Not visits. Players who were still there a week later, and spent.",
    options: [
      {
        score: 3,
        label: "Yes — we can tie retained payers back to specific sources",
        echo: "you can tie retained payers back to specific sources"
      },
      {
        score: 2,
        label: "We track visits by source, but not what those players did after",
        echo: "you track visits by source, but not what those players did after"
      },
      {
        score: 1,
        label: "We watch impressions and CCU — source quality is a guess",
        echo: "you watch impressions and CCU, and source quality is a guess"
      },
      {
        score: 0,
        label: "No idea — traffic shows up or it doesn't",
        echo: "traffic shows up or it doesn't, and you can't say from where"
      }
    ]
  },
  {
    kind: "scored",
    id: "activation",
    category: "activation",
    text: "Out of every 100 new players who join, how many come back for a second session?",
    helpText: "Day-1 retention in your Creator Dashboard. Closest band from memory is fine.",
    options: [
      {
        score: 3,
        label: "25+ — and we know which first-session moments drive it",
        echo: "25+ of every 100 come back, and you know which first-session moments drive it"
      },
      {
        score: 2,
        label: "Somewhere in the 15–25 range",
        echo: "somewhere between 15 and 25 of every 100 new players come back"
      },
      {
        score: 1,
        label: "Under 15",
        echo: "fewer than 15 of every 100 new players come back for a second session"
      },
      {
        score: 0,
        label: "I'd have to check — we don't watch that number",
        echo: "you'd have to check — second sessions aren't a number the team watches"
      }
    ]
  },
  {
    kind: "scored",
    id: "monetization",
    category: "monetization",
    text: "When does a new player first hit a real reason to spend?",
    helpText: "A purchase surface tied to something they already want — not just a store existing.",
    options: [
      {
        score: 3,
        label: "First session — a designed moment tied to something they already want",
        echo: "the first purchase moment is designed into the first session"
      },
      {
        score: 2,
        label: "Within the first few sessions, if they find the store",
        echo: "players hit a spend reason within a few sessions, if they find the store"
      },
      {
        score: 1,
        label: "Whenever they open the store on their own",
        echo: "the first purchase happens whenever a player opens the store on their own"
      },
      {
        score: 0,
        label: "We haven't designed a first-purchase moment",
        echo: "there is no designed first-purchase moment in the game"
      }
    ]
  },
  {
    kind: "scored",
    id: "measurement",
    category: "measurement",
    text: "Revenue drops 20% next week. How long until you know why?",
    helpText: "Not until you notice — until you know the cause well enough to act.",
    options: [
      {
        score: 3,
        label: "Same day — we'd see which stage moved: source, retention, or spend",
        echo: "you'd know the same day which stage moved — source, retention, or spend"
      },
      {
        score: 2,
        label: "Within a week, after some digging",
        echo: "you'd get to the cause within a week, after some digging"
      },
      {
        score: 1,
        label: "We'd notice the drop, but the 'why' would be a debate",
        echo: "you'd notice the drop, but the 'why' would be a debate"
      },
      {
        score: 0,
        label: "Honestly, we might not notice for a while",
        echo: "a 20% drop might run for a while before anyone noticed"
      }
    ]
  },
  {
    kind: "scored",
    id: "compounding",
    category: "compounding",
    text: "Your last three updates — what were they supposed to move?",
    helpText: "Revenue, retention, reactivation — or just the content calendar.",
    options: [
      {
        score: 3,
        label: "Each shipped against a specific revenue or retention target — and we checked after",
        echo: "your last three updates shipped against specific targets, and you checked the results"
      },
      {
        score: 2,
        label: "We had goals going in, but never went back to see what happened",
        echo: "updates ship with goals, but nobody goes back to see what happened"
      },
      {
        score: 1,
        label: "Content calendar — keep the game fresh, keep players happy",
        echo: "updates ship to keep the game fresh, not against a revenue target"
      },
      {
        score: 0,
        label: "We ship what feels right and watch CCU",
        echo: "updates ship on feel, and CCU is the scoreboard"
      }
    ]
  }
];

export const questions: Question[] = [contextQuestion, ...scoredQuestions];
