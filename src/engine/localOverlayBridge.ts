import type {
  ChartBounds,
  LiveCandleTracker,
  OperationalStatusState,
  PriceLine,
  VisualSignal,
} from '../types/signals.ts';

export const LOCAL_OVERLAY_URL = 'http://127.0.0.1:47821';

export type OverlayConnectionState = 'checking' | 'connected' | 'disconnected';

export interface LocalOverlayHealthResponse {
  ok: boolean;
  component?: string;
  version?: string;
  priceLineSupported?: boolean;
  liveCandleSupported?: boolean;
  operationalStatusSupported?: boolean;
  hasStatusAnchor?: boolean;
  hasLiveCandle?: boolean;
  hasPriceLine?: boolean;
  operationalStatus?: string;
  active?: boolean;
  autoStartEnabled?: boolean;
  displaySurface?: string;
  targetBounds?: string;
  overlayBounds?: string;
  overlayVisible?: boolean;
  targetWindowTitle?: string;
  lastStatusAnchorX?: number;
  lastStatusAnchorY?: number;
  lastCandleX?: number;
  lastCandleY?: number;
  priceLineUpdates?: number;
  liveCandleUpdates?: number;
  statusUpdates?: number;
  signalUpdates?: number;
  paintCount?: number;
}

/**
 * Validates whether an origin is permitted to control the local Windows overlay daemon.
 * Mirrors the exact allowlist enforced by ChartPulseOverlay.exe on 127.0.0.1:47821.
 */
export function isTrustedOverlayOrigin(
  origin: string,
  extraOrigins: string[] = []
): boolean {
  if (!origin || typeof origin !== 'string') return false;
  const trimmed = origin.trim().replace(/\/+$/, '');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const protocol = parsed.protocol.toLowerCase();

  if (
    (protocol === 'http:' || protocol === 'https:') &&
    (host === 'localhost' || host === '127.0.0.1')
  ) {
    return true;
  }

  if (protocol === 'https:') {
    if (host.endsWith('.netlify.app') && host.length > '.netlify.app'.length) {
      return true;
    }
    if (host.endsWith('.run.app') && host.length > '.run.app'.length) {
      return true;
    }
  }

  for (const extra of extraOrigins) {
    if (extra.trim().replace(/\/+$/, '').toLowerCase() === trimmed.toLowerCase()) {
      return true;
    }
  }

  return false;
}

async function fetchLocalOverlay(
  path: string,
  init: RequestInit = {},
  timeoutMs = 1200
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${LOCAL_OVERLAY_URL}${path}`, {
      ...init,
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
    });
    return response;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function checkLocalOverlayHealth(): Promise<LocalOverlayHealthResponse | null> {
  const res = await fetchLocalOverlay('/health', { method: 'GET' }, 1100);
  if (!res || !res.ok) return null;
  try {
    const data = (await res.json()) as LocalOverlayHealthResponse;
    return data?.ok ? data : null;
  } catch {
    return null;
  }
}

export async function notifyLocalOverlaySession(
  sessionId: string,
  displaySurface = 'unknown'
): Promise<boolean> {
  const res = await fetchLocalOverlay(
    '/overlay/session',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, displaySurface }),
    },
    1400
  );
  return Boolean(res && res.ok);
}

export async function pushLocalOverlaySignal(
  sessionId: string,
  signal: VisualSignal
): Promise<boolean> {
  const res = await fetchLocalOverlay(
    '/overlay/signal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        signal,
      }),
    },
    1400
  );
  return Boolean(res && res.ok);
}

interface CachedLiveCandleEntry {
  sessionId: string;
  liveCandle: LiveCandleTracker;
  updatedAt: number;
}

export interface BridgeDiagnosticSnapshot {
  candleSentCount: number;
  candleFailCount: number;
  statusSentCount: number;
  statusWithAnchorCount: number;
  statusFailCount: number;
  lastCandleCoords: { x: number; y: number; topY: number; dir: string } | null;
  lastStatusAnchor: { x: number; y: number; status: string } | null;
  lastError: string | null;
}

let cachedLiveCandle: CachedLiveCandleEntry | null = null;
const LIVE_CANDLE_ANCHOR_CACHE_MS = 2500;

const bridgeDiag: BridgeDiagnosticSnapshot = {
  candleSentCount: 0,
  candleFailCount: 0,
  statusSentCount: 0,
  statusWithAnchorCount: 0,
  statusFailCount: 0,
  lastCandleCoords: null,
  lastStatusAnchor: null,
  lastError: null,
};

export function getLastBridgeDiagnosticSnapshot(): BridgeDiagnosticSnapshot {
  return { ...bridgeDiag };
}

function clampUnit(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

function sanitizeBounds(bounds: ChartBounds | null | undefined): ChartBounds | null {
  if (!bounds) return null;
  const x = clampUnit(bounds.x, 0);
  const y = clampUnit(bounds.y, 0);
  const width = clampUnit(bounds.width, 0);
  const height = clampUnit(bounds.height, 0);
  if (width <= 0.05 || height <= 0.05) return null;
  return { x, y, width, height };
}

function sanitizeLiveCandle(liveCandle: LiveCandleTracker): LiveCandleTracker | null {
  if (
    typeof liveCandle.x !== 'number' ||
    typeof liveCandle.y !== 'number' ||
    !Number.isFinite(liveCandle.x) ||
    !Number.isFinite(liveCandle.y)
  ) {
    return null;
  }
  return {
    ...liveCandle,
    x: clampUnit(liveCandle.x, 0.5),
    y: clampUnit(liveCandle.y, 0.5),
    chartRelativeX: clampUnit(liveCandle.chartRelativeX, liveCandle.x),
    chartRelativeY: clampUnit(liveCandle.chartRelativeY, liveCandle.y),
    topY: clampUnit(liveCandle.topY, liveCandle.y),
    bottomY: clampUnit(liveCandle.bottomY, liveCandle.y),
    chartBounds: sanitizeBounds(liveCandle.chartBounds),
  };
}

export function buildOperationalStatusPayloadWithLiveCandle(
  sessionId: string,
  operationalStatus: OperationalStatusState | null
): OperationalStatusState | null {
  if (!operationalStatus) return null;
  const now = Date.now();
  const safeBounds = sanitizeBounds(operationalStatus.chartBounds);

  if (
    operationalStatus.anchor &&
    Number.isFinite(operationalStatus.anchor.x) &&
    Number.isFinite(operationalStatus.anchor.y)
  ) {
    return {
      ...operationalStatus,
      chartBounds: safeBounds,
      anchor: {
        x: clampUnit(operationalStatus.anchor.x, 0.5),
        y: clampUnit(operationalStatus.anchor.y, 0.5),
        chartRelativeX: clampUnit(
          operationalStatus.anchor.chartRelativeX,
          operationalStatus.anchor.x
        ),
        chartRelativeY: clampUnit(
          operationalStatus.anchor.chartRelativeY,
          operationalStatus.anchor.y
        ),
        candleTopY: clampUnit(
          operationalStatus.anchor.candleTopY,
          operationalStatus.anchor.y
        ),
        updatedAt: operationalStatus.anchor.updatedAt || now,
      },
    };
  }

  if (
    cachedLiveCandle &&
    cachedLiveCandle.sessionId === sessionId &&
    now - cachedLiveCandle.updatedAt <= LIVE_CANDLE_ANCHOR_CACHE_MS
  ) {
    const lc = cachedLiveCandle.liveCandle;
    const candleTopY = clampUnit(Math.min(lc.topY, lc.y), lc.y);
    const rawAnchorY = Math.max(0.02, candleTopY - 0.016);
    const lcBounds = lc.chartBounds ?? safeBounds;
    const anchorX = lcBounds
      ? clampUnit(lcBounds.x + lc.chartRelativeX * lcBounds.width, lc.x)
      : clampUnit(lc.x, 0.5);
    const anchorY = lcBounds
      ? clampUnit(
          Math.max(
            lcBounds.y + Math.min(0.014, lcBounds.height * 0.05),
            Math.min(lcBounds.y + lcBounds.height - 0.015, rawAnchorY)
          ),
          rawAnchorY
        )
      : clampUnit(rawAnchorY, 0.05);
    const relX = lcBounds
      ? clampUnit((anchorX - lcBounds.x) / Math.max(0.05, lcBounds.width), lc.chartRelativeX)
      : anchorX;
    const relY = lcBounds
      ? clampUnit((anchorY - lcBounds.y) / Math.max(0.05, lcBounds.height), lc.chartRelativeY)
      : anchorY;

    return {
      ...operationalStatus,
      chartBounds: lcBounds,
      anchor: {
        x: anchorX,
        y: anchorY,
        chartRelativeX: relX,
        chartRelativeY: relY,
        candleTopY,
        updatedAt: now,
      },
    };
  }

  return {
    ...operationalStatus,
    chartBounds: safeBounds,
  };
}

export async function pushLocalOverlayPrice(
  sessionId: string,
  priceLine: PriceLine | null
): Promise<boolean> {
  const safePrice =
    priceLine && Number.isFinite(priceLine.y)
      ? {
          ...priceLine,
          y: clampUnit(priceLine.y, 0.5),
          chartRelativeY: clampUnit(priceLine.chartRelativeY, priceLine.y),
          chartBounds: sanitizeBounds(priceLine.chartBounds),
        }
      : null;

  const res = await fetchLocalOverlay(
    '/overlay/price',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        priceLine: safePrice,
      }),
    },
    1000
  );
  return Boolean(res && res.ok);
}

export async function pushLocalOverlayCandle(
  sessionId: string,
  liveCandle: LiveCandleTracker | null
): Promise<boolean> {
  const safeCandle = liveCandle ? sanitizeLiveCandle(liveCandle) : null;
  if (safeCandle) {
    cachedLiveCandle = {
      sessionId,
      liveCandle: safeCandle,
      updatedAt: Date.now(),
    };
    bridgeDiag.lastCandleCoords = {
      x: safeCandle.x,
      y: safeCandle.y,
      topY: safeCandle.topY,
      dir: safeCandle.direction,
    };
  } else if (cachedLiveCandle && cachedLiveCandle.sessionId === sessionId) {
    if (Date.now() - cachedLiveCandle.updatedAt > LIVE_CANDLE_ANCHOR_CACHE_MS) {
      cachedLiveCandle = null;
    }
  }

  const res = await fetchLocalOverlay(
    '/overlay/candle',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        liveCandle: safeCandle,
      }),
    },
    1000
  );
  const ok = Boolean(res && res.ok);
  if (ok) {
    if (safeCandle) bridgeDiag.candleSentCount++;
    bridgeDiag.lastError = null;
  } else {
    bridgeDiag.candleFailCount++;
    bridgeDiag.lastError = res ? `/overlay/candle HTTP ${res.status}` : '/overlay/candle unreachable';
  }
  return ok;
}

export async function pushLocalOverlayStatus(
  sessionId: string,
  operationalStatus: OperationalStatusState | null
): Promise<boolean> {
  const payload = buildOperationalStatusPayloadWithLiveCandle(sessionId, operationalStatus);
  const res = await fetchLocalOverlay(
    '/overlay/status',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        operationalStatus: payload,
      }),
    },
    1000
  );
  const ok = Boolean(res && res.ok);
  if (ok) {
    bridgeDiag.statusSentCount++;
    if (payload?.anchor) {
      bridgeDiag.statusWithAnchorCount++;
      bridgeDiag.lastStatusAnchor = {
        x: payload.anchor.x,
        y: payload.anchor.y,
        status: payload.status,
      };
    }
    bridgeDiag.lastError = null;
  } else {
    bridgeDiag.statusFailCount++;
    bridgeDiag.lastError = res ? `/overlay/status HTTP ${res.status}` : '/overlay/status unreachable';
  }
  return ok;
}

export async function clearLocalOverlaySignals(sessionId: string | null): Promise<boolean> {
  cachedLiveCandle = null;
  bridgeDiag.lastCandleCoords = null;
  bridgeDiag.lastStatusAnchor = null;
  const res = await fetchLocalOverlay(
    '/overlay/clear',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    },
    1400
  );
  return Boolean(res && res.ok);
}
