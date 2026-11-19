import type {
  ChartBounds,
  OperationalStatusState,
  OperationalStatusValue,
  VisualSignal,
} from '../types/signals.ts';

export const MANDATORY_TIMEFRAME = 'M1' as const;
export const MIN_OPERATIONAL_CONFIDENCE = 90;

export function createInitialOperationalStatus(
  chartBounds: ChartBounds | null = null,
  now = Date.now()
): OperationalStatusState {
  return {
    status: 'AGUARDANDO',
    timeframe: MANDATORY_TIMEFRAME,
    confidence: 0,
    chartBounds,
    expiresAt: null,
    updatedAt: now,
  };
}

/**
 * Resolves the permanent non-flickering operational status indicator for M1 charts:
 * - Active session with no confirmed >= 90% signal => AGUARDANDO
 * - Confirmed buy >= 90% => COMPRA
 * - Confirmed sell >= 90% => VENDA
 * - Expired signal or new unconfirmed M1 cycle => reverts to AGUARDANDO without ever clearing to null while active.
 */
export function resolveOperationalStatus(params: {
  isActive: boolean;
  current: OperationalStatusState | null;
  activeSignal: VisualSignal | null;
  latestBounds: ChartBounds | null;
  now?: number;
}): OperationalStatusState | null {
  if (!params.isActive) {
    return null;
  }

  const now = params.now ?? Date.now();
  const resolvedBounds =
    params.activeSignal?.chartBounds ?? params.latestBounds ?? params.current?.chartBounds ?? null;

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
      expiresAt: sig.expiresAt,
      updatedAt: now,
    };
  }

  return {
    status: 'AGUARDANDO',
    timeframe: MANDATORY_TIMEFRAME,
    confidence: 0,
    chartBounds: resolvedBounds,
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
