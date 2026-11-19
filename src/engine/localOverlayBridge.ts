import type {
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
  active?: boolean;
  autoStartEnabled?: boolean;
  targetBounds?: string;
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
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

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
    window.clearTimeout(timer);
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

export async function pushLocalOverlayPrice(
  sessionId: string,
  priceLine: PriceLine | null
): Promise<boolean> {
  const res = await fetchLocalOverlay(
    '/overlay/price',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        priceLine,
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
  const res = await fetchLocalOverlay(
    '/overlay/candle',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        liveCandle,
      }),
    },
    1000
  );
  return Boolean(res && res.ok);
}

export async function pushLocalOverlayStatus(
  sessionId: string,
  operationalStatus: OperationalStatusState | null
): Promise<boolean> {
  const res = await fetchLocalOverlay(
    '/overlay/status',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        operationalStatus,
      }),
    },
    1000
  );
  return Boolean(res && res.ok);
}

export async function clearLocalOverlaySignals(sessionId: string | null): Promise<boolean> {
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
