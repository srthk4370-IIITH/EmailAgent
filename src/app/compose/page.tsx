"use client";

import { useCallback, useMemo, useState } from "react";
import { CheckCircle2, Send } from "lucide-react";
import { InlineErrorCard } from "../../components/errors/InlineErrorCard";
import { useErrorCenter } from "../../components/errors/ErrorCenter";
import { useScrollCollapse } from "../../components/layout/useScrollCollapse";
import type { AppError } from "../../lib/errorNormalizer";
import { fetchJsonWithAppError, toAppError } from "../../lib/fetchWithAppError";

type SendResult = {
  status: string;
  gmailId?: string;
  emailId?: number;
  traceId?: string;
  embedding_status?: string;
  error?: string;
  duplicate?: boolean;
};

export default function ComposePage() {
  const { setGlobalError, clearGlobalError } = useErrorCenter();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const { collapsed: heroCollapsed, onScroll: onComposeScroll } = useScrollCollapse({ threshold: 72 });

  const canSend = Boolean(to.trim() && subject.trim() && body.trim() && !sending);
  const bodyStats = useMemo(
    () => ({
      chars: body.length,
      words: body.trim() ? body.trim().split(/\s+/).length : 0,
    }),
    [body],
  );

  const preflight = useMemo(() => {
    const promptTokens = Math.ceil((subject.length + body.length + 300) / 4);
    const legalFinancial = /\b(refund|invoice|payment|wire|transfer|guarantee|contract|legal)\b/i.test(body);
    const aggressive = /\b(you\s+must|immediately|final\s+warning|legal\s+action)\b/i.test(body);
    const riskHints: string[] = [];
    if (legalFinancial) riskHints.push("Contains legal/financial intent");
    if (aggressive) riskHints.push("Contains aggressive language");
    return {
      promptTokens,
      riskHints,
      recommendation:
        riskHints.length > 0
          ? "Review carefully before send"
          : promptTokens > 2500
          ? "Long prompt: consider shortening"
          : "Ready to send",
    };
  }, [body, subject]);

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    setResult(null);
    setError(null);

    try {
      const data = await fetchJsonWithAppError<SendResult>("/api/compose/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          to: to.trim(),
          subject: subject.trim(),
          body: body.trim(),
        }),
      }, { retries: 2, retryDelayMs: 1000 });

      setResult(data);
      setTo("");
      setSubject("");
      setBody("");
      clearGlobalError();
    } catch (err) {
      const appError = toAppError(err);
      setError(appError);
      setGlobalError(appError, async () => {
        await handleSend();
      });
    } finally {
      setSending(false);
    }
  }, [body, canSend, clearGlobalError, setGlobalError, subject, to]);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="panel-surface flex min-h-0 flex-col overflow-hidden rounded-[24px]">
        {!heroCollapsed && (
          <div className="border-b app-border px-5 py-5 md:px-6 md:py-6">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] app-accent-text">Compose</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight app-text-primary">Write like Gmail, feed memory automatically.</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 app-text-secondary">
              Manual outbound mail still improves the system. Clean sent messages continue into your sent-memory pipeline after delivery.
            </p>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6" onScroll={onComposeScroll}>
          <div className="space-y-4">
            <label className="app-input block rounded-[18px] px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">To</div>
              <input
                id="compose-to"
                type="email"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                placeholder="recipient@example.com"
                disabled={sending}
                autoFocus
                className="mt-2 w-full bg-transparent text-base app-text-primary focus:outline-none"
              />
            </label>

            <label className="app-input block rounded-[18px] px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Subject</div>
              <input
                id="compose-subject"
                type="text"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="Write a clear subject line"
                disabled={sending}
                className="mt-2 w-full bg-transparent text-base app-text-primary focus:outline-none"
              />
            </label>

            <label className="app-input-strong block rounded-[20px] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Message</div>
              <textarea
                id="compose-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Write your email here."
                disabled={sending}
                className="mt-3 min-h-[460px] w-full resize-none bg-transparent text-[15px] leading-7 app-text-secondary focus:outline-none"
              />
            </label>
          </div>
        </div>
      </section>

      <section className="panel-surface flex min-h-0 flex-col overflow-hidden rounded-[24px]">
        <div className="border-b app-border px-5 py-5">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Send panel</div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight app-text-primary">Delivery</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-4">
            <Metric label="Characters" value={bodyStats.chars} />
            <Metric label="Words" value={bodyStats.words} />
            <Metric label="Estimated tokens" value={preflight.promptTokens} />
            <Metric label="Embedding" value={result?.embedding_status ?? "pending"} />

            <div className="app-input rounded-[18px] px-4 py-4 text-sm leading-6 app-text-secondary">
              Successful sends are inserted into the sent-memory workflow so future replies can learn from them.
            </div>

            <div className="app-input-strong rounded-[18px] px-4 py-4 text-sm leading-6 app-text-secondary">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Pre-send guidance</div>
              <p className="mt-2">{preflight.recommendation}</p>
              {preflight.riskHints.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs">
                  {preflight.riskHints.map((hint) => (
                    <li key={hint}>{hint}</li>
                  ))}
                </ul>
              )}
            </div>

            {error && <InlineErrorCard error={error} onRetry={async () => { await handleSend(); }} />}

            {result && (
              <div className="rounded-lg app-state-success border px-4 py-4">
                <div className="flex items-center gap-2 text-sm font-medium app-text-primary">
                  <CheckCircle2 className="h-4 w-4" />
                  Message sent successfully
                </div>
                <div className="mt-3 space-y-1 text-xs app-text-secondary">
                  {result.traceId && <div>Trace: {result.traceId}</div>}
                  {result.emailId && <div>Email ID: {result.emailId}</div>}
                  <div>Embedding status: {result.embedding_status ?? "pending"}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="border-t app-border px-5 py-5">
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!canSend}
            className="app-button-primary inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="app-input-strong rounded-[18px] px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight app-text-primary">{value}</div>
    </div>
  );
}
