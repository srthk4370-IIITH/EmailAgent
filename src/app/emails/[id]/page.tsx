import { notFound } from "next/navigation";

import { getEmailById } from "../../../db/emails";
import { listLogsByTraceId } from "../../../db/logs";
import { EmailMetadataPanel } from "../../../components/email/EmailMetadataPanel";
import { InlineStatusBar } from "../../../components/email/InlineStatusBar";
import { PageHeader } from "../../../components/layout/PageHeader";
import { PageSection } from "../../../components/layout/PageSection";

export default async function EmailDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const email = await getEmailById(Number(id));
  if (!email) return notFound();

  const logs = email.trace_id ? await listLogsByTraceId(email.trace_id) : [];

  return (
    <main className="h-full overflow-y-auto px-4 py-4 md:px-8 md:py-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <InlineStatusBar state={email.state} category={email.category} confidence={email.confidence} className="rounded-t-[18px]" />

        <PageSection>
          <PageHeader
            title={`Email #${email.id}`}
            subtitle="Thread metadata and reasoning summary."
            compactLabel={`Email #${email.id}`}
          />
          <div className="mt-4 grid gap-2 text-sm app-text-secondary md:grid-cols-2">
            <p><strong>Subject:</strong> {email.subject}</p>
            <p><strong>Decision:</strong> {email.decision}</p>
            <p><strong>Trace:</strong> <code>{email.trace_id}</code></p>
            <p><strong>Classification:</strong> {email.category} ({email.confidence})</p>
          </div>
        </PageSection>

        <PageSection title="Generated Reply">
          <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 app-text-secondary">{email.reply ?? "-"}</pre>
        </PageSection>

        <PageSection title="Context and transparency">
          <div className="mt-3 overflow-hidden rounded-[18px] border app-border bg-[color:var(--surface-elevated)]">
            <EmailMetadataPanel detail={email as never} title="Context and transparency" />
          </div>
        </PageSection>

        <PageSection title="RAG Context">
          <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 app-text-secondary">{JSON.stringify(email.rag_context, null, 2)}</pre>
        </PageSection>

        <PageSection title="Logs">
          <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 app-text-secondary">{JSON.stringify(logs, null, 2)}</pre>
        </PageSection>
      </div>
    </main>
  );
}
