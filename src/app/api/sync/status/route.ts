import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function GETHandler() {
  try {
    const countsRes = await db.query<{ status: string; count: string }>(
      `
      SELECT embedding_status as status, COUNT(*)::text as count
      FROM emails
      WHERE source = 'sent'
      GROUP BY embedding_status
      `
    );

    const counts = {
      pending: 0,
      embedded: 0,
      failed: 0,
    };

    let totalSent = 0;

    for (const row of countsRes.rows) {
      const c = parseInt(row.count, 10);
      totalSent += c;
      if (row.status === "pending") counts.pending += c;
      if (row.status === "embedded") counts.embedded += c;
      if (row.status === "failed") counts.failed += c;
    }

    // Estimated chunks is ~2 chunks per email
    const estimatedPendingChunks = counts.pending * 2;

    const configRes = await db.query<{ sync_running: boolean }>(`SELECT sync_running FROM config WHERE id = 1`);

    return NextResponse.json({
      counts,
      totalSent,
      estimatedPendingChunks,
      sync_running: configRes.rows[0]?.sync_running ?? false,
    });
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch sync status" }, { status: 500 });
  }
}


export const GET = withApiRoute(GETHandler, { route: '/sync/status', operation: 'GET' });
