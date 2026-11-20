import {
  emptyAnalyzeResponse,
  executeGeminiFrameAnalysis,
  isAuthorizedSameOriginRequest,
} from '../../server/analyzeFrameCore.ts';
import type { AnalyzeFrameRequest } from '../../src/types/signals.ts';

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse(405, emptyAnalyzeResponse(false, { error: 'Método não permitido.' }));
  }

  let reqHost: string | null = req.headers.get('host');
  if (!reqHost) {
    try {
      reqHost = new URL(req.url).host;
    } catch {
      reqHost = null;
    }
  }
  if (
    !isAuthorizedSameOriginRequest(
      req.headers.get('origin'),
      reqHost,
      req.headers.get('sec-fetch-site')
    )
  ) {
    return jsonResponse(403, emptyAnalyzeResponse(false, { error: 'Origem não autorizada.' }));
  }

  let body: Partial<AnalyzeFrameRequest>;
  try {
    body = (await req.json()) as Partial<AnalyzeFrameRequest>;
  } catch {
    return jsonResponse(400, emptyAnalyzeResponse(false, { error: 'Corpo JSON inválido.' }));
  }

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return jsonResponse(200, emptyAnalyzeResponse(true));
  }

  const result = await executeGeminiFrameAnalysis(body);
  return jsonResponse(result.status, result.body);
}
