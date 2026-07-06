"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EmailCapture } from "@/components/scorecard/EmailCapture";
import { ScorecardLanding } from "@/components/scorecard/ScorecardLanding";
import { ScorecardQuestion } from "@/components/scorecard/ScorecardQuestion";
import { ScorecardResults } from "@/components/scorecard/ScorecardResults";
import { BRAND_NAME } from "@/lib/brand";
import { getLeakResult, isComplete } from "@/lib/scorecard";
import { questions } from "@/lib/scorecard-data";
import {
  getResultEventPayload,
  logScorecardSession,
  submitScorecardLead,
  trackScorecardEvent
} from "@/lib/tracking";
import type { AnswerMap } from "@/types/scorecard";

const STORAGE_KEYS = {
  answers: "ascend-rld-answers-v2",
  unlocked: "ascend-rld-unlocked-v2",
  completionId: "ascend-rld-completion-v2"
};

const ADVANCE_DELAY_MS = 220;

type View = "landing" | "questions" | "capture" | "results";

function createCompletionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "";
}

export function ScorecardApp() {
  const [view, setView] = useState<View>("landing");
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [completionId, setCompletionId] = useState("");
  const hasTrackedResultsView = useRef(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const storedAnswers = window.localStorage.getItem(STORAGE_KEYS.answers);
      if (storedAnswers) setAnswers(JSON.parse(storedAnswers) as AnswerMap);
    } catch {
      window.localStorage.removeItem(STORAGE_KEYS.answers);
    }

    setIsUnlocked(window.localStorage.getItem(STORAGE_KEYS.unlocked) === "true");
    setCompletionId(window.localStorage.getItem(STORAGE_KEYS.completionId) ?? "");
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.answers, JSON.stringify(answers));
  }, [answers]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.unlocked, String(isUnlocked));
  }, [isUnlocked]);

  useEffect(() => {
    if (completionId) {
      window.localStorage.setItem(STORAGE_KEYS.completionId, completionId);
    }
  }, [completionId]);

  useEffect(() => () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
  }, []);

  const result = useMemo(() => getLeakResult(answers), [answers]);
  const complete = isComplete(answers);

  useEffect(() => {
    if (view !== "results" || hasTrackedResultsView.current) return;

    hasTrackedResultsView.current = true;
    trackScorecardEvent("results_viewed", getResultEventPayload(result));
  }, [result, view]);

  function handleStart() {
    trackScorecardEvent("scorecard_started", { resumed: complete, unlocked: isUnlocked });
    setView(complete ? (isUnlocked ? "results" : "capture") : "questions");
  }

  function finishScorecard(finalAnswers: AnswerMap) {
    const finalResult = getLeakResult(finalAnswers);
    const newCompletionId = createCompletionId();
    setCompletionId(newCompletionId);

    trackScorecardEvent("scorecard_completed", getResultEventPayload(finalResult));
    logScorecardSession({
      completionId: newCompletionId,
      result: finalResult,
      answers: finalAnswers
    });

    setView(isUnlocked ? "results" : "capture");
  }

  function handleSelect(optionIndex: number) {
    const question = questions[currentStep];
    const nextAnswers = { ...answers, [question.id]: optionIndex };
    setAnswers(nextAnswers);

    trackScorecardEvent("question_answered", {
      questionId: question.id,
      step: currentStep + 1,
      optionIndex
    });

    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    advanceTimer.current = setTimeout(() => {
      if (currentStep < questions.length - 1) {
        setCurrentStep((step) => step + 1);
      } else if (isComplete(nextAnswers)) {
        finishScorecard(nextAnswers);
      }
    }, ADVANCE_DELAY_MS);
  }

  async function handleCaptureSubmit(input: { email: string; discordUsername: string }) {
    try {
      await submitScorecardLead({
        completionId,
        email: input.email,
        discordUsername: input.discordUsername,
        answers,
        result
      });
    } catch {
      // Capture failures never block the diagnosis.
    }

    trackScorecardEvent("email_submitted", {
      ...getResultEventPayload(result),
      email: input.email,
      discordUsername: input.discordUsername
    });
    setIsUnlocked(true);
    setView("results");
  }

  function handleRestart() {
    trackScorecardEvent("scorecard_restarted", getResultEventPayload(result));
    hasTrackedResultsView.current = false;
    setAnswers({});
    setCurrentStep(0);
    setCompletionId("");
    window.localStorage.removeItem(STORAGE_KEYS.answers);
    window.localStorage.removeItem(STORAGE_KEYS.completionId);
    setView("questions");
  }

  return (
    <div className="min-h-screen">
      <div className="mx-auto w-full max-w-4xl px-5 sm:px-8">
        <header className="flex min-h-14 items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setView("landing")}
            className="label-mono text-white"
            aria-label={`${BRAND_NAME} home`}
          >
            {BRAND_NAME}
          </button>
          <span className="label-mono hidden text-slate-600 sm:block">
            Revenue Growth for Roblox Studios
          </span>
        </header>
        <div className="hairline" />

        {view === "landing" ? <ScorecardLanding onStart={handleStart} /> : null}

        {view === "questions" ? (
          <ScorecardQuestion
            question={questions[currentStep]}
            step={currentStep}
            totalSteps={questions.length}
            selectedIndex={answers[questions[currentStep].id]}
            onSelect={handleSelect}
            onBack={() => setCurrentStep((step) => Math.max(0, step - 1))}
            isFirst={currentStep === 0}
          />
        ) : null}

        {view === "capture" ? <EmailCapture onSubmit={handleCaptureSubmit} /> : null}

        {view === "results" ? (
          <ScorecardResults result={result} onRestart={handleRestart} />
        ) : null}
      </div>
    </div>
  );
}
