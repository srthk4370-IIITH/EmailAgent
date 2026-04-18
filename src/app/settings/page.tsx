"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Database,
  Download,
  Loader2,
  Palette,
  Play,
  Plus,
  RefreshCcw,
  Settings,
  Shield,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";

import { InlineErrorCard } from "../../components/errors/InlineErrorCard";
import { useTheme } from "../../components/ThemeProvider";
import { useScrollCollapse } from "../../components/layout/useScrollCollapse";
import { normalizeApiErrorPayload, normalizeError, type AppError } from "../../lib/errorNormalizer";
import { getCategoryTone } from "../../lib/mailVisuals";

type Config = {
  config_version: number;
  global_mode: string;
  send_mode: string;
  threshold: number;
  daily_token_limit?: number;
  token_budget_auto_expand_enabled?: boolean;
  token_budget_max_daily_limit?: number;
  token_budget_expand_step?: number;
  token_budget_expand_threshold_percent?: number;
  category_colors: Record<string, string>;
  category_rules: Record<
    string,
    | "assist"
    | "manual"
    | "auto"
    | {
        mode: "assist" | "manual" | "auto";
        confidence_threshold: number;
        description?: string;
      }
  >;
  tone: string;
};

const SETTINGS_CONFIG_CACHE_KEY = "settings:config:v1";
const DEFAULT_DAILY_TOKEN_LIMIT = 500_000;
const DEFAULT_BUDGET_EXPAND_THRESHOLD_PERCENT = 90;
const DEFAULT_BUDGET_EXPAND_STEP = 250_000;
const DEFAULT_BUDGET_MAX_DAILY_LIMIT = 3_000_000;

function readCachedSettingsConfig(): Config | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_CONFIG_CACHE_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as Config) ?? null;
  } catch {
    return null;
  }
}

function writeCachedSettingsConfig(config: Config): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SETTINGS_CONFIG_CACHE_KEY, JSON.stringify({ ...config, cachedAt: Date.now() }));
  } catch {
    // Cache is best-effort only.
  }
}

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [config, setConfig] = useState<Config | null>(null);
  const configRef = useRef<Config | null>(null);
  const [composeCategory, setComposeCategory] = useState("");
  const [composeContext, setComposeContext] = useState("");
  const [saving, setSaving] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryThreshold, setNewCategoryThreshold] = useState(0.7);
  const [newCategoryMode, setNewCategoryMode] = useState<"assist" | "manual" | "auto">("assist");
  const [configError, setConfigError] = useState<AppError | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupSummary, setCleanupSummary] = useState<{
    deletedEmails: number;
    deletedLogs: number;
    deletedErrorLogs: number;
    deletedThreads: number;
  } | null>(null);
  const { collapsed: heroCollapsed, onScroll: onSettingsScroll } = useScrollCollapse({ threshold: 72 });

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/config", { credentials: "include" });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw normalizeApiErrorPayload(payload, res.status);
      }
      const json = (await res.json()) as Config;
      setConfig(json);
      configRef.current = json;
      writeCachedSettingsConfig(json);
      setConfigError(null);
      return json;
    } catch (err) {
      const appError = normalizeError(err, {
        source: "ui",
        operation: "settings_refresh_config",
        fallbackStatus: 500,
      });
      setConfigError(appError);
      return null;
    }
  }, []);

  useEffect(() => {
    const cached = readCachedSettingsConfig();
    if (cached) {
      setConfig(cached);
      configRef.current = cached;
    }
    void refresh();
  }, [refresh]);

  const categories = useMemo(() => Object.keys(config?.category_rules ?? {}), [config]);

  useEffect(() => {
    if (composeCategory) return;
    if (categories.includes("general")) {
      setComposeCategory("general");
      return;
    }
    if (categories.length > 0) setComposeCategory(categories[0]!);
  }, [categories, composeCategory]);

  function normalizeCategoryRule(rule: Config["category_rules"][string] | undefined) {
    if (!rule) return { mode: "manual" as const, confidence_threshold: config?.threshold ?? 0.7 };
    if (typeof rule === "string") return { mode: rule, confidence_threshold: config?.threshold ?? 0.7 };
    return { mode: rule.mode, confidence_threshold: rule.confidence_threshold };
  }

  async function postConfig(body: Record<string, unknown>) {
    setSaving(true);
    setConfigError(null);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const expectedVersion = configRef.current?.config_version;
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            ...body,
            ...(typeof expectedVersion === "number" ? { expected_config_version: expectedVersion } : {}),
          }),
        });
        if (res.ok) {
          await refresh();
          return;
        }

        const errorPayload = await res.json().catch(() => null);
        const appError = normalizeApiErrorPayload(errorPayload, res.status);

        if (appError.code === "CONFIG_VERSION_CONFLICT" && attempt === 0) {
          await refresh();
          continue;
        }

        throw appError;
      }
    } catch (err) {
      const appError = normalizeError(err, {
        source: "ui",
        operation: "settings_update_config",
        fallbackStatus: 500,
      });
      setConfigError(appError);
    } finally {
      setSaving(false);
    }
  }

  async function updateCategoryMode(category: string, mode: "assist" | "manual" | "auto") {
    if (!config) return;
    const existing = config.category_rules?.[category];
    const normalized = normalizeCategoryRule(existing);
    await postConfig({
      category_rules: {
        ...config.category_rules,
        [category]: { mode, confidence_threshold: normalized.confidence_threshold },
      },
    });
  }

  async function updateCategoryThreshold(category: string, confidence_threshold: number) {
    if (!config) return;
    const existing = config.category_rules?.[category];
    const normalized = normalizeCategoryRule(existing);
    await postConfig({
      category_rules: {
        ...config.category_rules,
        [category]: { mode: normalized.mode, confidence_threshold },
      },
    });
  }

  async function createCategory() {
    if (!config) return;
    const name = newCategoryName.trim();
    if (!name || name in (config.category_rules ?? {})) return;
    const colorKey = name.toLowerCase();
    await postConfig({
      category_rules: {
        ...config.category_rules,
        [name]: { mode: newCategoryMode, confidence_threshold: newCategoryThreshold },
      },
      category_colors: {
        ...(config.category_colors ?? {}),
        [colorKey]: config.category_colors?.[colorKey] ?? "#52525b",
      },
    });
    setNewCategoryName("");
  }

  async function deleteCategory(category: string) {
    if (!config) return;
    const next = { ...(config.category_rules ?? {}) };
    const nextColors = { ...(config.category_colors ?? {}) };
    delete next[category];
    delete nextColors[category.toLowerCase()];
    await postConfig({ category_rules: next, category_colors: nextColors });
  }

  async function updateCategoryColor(category: string, color: string) {
    if (!config) return;
    const key = category.toLowerCase();
    await postConfig({
      category_colors: {
        ...(config.category_colors ?? {}),
        [key]: color,
      },
    });
  }

  async function resetCategoryColor(category: string) {
    if (!config) return;
    const next = { ...(config.category_colors ?? {}) };
    delete next[category.toLowerCase()];
    await postConfig({ category_colors: next });
  }

  async function queueCompose() {
    const category = composeCategory || (categories.includes("general") ? "general" : categories[0] || "general");
    await fetch("/api/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ category, context: composeContext }),
    });
    setComposeContext("");
    void refresh();
  }

  async function clearInjectedJunkEmails() {
    if (cleanupBusy) return;
    if (!confirm("This permanently deletes injected fault-test emails and related logs. Continue?")) return;

    setCleanupBusy(true);
    setCleanupSummary(null);
    setConfigError(null);
    try {
      const res = await fetch("/api/system/cleanup-injected", {
        method: "POST",
        credentials: "include",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw normalizeApiErrorPayload(payload, res.status);
      }

      const parsed = payload as {
        deletedEmails?: number;
        deletedLogs?: number;
        deletedErrorLogs?: number;
        deletedThreads?: number;
      };
      setCleanupSummary({
        deletedEmails: Number(parsed.deletedEmails ?? 0),
        deletedLogs: Number(parsed.deletedLogs ?? 0),
        deletedErrorLogs: Number(parsed.deletedErrorLogs ?? 0),
        deletedThreads: Number(parsed.deletedThreads ?? 0),
      });
    } catch (err) {
      const appError = normalizeError(err, {
        source: "ui",
        operation: "settings_cleanup_injected",
        fallbackStatus: 500,
      });
      setConfigError(appError);
    } finally {
      setCleanupBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto" onScroll={onSettingsScroll}>
      {!heroCollapsed && (
        <section className="panel-surface rounded-[20px] px-5 py-5 md:px-6 md:py-6">
        <div className="flex flex-wrap items-start justify-between gap-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] app-accent-text">
              <Settings className="h-3.5 w-3.5" />
              Settings
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight app-text-primary">Control routing, appearance, and knowledge sync from one place.</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 app-text-secondary">
              This page is your operator console for reasoning behavior, send behavior, category routing, manual synthesis, and sent-memory backfill.
            </p>
          </div>

          <div className="grid min-w-[280px] gap-3 sm:grid-cols-2">
            <InfoCard label="Theme" value={theme === "light" ? "Light mode" : "Dark mode"} />
            <InfoCard label="Categories" value={String(categories.length)} />
            <InfoCard label="Routing mode" value={config?.global_mode ?? "assist"} />
            <InfoCard label="Send mode" value={config?.send_mode ?? "dry"} />
          </div>
        </div>
        </section>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="panel-surface rounded-[16px] p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">
            <Palette className="h-3.5 w-3.5 app-accent-text" />
            Appearance
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight app-text-primary">Choose how the workspace looks.</h2>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setTheme("light")}
              className={`rounded-full px-5 py-2.5 text-sm font-medium transition ${theme === "light" ? "app-button-primary" : "app-button-secondary"}`}
            >
              Light mode
            </button>
            <button
              type="button"
              onClick={() => setTheme("dark")}
              className={`rounded-full px-5 py-2.5 text-sm font-medium transition ${theme === "dark" ? "app-button-primary" : "app-button-secondary"}`}
            >
              Dark mode
            </button>
          </div>
        </section>

        <section className="panel-surface rounded-[16px] p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">
            <Shield className="h-3.5 w-3.5 app-accent-text" />
            Core behavior
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight app-text-primary">Reasoning and send controls</h2>

          {config && (
            <div className="mt-5 grid gap-4">
              <SettingField label="Reasoning logic">
                <SelectField value={config.global_mode} disabled={saving} onChange={(ev) => void postConfig({ global_mode: ev.target.value })}>
                  <option value="manual">Manual</option>
                  <option value="assist">Assist</option>
                  <option value="auto">Auto</option>
                </SelectField>
              </SettingField>

              <SettingField label="Delivery mode">
                <SelectField value={config.send_mode} disabled={saving} onChange={(ev) => void postConfig({ send_mode: ev.target.value })}>
                  <option value="dry">Dry run</option>
                  <option value="live">Live send</option>
                </SelectField>
              </SettingField>

              <SettingField label="Confidence threshold">
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  key={config.threshold}
                  defaultValue={config.threshold}
                  disabled={saving}
                  onBlur={(ev) => {
                    const n = Number(ev.target.value);
                    if (Number.isFinite(n) && n >= 0 && n <= 1) void postConfig({ threshold: n });
                  }}
                  className="app-input app-focus-ring w-full rounded-2xl px-4 py-3 text-sm"
                />
              </SettingField>

              <div className="rounded-[16px] app-input-strong px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Token budget policy</div>

                <div className="mt-3 grid gap-4">
                  <SettingField label="Daily token limit">
                    <input
                      type="number"
                      min={10000}
                      step={10000}
                      key={`daily_token_limit:${config.daily_token_limit ?? DEFAULT_DAILY_TOKEN_LIMIT}`}
                      defaultValue={config.daily_token_limit ?? DEFAULT_DAILY_TOKEN_LIMIT}
                      disabled={saving}
                      onBlur={(ev) => {
                        const n = Number(ev.target.value);
                        if (Number.isFinite(n) && n > 0) {
                          void postConfig({ daily_token_limit: Math.floor(n) });
                        }
                      }}
                      className="app-input app-focus-ring w-full rounded-2xl px-4 py-3 text-sm"
                    />
                  </SettingField>

                  <SettingField label="Auto-expand on heavy traffic">
                    <SelectField
                      value={(config.token_budget_auto_expand_enabled ?? true) ? "true" : "false"}
                      disabled={saving}
                      onChange={(ev) =>
                        void postConfig({ token_budget_auto_expand_enabled: ev.target.value === "true" })
                      }
                    >
                      <option value="true">Enabled</option>
                      <option value="false">Disabled</option>
                    </SelectField>
                  </SettingField>

                  <SettingField label="Expansion trigger percent">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      key={`token_budget_expand_threshold_percent:${config.token_budget_expand_threshold_percent ?? DEFAULT_BUDGET_EXPAND_THRESHOLD_PERCENT}`}
                      defaultValue={
                        config.token_budget_expand_threshold_percent ?? DEFAULT_BUDGET_EXPAND_THRESHOLD_PERCENT
                      }
                      disabled={saving}
                      onBlur={(ev) => {
                        const n = Number(ev.target.value);
                        if (Number.isFinite(n) && n >= 1 && n <= 100) {
                          void postConfig({ token_budget_expand_threshold_percent: Math.floor(n) });
                        }
                      }}
                      className="app-input app-focus-ring w-full rounded-2xl px-4 py-3 text-sm"
                    />
                  </SettingField>

                  <SettingField label="Expansion step tokens">
                    <input
                      type="number"
                      min={10000}
                      step={10000}
                      key={`token_budget_expand_step:${config.token_budget_expand_step ?? DEFAULT_BUDGET_EXPAND_STEP}`}
                      defaultValue={config.token_budget_expand_step ?? DEFAULT_BUDGET_EXPAND_STEP}
                      disabled={saving}
                      onBlur={(ev) => {
                        const n = Number(ev.target.value);
                        if (Number.isFinite(n) && n > 0) {
                          void postConfig({ token_budget_expand_step: Math.floor(n) });
                        }
                      }}
                      className="app-input app-focus-ring w-full rounded-2xl px-4 py-3 text-sm"
                    />
                  </SettingField>

                  <SettingField label="Auto-expand max daily cap">
                    <input
                      type="number"
                      min={10000}
                      step={10000}
                      key={`token_budget_max_daily_limit:${config.token_budget_max_daily_limit ?? DEFAULT_BUDGET_MAX_DAILY_LIMIT}`}
                      defaultValue={config.token_budget_max_daily_limit ?? DEFAULT_BUDGET_MAX_DAILY_LIMIT}
                      disabled={saving}
                      onBlur={(ev) => {
                        const n = Number(ev.target.value);
                        if (Number.isFinite(n) && n > 0) {
                          void postConfig({ token_budget_max_daily_limit: Math.floor(n) });
                        }
                      }}
                      className="app-input app-focus-ring w-full rounded-2xl px-4 py-3 text-sm"
                    />
                  </SettingField>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="panel-surface rounded-[16px] p-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">
          <Sparkles className="h-3.5 w-3.5 app-accent-text" />
          Category routing
        </div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight app-text-primary">Tune how each category moves through the system.</h2>

        <div className="mt-5 grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
          <div className="rounded-[20px] app-input-strong p-5">
            <div className="text-sm font-medium app-text-primary">Add category</div>
            <div className="mt-4 grid gap-3">
              <input
                value={newCategoryName}
                onChange={(ev) => setNewCategoryName(ev.target.value)}
                placeholder="e.g. support"
                className="app-input app-focus-ring rounded-2xl px-4 py-3 text-sm"
              />
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={newCategoryThreshold}
                onChange={(ev) => setNewCategoryThreshold(Number(ev.target.value))}
                className="app-input app-focus-ring rounded-2xl px-4 py-3 text-sm"
              />
              <SelectField value={newCategoryMode} onChange={(ev) => setNewCategoryMode(ev.target.value as "assist" | "manual" | "auto")}>
                <option value="manual">Manual</option>
                <option value="assist">Assist</option>
                <option value="auto">Auto</option>
              </SelectField>
              <button
                type="button"
                disabled={saving || !newCategoryName.trim()}
                onClick={() => void createCategory()}
                className="app-button-primary inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
                Add category
              </button>
            </div>
          </div>

          <div className="grid gap-3">
            {categories.length === 0 && (
              <div className="rounded-[20px] border border-dashed app-border px-6 py-12 text-center app-text-muted">
                No categories configured yet.
              </div>
            )}
            {categories.map((category) => (
              <div key={category} className="rounded-[20px] app-input-strong px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="app-category-token flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold"
                      style={getCategoryTone(category, config?.category_colors)}
                    >
                      {category?.[0]?.toUpperCase() ?? "?"}
                    </div>
                    <div>
                      <div className="text-sm font-medium app-text-primary">{category}</div>
                      <div className="text-xs app-text-muted">Custom routing rule and custom color</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={!config || saving}
                    onClick={() => void deleteCategory(category)}
                    className="app-button-secondary rounded-full px-3 py-2 text-sm transition"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <SelectField
                    value={normalizeCategoryRule(config?.category_rules?.[category]).mode}
                    disabled={!config || saving}
                    onChange={(ev) => void updateCategoryMode(category, ev.target.value as "assist" | "manual" | "auto")}
                  >
                    <option value="manual">Manual</option>
                    <option value="assist">Assist</option>
                    <option value="auto">Auto</option>
                  </SelectField>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={!config || saving}
                    defaultValue={normalizeCategoryRule(config?.category_rules?.[category]).confidence_threshold}
                    onBlur={(ev) => {
                      const n = Number(ev.target.value);
                      if (Number.isFinite(n) && n >= 0 && n <= 1) void updateCategoryThreshold(category, n);
                    }}
                    className="app-input app-focus-ring rounded-2xl px-4 py-3 text-sm"
                  />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-xs app-text-secondary">
                    <span>Category color</span>
                    <input
                      type="color"
                      value={config?.category_colors?.[category.toLowerCase()] ?? "#52525b"}
                      disabled={!config || saving}
                      onChange={(ev) => void updateCategoryColor(category, ev.target.value)}
                      className="h-8 w-10 cursor-pointer rounded border app-border bg-transparent"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!config || saving || !(config?.category_colors?.[category.toLowerCase()])}
                    onClick={() => void resetCategoryColor(category)}
                    className="app-button-secondary rounded-full px-3 py-1.5 text-xs"
                  >
                    Reset color
                  </button>
                  <span
                    className="app-category-token rounded-full px-2.5 py-1 text-[11px] font-medium"
                    style={getCategoryTone(category, config?.category_colors)}
                  >
                    Preview
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {configError && (
        <InlineErrorCard
          error={configError}
          onRetry={async () => {
            await refresh();
          }}
        />
      )}

      <section className="panel-surface rounded-[16px] p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">
              <Trash2 className="h-3.5 w-3.5 app-accent-text" />
              Workspace hygiene
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight app-text-primary">Clear injected fault-test email junk instantly.</h2>
            <p className="mt-2 text-sm app-text-secondary">
              Removes synthetic fault-injection inbox entries and their related logs while keeping real mail untouched.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void clearInjectedJunkEmails()}
            disabled={cleanupBusy}
            className="app-button-secondary inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition disabled:opacity-40"
          >
            {cleanupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {cleanupBusy ? "Clearing..." : "Clear injected emails"}
          </button>
        </div>

        {cleanupSummary && (
          <div className="mt-4 rounded-[14px] app-state-success border px-4 py-3 text-xs">
            Deleted {cleanupSummary.deletedEmails} emails, {cleanupSummary.deletedLogs} logs, {cleanupSummary.deletedErrorLogs} error logs, and {cleanupSummary.deletedThreads} orphaned threads.
          </div>
        )}
      </section>

      <section className="panel-surface rounded-[16px] p-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">
          <Zap className="h-3.5 w-3.5 app-accent-text" />
          Manual synthesis
        </div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight app-text-primary">Queue a manual synthesis job from the UI.</h2>

        <div className="mt-5 grid gap-4 lg:max-w-3xl">
          <SelectField value={composeCategory} onChange={(ev) => setComposeCategory(ev.target.value)}>
            <option value="general">general</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>

          <textarea
            value={composeContext}
            onChange={(ev) => setComposeContext(ev.target.value)}
            placeholder="Describe the context or objective for the synthesis run."
            rows={5}
            className="app-input app-focus-ring rounded-[20px] px-4 py-4 text-sm resize-none"
          />

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void queueCompose()}
              disabled={!composeContext.trim()}
              className="app-button-primary inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition disabled:opacity-40"
            >
              <Zap className="h-4 w-4" />
              Queue synthesis
            </button>
          </div>
        </div>
      </section>

      <SyncKnowledgeBaseCard />
    </div>
  );
}

function SyncKnowledgeBaseCard() {
  const [stats, setStats] = useState<{
    counts: { pending: number; embedded: number; failed: number };
    totalSent: number;
    estimatedPendingChunks: number;
    sync_running: boolean;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<{
    processed: number;
    embedded: number;
    skipped: number;
    failed: number;
    total_remaining: number;
  } | null>(null);

  const loadStats = useCallback(async () => {
    const res = await fetch("/api/sync/status");
    if (res.ok) setStats(await res.json());
  }, []);

  useEffect(() => {
    void loadStats();
    const t = setInterval(() => void loadStats(), 10000);
    return () => clearInterval(t);
  }, [loadStats]);

  async function runSyncLoop(retryFailed = false) {
    if (syncing || stats?.sync_running) {
      alert("A sync is already running on the server.");
      return;
    }
    if (!confirm("This will process and embed your historical sent emails. Proceed?")) return;

    setSyncing(true);
    setProgress({
      processed: 0,
      embedded: 0,
      skipped: 0,
      failed: 0,
      total_remaining: retryFailed ? (stats?.counts.failed ?? 0) : (stats?.counts.pending ?? 0),
    });

    try {
      while (true) {
        const res = await fetch("/api/sync/sent-history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retryFailed }),
        });

        if (res.status === 409) {
          alert("Server lock prevented sync. Already running.");
          break;
        }

        const data = await res.json();
        if (!res.ok) {
          alert("Error: " + data.error);
          break;
        }

        setProgress((prev) => ({
          processed: (prev?.processed ?? 0) + data.processed,
          embedded: (prev?.embedded ?? 0) + data.embedded,
          skipped: (prev?.skipped ?? 0) + data.skipped,
          failed: (prev?.failed ?? 0) + data.failed,
          total_remaining: data.total_remaining,
        }));

        if (data.done) {
          alert("Knowledge Base Sync Complete!");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      setSyncing(false);
      void loadStats();
    }
  }

  return (
    <section className="panel-surface rounded-[16px] p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">
            <Database className="h-3.5 w-3.5 app-accent-text" />
            Sent-memory sync
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight app-text-primary">Backfill and repair your knowledge base.</h2>
        </div>
        <div className={`rounded-full px-3 py-1 text-xs font-medium ${stats?.sync_running || syncing ? "app-state-success" : "app-chip"}`}>
          {stats?.sync_running || syncing ? "Sync active" : "Idle"}
        </div>
      </div>

      {stats && (
        <div className="mt-6 space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SyncStat label="Total sent" value={stats.totalSent} icon={<Download className="h-4 w-4" />} />
            <SyncStat label="Pending" value={stats.counts.pending} subtext={`~${stats.estimatedPendingChunks} chunks`} icon={<Clock className="h-4 w-4" />} />
            <SyncStat label="Embedded" value={stats.counts.embedded} icon={<CheckCircle2 className="h-4 w-4" />} />
            <SyncStat label="Failed" value={stats.counts.failed} icon={<AlertTriangle className="h-4 w-4" />} />
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={async () => {
                if (!confirm("This will fetch your last 1000 sent emails from Gmail. Continue?")) return;
                setSyncing(true);
                try {
                  let token: string | null = null;
                  let totalFetched = 0;
                  while (totalFetched < 1000) {
                    const backRes: Response = await fetch("/api/sync/backfill", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ limit: 100, pageToken: token }),
                    });
                    const backData: { inserted: number; nextPageToken: string | null; done?: boolean } = await backRes.json();
                    if (!backRes.ok) break;
                    totalFetched += backData.inserted;
                    token = backData.nextPageToken;
                    if (backData.done || !token) break;
                  }
                  alert(`Imported ${totalFetched} new messages from Gmail.`);
                  await loadStats();
                } finally {
                  setSyncing(false);
                }
              }}
              disabled={syncing || stats.sync_running}
              className="app-button-secondary inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition disabled:opacity-40"
            >
              <Download className="h-4 w-4" />
              Ingest last 1000
            </button>

            <button
              onClick={() => void runSyncLoop(false)}
              disabled={syncing || stats.counts.pending === 0 || stats.sync_running}
              className="app-button-primary inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition disabled:opacity-40"
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {syncing ? "Processing" : "Process and synthesize"}
            </button>

            {stats.counts.failed > 0 && (
              <button
                onClick={() => void runSyncLoop(true)}
                disabled={syncing || stats.sync_running}
                className="app-button-secondary inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition disabled:opacity-40"
              >
                <RefreshCcw className="h-4 w-4" />
                Repair failed
              </button>
            )}
          </div>

          {(syncing || (progress && progress.processed > 0)) && progress && (
            <div className="rounded-[20px] app-input-strong p-5">
              <div className="flex items-center justify-between text-sm">
                <span className="app-text-secondary">Sync progress</span>
                <span className="font-medium app-accent-text">
                  {((progress.processed / (progress.processed + progress.total_remaining || 1)) * 100).toFixed(0)}%
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full app-bg-soft">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(progress.processed / (progress.processed + progress.total_remaining || 1)) * 100}%`,
                    background: "var(--accent)",
                  }}
                />
              </div>
              <div className="mt-4 flex flex-wrap gap-4 text-xs app-text-muted">
                <span>Processed {progress.processed}</span>
                <span>Embedded {progress.embedded}</span>
                <span>Failed {progress.failed}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] app-input-strong px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{label}</div>
      <div className="mt-2 text-sm font-medium app-text-primary">{value}</div>
    </div>
  );
}

function SettingField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{label}</div>
      {children}
    </div>
  );
}

function SelectField({
  children,
  className = "",
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={`app-input app-focus-ring w-full appearance-none rounded-2xl px-4 py-3 pr-10 text-sm ${className}`.trim()}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 app-text-faint" />
    </div>
  );
}

function SyncStat({ label, value, subtext, icon }: { label: string; value: number; subtext?: string; icon: ReactNode }) {
  return (
    <div className="rounded-[18px] app-input-strong px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{label}</div>
        <div className="app-accent-text">{icon}</div>
      </div>
      <div className="mt-3 flex items-end gap-2">
        <div className="text-3xl font-semibold tracking-tight app-text-primary">{value}</div>
        {subtext && <div className="text-xs app-text-muted">{subtext}</div>}
      </div>
    </div>
  );
}
