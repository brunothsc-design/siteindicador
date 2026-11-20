import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  AnalyzeFrameRequest,
  AnalyzeFrameResponse,
  MarketRegime,
  SignalDirection,
} from '../src/types/signals.ts';

import {
  MIN_SIGNAL_CONFIDENCE,
  isSignalConfidenceValid,
} from '../src/config/signalConfig.ts';

export { MIN_SIGNAL_CONFIDENCE };

let cachedApiKey: string | null = null;
let aiClient: GoogleGenAI | null = null;

function getConfiguredApiKey(): string | null {
  const raw = process.env.GEMINI_API_KEY;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'MY_GEMINI_API_KEY') return null;
  return trimmed;
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) return null;

  if (!aiClient || cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

let rateLimitCooldownUntil = 0;
let consecutiveErrors = 0;
const sessionLastCallMs = new Map<string, number>();
const SERVER_MIN_SESSION_INTERVAL_MS = 1500;
const MAX_IMAGE_BASE64_CHARS = 5_500_000;

export function sanitizeSecretFromText(raw: string): string {
  let clean = raw ?? '';
  const activeKey = getConfiguredApiKey();
  if (activeKey && activeKey.length >= 8) {
    clean = clean.split(activeKey).join('[REDACTED]');
  }
  clean = clean.replace(/AIza[0-9A-Za-z_-]{16,}/g, '[REDACTED]');
  return clean;
}

export function isAuthorizedSameOriginRequest(
  originHeader: string | null | undefined,
  hostHeader: string | null | undefined,
  secFetchSite?: string | null | undefined
): boolean {
  if (secFetchSite && secFetchSite.toLowerCase() === 'cross-site') {
    return false;
  }
  if (!originHeader || !originHeader.trim()) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(originHeader.trim());
  } catch {
    return false;
  }
  const originHost = parsed.host.toLowerCase();
  const originName = parsed.hostname.toLowerCase();
  if (originName === 'localhost' || originName === '127.0.0.1') {
    return true;
  }
  if (hostHeader && hostHeader.trim().length > 0) {
    return originHost === hostHeader.trim().toLowerCase();
  }
  return false;
}

export function emptyAnalyzeResponse(
  ok: boolean,
  extra: Partial<AnalyzeFrameResponse> = {}
): AnalyzeFrameResponse {
  return {
    ok,
    chartDetected: false,
    signal: 'NONE',
    confidence: 0,
    candleX: 0.5,
    candleY: 0.5,
    chartRelativeX: 0.5,
    chartRelativeY: 0.5,
    chartBounds: null,
    candleId: '',
    marketRegime: 'UNCLEAR',
    ...extra,
  };
}

function clamp01(value: unknown, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(0.02, Math.min(0.98, num));
}

export type GeminiErrorCategory = 'RATE_LIMIT' | 'AUTH' | 'UNAVAILABLE' | 'UNKNOWN';

export function classifyGeminiUpstreamError(err: unknown): {
  category: GeminiErrorCategory;
  httpStatus: number;
  userMessage: string;
} {
  const rawMsg = sanitizeSecretFromText(err instanceof Error ? err.message : String(err ?? ''));
  const msg = rawMsg.toLowerCase();
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : undefined;

  if (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit')
  ) {
    return {
      category: 'RATE_LIMIT',
      httpStatus: 429,
      userMessage: 'Limite de requisições ou quota da API Gemini excedido (429). Análise pausada automaticamente.',
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    msg.includes('api_key_invalid') ||
    msg.includes('permission_denied') ||
    msg.includes('invalid api key') ||
    msg.includes('api key not valid') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden')
  ) {
    return {
      category: 'AUTH',
      httpStatus: 401,
      userMessage:
        'Falha na autenticação com a API Gemini. Verifique se a variável GEMINI_API_KEY configurada no servidor é válida.',
    };
  }

  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    msg.includes('unavailable') ||
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed') ||
    msg.includes('network')
  ) {
    return {
      category: 'UNAVAILABLE',
      httpStatus: 503,
      userMessage: 'API Gemini temporariamente indisponível. Tentando novamente em instantes.',
    };
  }

  return {
    category: 'UNKNOWN',
    httpStatus: 500,
    userMessage: 'Não foi possível concluir a análise visual no momento.',
  };
}

export function applySignalPrecisionFilter(params: {
  chartDetected: boolean;
  rawSignal: string;
  confidence: number;
  rawRegime: string;
}): {
  signal: SignalDirection | 'NONE';
  marketRegime: MarketRegime;
  confidence: number;
} {
  const confidence = Number.isFinite(params.confidence)
    ? Math.max(0, Math.min(100, params.confidence))
    : 0;

  const upperRegime = String(params.rawRegime ?? 'UNCLEAR').toUpperCase();
  const marketRegime: MarketRegime =
    upperRegime === 'TRENDING_UP' ||
    upperRegime === 'TRENDING_DOWN' ||
    upperRegime === 'SIDEWAYS'
      ? upperRegime
      : 'UNCLEAR';

  const upperSignal = String(params.rawSignal ?? 'NONE').toUpperCase();
  let signal: SignalDirection | 'NONE' =
    upperSignal === 'COMPRA' || upperSignal === 'VENDA' ? upperSignal : 'NONE';

  if (
    !params.chartDetected ||
    !isSignalConfidenceValid(confidence) ||
    marketRegime === 'SIDEWAYS' ||
    marketRegime === 'UNCLEAR' ||
    (signal === 'COMPRA' && marketRegime !== 'TRENDING_UP') ||
    (signal === 'VENDA' && marketRegime !== 'TRENDING_DOWN')
  ) {
    signal = 'NONE';
  }

  return { signal, marketRegime, confidence };
}

export interface CoreAnalyzeResult {
  status: number;
  body: AnalyzeFrameResponse;
}

export async function executeGeminiFrameAnalysis(
  request: Partial<AnalyzeFrameRequest>,
  options?: {
    isSessionCancelled?: () => boolean;
  }
): Promise<CoreAnalyzeResult> {
  const now = Date.now();
  if (now < rateLimitCooldownUntil) {
    const retryAfterMs = rateLimitCooldownUntil - now;
    return {
      status: 429,
      body: emptyAnalyzeResponse(false, {
        rateLimited: true,
        retryAfterMs,
        error: 'Limite temporário de requisições Gemini atingido. Aguardando cooldown.',
      }),
    };
  }

  const rawBase64 = typeof request?.imageBase64 === 'string' ? request.imageBase64 : '';
  const cleanBase64 = rawBase64.replace(/^data:image\/\w+;base64,/, '');
  const mimeType = typeof request?.mimeType === 'string' ? request.mimeType : 'image/jpeg';

  if (!cleanBase64 || cleanBase64.length < 100) {
    return {
      status: 400,
      body: emptyAnalyzeResponse(false, {
        error: 'Frame de imagem inválido.',
      }),
    };
  }

  if (cleanBase64.length > MAX_IMAGE_BASE64_CHARS) {
    return {
      status: 413,
      body: emptyAnalyzeResponse(false, {
        error: 'Frame de imagem excede o limite permitido.',
      }),
    };
  }

  const ai = getAiClient();
  if (!ai) {
    return {
      status: 503,
      body: emptyAnalyzeResponse(false, {
        error:
          'Chave da API Gemini não configurada. Defina a variável de ambiente GEMINI_API_KEY nas configurações do servidor.',
      }),
    };
  }

  const sid = typeof request?.sessionId === 'string' ? request.sessionId.trim() : '';
  if (sid) {
    const prevCallAt = sessionLastCallMs.get(sid) ?? 0;
    const elapsed = now - prevCallAt;
    if (elapsed < SERVER_MIN_SESSION_INTERVAL_MS) {
      return {
        status: 429,
        body: emptyAnalyzeResponse(false, {
          rateLimited: true,
          retryAfterMs: SERVER_MIN_SESSION_INTERVAL_MS - elapsed,
          error: 'Intervalo mínimo entre análises atingido.',
        }),
      };
    }
    if (sessionLastCallMs.size > 256) {
      const oldest = sessionLastCallMs.keys().next().value;
      if (oldest) sessionLastCallMs.delete(oldest);
    }
    sessionLastCallMs.set(sid, now);
  }

  const localBounds = request?.chartBounds ?? null;
  const boundsHint = localBounds
    ? `Região aproximada do gráfico detectada localmente (coordenadas 0..1 na janela): x=${localBounds.x.toFixed(2)}, y=${localBounds.y.toFixed(2)}, width=${localBounds.width.toFixed(2)}, height=${localBounds.height.toFixed(2)}.`
    : 'Localize automaticamente a área do gráfico de velas (candlesticks), ignorando barras laterais, menus e botões de ordem.';

  const lastSignalHint = request?.lastSignal
    ? `Último sinal emitido: ${request.lastSignal.direction} na posição X=${request.lastSignal.candleX.toFixed(2)} (id=${request.lastSignal.candleId}). NÃO repita sinal na mesma vela nem inverta bruscamente sem clara reversão confirmada.`
    : 'Nenhum sinal recente ativo.';

  const promptText = `Você é o motor visual universal de altíssima precisão do ChartPulse AI. TIMEFRAME OBRIGATÓRIO: 1 MINUTO (M1). Analise esta captura de tela de qualquer plataforma ou corretora financeira (ex: plataformas web, desktop EXE, TradingView, MetaTrader 4/5, IQ Option, Quotex, Binomo, Pocket Option ou similares), independentemente de tema (claro/escuro), esquema de cores das velas ou escala visual.
${boundsHint}
${lastSignalHint}

Regras obrigatórias de decisão para gráfico M1 (meta de ~95% de precisão):
1. Identifique se existe uma área legível de gráfico de velas (candlesticks) na captura. Ignore botões de compra/venda, listas de ativos, menus e barras de ferramentas. Se não reconhecer um gráfico de velas com segurança, retorne chartDetected=false e signal="NONE".
2. Retorne chartX, chartY, chartWidth e chartHeight (0.0 a 1.0 da imagem inteira) delimitando apenas a área útil do gráfico onde as velas são desenhadas.
3. Considere obrigatoriamente o ciclo de 1 minuto (M1): avalie a formação em tempo real da vela atual de M1 à direita em conjunto com o contexto das 5-10 velas anteriores de M1, direção da tendência predominante, força do impulso, padrões de candles (engolfo, martelo/pin bar confirmado, continuação com corpo sólido), volatilidade e rejeições de pavio.
4. REGRA FUNDAMENTAL: Não emita COMPRA ou VENDA por mera oscilação momentânea. Na dúvida, em mercado lateral/consolidado (SIDEWAYS), velas pequenas indecisas (dojis/spinning tops), pavios longos contraditórios ou movimento já esticado/atrasado, retorne OBRIGATORIAMENTE signal="NONE" (mantendo o status em AGUARDANDO). É muito melhor NÃO emitir sinal do que emitir um sinal falso.
5. Só retorne signal="COMPRA" ou signal="VENDA" quando houver confirmação técnica excepcional no contexto M1 (confidence >= ${MIN_SIGNAL_CONFIDENCE}).
6. Posicione chartRelativeX e chartRelativeY (0.0 a 1.0 RELATIVOS À REGIÃO DO GRÁFICO delimitada por chartX/chartY/chartWidth/chartHeight) exatamente sobre a vela correspondente (logo acima ou abaixo do corpo/pavio sem cobrir a vela).
7. Gere um candleId curto identificando a vela alvo (ex: "m1-right-0-bull" ou posição aproximada) para evitar sinais duplicados.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: cleanBase64,
            },
          },
          { text: promptText },
        ],
      },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            chartDetected: { type: Type.BOOLEAN },
            signal: {
              type: Type.STRING,
              description: 'Must be COMPRA, VENDA, or NONE',
            },
            confidence: {
              type: Type.NUMBER,
              description: '0 to 100 confidence score',
            },
            chartX: {
              type: Type.NUMBER,
              description: 'Normalized 0..1 left edge of the candlestick plot area',
            },
            chartY: {
              type: Type.NUMBER,
              description: 'Normalized 0..1 top edge of the candlestick plot area',
            },
            chartWidth: {
              type: Type.NUMBER,
              description: 'Normalized 0..1 width of the candlestick plot area',
            },
            chartHeight: {
              type: Type.NUMBER,
              description: 'Normalized 0..1 height of the candlestick plot area',
            },
            chartRelativeX: {
              type: Type.NUMBER,
              description: 'Normalized 0..1 X coordinate relative to the chart plot area',
            },
            chartRelativeY: {
              type: Type.NUMBER,
              description: 'Normalized 0..1 Y coordinate relative to the chart plot area',
            },
            candleId: {
              type: Type.STRING,
              description: 'Short identifier of the target candle',
            },
            marketRegime: {
              type: Type.STRING,
              description: 'TRENDING_UP, TRENDING_DOWN, SIDEWAYS, or UNCLEAR',
            },
          },
          required: [
            'chartDetected',
            'signal',
            'confidence',
            'chartX',
            'chartY',
            'chartWidth',
            'chartHeight',
            'chartRelativeX',
            'chartRelativeY',
            'candleId',
            'marketRegime',
          ],
        },
      },
    });

    consecutiveErrors = 0;

    if (options?.isSessionCancelled?.()) {
      return {
        status: 200,
        body: emptyAnalyzeResponse(true),
      };
    }

    const rawJson = (response.text ?? '{}').trim();
    const parsed = JSON.parse(rawJson) as {
      chartDetected?: boolean;
      signal?: string;
      confidence?: number;
      chartX?: number;
      chartY?: number;
      chartWidth?: number;
      chartHeight?: number;
      chartRelativeX?: number;
      chartRelativeY?: number;
      candleId?: string;
      marketRegime?: string;
    };

    const chartDetected = Boolean(parsed.chartDetected);
    const filtered = applySignalPrecisionFilter({
      chartDetected,
      rawSignal: String(parsed.signal ?? 'NONE'),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      rawRegime: String(parsed.marketRegime ?? 'UNCLEAR'),
    });

    const hasValidVisionBounds =
      typeof parsed.chartWidth === 'number' &&
      typeof parsed.chartHeight === 'number' &&
      parsed.chartWidth >= 0.15 &&
      parsed.chartHeight >= 0.12;

    const resolvedBounds = hasValidVisionBounds
      ? {
          x: clamp01(parsed.chartX, localBounds?.x ?? 0.05),
          y: clamp01(parsed.chartY, localBounds?.y ?? 0.08),
          width: Math.max(0.15, Math.min(1, Number(parsed.chartWidth))),
          height: Math.max(0.12, Math.min(1, Number(parsed.chartHeight))),
        }
      : localBounds;

    const chartRelativeX = clamp01(parsed.chartRelativeX, 0.82);
    const chartRelativeY = clamp01(parsed.chartRelativeY, 0.48);

    const candleX = resolvedBounds
      ? clamp01(resolvedBounds.x + chartRelativeX * resolvedBounds.width, 0.78)
      : chartRelativeX;
    const candleY = resolvedBounds
      ? clamp01(resolvedBounds.y + chartRelativeY * resolvedBounds.height, 0.48)
      : chartRelativeY;

    const candleId = typeof parsed.candleId === 'string' ? parsed.candleId.slice(0, 48) : '';

    let finalSignal = filtered.signal;
    if (finalSignal !== 'NONE' && request.lastSignal) {
      const elapsedMs = Date.now() - request.lastSignal.createdAt;
      const sameRegion = Math.abs(candleX - request.lastSignal.candleX) < 0.035;
      const sameId = candleId !== '' && candleId === request.lastSignal.candleId;
      if ((sameRegion || sameId) && elapsedMs < 30000) {
        finalSignal = 'NONE';
      }
    }

    return {
      status: 200,
      body: {
        ok: true,
        chartDetected,
        signal: finalSignal,
        confidence: filtered.confidence,
        candleX,
        candleY,
        chartRelativeX,
        chartRelativeY,
        chartBounds: resolvedBounds,
        candleId,
        marketRegime: filtered.marketRegime,
      },
    };
  } catch (err) {
    consecutiveErrors++;
    const classified = classifyGeminiUpstreamError(err);

    if (classified.category === 'RATE_LIMIT') {
      const backoffMs = Math.min(60000, 12000 * Math.pow(1.5, Math.min(4, consecutiveErrors - 1)));
      rateLimitCooldownUntil = Date.now() + backoffMs;
      return {
        status: 429,
        body: emptyAnalyzeResponse(false, {
          rateLimited: true,
          retryAfterMs: backoffMs,
          error: classified.userMessage,
        }),
      };
    }

    return {
      status: classified.httpStatus,
      body: emptyAnalyzeResponse(false, {
        error: classified.userMessage,
      }),
    };
  }
}
