/** Tiny response helpers — keeps routes uncluttered. */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function badRequest(message: string): Response {
  return jsonResponse({ ok: false, error: message }, 400);
}

export function notFound(message: string): Response {
  return jsonResponse({ ok: false, error: message }, 404);
}

export function emptyOk(): Response {
  return jsonResponse({ ok: true });
}
