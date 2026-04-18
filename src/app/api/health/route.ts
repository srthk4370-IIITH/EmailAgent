import { NextResponse } from "next/server";

import { db } from "../../../db/client";

export async function GET() {
  const start = Date.now();

  try {
    await db.query("SELECT 1");

    return NextResponse.json(
      {
        ok: true,
        service: "emailagent-backend",
        latency_ms: Date.now() - start,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "health_check_failed";

    return NextResponse.json(
      {
        ok: false,
        service: "emailagent-backend",
        reason,
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
