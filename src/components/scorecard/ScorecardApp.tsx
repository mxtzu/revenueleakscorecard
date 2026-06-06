"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ScorecardLanding } from "@/components/scorecard/ScorecardLanding";
import { ScorecardProgress } from "@/components/scorecard/ScorecardProgress";
import { ScorecardQuestion } from "@/components/scorecard/ScorecardQuestion";
import { EmailCapture } from "@/components/scorecard/EmailCapture";
import { ScorecardResults } from "@/components/scorecard/ScorecardResults";
import { getScoreSummary, isComplete } from "@/lib/scorecard";
import { questions } from "@/lib/scorecard-data";
import {
  getScoreEventPayload,
  submitScorecardSubmission,
  trackScorecardEvent
} from "@/lib/tracking";
import type { AnswerMap, AnswerValue } from "@/types/scorecard";

const STORAGE_KEYS = {
  answers: "ascend-revenue-leak-scorecard-answers",
  email: "ascend-revenue-leak-scorecard-email",
  unlocked: "ascend-revenue-leak-scorecard-unlocked"
};

type View = "landing" | "questions" | "email" | "results";

export function ScorecardApp() {
  const [view, setView] = useState<View>("landing");
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [email, setEmail] = useState("");
  const [isUnlocked, setIsUnlocked] = useState(false);
  const hasTrackedResultsView = useRef(false);

  useEffect(() => {
    const storedAnswers = window.localStorage.getItem(STORAGE_KEYS.answers);
    const storedEmail = window.localStorage.getItem(STORAGE_KEYS.email);
    const storedUnlocked = window.localStorage.getItem(STORAGE_KEYS.unlocked);

    if (storedAnswers) {
      try {
        setAnswers(JSON.parse(storedAnswers) as AnswerMap);
      } catch {
        window.localStorage.removeItem(STORAGE_KEYS.answers);
      }
    }

    if (storedEmail) setEmail(storedEmail);
    if (storedUnlocked === "true") setIsUnlocked(true);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.answers, JSON.stringify(answers));
  }, [answers]);

  useEffect(() => {
    if (email) window.localStorage.setItem(STORAGE_KEYS.email, email);
  }, [email]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.unlocked, String(isUnlocked));
  }, [isUnlocked]);

  const summary = useMemo(() => getScoreSummary(answers), [answers]);
  const currentQuestion = questions[currentStep];
  const complete = isComplete(answers);

  useEffect(() => {
    if (view !== "results" || hasTrackedResultsView.current) return;

    hasTrackedResultsView.current = true;
    trackScorecardEvent("results_viewed", getScoreEventPayload(summary));
  }, [summary, view]);

  function handleStart() {
    trackScorecardEvent("scorecard_started", {
      resumed: complete,
      unlocked: isUnlocked
    });
    setView(complete ? (isUnlocked ? "results" : "email") : "questions");
  }

  function handleAnswer(value: AnswerValue) {
    setAnswers((currentAnswers) => ({
      ...currentAnswers,
      [currentQuestion.id]: value
    }));
    trackScorecardEvent("question_answered", {
      questionId: currentQuestion.id,
      category: currentQuestion.category,
      step: currentStep + 1,
      value
    });
  }

  function handleNext() {
    if (typeof answers[currentQuestion.id] !== "number") return;

    if (currentStep < questions.length - 1) {
      setCurrentStep((step) => step + 1);
      return;
    }

    if (isComplete(answers)) {
      trackScorecardEvent("scorecard_completed", getScoreEventPayload(summary));
      setView(isUnlocked ? "results" : "email");
    }
  }

  async function handleEmailSubmit(nextEmail: string) {
    let deliveredToCaptureEndpoint = false;

    try {
      const result = await submitScorecardSubmission({
        email: nextEmail,
        answers,
        summary
      });
      deliveredToCaptureEndpoint = result.delivered;
    } catch {
      deliveredToCaptureEndpoint = false;
    }

    trackScorecardEvent("email_submitted", {
      ...getScoreEventPayload(summary),
      deliveredToCaptureEndpoint
    });
    setEmail(nextEmail);
    setIsUnlocked(true);
    setView("results");
  }

  function handleRestart() {
    trackScorecardEvent("scorecard_restarted", getScoreEventPayload(summary));
    hasTrackedResultsView.current = false;
    setAnswers({});
    setCurrentStep(0);
    setEmail("");
    setIsUnlocked(false);
    window.localStorage.removeItem(STORAGE_KEYS.answers);
    window.localStorage.removeItem(STORAGE_KEYS.email);
    window.localStorage.removeItem(STORAGE_KEYS.unlocked);
    setView("landing");
  }

  return (
    <div className="audit-shell min-h-screen">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <header className="no-print flex min-h-16 items-center justify-between gap-4 border-b border-white/10">
          <button
            type="button"
            onClick={() => setView("landing")}
            className="text-left text-sm font-semibold uppercase tracking-[0.24em] text-white"
            aria-label="ASCEND home"
          >
            ASCEND
          </button>
          <div className="hidden text-sm text-slate-400 sm:block">
            Increase the value of every player before you spend more to acquire the next one.
          </div>
        </header>

        {view === "landing" ? <ScorecardLanding onStart={handleStart} /> : null}

        {view === "questions" ? (
          <main className="mx-auto max-w-5xl space-y-6 py-8 sm:py-10">
            <ScorecardProgress currentStep={currentStep} answers={answers} />
            <ScorecardQuestion
              question={currentQuestion}
              selectedAnswer={answers[currentQuestion.id]}
              onAnswer={handleAnswer}
              onBack={() => setCurrentStep((step) => Math.max(0, step - 1))}
              onNext={handleNext}
              isFirst={currentStep === 0}
              isLast={currentStep === questions.length - 1}
            />
          </main>
        ) : null}

        {view === "email" ? (
          <EmailCapture onSubmit={handleEmailSubmit} />
        ) : null}

        {view === "results" ? (
          <ScorecardResults
            summary={summary}
            email={email}
            onRestart={handleRestart}
          />
        ) : null}
      </div>
    </div>
  );
}
