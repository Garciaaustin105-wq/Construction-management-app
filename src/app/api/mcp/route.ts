import { NextResponse } from "next/server";
import { LATEST_PROTOCOL_VERSION, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Model Context Protocol server — streamable HTTP, JSON response mode.
//
// This is the "AI-native lawn CRM" counter to Home.works' public GraphQL+MCP:
// an AI client (Claude Desktop, an agent) can READ an org's lawn data through
// one audited, RLS-scoped endpoint. Slice 1 exposes exactly one read-only tool.
//
// ── WHY HAND-ROLLED JSON-RPC RATHER THAN THE SDK TRANSPORT ─────────────────
// @modelcontextprotocol/sdk ships StreamableHTTPServerTransport, but its
// handleRequest(req, res) takes Node's IncomingMessage/ServerResponse. App
// Router handlers get a Web `Request` and return a Web `Response`, so using it
// requires shimming fake Node streams — fragile, and it breaks on a Next
// upgrade. The MCP streamable-HTTP spec explicitly allows a server to answer a
// POST with a single `application/json` body instead of an SSE stream, which is
// all a non-streaming tool server needs. So the JSON-RPC envelope is handled
// directly here, importing the SDK's protocol constants + error codes so the
// wire format can't drift from the SDK we depend on.
//
// ── AUTH (Claude-direct owns the final call) ───────────────────────────────
// Authentication is the caller's Supabase SESSION COOKIE, read by
// createClient() from src/lib/supabase/server.ts. Consequences, stated plainly
// because this is the part that needs review:
//   • Every read is RLS-scoped to the caller's org. No service role is used
//     anywhere in this file, and no query here can outrun the caller's own
//     permissions.
//   • BUT cookie auth is not how remote MCP clients normally connect — they
//     expect OAuth 2.1 / a bearer token (the SDK ships auth helpers under
//     server/auth). As written, this endpoint is usable by a browser-context
//     client or anything that can forward the session cookie; it is NOT yet a
//     public, token-authenticated MCP server.
//   • Lawn-only at the edge: "/api/mcp" is in LAWN_BLOCKED_API_PREFIXES in
//     src/proxy.ts, so the construction deploy 404s this route before it runs.
//     The role gate below is the second layer, not the only one.
//
// ── QUOTA ──────────────────────────────────────────────────────────────────
// This tool runs NO LLM call, so it deliberately does NOT touch checkAiQuota /
// recordAiAction. In MCP the CLIENT is the model: the right division is that we
// hand over clean, scoped data and the client's own model summarizes it. Our
// AI quota exists to bound OUR provider spend, and there is none here. (If this
// tool should instead run our LLM, it needs the checkAiQuota →
// recordAiAction sandwich and becomes a metered action — that is a product
// decision, not a mechanical one.)

const SERVER_INFO = { name: "terra-verde-lawn", version: "0.1.0" };

const TOOLS = [
  {
    name: "summarize_lawn_visits",
    title: "Summarize lawn visits",
    description:
      "Read this organization's lawn visits for a date range, optionally narrowed to one customer. Returns the visit records (date, status, customer, property, crew notes, skip reasons) plus per-status counts, so the caller can summarize the period. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Start date, inclusive. YYYY-MM-DD.",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        },
        to: {
          type: "string",
          description: "End date, inclusive. YYYY-MM-DD.",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        },
        customerId: {
          type: "string",
          description: "Optional customer UUID to narrow the results.",
        },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
] as const;

// Cap the rows any single call can pull. An unbounded range on a busy org
// would blow past the client's context window and make one tool call cost more
// than the whole conversation.
const MAX_ROWS = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string, httpStatus = 200) {
  // JSON-RPC errors ride a 200 by default: the transport succeeded, the call
  // did not. Transport-level failures (auth) use a real HTTP status.
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status: httpStatus }
  );
}

type VisitRow = {
  id: string;
  due_date: string;
  status: string;
  completed_at: string | null;
  notes: string | null;
  skip_reason: string | null;
  jobs: {
    name: string | null;
    address: string | null;
    customers: { id: string; name: string | null } | null;
  } | null;
};

async function runSummarizeLawnVisits(args: Record<string, unknown>) {
  const from = typeof args.from === "string" ? args.from : "";
  const to = typeof args.to === "string" ? args.to : "";
  const customerId =
    typeof args.customerId === "string" && args.customerId ? args.customerId : null;

  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return { error: "`from` and `to` are required and must be YYYY-MM-DD." };
  }
  if (from > to) {
    return { error: "`from` must be on or before `to`." };
  }

  const supabase = await createClient();
  const q = supabase
    .from("lawn_visits")
    .select(
      "id, due_date, status, completed_at, notes, skip_reason, jobs(name, address, customers(id, name))"
    )
    .gte("due_date", from)
    .lte("due_date", to)
    .order("due_date", { ascending: true })
    .limit(MAX_ROWS);

  const { data, error } = await q;
  if (error) return { error: `Query failed: ${error.message}` };

  let rows = (data as unknown as VisitRow[] | null) ?? [];
  // customers is reached THROUGH jobs (lawn_visits has job_id, no customer_id),
  // so the customer filter is applied in JS rather than as a PostgREST filter
  // on an embedded relation — the same join shape /lawn's visit query uses.
  if (customerId) {
    rows = rows.filter((r) => r.jobs?.customers?.id === customerId);
  }

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  return {
    range: { from, to },
    visitCount: rows.length,
    truncated: rows.length === MAX_ROWS,
    byStatus,
    visits: rows.map((r) => ({
      id: r.id,
      date: r.due_date,
      status: r.status,
      completedAt: r.completed_at,
      customer: r.jobs?.customers?.name ?? null,
      property: r.jobs?.name ?? null,
      address: r.jobs?.address ?? null,
      notes: r.notes,
      skipReason: r.skip_reason,
    })),
  };
}

export async function POST(req: Request) {
  // ---- transport-level auth ------------------------------------------------
  const me = await getMe();
  if (!me) {
    return rpcError(null, ErrorCode.InvalidRequest, "Not authenticated", 401);
  }
  // Same audience as /lawn/ai: office + admin, super_admin bounced (null org →
  // org-scoped reads would span every tenant). See that page for the navItems
  // cross-reference.
  if (isSuperAdmin(me.role) || !isOfficeLike(me.role) || !me.orgId) {
    return rpcError(null, ErrorCode.InvalidRequest, "Not authorized", 403);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, ErrorCode.ParseError, "Invalid JSON");
  }

  // Batches are legal JSON-RPC but this server does not need them; reject
  // clearly rather than half-supporting them.
  if (Array.isArray(body)) {
    return rpcError(null, ErrorCode.InvalidRequest, "Batch requests are not supported");
  }

  const msg = body as { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown };
  const id: JsonRpcId = msg.id ?? null;
  const method = msg.method ?? "";

  // Notifications (no `id`) get 202 with no body, per JSON-RPC.
  if (msg.id === undefined) {
    return new NextResponse(null, { status: 202 });
  }

  switch (method) {
    case "initialize": {
      const params = (msg.params ?? {}) as { protocolVersion?: string };
      // Echo the client's version when we can speak it; otherwise answer with
      // ours and let the client decide whether to continue.
      const requested = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: requested ?? LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const params = (msg.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (params.name !== "summarize_lawn_visits") {
        return rpcError(id, ErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
      }
      const out = await runSummarizeLawnVisits(params.arguments ?? {});
      // Tool-level failures are reported as isError results, not JSON-RPC
      // errors — that is what lets the calling model read the message and
      // retry with better arguments.
      if ("error" in out) {
        return rpcResult(id, {
          content: [{ type: "text", text: out.error }],
          isError: true,
        });
      }
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
        isError: false,
      });
    }

    default:
      return rpcError(id, ErrorCode.MethodNotFound, `Unknown method: ${method}`);
  }
}

// GET on a streamable-HTTP endpoint is the client opening an SSE stream for
// server-initiated messages. This server never initiates any, so decline
// rather than hold a socket open.
export async function GET() {
  return NextResponse.json(
    { error: "This MCP endpoint is POST-only (no server-initiated stream)." },
    { status: 405 }
  );
}
