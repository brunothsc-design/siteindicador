import type {
  ChartBounds,
  LiveCandleTracker,
  OperationalStatusAnchor,
  OperationalStatusState,
  OperationalStatusValue,
  VisualSignal,
} from '../types/signals.ts';

import { MIN_SIGNAL_CONFIDENCE } from '../config/signalConfig.ts';

export const MANDATORY_TIMEFRAME = 'M1' as const;
export const MIN_OPERATIONAL_CONFIDENCE = MIN_SIGNAL_CONFIDENCE;
export const ABOVE_CANDLE_GAP_Y = 0.016;
export const CANDLE_ANCHOR_HOLD_MS = 2500;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Computes the indicator anchor directly above the real forming candle,
 * horizontally centered on it and clamped within chartBounds.
 * Returns null whenever no real candle was detected (never invents positions).
 */
export function computeCandleStatusAnchor(
  liveCandle: LiveCandleTracker | null,
  fallbackBounds: ChartBounds | null = null,
  now = Date.now()
): OperationalStatusAnchor | null {
  if (!liveCandle) {
    return null;
  }

  const bounds = liveCandle.chartBounds ?? fallbackBounds;
  const rawCandleX = bounds
    ? bounds.x + liveCandle.chartRelativeX * bounds.width
    : liveCandle.x;
  const candleTopY = clamp(Math.min(liveCandle.topY, liveCandle.y), 0.01, 0.98);
  const rawAnchorY = candleTopY - ABOVE_CANDLE_GAP_Y;

  let clampedX: number;
  let clampedY: number;
  let chartRelativeX: number;
  let chartRelativeY: number;

  if (bounds) {
    const marginX = Math.min(0.012, bounds.width * 0.04);
    const minX = bounds.x + marginX;
    const maxX = bounds.x + bounds.width - marginX;
    clampedX = clamp(rawCandleX, minX, maxX);

    // Keep anchor tip above candleTopY while staying strictly inside chartBounds
    const minY = bounds.y + Math.min(0.014, bounds.height * 0.05);
    const maxY = bounds.y + bounds.height - 0.015;
    clampedY = clamp(rawAnchorY, minY, maxY);

    chartRelativeX = clamp((clampedX - bounds.x) / Math.max(0.05, bounds.width), 0.01, 0.99);
    chartRelativeY = clamp((clampedY - bounds.y) / Math.max(0.05, bounds.height), 0.02, 0.98);
  } else {
    clampedX = clamp(rawCandleX, 0.06, 0.94);
    clampedY = clamp(rawAnchorY, 0.05, 0.96);
    chartRelativeX = clampedX;
    chartRelativeY = clampedY;
  }

  return {
    x: round4(clampedX),
    y: round4(clampedY),
    chartRelativeX: round4(chartRelativeX),
    chartRelativeY: round4(chartRelativeY),
    candleTopY: round4(candleTopY),
    updatedAt: now,
  };
}

export function createInitialOperationalStatus(
  chartBounds: ChartBounds | null = null,
  liveCandle: LiveCandleTracker | null = null,
  now = Date.now()
): OperationalStatusState {
  const resolvedBounds = liveCandle?.chartBounds ?? chartBounds;
  return {
    status: 'AGUARDANDO',
    timeframe: MANDATORY_TIMEFRAME,
    confidence: 0,
    chartBounds: resolvedBounds,
    anchor: computeCandleStatusAnchor(liveCandle, resolvedBounds, now),
    expiresAt: null,
    updatedAt: now,
  };
}

/**
 * Resolves the permanent non-flickering operational status indicator for M1 charts:
 * - Positioned directly above the real detected forming candle (never invented if candle missing)
 * - Holds brief transient capture misses (<= CANDLE_ANCHOR_HOLD_MS) while chart is active to prevent flicker
 * - Active session with no confirmed >= MIN_OPERATIONAL_CONFIDENCE signal => AGUARDANDO
 * - Confirmed buy >= MIN_OPERATIONAL_CONFIDENCE => COMPRA (same position above candle)
 * - Confirmed sell >= MIN_OPERATIONAL_CONFIDENCE => VENDA (same position above candle)
 */
export function resolveOperationalStatus(params: {
  isActive: boolean;
  current: OperationalStatusState | null;
  activeSignal: VisualSignal | null;
  liveCandle: LiveCandleTracker | null;
  latestBounds: ChartBounds | null;
  chartDetected?: boolean;
  now?: number;
}): OperationalStatusState | null {
  if (!params.isActive) {
    return null;
  }

  const now = params.now ?? Date.now();
  const resolvedBounds =
    params.liveCandle?.chartBounds ??
    params.activeSignal?.chartBounds ??
    params.latestBounds ??
    params.current?.chartBounds ??
    null;

  const freshAnchor = computeCandleStatusAnchor(params.liveCandle, resolvedBounds, now);
  let anchor: OperationalStatusAnchor | null = freshAnchor;

  if (
    !anchor &&
    params.current?.anchor &&
    params.chartDetected !== false &&
    now - params.current.anchor.updatedAt <= CANDLE_ANCHOR_HOLD_MS
  ) {
    anchor = params.current.anchor;
  }

  const sig = params.activeSignal;
  if (
    sig &&
    (sig.direction === 'COMPRA' || sig.direction === 'VENDA') &&
    sig.confidence >= MIN_OPERATIONAL_CONFIDENCE &&
    now <= sig.expiresAt
  ) {
    const nextStatus: OperationalStatusValue = sig.direction;
    return {
      status: nextStatus,
      timeframe: MANDATORY_TIMEFRAME,
      confidence: sig.confidence,
      chartBounds: resolvedBounds,
      anchor,
      expiresAt: sig.expiresAt,
      updatedAt: now,
    };
  }

  return {
    status: 'AGUARDANDO',
    timeframe: MANDATORY_TIMEFRAME,
    confidence: 0,
    chartBounds: resolvedBounds,
    anchor,
    expiresAt: null,
    updatedAt: now,
  };
}

export function operationalStatusChanged(
  prev: OperationalStatusState | null,
  next: OperationalStatusState | null
): boolean {
  if (prev === null && next === null) return false;
  if (prev === null || next === null) return true;
  if (prev.status !== next.status) return true;
  if (prev.confidence !== next.confidence) return true;
  if (prev.expiresAt !== next.expiresAt) return true;

  const pa = prev.anchor;
  const na = next.anchor;
  if ((pa === null) !== (na === null)) return true;
  if (pa && na) {
    if (
      Math.abs(pa.x - na.x) >= 0.0015 ||
      Math.abs(pa.y - na.y) >= 0.0015 ||
      Math.abs(pa.chartRelativeX - na.chartRelativeX) >= 0.0015 ||
      Math.abs(pa.chartRelativeY - na.chartRelativeY) >= 0.0015
    ) {
      return true;
    }
  }

  const pb = prev.chartBounds;
  const nb = next.chartBounds;
  if ((pb === null) !== (nb === null)) return true;
  if (pb && nb) {
    if (
      Math.abs(pb.x - nb.x) >= 0.005 ||
      Math.abs(pb.y - nb.y) >= 0.005 ||
      Math.abs(pb.width - nb.width) >= 0.005 ||
      Math.abs(pb.height - nb.height) >= 0.005
    ) {
      return true;
    }
  }
  return false;
}
