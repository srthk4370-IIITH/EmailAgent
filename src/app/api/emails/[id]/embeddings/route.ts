import { NextRequest, NextResponse } from "next/server";

import { listEmbeddingsForEmail } from "../../../../../db/embeddings";
import { getEmailById } from "../../../../../db/emails";
import { logSlowApi } from "../../../../../utils/api";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";

async function GETHandler(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const start = Date.now();
  try {
    const { id } = await params;
    const emailId = Number(id);
    if (!Number.isFinite(emailId) || emailId < 1) {
      return NextResponse.json({ error: "Invalid email id" }, { status: 400 });
    }

    const [email, embeddings] = await Promise.all([
      getEmailById(emailId),
      listEmbeddingsForEmail(emailId),
    ]);

    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    const response = NextResponse.json({
      embeddings,
      count: embeddings.length,
      status: email.embedding_status ?? "pending",
      error: email.embedding_error ?? null,
    });
    logSlowApi(`/api/emails/${id}/embeddings`, start);
    return response;
  } catch {
    const response = NextResponse.json({ error: "Failed to load embeddings" }, { status: 500 });
    logSlowApi("/api/emails/[id]/embeddings", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/emails/[id]/embeddings', operation: 'GET' });
