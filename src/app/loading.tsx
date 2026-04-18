export default function GlobalLoading() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--surface-secondary)_46%,transparent),transparent_52%),radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--surface-accent)_58%,transparent),transparent_48%)]" />

      <div className="relative w-full max-w-6xl">
        <div className="mb-6 text-center md:mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border app-border bg-[color:var(--surface-layer-1)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] app-text-faint shadow-sm backdrop-blur">
            Nova Mail
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight app-text-primary md:text-4xl">Loading your workspace</h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm app-text-secondary">Restoring inbox state, sync health, and account context with a quieter interface and cached entry.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-[320px_minmax(0,1fr)]">
          <div className="panel-surface-strong rounded-[28px] p-5 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] app-text-faint">Workspace index</div>
                <div className="mt-2 text-sm font-semibold app-text-primary">Preparing inbox routes</div>
              </div>
              <div className="relative flex h-14 w-14 items-center justify-center">
                <div className="absolute inset-0 rounded-full border border-[color:var(--border-soft)]" />
                <div className="absolute inset-1 rounded-full border border-[color:var(--border-soft)] opacity-70" />
                <div className="absolute inset-2 rounded-full border border-[color:var(--border-soft)] border-t-[color:var(--text-primary)] animate-spin" />
                <div
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--text-primary) 88%, transparent)",
                    boxShadow: "0 0 0 8px color-mix(in srgb, var(--text-primary) 8%, transparent)",
                  }}
                />
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {Array.from({ length: 7 }).map((_, index) => (
                <div key={index} className="app-shimmer h-10 rounded-2xl" style={{ animationDelay: `${index * 90}ms` }} />
              ))}
            </div>
          </div>

          <div className="panel-surface rounded-[28px] p-4 md:p-6">
            <div className="grid gap-3 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="app-shimmer h-20 rounded-[22px]" style={{ animationDelay: `${index * 120}ms` }} />
              ))}
            </div>

            <div className="mt-5 rounded-[22px] border app-border bg-[color:var(--surface-layer-2)] px-4 py-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.2em] app-text-faint">Current load</div>
                  <div className="mt-1 text-sm font-semibold app-text-primary">Routing, sync, and caches</div>
                </div>
                <div className="flex items-center gap-1.5 text-xs app-text-muted">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "color-mix(in srgb, var(--text-primary) 60%, transparent)", animation: "pulse 1.6s ease-in-out infinite" }} />
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "color-mix(in srgb, var(--text-primary) 74%, transparent)", animation: "pulse 1.6s ease-in-out infinite", animationDelay: "120ms" }} />
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "color-mix(in srgb, var(--text-primary) 86%, transparent)", animation: "pulse 1.6s ease-in-out infinite", animationDelay: "240ms" }} />
                </div>
              </div>

              <div className="mt-4 h-2 overflow-hidden rounded-full bg-[color:var(--surface-secondary)]">
                <div
                  className="h-full w-2/3 rounded-full"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--text-primary) 85%, transparent)",
                    animation: "loadingSlide 1.7s ease-in-out infinite",
                  }}
                />
              </div>
            </div>

            <div className="mt-3 app-shimmer h-12 rounded-[22px]" />

            <div className="mt-5 space-y-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="app-shimmer h-16 rounded-[22px]" style={{ animationDelay: `${index * 80}ms` }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
