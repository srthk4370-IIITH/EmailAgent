"use client";

import React from "react";

export type EmbeddingChunk = {
  id: number;
  chunk_text: string;
  chunk_type: string;
  content_hash: string | null;
  created_at: string;
};

export type EmbeddingViewerProps = {
  status: string;
  error?: string | null | undefined;
  chunks: EmbeddingChunk[];
  chunkCount?: number;
  loading: boolean;
};

function statusTone(status: string) {
  if (status === "embedded") {
    return { background: "var(--color-success-soft)", color: "var(--color-success)" };
  }
  if (status === "failed") {
    return { background: "var(--color-danger-soft)", color: "var(--color-danger)" };
  }
  if (status.startsWith("skipped")) {
    return { background: "var(--color-warning-soft)", color: "var(--color-warning)" };
  }
  return { background: "var(--surface-secondary)", color: "var(--text-secondary)" };
}

export function EmbeddingViewer({ status, error, chunks, chunkCount, loading }: EmbeddingViewerProps) {
  const tone = statusTone(status);
  const totalChunks = chunkCount ?? chunks.length;

  return (
    <div className="flex h-full flex-col bg-transparent">
      <div className="border-b app-border px-5 py-4">
        <h3 className="text-sm font-semibold app-text-primary">Sent memory</h3>
        <p className="mt-1 text-xs app-text-muted">Chunks extracted from the outbound message for RAG.</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <section>
          <div className="mb-4 flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Indexing status</h4>
            <span
              className="rounded-full px-3 py-1 text-xs font-medium"
              style={tone}
            >
              {status.toUpperCase().replaceAll("_", " ")}
            </span>
          </div>

          <div className="mb-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-[18px] app-input-strong p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Chunk count</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight app-text-primary">{totalChunks}</p>
            </div>
            <div className="rounded-[18px] app-input-strong p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Current state</p>
              <p className="mt-2 text-sm font-medium app-text-primary">{status.replaceAll("_", " ")}</p>
            </div>
          </div>

          {error && (
            <div
              className="mb-4 rounded-[18px] p-4"
              style={{
                border: "1px solid var(--border-soft)",
                background: status === "failed" ? "var(--color-danger-soft)" : "var(--surface-secondary)",
              }}
            >
              <p className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">
                {status === "failed" ? "Failure reason" : "Status reason"}
              </p>
              <p className="mt-2 text-sm leading-6 app-text-secondary">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex flex-col gap-3">
              <div className="h-24 animate-pulse rounded-[18px] app-bg-soft"></div>
              <div className="h-16 animate-pulse rounded-[18px] app-bg-soft"></div>
            </div>
          ) : chunks.length === 0 ? (
            <div className="rounded-[18px] border border-dashed app-border app-input-strong p-8 text-center text-sm app-text-muted">
              No chunks extracted.
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm app-text-secondary">
                {totalChunks} internal chunk{totalChunks === 1 ? "" : "s"} indexed for retrieval.
              </p>
              {chunks.map((chunk) => (
                <div key={chunk.id} className="rounded-[18px] app-input-strong p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="app-chip rounded-full px-3 py-1 text-xs font-medium">{chunk.chunk_type}</span>
                    <span className="text-xs app-text-muted">{new Date(chunk.created_at).toLocaleString()}</span>
                  </div>
                  {chunk.content_hash && (
                    <div className="mb-3 text-xs app-text-muted">Hash: {chunk.content_hash}</div>
                  )}
                  <p className="whitespace-pre-wrap break-words text-sm leading-7 app-text-secondary">{chunk.chunk_text}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
