"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

const LOGIN_SUGGESTIONS = [
  "Use one active account per environment for predictable OAuth callbacks.",
  "After sign-in, pin Inbox filters that match your highest-volume categories.",
  "Use inspect mode in threads when confidence is low before approving send.",
  "Archive from Inbox quick actions to keep working set focused.",
];

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const err = params.get("error");
  const [checked, setChecked] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);

  useEffect(() => {
    if (checked) return;
    setSuggestionIndex(Math.floor(Math.random() * LOGIN_SUGGESTIONS.length));
    const timer = window.setInterval(() => {
      setSuggestionIndex((current) => (current + 1 + Math.floor(Math.random() * 2)) % LOGIN_SUGGESTIONS.length);
    }, 2400);
    return () => window.clearInterval(timer);
  }, [checked]);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        router.replace("/");
        return;
      }
      setChecked(true);
    })();
  }, [router]);

  const errorLabel =
    err === "oauth_config"
      ? "Google sign-in is not configured (check GMAIL_CLIENT_ID / SECRET)."
      : err
        ? `Sign-in failed (${err}).`
        : null;

  if (!checked) {
    return (
      <div className="mx-auto flex min-h-[70vh] w-full max-w-lg items-center px-4">
        <div className="panel-surface-strong w-full rounded-[26px] px-6 py-6 text-center shadow-sm">
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] app-text-faint">Session check</div>
          <h2 className="mt-3 text-2xl font-semibold app-text-primary">Checking your sign-in status</h2>
          <p className="mt-2 text-sm app-text-muted">We are validating your active session before showing login.</p>
          <div className="mt-5 rounded-2xl app-input px-4 py-3 text-sm app-text-secondary">
            <span className="font-semibold app-text-primary">Suggestion:</span> {LOGIN_SUGGESTIONS[suggestionIndex]}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4">
      <div className="panel-surface-strong rounded-xl p-6 md:p-7 shadow-sm">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] app-text-faint">Workspace access</div>
        <h1 className="mt-2 text-2xl font-semibold app-text-primary">Sign in</h1>
        <p className="mt-2 text-sm app-text-muted">
          Use your Google account. Register the callback URL in Google Cloud Console:{" "}
          <code className="rounded bg-[color:var(--surface-secondary)] px-1.5 py-0.5 text-xs app-accent-text">/api/auth/google/callback</code>
        </p>
        {errorLabel && <p className="mt-4 rounded-lg border app-state-error px-3 py-2 text-sm">{errorLabel}</p>}
        <a
          href="/api/auth/google"
          className="app-button-primary mt-6 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="currentColor"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="currentColor"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="currentColor"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Continue with Google
        </a>
        <p className="mt-5 text-center text-xs app-text-muted">
          <Link href="/" className="app-text-secondary hover:opacity-80">
            Back home
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<p className="p-8 app-text-muted">Loading...</p>}>
      <LoginInner />
    </Suspense>
  );
}
