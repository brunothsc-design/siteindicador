import { isSignalConfidenceValid } from '../config/signalConfig.ts';
import type {
  LiveCandleTracker,
  OperationalStatusState,
  PriceLine,
  VisualSignal,
} from '../types/signals.ts';

export interface VideoDisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SignalOverlayProps {
  active: boolean;
  signal: VisualSignal | null;
  priceLine?: PriceLine | null;
  liveCandle?: LiveCandleTracker | null;
  operationalStatus?: OperationalStatusState | null;
  rect: VideoDisplayRect | null;
}

export function SignalOverlay({
  active,
  signal,
  priceLine = null,
  liveCandle = null,
  operationalStatus = null,
  rect,
}: SignalOverlayProps) {
  const validSignal =
    signal && isSignalConfidenceValid(signal.confidence) ? signal : null;
  const statusAnchor = operationalStatus?.anchor ?? null;
  if (
    !active ||
    (!validSignal && !priceLine && !liveCandle && !statusAnchor) ||
    !rect ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }

  const lineBounds = priceLine?.chartBounds ?? null;
  const lineLeft = lineBounds ? lineBounds.x : 0.04;
  const lineWidth = lineBounds ? lineBounds.width : 0.88;
  const lineTop =
    priceLine && lineBounds
      ? lineBounds.y + priceLine.chartRelativeY * lineBounds.height
      : priceLine
        ? priceLine.y
        : 0;

  const candleBounds = liveCandle?.chartBounds ?? null;
  const liveX = liveCandle
    ? candleBounds
      ? candleBounds.x + liveCandle.chartRelativeX * candleBounds.width
      : liveCandle.x
    : 0;
  const liveY = liveCandle
    ? candleBounds
      ? candleBounds.y + liveCandle.chartRelativeY * candleBounds.height
      : liveCandle.y
    : 0;
  const liveColor =
    liveCandle?.direction === 'BULL'
      ? '#10B981'
      : liveCandle?.direction === 'BEAR'
        ? '#F43F5E'
        : '#FBBF24';

  const statusBounds = operationalStatus?.chartBounds ?? candleBounds ?? lineBounds ?? validSignal?.chartBounds ?? null;
  let statusLeft = statusAnchor
    ? statusBounds
      ? statusBounds.x + statusAnchor.chartRelativeX * statusBounds.width
      : statusAnchor.x
    : 0;
  let statusTop = statusAnchor
    ? statusBounds
      ? statusBounds.y + statusAnchor.chartRelativeY * statusBounds.height
      : statusAnchor.y
    : 0;

  if (statusAnchor && statusBounds) {
    const padX = Math.min(0.012, statusBounds.width * 0.04);
    const minLeft = statusBounds.x + padX;
    const maxLeft = Math.max(minLeft, statusBounds.x + statusBounds.width - padX);
    const minTop = statusBounds.y + Math.min(0.045, statusBounds.height * 0.16);
    const maxTop = Math.max(minTop, statusBounds.y + statusBounds.height - 0.015);
    statusLeft = Math.max(minLeft, Math.min(maxLeft, statusLeft));
    statusTop = Math.max(minTop, Math.min(maxTop, statusTop));
  }

  const statusColor =
    operationalStatus?.status === 'COMPRA'
      ? '#22C55E'
      : operationalStatus?.status === 'VENDA'
        ? '#EF4444'
        : '#FBBF24';

  const isBuy = validSignal?.direction === 'COMPRA';
  const posX = validSignal
    ? validSignal.chartBounds
      ? validSignal.chartBounds.x + validSignal.chartRelativeX * validSignal.chartBounds.width
      : validSignal.candleX
    : 0;
  const posY = validSignal
    ? validSignal.chartBounds
      ? validSignal.chartBounds.y + validSignal.chartRelativeY * validSignal.chartBounds.height
      : validSignal.candleY
    : 0;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none select-none fixed z-20"
      style={{
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    >
      {operationalStatus && statusAnchor && (
        <div
          className="absolute font-mono font-bold tracking-wider text-xs sm:text-sm px-2 py-0.5 rounded whitespace-nowrap transition-[left,top,color,border-color] duration-200 ease-out"
          style={{
            left: `${statusLeft * 100}%`,
            top: `${statusTop * 100}%`,
            transform: 'translate(-50%, -100%)',
            color: statusColor,
            backgroundColor: 'rgba(11, 14, 17, 0.78)',
            border: `1px solid ${statusColor}`,
            boxShadow: '0 2px 6px rgba(0, 0, 0, 0.85)',
          }}
        >
          {operationalStatus.status}
        </div>
      )}

      {priceLine && (
        <div
          className="absolute h-[2px] transition-[top] duration-150 ease-out"
          style={{
            left: `${lineLeft * 100}%`,
            width: `${lineWidth * 100}%`,
            top: `${lineTop * 100}%`,
            transform: 'translateY(-50%)',
            backgroundColor: '#38BDF8',
            boxShadow: '0 0 4px rgba(0, 0, 0, 0.9), 0 1px 1px rgba(0, 0, 0, 0.95)',
          }}
        />
      )}

      {liveCandle && (
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 transition-[left,top] duration-150 ease-out"
          style={{
            left: `${liveX * 100}%`,
            top: `${liveY * 100}%`,
          }}
        >
          <div
            className="w-4 h-4 rounded-full flex items-center justify-center"
            style={{
              border: `2px solid ${liveColor}`,
              backgroundColor: 'rgba(11, 14, 17, 0.45)',
              boxShadow: '0 0 6px rgba(0, 0, 0, 0.95)',
            }}
          >
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: liveColor }}
            />
          </div>
        </div>
      )}

      {validSignal && (
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 font-mono font-bold tracking-wider text-sm sm:text-base transition-opacity duration-150"
          style={{
            left: `${posX * 100}%`,
            top: `${posY * 100}%`,
            color: isBuy ? '#22C55E' : '#EF4444',
            textShadow:
              '0 1px 2px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.85), 0 0 1px rgba(0,0,0,1)',
          }}
        >
          {validSignal.direction}
        </div>
      )}
    </div>
  );
}
