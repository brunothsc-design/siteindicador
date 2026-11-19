export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  let sessionId: string | null = null;
  try {
    const body = (await req.json()) as { sessionId?: string };
    sessionId = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : null;
  } catch {
    sessionId = null;
  }

  if (!sessionId) {
    return new Response(JSON.stringify({ ok: false, error: 'sessionId required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  return new Response(JSON.stringify({ ok: true, sessionId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
