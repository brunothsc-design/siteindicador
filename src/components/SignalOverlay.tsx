import type { VisualSignal } from '../types/signals.ts';

export interface VideoDisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SignalOverlayProps {
  active: boolean;
  signal: VisualSignal | null;
  rect: VideoDisplayRect | null;
}

export function SignalOverlay({ active, signal, rect }: SignalOverlayProps) {
  if (!active || !signal || !rect || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const isBuy = signal.direction === 'COMPRA';
  const posX = signal.chartBounds
    ? signal.chartBounds.x + signal.chartRelativeX * signal.chartBounds.width
    : signal.candleX;
  const posY = signal.chartBounds
    ? signal.chartBounds.y + signal.chartRelativeY * signal.chartBounds.height
    : signal.candleY;

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
        {signal.direction}
      </div>
    </div>
  );
}
