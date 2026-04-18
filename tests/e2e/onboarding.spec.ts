import { expect, test, type Page, type Route } from "@playwright/test";

type StepId = "openai" | "database" | "oauth" | "gmail" | "final_validation";

function makeOnboardingGetPayload(step: StepId) {
  const stepIndex: Record<StepId, number> = {
    openai: 1,
    database: 2,
    oauth: 3,
    gmail: 4,
    final_validation: 5,
  };

  return {
    currentStepIndex: stepIndex[step],
    completed: false,
    checks: {
      openai: false,
      database: false,
      oauth: false,
      gmail: false,
      final_validation: false,
    },
    steps: [
      { id: "openai", order: 1, title: "OpenAI API Key" },
      { id: "database", order: 2, title: "Database setup" },
      { id: "oauth", order: 3, title: "OAuth setup" },
      { id: "gmail", order: 4, title: "Gmail integration" },
      { id: "final_validation", order: 5, title: "Final system validation" },
    ],
    draft: {},
    debug: {
      traceId: "trace-get",
      endpoint: "GET /api/system/onboarding",
      timestamp: new Date().toISOString(),
    },
  };
}

async function setupMockedOnboarding(page: Page, failingStep: StepId) {
  const attempts: Record<StepId, number> = {
    openai: 0,
    database: 0,
    oauth: 0,
    gmail: 0,
    final_validation: 0,
  };

  await page.route("**/api/auth/me", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: 1, email: "qa@example.com" } }),
    });
  });

  await page.route("**/api/system/onboarding", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeOnboardingGetPayload(failingStep)),
      });
      return;
    }

    const body = req.postDataJSON() as { action?: string; step?: StepId };

    if (body.action === "save_step_input") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          debug: {
            traceId: "trace-save",
            endpoint: "POST /api/system/onboarding save_step_input",
            timestamp: new Date().toISOString(),
          },
        }),
      });
      return;
    }

    const step = body.step ?? "final_validation";
    attempts[step] += 1;

    const firstAttemptFails = step === failingStep && attempts[step] === 1;
    if (firstAttemptFails) {
      const failedChecks =
        step === "final_validation"
          ? {
              openai: { ok: true, message: "ok" },
              database: { ok: true, message: "ok" },
              oauth: { ok: true, message: "ok" },
              gmail: { ok: false, error: "GMAIL_PERMISSION_INVALID", cause: "Missing scopes", fix: "Reconnect Gmail" },
            }
          : undefined;

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `${step.toUpperCase()}_FAILED`,
          cause: "Simulated failure for E2E",
          fix: "Simulated recovery path",
          checks: failedChecks,
          debug: {
            traceId: `trace-${step}-fail`,
            endpoint: "POST /api/system/onboarding validate_step",
            timestamp: new Date().toISOString(),
          },
        }),
      });
      return;
    }

    const successChecks =
      step === "final_validation"
        ? {
            openai: { ok: true, message: "ok" },
            database: { ok: true, message: "ok" },
            oauth: { ok: true, message: "ok" },
            gmail: { ok: true, message: "ok" },
          }
        : undefined;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        message: "Validated successfully.",
        checks: successChecks,
        debug: {
          traceId: `trace-${step}-success`,
          endpoint: "POST /api/system/onboarding validate_step",
          timestamp: new Date().toISOString(),
        },
      }),
    });
  });
}

async function goToStep(page: Page, step: StepId) {
  const stepNav = page.getByTestId(`step-nav-${step}`);
  await expect(stepNav).toBeVisible();
  await stepNav.click();
  await expect(page.getByTestId("button-validate-step")).toBeVisible();
}

async function openOnboarding(page: Page) {
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("step-nav-openai")).toBeVisible();
  await expect(page.getByTestId("step-nav-final_validation")).toBeVisible();
  await expect(page.getByTestId("button-validate-step")).toBeVisible();
}

async function clickValidateAndWait(page: Page) {
  await Promise.all([
    page.waitForResponse((response) => {
      if (!response.url().includes("/api/system/onboarding")) return false;
      if (response.request().method() !== "POST") return false;
      const body = response.request().postData() ?? "";
      return body.includes('"action":"validate_step"') || body.includes('"action":"run_final_validation"');
    }),
    page.getByTestId("button-validate-step").click(),
  ]);
}

test("Step 1 openai failure then recovery", async ({ page }) => {
  await setupMockedOnboarding(page, "openai");
  await openOnboarding(page);

  await page.getByTestId("input-openai-key").fill("sk-test");
  await clickValidateAndWait(page);
  await expect(page.getByText("OPENAI_FAILED")).toBeVisible();

  await clickValidateAndWait(page);
  await expect(page.getByText("OPENAI_FAILED")).toHaveCount(0);
});

test("Step 2 database failure then recovery", async ({ page }) => {
  await setupMockedOnboarding(page, "database");
  await openOnboarding(page);

  await goToStep(page, "database");
  await page.getByTestId("input-database-url").fill("postgresql://user:pass@localhost:5432/db");
  await clickValidateAndWait(page);
  await expect(page.getByText("DATABASE_FAILED")).toBeVisible();

  await clickValidateAndWait(page);
  await expect(page.getByText("DATABASE_FAILED")).toHaveCount(0);
});

test("Step 3 oauth failure then recovery", async ({ page }) => {
  await setupMockedOnboarding(page, "oauth");
  await openOnboarding(page);

  await goToStep(page, "oauth");
  await page.getByTestId("input-client-id").fill("client-id");
  await page.getByTestId("input-client-secret").fill("client-secret");
  await page.getByTestId("input-redirect-uri").fill("http://127.0.0.1:3000/api/auth/google/callback");
  await clickValidateAndWait(page);
  await expect(page.getByText("OAUTH_FAILED")).toBeVisible();

  await clickValidateAndWait(page);
  await expect(page.getByText("OAUTH_FAILED")).toHaveCount(0);
});

test("Step 4 gmail failure then recovery", async ({ page }) => {
  await setupMockedOnboarding(page, "gmail");
  await openOnboarding(page);

  await goToStep(page, "gmail");
  await clickValidateAndWait(page);
  await expect(page.getByText("GMAIL_FAILED")).toBeVisible();

  await clickValidateAndWait(page);
  await expect(page.getByText("GMAIL_FAILED")).toHaveCount(0);
});

test("Step 5 final validation failure then recovery", async ({ page }) => {
  await setupMockedOnboarding(page, "final_validation");
  await openOnboarding(page);

  await goToStep(page, "final_validation");
  await clickValidateAndWait(page);
  await expect(page.getByText("Missing scopes")).toBeVisible();

  await clickValidateAndWait(page);
  await expect(page.getByText("Missing scopes")).toHaveCount(0);
  await expect(page.getByTestId("step-nav-final_validation")).toContainText("Passed");
});
