import { expect, test, type Page } from "@playwright/test";

type Mode = "manual" | "assist" | "auto";
type SendMode = "dry" | "live";

type ConfigSnapshot = {
  config_version: number;
  global_mode: Mode;
  send_mode: SendMode;
};

type EmailSummary = {
  id: number;
  subject: string;
  state: string;
  trace_id: string | null;
  review_outcome?: string | null;
  draft?: {
    id?: number;
  } | null;
};

type TraceLog = {
  id: number;
  step: string;
  state: string;
  error?: string | null;
};

type TestEmailInsertResponse = {
  status?: string;
  emailId?: number | null;
  trace_id?: string | null;
};

const LIVE_SEND_STEPS = new Set([
  "send",
  "send_error",
  "send_blocked_risk_or_confidence",
  "send_blocked_duplicate",
  "send_blocked_safety",
  "send_blocked_semantic_intent",
  "send_blocked_idempotent_duplicate",
]);

async function loginWithLocalSession(page: Page): Promise<void> {
  const email = `desktop-ship-${Date.now()}@example.com`;
  const response = await page.request.post("/api/auth/login", {
    data: { email },
    failOnStatusCode: false,
  });
  expect(response.ok(), `login failed with status ${response.status()}`).toBeTruthy();
}

async function getConfig(page: Page): Promise<ConfigSnapshot> {
  const response = await page.request.get("/api/config", { failOnStatusCode: false });
  expect(response.ok(), `failed reading config (${response.status()})`).toBeTruthy();
  const json = (await response.json()) as Partial<ConfigSnapshot>;
  if (typeof json.config_version !== "number") {
    throw new Error("Config response missing config_version");
  }
  if (json.global_mode !== "manual" && json.global_mode !== "assist" && json.global_mode !== "auto") {
    throw new Error("Config response missing global_mode");
  }
  if (json.send_mode !== "dry" && json.send_mode !== "live") {
    throw new Error("Config response missing send_mode");
  }
  return {
    config_version: json.config_version,
    global_mode: json.global_mode,
    send_mode: json.send_mode,
  };
}

async function updateConfigModes(page: Page, patch: Partial<Pick<ConfigSnapshot, "global_mode" | "send_mode">>): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await getConfig(page);
    const response = await page.request.post("/api/config", {
      data: {
        expected_config_version: current.config_version,
        ...patch,
      },
      failOnStatusCode: false,
    });

    if (response.status() === 409) {
      continue;
    }

    expect(response.ok(), `failed updating config modes (${response.status()})`).toBeTruthy();
    return;
  }

  throw new Error("Unable to update config after repeated version conflicts");
}

async function listEmails(page: Page, filter: "all" | "inbox" | "sent" | "rejected" = "all", limit = 60): Promise<EmailSummary[]> {
  const response = await page.request.get(`/api/emails?filter=${filter}&limit=${limit}`, {
    failOnStatusCode: false,
  });
  expect(response.ok(), `failed reading email list (${response.status()})`).toBeTruthy();
  const json = (await response.json()) as { emails?: EmailSummary[] };
  return Array.isArray(json.emails) ? json.emails : [];
}

async function fetchTraceLogs(page: Page, traceId: string): Promise<TraceLog[]> {
  const response = await page.request.get(`/api/logs?trace_id=${encodeURIComponent(traceId)}`, {
    failOnStatusCode: false,
  });
  expect(response.ok(), `failed reading logs for trace ${traceId} (${response.status()})`).toBeTruthy();
  const json = (await response.json()) as { logs?: TraceLog[] };
  return Array.isArray(json.logs) ? json.logs : [];
}

async function waitForTraceStep(
  page: Page,
  traceId: string,
  matcher: (log: TraceLog) => boolean,
  timeoutMs: number,
): Promise<TraceLog> {
  const deadline = Date.now() + timeoutMs;
  let lastStepSummary = "";

  while (Date.now() < deadline) {
    const logs = await fetchTraceLogs(page, traceId);
    const hit = logs.find(matcher);
    if (hit) return hit;

    lastStepSummary = logs
      .slice(-8)
      .map((log) => `${log.id}:${log.step}`)
      .join(", ");

    await page.waitForTimeout(2000);
  }

  throw new Error(`Timed out waiting for trace step on ${traceId}. Last steps: ${lastStepSummary}`);
}

async function approveDraftForSend(page: Page, draftId: number): Promise<void> {
  const response = await page.request.post(`/api/drafts/${draftId}/approve-send`, {
    data: {},
    failOnStatusCode: false,
  });

  // 409 means state already moved; that is acceptable for this helper.
  if (response.status() === 409) return;

  expect(response.ok(), `approve-send failed for draft ${draftId} (${response.status()})`).toBeTruthy();
}

async function forceProcessByTrace(page: Page, traceId: string): Promise<void> {
  const response = await page.request.post("/api/system/process/force", {
    data: { traceId, timeoutMs: 20_000 },
    failOnStatusCode: false,
  });

  expect(response.ok(), `force-process failed for trace ${traceId} (${response.status()})`).toBeTruthy();
}

async function ensureReadyToSendEmail(page: Page): Promise<{ id: number; traceId: string }> {
  // Always generate a fresh trace for deterministic dry/live assertions.
  const probeSubject = `Desktop live send probe ${Date.now()}`;
  const inserted = await page.request.post("/api/test/email", {
    data: {
      subject: probeSubject,
      from: "probe.sender@example.com",
      body: "Need pricing and onboarding details for our team by this week.",
    },
    failOnStatusCode: false,
  });
  expect(inserted.ok(), `failed inserting probe email (${inserted.status()})`).toBeTruthy();

  const insertedJson = (await inserted.json()) as TestEmailInsertResponse;
  const probeTraceId = typeof insertedJson.trace_id === "string" && insertedJson.trace_id.length > 0
    ? insertedJson.trace_id
    : null;

  if (probeTraceId) {
    await forceProcessByTrace(page, probeTraceId);
  }

  let approvedDraftId: number | null = null;
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    if (probeTraceId) {
      await forceProcessByTrace(page, probeTraceId);
    }

    const emails = await listEmails(page, "all", 80);
    const probe = emails.find((email) => email.subject === probeSubject);

    if (probe?.state === "READY_TO_SEND" && probe.trace_id) {
      return { id: probe.id, traceId: probe.trace_id };
    }

    if (probe?.state === "AWAITING_REVIEW" && typeof probe.draft?.id === "number") {
      if (approvedDraftId !== probe.draft.id) {
        approvedDraftId = probe.draft.id;
        await approveDraftForSend(page, probe.draft.id);
      }
    }

    await page.waitForTimeout(2500);
  }

  throw new Error("Unable to produce a READY_TO_SEND email for dry/live verification");
}

async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
}

async function clickIfPresent(page: Page, selector: ReturnType<Page["getByRole"]>): Promise<void> {
  const count = await selector.count();
  if (count > 0) {
    await selector.first().click();
  }
}

async function runUiSweep(page: Page, knownTraceId: string): Promise<void> {
  await gotoRoute(page, "/");
  await clickIfPresent(page, page.getByRole("button", { name: /toggle sidebar/i }));
  await clickIfPresent(page, page.getByRole("button", { name: /toggle sidebar/i }));
  await clickIfPresent(page, page.getByRole("button", { name: /toggle theme/i }));
  await clickIfPresent(page, page.getByRole("button", { name: /toggle theme/i }));

  await gotoRoute(page, "/inbox");
  await page.getByPlaceholder("Search sender, subject, text").fill("invoice");
  await page.getByPlaceholder("Search sender, subject, text").fill("");

  await page.getByRole("button", { name: "Stage" }).click();
  for (const stage of ["Ready", "Generated", "Needs review", "Drafted", "All"]) {
    const option = page.getByRole("button", { name: new RegExp(`^${stage}`) });
    if (await option.count()) {
      await option.first().click();
      await page.getByRole("button", { name: "Stage" }).click();
    }
  }
  await page.keyboard.press("Escape");
  await clickIfPresent(page, page.getByRole("button", { name: /^Unread$/ }));
  await clickIfPresent(page, page.getByRole("button", { name: /^Read$/ }));
  await clickIfPresent(page, page.getByRole("button", { name: /^All mail$/ }));

  const firstInboxRow = page.locator('[role="button"][tabindex="0"]').first();
  if (await firstInboxRow.count()) {
    await firstInboxRow.click();
    await clickIfPresent(page, page.getByRole("button", { name: /^Generate$/ }));
    await clickIfPresent(page, page.getByRole("button", { name: /^Context$/ }));
    await clickIfPresent(page, page.getByRole("button", { name: /^Inbox$/ }));
  }

  await gotoRoute(page, "/drafts");
  await page.getByPlaceholder("Search drafts").fill("draft");
  await page.getByPlaceholder("Search drafts").fill("");
  await clickIfPresent(page, page.getByRole("button", { name: /^Edit$/ }));
  await clickIfPresent(page, page.getByRole("button", { name: /^Cancel$/ }));

  await gotoRoute(page, "/sent");
  await page.getByPlaceholder("Search sent mail").fill("sent");
  await page.getByPlaceholder("Search sent mail").fill("");
  const firstSentRow = page.locator('[role="button"][tabindex="0"]').first();
  if (await firstSentRow.count()) {
    await firstSentRow.click();
    await clickIfPresent(page, page.getByRole("button", { name: /^Memory$/ }));
    await clickIfPresent(page, page.getByRole("button", { name: /^Metadata$/ }));
    await clickIfPresent(page, page.getByRole("button", { name: /^Message$/ }));
  }

  await gotoRoute(page, "/rejected");
  await page.getByPlaceholder("Search rejected items").fill("manual");
  await page.getByPlaceholder("Search rejected items").fill("");
  await clickIfPresent(page, page.getByRole("button", { name: /^Refresh$/ }));
  await clickIfPresent(page, page.getByRole("button", { name: /^Open thread$/ }));
  if (/\/inbox/.test(page.url())) {
    await clickIfPresent(page, page.getByRole("button", { name: /^Inbox$/ }));
    await gotoRoute(page, "/rejected");
  }

  await gotoRoute(page, "/logs");
  await page.getByPlaceholder("Search step, trace, subject, state, error").fill("send");
  await page.getByPlaceholder("Search step, trace, subject, state, error").fill("");
  await clickIfPresent(page, page.getByRole("button", { name: /^Refresh$/ }));
  await clickIfPresent(page, page.getByRole("button", { name: /^Trace lookup$/ }));
  await page.getByPlaceholder("Paste trace_id or Gmail id").fill(knownTraceId);
  await clickIfPresent(page, page.getByRole("button", { name: /^Load trace$/ }));

  await gotoRoute(page, "/profile");
  await clickIfPresent(page, page.getByRole("button", { name: /^Refresh$/ }));

  await gotoRoute(page, "/settings");
  await clickIfPresent(page, page.getByRole("button", { name: /^Light mode$/ }));
  await clickIfPresent(page, page.getByRole("button", { name: /^Dark mode$/ }));

  const settingsSelects = page.locator("main select");
  const selectCount = await settingsSelects.count();
  if (selectCount >= 3) {
    await settingsSelects.nth(0).selectOption("manual");
    await settingsSelects.nth(0).selectOption("assist");
    await settingsSelects.nth(0).selectOption("auto");

    await settingsSelects.nth(1).selectOption("dry");
    await settingsSelects.nth(1).selectOption("live");
    await settingsSelects.nth(1).selectOption("dry");

    await settingsSelects.nth(2).selectOption("false");
    await settingsSelects.nth(2).selectOption("true");
  }

  const confidenceInput = page.locator("main input[type='number']").first();
  if (await confidenceInput.count()) {
    await confidenceInput.fill("0.65");
    await confidenceInput.press("Tab");
    await confidenceInput.fill("0.70");
    await confidenceInput.press("Tab");
  }

  const newCategory = `desktop_flow_${Date.now()}`;
  const categoryNameInput = page.getByPlaceholder("e.g. support");
  if (await categoryNameInput.count()) {
    await categoryNameInput.fill(newCategory);
  }

  const synthesisInput = page.getByPlaceholder("Describe the context or objective for the synthesis run.");
  if (await synthesisInput.count()) {
    await synthesisInput.fill("Desktop smoke synthesis request for release verification.");
    await clickIfPresent(page, page.getByRole("button", { name: /^Queue synthesis$/ }));
  }

  await gotoRoute(page, "/compose");
  await page.locator("#compose-to").fill("desktop-qa@example.com");
  await page.locator("#compose-subject").fill(`Desktop flow smoke ${Date.now()}`);
  await page.locator("#compose-body").fill("This is a release-smoke compose send from automated desktop validation.");

  await gotoRoute(page, "/onboarding");
  await clickIfPresent(page, page.getByTestId("step-nav-openai"));
  await clickIfPresent(page, page.getByTestId("step-nav-database"));
  await clickIfPresent(page, page.getByTestId("step-nav-oauth"));
  await clickIfPresent(page, page.getByTestId("step-nav-gmail"));
  await clickIfPresent(page, page.getByTestId("step-nav-final_validation"));
  await clickIfPresent(page, page.getByTestId("button-toggle-debug"));
  await clickIfPresent(page, page.getByTestId("button-toggle-debug"));
}

test("Desktop full flow: pages, controls, dry/live modes", async ({ page }) => {
  test.setTimeout(18 * 60_000);

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // Accept confirms/alerts from settings actions without blocking the test run.
  page.on("dialog", async (dialog) => {
    await dialog.accept();
  });

  await loginWithLocalSession(page);
  const originalConfig = await getConfig(page);

  try {
    await gotoRoute(page, "/");

    await updateConfigModes(page, {
      global_mode: "auto",
      send_mode: "dry",
    });

    const ready = await ensureReadyToSendEmail(page);

    await waitForTraceStep(page, ready.traceId, (log) => log.step === "send_skipped_dry_mode", 90_000);

    const baselineLogs = await fetchTraceLogs(page, ready.traceId);
    const baselineId = baselineLogs.reduce((max, log) => Math.max(max, log.id), 0);

    await updateConfigModes(page, { send_mode: "live" });
    await forceProcessByTrace(page, ready.traceId);

    const liveOutcome = await waitForTraceStep(
      page,
      ready.traceId,
      (log) => log.id > baselineId && LIVE_SEND_STEPS.has(log.step),
      120_000,
    );

    expect(LIVE_SEND_STEPS.has(liveOutcome.step), `unexpected live outcome step: ${liveOutcome.step}`).toBeTruthy();

    await runUiSweep(page, ready.traceId);

    await gotoRoute(page, "/");
    const exceptionBanner = page.locator("text=client-side exception has occurred");
    await expect(exceptionBanner).toHaveCount(0);

    expect(pageErrors, `Captured page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  } finally {
    await updateConfigModes(page, {
      global_mode: originalConfig.global_mode,
      send_mode: originalConfig.send_mode,
    });
  }
});
