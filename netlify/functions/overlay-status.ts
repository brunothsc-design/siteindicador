import { isSignalConfidenceValid } from '../../src/config/signalConfig.ts';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  let sessionId: string | null = null;
  let status = 'AGUARDANDO';
  let hasAnchor = false;
  try {
    const body = (await req.json()) as {
      sessionId?: string;
      operationalStatus?: {
        status?: string;
        confidence?: number;
        anchor?: { x?: number; y?: number } | null;
      } | null;
    };
    sessionId = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    const raw = String(body?.operationalStatus?.status ?? 'AGUARDANDO').toUpperCase();
    const conf = body?.operationalStatus?.confidence;
    const confidenceValid = typeof conf !== 'number' || isSignalConfidenceValid(conf);
    status = (raw === 'COMPRA' || raw === 'VENDA') && confidenceValid ? raw : 'AGUARDANDO';
    hasAnchor = Boolean(
      body?.operationalStatus?.anchor &&
        typeof body.operationalStatus.anchor.x === 'number' &&
        typeof body.operationalStatus.anchor.y === 'number'
    );
  } catch {
    sessionId = null;
  }

  if (!sessionId) {
    return new Response(JSON.stringify({ ok: false, error: 'sessionId required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  return new Response(JSON.stringify({ ok: true, status, timeframe: 'M1', hasAnchor }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
