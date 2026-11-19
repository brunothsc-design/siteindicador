export type SignalDirection = 'COMPRA' | 'VENDA';

export type MarketRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'SIDEWAYS' | 'UNCLEAR';

export interface ChartBounds {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  width: number; // normalized 0..1
  height: number; // normalized 0..1
}

export interface VisualSignal {
  id: string;
  direction: SignalDirection;
  candleX: number; // normalized 0..1 relative to captured frame
  candleY: number; // normalized 0..1 relative to captured frame
  chartRelativeX: number; // normalized 0..1 relative to detected chart region
  chartRelativeY: number; // normalized 0..1 relative to detected chart region
  chartBounds: ChartBounds | null;
  confidence: number;
  candleId: string;
  marketRegime: MarketRegime;
  createdAt: number;
  expiresAt: number;
}

export interface PriceLine {
  y: number; // normalized 0..1 relative to captured frame
  chartRelativeY: number; // normalized 0..1 relative to detected chartBounds
  chartBounds: ChartBounds | null;
  confidence: number; // 0..1
  source: 'PRICE_LINE' | 'CANDLE_CLOSE';
  updatedAt: number;
}

export type LiveCandleDirection = 'BULL' | 'BEAR' | 'NEUTRAL';

export interface LiveCandleTracker {
  x: number; // normalized 0..1 relative to captured frame
  y: number; // normalized 0..1 relative to captured frame (live price on forming candle)
  chartRelativeX: number; // normalized 0..1 relative to chartBounds
  chartRelativeY: number; // normalized 0..1 relative to chartBounds
  topY: number; // normalized 0..1 upper bound of forming candle
  bottomY: number; // normalized 0..1 lower bound of forming candle
  direction: LiveCandleDirection;
  chartBounds: ChartBounds | null;
  confidence: number; // 0..1
  updatedAt: number;
}

export type OperationalStatusValue = 'AGUARDANDO' | 'COMPRA' | 'VENDA';

export interface OperationalStatusAnchor {
  x: number; // normalized 0..1 horizontal center of the forming candle
  y: number; // normalized 0..1 bottom anchor directly above the candle top
  chartRelativeX: number; // normalized 0..1 relative to chartBounds
  chartRelativeY: number; // normalized 0..1 relative to chartBounds
  candleTopY: number; // normalized 0..1 top edge of the forming candle
  updatedAt: number;
}

export interface OperationalStatusState {
  status: OperationalStatusValue;
  timeframe: 'M1';
  confidence: number;
  chartBounds: ChartBounds | null;
  anchor: OperationalStatusAnchor | null;
  expiresAt: number | null;
  updatedAt: number;
}

export interface OverlayState {
  active: boolean;
  sessionId: string | null;
  signal: VisualSignal | null;
  priceLine: PriceLine | null;
  liveCandle: LiveCandleTracker | null;
  operationalStatus?: OperationalStatusState | null;
  chartBounds: ChartBounds | null;
  updatedAt: number;
}

export interface AnalyzeFrameRequest {
  imageBase64: string;
  mimeType: string;
  chartBounds: ChartBounds | null;
  sessionId: string;
  lastSignal: {
    direction: SignalDirection;
    candleX: number;
    candleId: string;
    createdAt: number;
  } | null;
}

export interface AnalyzeFrameResponse {
  ok: boolean;
  chartDetected: boolean;
  signal: SignalDirection | 'NONE';
  confidence: number;
  candleX: number;
  candleY: number;
  chartRelativeX: number;
  chartRelativeY: number;
  chartBounds: ChartBounds | null;
  candleId: string;
  marketRegime: MarketRegime;
  rateLimited?: boolean;
  retryAfterMs?: number;
  error?: string;
}
