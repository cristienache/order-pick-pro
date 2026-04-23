import { createFileRoute } from "@tanstack/react-router";

const API_ORIGIN = process.env.ULTRAX_API_ORIGIN || "http://127.0.0.1:3000";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function getForwardHeaders(request: Request) {
  const headers = new Headers();

  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  return headers;
}

async function proxyRequest(request: Request, splat = "") {
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(`/api/${splat}`, API_ORIGIN);
  upstreamUrl.search = incomingUrl.search;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: getForwardHeaders(request),
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
      redirect: "manual",
    });

    const headers = new Headers(upstream.headers);
    for (const key of HOP_BY_HOP_HEADERS) headers.delete(key);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Upstream API unavailable",
      },
      { status: 502 },
    );
  }
}

type ProxyCtx = { request: Request; params: { _splat?: string } };
const handler = ({ request, params }: ProxyCtx) =>
  proxyRequest(request, params._splat ?? "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = (createFileRoute as any)("/api/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
      PUT: handler,
      PATCH: handler,
      DELETE: handler,
      OPTIONS: handler,
    },
  },
});