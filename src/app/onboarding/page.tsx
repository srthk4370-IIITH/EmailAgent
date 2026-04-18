"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, HelpCircle, Loader2, RefreshCcw, Wrench, XCircle } from "lucide-react";

type StepId = "openai" | "database" | "oauth" | "gmail" | "final_validation";
type StepStatus = "idle" | "loading" | "success" | "error";

type OnboardingStatusResponse = {
  currentStepIndex: number;
  completed: boolean;
  draft?: Partial<FormState> & {
    hasOpenAiKey?: boolean;
    hasDatabaseUrl?: boolean;
    hasClientSecret?: boolean;
    openaiKeyPreview?: string;
    databaseUrlPreview?: string;
    clientSecretPreview?: string;
  };
  checks: {
    openai: boolean;
    database: boolean;
    oauth: boolean;
    gmail: boolean;
    final_validation: boolean;
  };
  readiness?: {
    ready: boolean;
    issues: Array<{
      code: string;
      cause: string;
      fix: string;
      step: StepId;
    }>;
  };
};

type DebugInfo = {
  traceId: string;
  endpoint: string;
  timestamp: string;
};

type ValidationError = {
  error: string;
  cause: string;
  fix: string;
  remediationStep?: StepId;
};

type ValidationResponse = {
  ok: boolean;
  retryable?: boolean;
  remediationStep?: StepId;
  message?: string;
  error?: string;
  cause?: string;
  fix?: string;
  debug?: DebugInfo;
  readiness?: {
    ready: boolean;
    issues: Array<{
      code: string;
      cause: string;
      fix: string;
      step: StepId;
    }>;
  };
  checks?: Record<string, { ok: boolean; message?: string; error?: string; cause?: string; fix?: string; remediationStep?: StepId }>;
  missingScopes?: string[];
  expectedRedirectUri?: string;
};

type StepContent = {
  id: StepId;
  title: string;
  purpose: string;
  inputRequired: string[];
  guide: string[];
  commonErrors: string[];
  screenshotNotes: string[];
};

type FormState = {
  openaiKey: string;
  databaseProvider: "postgresql" | "supabase" | "firebase";
  databaseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

const STEP_LIST: StepContent[] = [
  {
    id: "openai",
    title: "OpenAI API Key",
    purpose: "Connect AI generation so the app can draft and classify emails.",
    inputRequired: ["OpenAI API key from OpenAI dashboard (starts with sk-...)."],
    guide: [
      "Open browser -> go to https://platform.openai.com -> sign in.",
      "Top-right avatar menu -> click API keys.",
      "On API Keys page click Create new secret key.",
      "In Name field type EmailAgent-Production -> click Create secret key.",
      "Click Copy on the generated key modal (the key is shown only once).",
      "Return to this page -> paste full key into OpenAI API Key field (starts with sk-).",
      "Click Validate this step and wait for success badge.",
    ],
    commonErrors: [
      "Copied only part of the key.",
      "Using a revoked or deleted key.",
      "No billing/quota enabled in OpenAI account.",
      "Temporary rate limits causing validation failure.",
    ],
    screenshotNotes: [
      "OpenAI API Keys page with the Create new secret key button highlighted.",
      "Secret key modal showing one-time copy warning.",
      "Billing usage screen where quota and limits are configured.",
    ],
  },
  {
    id: "database",
    title: "Database setup (Supabase / PostgreSQL)",
    purpose: "Store accounts, emails, drafts, logs, and onboarding progress.",
    inputRequired: ["Provider selection", "DATABASE_URL connection string"],
    guide: [
      "Choose provider from dropdown: PostgreSQL or Supabase.",
      "If Supabase: open https://app.supabase.com -> click New project -> fill Organization, Name, Database Password -> click Create new project.",
      "In Supabase project: left menu Settings -> Database -> Connection string -> URI, then click Copy.",
      "If PostgreSQL: open your DB admin panel -> create database + user -> grant read/write/create temp permissions -> copy URI in format postgresql://user:password@host:5432/dbname.",
      "Paste URI into DATABASE_URL field exactly (include sslmode=require when provider requires SSL).",
      "Click Validate this step to run connection, read/write, and required-table checks.",
    ],
    commonErrors: [
      "Password contains special characters not URL-encoded.",
      "Incorrect host/port in URI.",
      "SSL mode required by provider but not configured.",
      "Database user lacks insert/select permissions.",
    ],
    screenshotNotes: [
      "Supabase settings page showing Connection string section.",
      "PostgreSQL admin page with host, port, db name, username fields.",
      "URI example with encoded password and sslmode parameter.",
    ],
  },
  {
    id: "oauth",
    title: "OAuth setup (Google Cloud)",
    purpose: "Enable secure Google authorization and callback handling.",
    inputRequired: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REDIRECT_URI"],
    guide: [
      "Open https://console.cloud.google.com -> top project picker -> New Project -> enter name EmailAgent -> click Create.",
      "Left menu APIs & Services -> OAuth consent screen -> choose External -> click Create.",
      "Fill app name, support email, developer contact email -> click Save and Continue until Back to Dashboard.",
      "Open APIs & Services -> Credentials -> click Create Credentials -> OAuth client ID.",
      "Application type: Web application, name: EmailAgent Web Client.",
      "Authorized redirect URIs -> Add URI -> paste exact value shown in this step (example: https://your-domain.com/api/auth/google/callback) -> click Create.",
      "Copy Client ID and Client Secret from popup, then paste into GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET fields.",
      "Paste the same redirect URI into GMAIL_REDIRECT_URI field and click Validate this step.",
    ],
    commonErrors: [
      "Redirect URI mismatch due to extra slash or wrong host.",
      "Client secret copied from wrong project.",
      "OAuth app still missing consent screen fields.",
      "Testing users not added for unverified app.",
    ],
    screenshotNotes: [
      "Google Cloud OAuth consent screen configuration page.",
      "OAuth client creation form with Web application selected.",
      "Authorized redirect URIs list showing exact callback URL.",
    ],
  },
  {
    id: "gmail",
    title: "Gmail integration (permissions + scopes)",
    purpose: "Connect Gmail account with required read/compose/send permissions.",
    inputRequired: ["Authorize Gmail via Connect Gmail button"],
    guide: [
      "Click Connect Gmail account.",
      "In Google account picker select the mailbox this app should automate.",
      "On consent screen click Continue then Allow for all requested Gmail scopes.",
      "Wait for redirect back to onboarding page.",
      "Click Validate this step to verify refresh token, required scopes, Gmail profile access, and sync cursor.",
    ],
    commonErrors: [
      "User denied one or more required Gmail scopes.",
      "Connected wrong Google account.",
      "Refresh token not issued due to consent flow mismatch.",
      "Initial sync cursor not created yet.",
    ],
    screenshotNotes: [
      "Google account picker with selected account highlighted.",
      "Consent screen showing Gmail scope list and Allow button.",
      "Successful return screen back in app after OAuth callback.",
    ],
  },
  {
    id: "final_validation",
    title: "Final system validation",
    purpose: "Confirm OpenAI, database, OAuth, and Gmail all work together.",
    inputRequired: ["No extra input required"],
    guide: [
      "Click Run final validation.",
      "Wait while the app checks OpenAI, database, OAuth, Gmail, and Gmail self-send delivery test.",
      "Review pass/fail cards in System Test Results.",
      "For any failed card click Fix this to jump to the relevant setup step.",
      "After fixing, run final validation again and finish setup only when all cards are green.",
    ],
    commonErrors: [
      "Single subsystem still misconfigured.",
      "Token expired between steps.",
      "Transient network timeout on one check.",
    ],
    screenshotNotes: [
      "Final validation matrix showing green checks and red failures.",
      "Fix action buttons that jump back to the failing step.",
      "Setup complete confirmation card.",
    ],
  },
];

const STORAGE_KEY = "onboarding-form-v1";

export default function OnboardingPage() {
  const router = useRouter();
  const [status, setStatus] = useState<OnboardingStatusResponse | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStatus, setStepStatus] = useState<Record<StepId, StepStatus>>({
    openai: "idle",
    database: "idle",
    oauth: "idle",
    gmail: "idle",
    final_validation: "idle",
  });
  const [stepErrors, setStepErrors] = useState<Partial<Record<StepId, ValidationError>>>({});
  const [stepMessages, setStepMessages] = useState<Partial<Record<StepId, string>>>({});
  const [showHelp, setShowHelp] = useState<Partial<Record<StepId, boolean>>>({});
  const [finalChecks, setFinalChecks] = useState<ValidationResponse["checks"]>();
  const [savedAt, setSavedAt] = useState<string>("");
  const [origin, setOrigin] = useState<string>("");
  const [showDebug, setShowDebug] = useState(false);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
  const [isSavingRemote, setIsSavingRemote] = useState(false);
  const [readiness, setReadiness] = useState<OnboardingStatusResponse["readiness"]>();
  const [validationAttempts, setValidationAttempts] = useState<Record<StepId, number>>({
    openai: 0,
    database: 0,
    oauth: 0,
    gmail: 0,
    final_validation: 0,
  });
  const [serverDraftHints, setServerDraftHints] = useState<{
    hasOpenAiKey: boolean;
    hasDatabaseUrl: boolean;
    hasClientSecret: boolean;
    openaiKeyPreview: string;
    databaseUrlPreview: string;
    clientSecretPreview: string;
  }>({
    hasOpenAiKey: false,
    hasDatabaseUrl: false,
    hasClientSecret: false,
    openaiKeyPreview: "",
    databaseUrlPreview: "",
    clientSecretPreview: "",
  });

  const [form, setForm] = useState<FormState>({
    openaiKey: "",
    databaseProvider: "postgresql",
    databaseUrl: "",
    clientId: "",
    clientSecret: "",
    redirectUri: "",
  });

  const current: StepContent = STEP_LIST[currentStep] ?? STEP_LIST[0]!;

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<FormState>;
        setForm((prev) => ({ ...prev, ...parsed }));
      } catch {
        // no-op
      }
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    setSavedAt(new Date().toLocaleTimeString());
  }, [form]);

  async function refreshStatus() {
    const res = await fetch("/api/system/onboarding", { credentials: "include" });
    if (!res.ok) return;
    const json = (await res.json()) as OnboardingStatusResponse;
    setStatus(json);
    setReadiness(json.readiness);
    if (json.draft) {
      setForm((prev) => ({ ...prev, ...json.draft }));
      setServerDraftHints({
        hasOpenAiKey: Boolean(json.draft.hasOpenAiKey),
        hasDatabaseUrl: Boolean(json.draft.hasDatabaseUrl),
        hasClientSecret: Boolean(json.draft.hasClientSecret),
        openaiKeyPreview: json.draft.openaiKeyPreview ?? "",
        databaseUrlPreview: json.draft.databaseUrlPreview ?? "",
        clientSecretPreview: json.draft.clientSecretPreview ?? "",
      });
    }
    if (json.completed) {
      router.replace("/");
      return;
    }

    setStepStatus((prev) => ({
      ...prev,
      openai: json.checks.openai ? "success" : prev.openai,
      database: json.checks.database ? "success" : prev.database,
      oauth: json.checks.oauth ? "success" : prev.oauth,
      gmail: json.checks.gmail ? "success" : prev.gmail,
      final_validation: json.checks.final_validation ? "success" : prev.final_validation,
    }));

    const idx = Math.max(0, Math.min(4, json.currentStepIndex));
    setCurrentStep(idx > 0 ? idx - 1 : 0);
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        setIsSavingRemote(true);
        try {
          await fetch("/api/system/onboarding", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              action: "save_step_input",
              step: current.id,
              payload: {
                openaiKey: form.openaiKey,
                databaseProvider: form.databaseProvider,
                databaseUrl: form.databaseUrl,
                clientId: form.clientId,
                clientSecret: form.clientSecret,
                redirectUri: form.redirectUri,
              },
            }),
          });
        } finally {
          setIsSavingRemote(false);
        }
      })();
    }, 700);

    return () => clearTimeout(timer);
  }, [current.id, form]);

  const stepCompleted = useMemo(() => {
    const id = STEP_LIST[currentStep]?.id;
    if (!id) return false;
    return stepStatus[id] === "success";
  }, [currentStep, stepStatus]);

  async function validateStep(id: StepId) {
    setStepStatus((prev) => ({ ...prev, [id]: "loading" }));
    setStepErrors((prev) => ({ ...prev, [id]: undefined }));

    const action = id === "final_validation" ? "run_final_validation" : "validate_step";
    const res = await fetch("/api/system/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        action,
        step: id,
        payload: {
          openaiKey: form.openaiKey,
          databaseProvider: form.databaseProvider,
          databaseUrl: form.databaseUrl,
          clientId: form.clientId,
          clientSecret: form.clientSecret,
          redirectUri: form.redirectUri,
        },
      }),
    });

    const json = (await res.json()) as ValidationResponse;
    setDebugInfo(json.debug ?? null);

    if (json.ok) {
      setStepStatus((prev) => ({ ...prev, [id]: "success" }));
      setValidationAttempts((prev) => ({ ...prev, [id]: 0 }));
      setStepMessages((prev) => ({ ...prev, [id]: json.message ?? "Validated successfully." }));
      if (json.readiness) {
        setReadiness(json.readiness);
      }
      if (id === "final_validation" && json.checks) {
        setFinalChecks(json.checks);
      }
      await refreshStatus();
      return;
    }

    setStepStatus((prev) => ({ ...prev, [id]: "error" }));
    setValidationAttempts((prev) => ({ ...prev, [id]: prev[id] + 1 }));
    setStepErrors((prev) => ({
      ...prev,
      [id]: {
        error: json.error ?? "Validation failed",
        cause: json.cause ?? "Unknown reason",
        fix: json.fix ?? "Retry this step after reviewing your inputs.",
        remediationStep: json.remediationStep,
      },
    }));
    if (json.readiness) {
      setReadiness(json.readiness);
    }
    if (id === "final_validation" && json.checks) {
      setFinalChecks(json.checks);
    }
  }

  function nextStep() {
    setCurrentStep((prev) => Math.min(STEP_LIST.length - 1, prev + 1));
  }

  function jumpToStep(step: StepId) {
    const idx = STEP_LIST.findIndex((item) => item.id === step);
    if (idx >= 0) setCurrentStep(idx);
  }

  function inputForCurrentStep() {
    if (current.id === "openai") {
      return (
        <label className="space-y-2 text-sm">
          <span className="app-text-secondary">OpenAI API Key</span>
          <input
            type="password"
            data-testid="input-openai-key"
            value={form.openaiKey}
            onChange={(event) => setForm((prev) => ({ ...prev, openaiKey: event.target.value }))}
            placeholder="sk-..."
            className="w-full rounded-xl app-input px-3 py-2"
          />
        </label>
      );
    }

    if (current.id === "database") {
      return (
        <div className="space-y-3">
          <label className="space-y-2 text-sm">
            <span className="app-text-secondary">Database provider</span>
            <select
              data-testid="select-database-provider"
              value={form.databaseProvider}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, databaseProvider: event.target.value as FormState["databaseProvider"] }))
              }
              className="w-full rounded-xl app-input px-3 py-2"
            >
              <option value="postgresql">PostgreSQL</option>
              <option value="supabase">Supabase</option>
              <option value="firebase" disabled>
                Firebase (coming soon)
              </option>
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="app-text-secondary">DATABASE_URL</span>
            <input
              type="text"
              data-testid="input-database-url"
              value={form.databaseUrl}
              onChange={(event) => setForm((prev) => ({ ...prev, databaseUrl: event.target.value }))}
              placeholder="postgresql://user:pass@host:5432/db"
              className="w-full rounded-xl app-input px-3 py-2"
            />
          </label>
        </div>
      );
    }

    if (current.id === "oauth") {
      return (
        <div className="space-y-3">
          <label className="space-y-2 text-sm">
            <span className="app-text-secondary">GMAIL_CLIENT_ID</span>
            <input
              type="text"
              data-testid="input-client-id"
              value={form.clientId}
              onChange={(event) => setForm((prev) => ({ ...prev, clientId: event.target.value }))}
              placeholder="Google OAuth Client ID"
              className="w-full rounded-xl app-input px-3 py-2"
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="app-text-secondary">GMAIL_CLIENT_SECRET</span>
            <input
              type="password"
              data-testid="input-client-secret"
              value={form.clientSecret}
              onChange={(event) => setForm((prev) => ({ ...prev, clientSecret: event.target.value }))}
              placeholder="Google OAuth Client Secret"
              className="w-full rounded-xl app-input px-3 py-2"
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="app-text-secondary">GMAIL_REDIRECT_URI</span>
            <input
              type="text"
              data-testid="input-redirect-uri"
              value={form.redirectUri}
              onChange={(event) => setForm((prev) => ({ ...prev, redirectUri: event.target.value }))}
              placeholder={origin ? `${origin}/api/auth/google/callback` : "https://your-domain.com/api/auth/google/callback"}
              className="w-full rounded-xl app-input px-3 py-2"
            />
          </label>
        </div>
      );
    }

    if (current.id === "gmail") {
      return (
        <div className="rounded-xl app-input px-4 py-4 text-sm app-text-secondary">
          <p className="mb-3">Authorize your Gmail account before validating this step.</p>
          <a href="/api/auth/google" data-testid="button-connect-gmail" className="app-button-secondary inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs">
            <LinkIcon /> Connect Gmail account
          </a>
          <p className="mt-3 text-xs app-text-muted">
            Required scopes: gmail.readonly, gmail.compose, gmail.send.
          </p>
        </div>
      );
    }

    return (
      <div className="rounded-xl app-input px-4 py-4 text-sm app-text-secondary">
        Run the final test to verify all systems together.
      </div>
    );
  }

  function statusBadge(id: StepId) {
    const s = stepStatus[id];
    if (s === "loading") return <span className="inline-flex items-center gap-1 rounded-full app-input px-2 py-1 text-xs"><Loader2 className="h-3 w-3 animate-spin" /> Validating</span>;
    if (s === "success") return <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs" style={{ background: "var(--success-soft)", color: "var(--success)" }}><CheckCircle2 className="h-3 w-3" /> Passed</span>;
    if (s === "error") return <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}><XCircle className="h-3 w-3" /> Failed</span>;
    return <span className="inline-flex items-center gap-1 rounded-full app-input px-2 py-1 text-xs app-text-muted">Waiting</span>;
  }

  return (
    <div className="min-h-screen bg-[color:var(--surface-secondary)] px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto grid w-full max-w-6xl gap-4 lg:grid-cols-[320px_1fr]">
        <aside className="rounded-2xl bg-[color:var(--surface-elevated)] p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] app-text-faint">Onboarding progress</div>
          <h1 className="mt-2 text-2xl font-semibold app-text-primary">Guided setup</h1>
          <p className="mt-2 text-sm app-text-secondary">Complete all 5 steps. Next is locked until each validation passes.</p>

          <div className="mt-4 h-2 w-full overflow-hidden rounded-full app-input">
            <div
              className="h-full rounded-full"
              style={{ width: `${((currentStep + 1) / STEP_LIST.length) * 100}%`, background: "var(--accent)" }}
            />
          </div>
          <p className="mt-2 text-xs app-text-muted">Step {currentStep + 1} of {STEP_LIST.length}</p>

          <div className="mt-4 space-y-2">
            {STEP_LIST.map((step, idx) => (
              <button
                type="button"
                key={step.id}
                data-testid={`step-nav-${step.id}`}
                onClick={() => jumpToStep(step.id)}
                className={`w-full rounded-xl border px-3 py-2 text-left ${idx === currentStep ? "app-accent-bg" : "app-input"}`}
              >
                <div className="text-xs app-text-faint">{idx + 1}/5</div>
                <div className="text-sm font-semibold app-text-primary">{step.title}</div>
                <div className="mt-1">{statusBadge(step.id)}</div>
              </button>
            ))}
          </div>

          <p className="mt-4 text-xs app-text-muted">Auto-saved {savedAt || "just now"}{isSavingRemote ? " - Syncing to server..." : ""}</p>
        </aside>

        <main className="rounded-2xl bg-[color:var(--surface-elevated)] p-5 shadow-sm md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.14em] app-text-faint">Step {currentStep + 1}</div>
              <h2 className="mt-1 text-2xl font-semibold app-text-primary">{current.title}</h2>
              <p className="mt-2 text-sm app-text-secondary"><strong>Purpose:</strong> {current.purpose}</p>
            </div>
            {statusBadge(current.id)}
          </div>

          <section className="mt-5 rounded-xl app-input px-4 py-4">
            <div className="text-sm font-semibold app-text-primary">Input Required</div>
            <ul className="mt-2 list-disc pl-5 text-sm app-text-secondary">
              {current.inputRequired.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          {readiness && !readiness.ready && (
            <section className="mt-4 rounded-xl border px-4 py-3 app-state-error text-sm">
              <div className="font-semibold">Readiness checks found blockers</div>
              <ul className="mt-2 list-disc pl-5">
                {readiness.issues.map((issue) => (
                  <li key={issue.code}>
                    <strong>{issue.cause}</strong> {issue.fix}{" "}
                    <button
                      type="button"
                      onClick={() => jumpToStep(issue.step)}
                      className="app-button-secondary ml-2 rounded-full px-2 py-1 text-[11px]"
                    >
                      Fix in step
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-4 rounded-xl app-input px-4 py-4">
            <div className="text-sm font-semibold app-text-primary">Step-by-Step Guide</div>
            <ol className="mt-2 list-decimal pl-5 text-sm app-text-secondary">
              {current.guide.map((item) => (
                <li key={item} className="mt-1">{item}</li>
              ))}
            </ol>
          </section>

          <section className="mt-4">{inputForCurrentStep()}</section>

          {(current.id === "openai" && serverDraftHints.hasOpenAiKey) ||
          (current.id === "database" && serverDraftHints.hasDatabaseUrl) ||
          (current.id === "oauth" && serverDraftHints.hasClientSecret) ? (
            <section className="mt-3 rounded-xl border app-border bg-[color:var(--surface-secondary)] px-4 py-3 text-xs app-text-secondary">
              <div className="font-semibold app-text-primary">Saved secure value detected</div>
              {current.id === "openai" ? <div className="mt-1">Server preview: {serverDraftHints.openaiKeyPreview || "***"}</div> : null}
              {current.id === "database" ? <div className="mt-1">Server preview: {serverDraftHints.databaseUrlPreview || "***"}</div> : null}
              {current.id === "oauth" ? <div className="mt-1">Server preview: {serverDraftHints.clientSecretPreview || "***"}</div> : null}
              <div className="mt-1 app-text-muted">Sensitive values are masked in the browser for safety. Re-enter if you need to edit.</div>
            </section>
          ) : null}

          <section className="mt-4 rounded-xl border app-border bg-[color:var(--surface-secondary)] px-4 py-3">
            <button
              type="button"
              onClick={() => setShowHelp((prev) => ({ ...prev, [current.id]: !prev[current.id] }))}
              className="app-button-secondary inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs"
            >
              <HelpCircle className="h-4 w-4" />
              Don’t know how to get this?
            </button>

            {showHelp[current.id] && (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl app-input px-3 py-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.1em] app-text-faint">Common mistakes</div>
                  <ul className="mt-2 list-disc pl-5 text-sm app-text-secondary">
                    {current.commonErrors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl app-input px-3 py-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.1em] app-text-faint">Screenshot descriptions</div>
                  <ul className="mt-2 list-disc pl-5 text-sm app-text-secondary">
                    {current.screenshotNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>

          {stepMessages[current.id] && (
            <section className="mt-4 rounded-xl px-4 py-3 text-sm" style={{ background: "var(--success-soft)", color: "var(--success)" }}>
              <div className="inline-flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4" />
                <span>{stepMessages[current.id]}</span>
              </div>
            </section>
          )}

          {stepErrors[current.id] && (
            <section className="mt-4 rounded-xl border px-4 py-3 app-state-error text-sm">
              <div className="font-semibold">{stepErrors[current.id]?.error}</div>
              <div className="mt-1"><strong>Cause:</strong> {stepErrors[current.id]?.cause}</div>
              <div className="mt-1"><strong>How to fix:</strong> {stepErrors[current.id]?.fix}</div>
              {stepErrors[current.id]?.remediationStep && stepErrors[current.id]?.remediationStep !== current.id ? (
                <button
                  type="button"
                  onClick={() => jumpToStep(stepErrors[current.id]!.remediationStep!)}
                  className="app-button-secondary mt-2 inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px]"
                >
                  <Wrench className="h-3 w-3" /> Go to fix step
                </button>
              ) : null}
            </section>
          )}

          {validationAttempts[current.id] >= 3 && stepStatus[current.id] === "error" && (
            <section className="mt-3 rounded-xl border app-border px-4 py-3 text-xs app-text-secondary">
              You have hit 3 failed attempts for this step. You can keep retrying, but it is best to review the tutorial and fix checklist first.
            </section>
          )}

          {current.id === "final_validation" && finalChecks && (
            <section className="mt-4 rounded-xl app-input px-4 py-4">
              <div className="text-sm font-semibold app-text-primary">System Test Results</div>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {Object.entries(finalChecks).map(([name, value]) => {
                  const targetStep: StepId =
                    value.remediationStep ??
                    (name === "openai" ? "openai" : name === "database" ? "database" : name === "oauth" ? "oauth" : "gmail");
                  const title = name === "gmailSendProbe" ? "GMAIL SEND TEST" : name.toUpperCase();
                  return (
                    <div key={name} className="rounded-xl border app-border px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold app-text-primary">{title}</div>
                        {value.ok ? (
                          <span className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--success)" }}>
                            <CheckCircle2 className="h-3 w-3" /> OK
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--danger)" }}>
                            <XCircle className="h-3 w-3" /> Failed
                          </span>
                        )}
                      </div>
                      {!value.ok && (
                        <>
                          <div className="mt-1 text-xs app-text-secondary">{value.cause ?? value.error ?? "Validation failed"}</div>
                          <button
                            type="button"
                            onClick={() => jumpToStep(targetStep)}
                            className="app-button-secondary mt-2 inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px]"
                          >
                            <Wrench className="h-3 w-3" /> Fix this
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              data-testid="button-validate-step"
              onClick={() => void validateStep(current.id)}
              disabled={stepStatus[current.id] === "loading"}
              className="app-button-primary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm disabled:opacity-60"
            >
              {stepStatus[current.id] === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              {current.id === "final_validation" ? "Run final validation" : "Validate this step"}
            </button>

            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshStatus()}
                className="app-button-secondary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm"
              >
                <RefreshCcw className="h-4 w-4" /> Retry check
              </button>
              {current.id !== "final_validation" ? (
                <button
                  type="button"
                  onClick={nextStep}
                  disabled={!stepCompleted}
                  className="app-button-primary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm disabled:opacity-50"
                >
                  Next <ChevronRight className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => router.replace("/")}
                  disabled={stepStatus.final_validation !== "success"}
                  className="app-button-primary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm disabled:opacity-50"
                >
                  Finish setup <ChevronRight className="h-4 w-4" />
                </button>
              )}
            </div>
          </section>

          <section className="mt-5 rounded-xl border app-border px-4 py-3 text-xs app-text-muted">
            Raw backend errors are hidden by design. Every failure includes Cause + How to fix. Use Retry without losing inputs.
          </section>

          <section className="mt-3 rounded-xl border app-border px-4 py-3 text-xs">
            <button
              type="button"
              data-testid="button-toggle-debug"
              onClick={() => setShowDebug((prev) => !prev)}
              className="app-button-secondary rounded-full px-3 py-1.5"
            >
              {showDebug ? "Hide advanced diagnostics" : "Show advanced diagnostics"}
            </button>

            {showDebug && (
              <div className="mt-3 rounded-lg app-input px-3 py-3 app-text-secondary">
                <div><strong>Trace ID:</strong> {debugInfo?.traceId ?? "Not available yet"}</div>
                <div className="mt-1"><strong>Endpoint:</strong> {debugInfo?.endpoint ?? "Not available yet"}</div>
                <div className="mt-1"><strong>Timestamp:</strong> {debugInfo?.timestamp ?? "Not available yet"}</div>
                <div className="mt-2 app-text-muted">Use this block when reporting onboarding issues to support.</div>
              </div>
            )}
          </section>

          <section className="mt-3 text-xs app-text-muted">
            Need to reauthenticate now? <Link href="/api/auth/google" className="app-accent-text">Connect Gmail again</Link>
          </section>

          {!status && (
            <section className="mt-4 inline-flex items-center gap-2 rounded-xl app-input px-3 py-2 text-sm app-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading onboarding status...
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function LinkIcon() {
  return <ChevronRight className="h-4 w-4" />;
}
