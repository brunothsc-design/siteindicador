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

export interface OverlayState {
  active: boolean;
  sessionId: string | null;
  signal: VisualSignal | null;
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
