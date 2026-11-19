import type { ChartBounds } from '../types/signals.ts';

export type ChartTheme = 'DARK' | 'LIGHT';

export interface LocalFrameDigest {
  chartDetected: boolean;
  chartBounds: ChartBounds | null;
  theme: ChartTheme;
  candleDensityScore: number;
  diffScore: number;
  signature: Float32Array;
}

const GRID_W = 96;
const GRID_H = 54;

/**
 * Estimates dominant canvas background RGB from the interior region of the frame
 * so chart detection works across dark, navy, black (MT4/5), and light (TradingView) themes.
 */
function estimateBackgroundColor(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { r: number; g: number; b: number; luma: number; theme: ChartTheme } {
  const rBins = new Uint16Array(16);
  const gBins = new Uint16Array(16);
  const bBins = new Uint16Array(16);
  const binSumR = new Uint32Array(16);
  const binSumG = new Uint32Array(16);
  const binSumB = new Uint32Array(16);

  // Sample central 65% where chart canvas typically dominates over sidebars
  for (let gy = 10; gy <= GRID_H - 12; gy += 2) {
    const py = Math.min(height - 1, Math.floor(((gy + 0.5) / GRID_H) * height));
    for (let gx = 14; gx <= GRID_W - 18; gx += 2) {
      const px = Math.min(width - 1, Math.floor(((gx + 0.5) / GRID_W) * width));
      const idx = (py * width + px) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const lumaBin = Math.min(15, Math.floor((0.299 * r + 0.587 * g + 0.114 * b) / 16));
      rBins[lumaBin]++;
      gBins[lumaBin]++;
      bBins[lumaBin]++;
      binSumR[lumaBin] += r;
      binSumG[lumaBin] += g;
      binSumB[lumaBin] += b;
    }
  }

  let bestBin = 0;
  let bestCount = 0;
  for (let i = 0; i < 16; i++) {
    if (rBins[i] > bestCount) {
      bestCount = rBins[i];
      bestBin = i;
    }
  }

  const count = Math.max(1, bestCount);
  const r = Math.round(binSumR[bestBin] / count);
  const g = Math.round(binSumG[bestBin] / count);
  const b = Math.round(binSumB[bestBin] / count);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;

  return {
    r,
    g,
    b,
    luma,
    theme: luma > 140 ? 'LIGHT' : 'DARK',
  };
}

function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
}

/**
 * Universal broker-agnostic local frame processor:
 * 1) Adapts automatically to dark, black (MT4/MT5), navy (Quotex/IQ/Pocket), and light (TradingView) charts.
 * 2) Recognizes colored candles (green/red, teal/coral, lime/white, blue/orange) AND monochrome/hollow candles
 *    by detecting thin vertical foreground strokes isolated from wide solid UI buttons.
 * 3) Extracts tight relative chartBounds while rejecting non-chart screens and static unchanged frames.
 */
export function processFrameLocally(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  previousSignature: Float32Array | null
): LocalFrameDigest {
  const signature = new Float32Array(GRID_W * GRID_H);
  const bg = estimateBackgroundColor(rgba, width, height);

  const lumaGrid = new Float32Array(GRID_W * GRID_H);
  const chromaCandleMask = new Uint8Array(GRID_W * GRID_H);
  const contrastMask = new Uint8Array(GRID_W * GRID_H);

  let diffAccumulator = 0;

  for (let gy = 0; gy < GRID_H; gy++) {
    const py = Math.min(height - 1, Math.floor(((gy + 0.5) / GRID_H) * height));
    for (let gx = 0; gx < GRID_W; gx++) {
      const px = Math.min(width - 1, Math.floor(((gx + 0.5) / GRID_W) * width));
      const idx = (py * width + px) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];

      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const sigIdx = gy * GRID_W + gx;
      signature[sigIdx] = luma;
      lumaGrid[sigIdx] = luma;

      if (previousSignature) {
        const regionWeight =
          gx >= GRID_W * 0.48 && gy >= GRID_H * 0.08 && gy <= GRID_H * 0.88 ? 1.8 : 0.7;
        diffAccumulator += Math.abs(luma - previousSignature[sigIdx]) * regionWeight;
      }

      if (gy >= 3 && gy <= GRID_H - 4 && gx >= 2 && gx <= GRID_W - 3) {
        const bgDiff = colorDist(r, g, b, bg.r, bg.g, bg.b);
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const saturation = maxC - minC;

        // Supports green/teal/lime/cyan bullish and red/coral/orange/magenta bearish palettes
        const isChromaCandle =
          bgDiff >= 48 &&
          saturation >= 32 &&
          ((g >= r + 14 && g >= b - 10) || // green / teal / lime
            (r >= g + 16 && r >= b + 6) || // red / coral / orange
            (b >= r + 24 && g >= r + 12)); // cyan / blue candles

        if (isChromaCandle) {
          chromaCandleMask[sigIdx] = 1;
        }
        if (bgDiff >= 75) {
          contrastMask[sigIdx] = 1;
        }
      }
    }
  }

  const diffScore = previousSignature ? diffAccumulator / (GRID_W * GRID_H) : 1;

  // Filter out wide solid UI buttons (e.g., Buy/Sell buttons on right/bottom panels)
  // A candlestick column has vertical continuity (>= 2 vertical pixels) and limited horizontal solid span (<= 4 cells)
  const candleHitsX = new Float32Array(GRID_W);
  const candleHitsY = new Float32Array(GRID_H);
  let totalCandleSamples = 0;

  for (let gy = 3; gy <= GRID_H - 4; gy++) {
    for (let gx = 2; gx <= GRID_W - 3; gx++) {
      const idx = gy * GRID_W + gx;
      const isChroma = chromaCandleMask[idx] === 1;
      const isContrast = contrastMask[idx] === 1;
      if (!isChroma && !isContrast) continue;

      // Measure contiguous horizontal run of similar mask to reject wide solid UI buttons/headers
      let horizRun = 1;
      for (let lx = gx - 1; lx >= Math.max(0, gx - 5); lx--) {
        if (contrastMask[gy * GRID_W + lx] || chromaCandleMask[gy * GRID_W + lx]) horizRun++;
        else break;
      }
      for (let rx = gx + 1; rx <= Math.min(GRID_W - 1, gx + 5); rx++) {
        if (contrastMask[gy * GRID_W + rx] || chromaCandleMask[gy * GRID_W + rx]) horizRun++;
        else break;
      }

      if (horizRun >= 6) {
        continue; // Likely a solid UI button, banner, or panel border — not a candle
      }

      // Check vertical stroke continuity (candle body or wick)
      const hasVertNeighbor =
        chromaCandleMask[(gy - 1) * GRID_W + gx] === 1 ||
        chromaCandleMask[(gy + 1) * GRID_W + gx] === 1 ||
        contrastMask[(gy - 1) * GRID_W + gx] === 1 ||
        contrastMask[(gy + 1) * GRID_W + gx] === 1;

      if (isChroma || (isContrast && hasVertNeighbor && horizRun <= 3)) {
        // Weight chroma candles higher than monochrome contrast strokes
        const weight = isChroma ? 1 : 0.65;
        totalCandleSamples += weight;
        candleHitsX[gx] += weight;
        candleHitsY[gy] += weight;
      }
    }
  }

  // Isolate the contiguous horizontal chart cluster (ignore isolated outlier icons on far left/right toolbars)
  let activeColumns = 0;
  const activeColIndices: number[] = [];
  for (let gx = 0; gx < GRID_W; gx++) {
    if (candleHitsX[gx] >= 1) {
      activeColumns++;
      activeColIndices.push(gx);
    }
  }

  const activeRowIndices: number[] = [];
  for (let gy = 0; gy < GRID_H; gy++) {
    if (candleHitsY[gy] >= 1) {
      activeRowIndices.push(gy);
    }
  }

  // Trim isolated extreme 5% toolbar outliers only if enough columns exist
  let minGx = GRID_W;
  let maxGx = -1;
  if (activeColIndices.length >= 6) {
    // Keep dense cluster: drop single isolated edge column if separated by >= 8 empty columns
    let startIdx = 0;
    let endIdx = activeColIndices.length - 1;
    if (activeColIndices[1] - activeColIndices[0] >= 8) startIdx = 1;
    if (activeColIndices[endIdx] - activeColIndices[endIdx - 1] >= 8) endIdx--;
    minGx = activeColIndices[startIdx];
    maxGx = activeColIndices[endIdx];
  } else if (activeColIndices.length > 0) {
    minGx = activeColIndices[0];
    maxGx = activeColIndices[activeColIndices.length - 1];
  }

  let minGy = GRID_H;
  let maxGy = -1;
  if (activeRowIndices.length >= 4) {
    let startIdx = 0;
    let endIdx = activeRowIndices.length - 1;
    if (activeRowIndices[1] - activeRowIndices[0] >= 7) startIdx = 1;
    if (activeRowIndices[endIdx] - activeRowIndices[endIdx - 1] >= 7) endIdx--;
    minGy = activeRowIndices[startIdx];
    maxGy = activeRowIndices[endIdx];
  } else if (activeRowIndices.length > 0) {
    minGy = activeRowIndices[0];
    maxGy = activeRowIndices[activeRowIndices.length - 1];
  }

  const candleDensityScore = totalCandleSamples / (GRID_W * GRID_H);
  const spanX = maxGx >= minGx ? (maxGx - minGx + 1) / GRID_W : 0;
  const spanY = maxGy >= minGy ? (maxGy - minGy + 1) / GRID_H : 0;

  // Genuine candlestick chart requires >= 5 distinct candle columns, vertical body span, and sufficient samples
  const chartDetected =
    totalCandleSamples >= 8 &&
    activeColumns >= 5 &&
    spanX >= 0.16 &&
    spanY >= 0.1;

  const padX = 0.03;
  const padY = 0.05;
  const left = Math.max(0, minGx / GRID_W - padX);
  const top = Math.max(0, minGy / GRID_H - padY);
  const right = Math.min(1, (maxGx + 1) / GRID_W + padX);
  const bottom = Math.min(1, (maxGy + 1) / GRID_H + padY);

  const chartBounds: ChartBounds | null = chartDetected
    ? {
        x: Number(left.toFixed(4)),
        y: Number(top.toFixed(4)),
        width: Number(Math.max(0.1, right - left).toFixed(4)),
        height: Number(Math.max(0.1, bottom - top).toFixed(4)),
      }
    : null;

  return {
    chartDetected,
    chartBounds,
    theme: bg.theme,
    candleDensityScore,
    diffScore,
    signature,
  };
}
