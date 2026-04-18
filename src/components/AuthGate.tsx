"use client";

import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

const AUTH_READY_KEY = "auth:ok";
const ONBOARDING_READY_KEY = "onboarding:completed";
const LOADING_SUGGESTIONS = [
  "Use / in Inbox to jump straight into search.",
  "Open any thread in Gmail directly from inbox quick actions.",
  "Use Unread and category chips to triage heavy traffic faster.",
  "Generate mode is great for first drafts, then approve with confidence.",
  "Keep auto mode on only for categories with strong confidence signals.",
  "Inspect mode shows decision reasons and RAG confidence in one place.",
];

export function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(pathname === "/login");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const isLogin = pathname === "/login";
  const isOnboarding = pathname === "/onboarding";

  useEffect(() => {
    if (isLogin || ready) return;
    setSuggestionIndex(Math.floor(Math.random() * LOADING_SUGGESTIONS.length));
    const timer = window.setInterval(() => {
      setSuggestionIndex((current) => (current + 1 + Math.floor(Math.random() * 2)) % LOADING_SUGGESTIONS.length);
    }, 2600);
    return () => window.clearInterval(timer);
  }, [isLogin, ready]);

  useEffect(() => {
    if (isLogin) {
      setReady(true);
      return;
    }

    const hintedAuth = typeof window !== "undefined" && window.sessionStorage.getItem(AUTH_READY_KEY) === "1";
    if (hintedAuth) {
      // Show the shell immediately for repeat visits while we validate in the background.
      setReady(true);
    }

    let cancelled = false;
    void (async () => {
      try {
        const [res, onboardingRes] = await Promise.all([
          fetch("/api/auth/me", { credentials: "include" }),
          fetch("/api/system/onboarding", { credentials: "include" }),
        ]);
        if (cancelled) return;
        if (res.status === 401) {
          if (typeof window !== "undefined") {
            window.sessionStorage.removeItem(AUTH_READY_KEY);
            window.sessionStorage.removeItem(ONBOARDING_READY_KEY);
          }
          router.replace("/login");
          return;
        }

        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(AUTH_READY_KEY, "1");
        }
        
        let onboardingCompleted: boolean | null = null;
        if (onboardingRes.ok) {
          const onboarding = (await onboardingRes.json()) as { completed?: boolean };
          onboardingCompleted = Boolean(onboarding.completed);
          if (typeof window !== "undefined") {
            window.sessionStorage.setItem(ONBOARDING_READY_KEY, onboardingCompleted ? "1" : "0");
          }
        } else if (typeof window !== "undefined") {
          const hintedOnboarding = window.sessionStorage.getItem(ONBOARDING_READY_KEY);
          onboardingCompleted = hintedOnboarding === "1" ? true : hintedOnboarding === "0" ? false : null;
        }

        if (onboardingCompleted === false && !isOnboarding) {
            router.replace("/onboarding");
            return;
        }
        if (onboardingCompleted === true && isOnboarding) {
            router.replace("/");
            return;
        }

        setReady(true);
      } catch {
        if (!cancelled) {
          // If we had a trusted session hint, keep UX instant even if health checks briefly fail.
          if (!hintedAuth) {
            setReady(true);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLogin, isOnboarding, router]);

  if (!ready && !isLogin) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--surface-secondary)_48%,transparent),transparent_54%),radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--surface-accent)_62%,transparent),transparent_48%)]" />
        <div className="panel-surface-strong relative w-full max-w-lg rounded-[28px] px-6 py-6 text-center shadow-md">
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] app-text-faint">Workspace startup</div>
          <h2 className="mt-3 text-2xl font-semibold app-text-primary">Preparing your email workspace</h2>
          <p className="mt-2 text-sm app-text-muted">Authenticating account and restoring inbox context.</p>
          <div className="mt-5 rounded-2xl app-input px-4 py-3 text-sm app-text-secondary">
            <span className="font-semibold app-text-primary">Suggestion:</span> {LOADING_SUGGESTIONS[suggestionIndex]}
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
