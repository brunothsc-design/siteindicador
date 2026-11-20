import type { ChartBounds, PriceLine } from '../types/signals.ts';

export type ChartTheme = 'DARK' | 'LIGHT';

export interface LocalFrameDiagnostics {
  width: number;
  height: number;
  bg: { r: number; g: number; b: number; luma: number };
  totalCandleSamples: number;
  activeColumns: number;
  activeRows: number;
  spanX: number;
  spanY: number;
  rejectedWideRuns: number;
  failureReason:
    | null
    | 'insufficient_candle_samples'
    | 'insufficient_active_columns'
    | 'insufficient_horizontal_span'
    | 'insufficient_vertical_span';
}

export interface LocalFrameDigest {
  chartDetected: boolean;
  chartBounds: ChartBounds | null;
  priceLine: PriceLine | null;
  theme: ChartTheme;
  candleDensityScore: number;
  diffScore: number;
  signature: Float32Array;
  diagnostics: LocalFrameDiagnostics;
}

const GRID_W = 240;
const GRID_H = 135;

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
        const cellStepPx = Math.max(2, Math.floor(width / GRID_W));
        const tapOffset1 = Math.max(1, Math.floor(cellStepPx / 3));
        const tapOffset2 = Math.max(2, Math.floor((cellStepPx * 2) / 3));
        const px2 = Math.min(width - 1, px + tapOffset1);
        const px3 = Math.min(width - 1, px + tapOffset2);
        const idx2 = (py * width + px2) * 4;
        const idx3 = (py * width + px3) * 4;

        const classifyGridTap = (tr: number, tg: number, tb: number): { chroma: boolean; contrast: boolean } => {
          const bgDiff = colorDist(tr, tg, tb, bg.r, bg.g, bg.b);
          const maxC = Math.max(tr, tg, tb);
          const minC = Math.min(tr, tg, tb);
          const saturation = maxC - minC;
          const chroma =
            bgDiff >= 30 &&
            saturation >= 18 &&
            ((tg >= tr + 10 && tg >= tb - 16) || // green / teal / lime
              (tr >= tg + 12 && tr >= tb - 4) || // red / coral / rose / orange
              (tb >= tr + 18 && tg >= tr + 8)); // cyan / blue candles
          return { chroma, contrast: bgDiff >= 75 };
        };

        const tap1 = classifyGridTap(r, g, b);
        const tap2 = tap1.chroma ? tap1 : classifyGridTap(rgba[idx2], rgba[idx2 + 1], rgba[idx2 + 2]);
        const tap3 =
          tap1.chroma || tap2.chroma
            ? tap2
            : classifyGridTap(rgba[idx3], rgba[idx3 + 1], rgba[idx3 + 2]);

        if (tap1.chroma || tap2.chroma || tap3.chroma) {
          chromaCandleMask[sigIdx] = 1;
        }
        if (tap1.contrast || tap2.contrast || tap3.contrast) {
          contrastMask[sigIdx] = 1;
        }
      }
    }
  }

  const diffScore = previousSignature ? diffAccumulator / (GRID_W * GRID_H) : 1;

  // Filter out wide solid UI buttons and horizontal right-axis price pills while keeping zoomed-in vertical M1 candles
  const candleHitsX = new Float32Array(GRID_W);
  const candleHitsY = new Float32Array(GRID_H);
  let totalCandleSamples = 0;
  let rejectedWideRuns = 0;

  for (let gy = 3; gy <= GRID_H - 4; gy++) {
    for (let gx = 2; gx <= GRID_W - 3; gx++) {
      const idx = gy * GRID_W + gx;
      const isChroma = chromaCandleMask[idx] === 1;
      const isContrast = contrastMask[idx] === 1;
      if (!isChroma && !isContrast) continue;

      let horizRun = 1;
      for (let lx = gx - 1; lx >= Math.max(0, gx - 16); lx--) {
        if (contrastMask[gy * GRID_W + lx] || chromaCandleMask[gy * GRID_W + lx]) horizRun++;
        else break;
      }
      for (let rx = gx + 1; rx <= Math.min(GRID_W - 1, gx + 16); rx++) {
        if (contrastMask[gy * GRID_W + rx] || chromaCandleMask[gy * GRID_W + rx]) horizRun++;
        else break;
      }

      let vertRun = 1;
      for (let uy = gy - 1; uy >= Math.max(0, gy - 16); uy--) {
        if (contrastMask[uy * GRID_W + gx] || chromaCandleMask[uy * GRID_W + gx]) vertRun++;
        else break;
      }
      for (let dy = gy + 1; dy <= Math.min(GRID_H - 1, gy + 16); dy++) {
        if (contrastMask[dy * GRID_W + gx] || chromaCandleMask[dy * GRID_W + gx]) vertRun++;
        else break;
      }

      if (horizRun >= 14 || (horizRun >= 7 && horizRun > vertRun * 1.8)) {
        rejectedWideRuns++;
        continue; // Wide UI button, right-axis price pill, or panel bar — not a candle
      }

      // Skip full-height 1-cell monochrome vertical grid lines / crosshairs so they don't expand bounds
      if (!isChroma && horizRun <= 1 && vertRun >= Math.round(GRID_H * 0.58)) {
        continue;
      }

      // Check vertical stroke continuity (candle body or wick, +-1 cells)
      const hasVertNeighbor =
        chromaCandleMask[(gy - 1) * GRID_W + gx] === 1 ||
        chromaCandleMask[(gy + 1) * GRID_W + gx] === 1 ||
        contrastMask[(gy - 1) * GRID_W + gx] === 1 ||
        contrastMask[(gy + 1) * GRID_W + gx] === 1;

      if (isChroma || (isContrast && hasVertNeighbor && horizRun <= 8)) {
        // Weight chroma candles higher than monochrome contrast strokes
        const weight = isChroma ? 1 : 0.65;
        totalCandleSamples += weight;
        candleHitsX[gx] += weight;
      }
    }
  }

  // Isolate the dominant contiguous horizontal candlestick cluster
  // (separates sidebars, toolbars, Order Books, and Watchlists separated by UI gutters/axes)
  const rawActiveCols: number[] = [];
  for (let gx = 0; gx < GRID_W; gx++) {
    if (candleHitsX[gx] >= 1) {
      rawActiveCols.push(gx);
    }
  }

  interface GridSegment {
    minIdx: number;
    maxIdx: number;
    count: number;
    hits: number;
  }

  let minGx = GRID_W;
  let maxGx = -1;
  if (rawActiveCols.length > 0) {
    const hSegments: GridSegment[] = [];
    let segMin = rawActiveCols[0];
    let segMax = rawActiveCols[0];
    let segCount = 1;
    let segHits = candleHitsX[rawActiveCols[0]];

    for (let i = 1; i < rawActiveCols.length; i++) {
      const gx = rawActiveCols[i];
      if (gx - rawActiveCols[i - 1] <= 14) {
        segMax = gx;
        segCount++;
        segHits += candleHitsX[gx];
      } else {
        hSegments.push({ minIdx: segMin, maxIdx: segMax, count: segCount, hits: segHits });
        segMin = gx;
        segMax = gx;
        segCount = 1;
        segHits = candleHitsX[gx];
      }
    }
    hSegments.push({ minIdx: segMin, maxIdx: segMax, count: segCount, hits: segHits });

    let bestHSeg = hSegments[0];
    let bestHScore = -1;
    for (const seg of hSegments) {
      const span = seg.maxIdx - seg.minIdx + 1;
      const viabilityBonus = seg.count >= 4 && span >= 16 ? 1.5 : 0.5;
      const score = seg.hits * Math.sqrt(Math.max(1, span)) * viabilityBonus;
      if (score > bestHScore) {
        bestHScore = score;
        bestHSeg = seg;
      }
    }
    minGx = bestHSeg.minIdx;
    maxGx = bestHSeg.maxIdx;
  }

  let activeColumns = 0;
  for (let gx = Math.max(0, minGx); gx <= Math.min(GRID_W - 1, maxGx); gx++) {
    if (candleHitsX[gx] >= 1) activeColumns++;
  }

  // Compute vertical hits strictly inside the isolated horizontal candlestick plot [minGx..maxGx]
  // so Order Books, Watchlists, and sidebars cannot inflate vertical bounds, and split off bottom RSI/MACD sub-panes.
  if (maxGx >= minGx) {
    for (let gy = 3; gy <= GRID_H - 4; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        const idx = gy * GRID_W + gx;
        const isChroma = chromaCandleMask[idx] === 1;
        const isContrast = contrastMask[idx] === 1;
        if (!isChroma && !isContrast) continue;

        let horizRun = 1;
        for (let lx = gx - 1; lx >= Math.max(0, gx - 16); lx--) {
          if (contrastMask[gy * GRID_W + lx] || chromaCandleMask[gy * GRID_W + lx]) horizRun++;
          else break;
        }
        for (let rx = gx + 1; rx <= Math.min(GRID_W - 1, gx + 16); rx++) {
          if (contrastMask[gy * GRID_W + rx] || chromaCandleMask[gy * GRID_W + rx]) horizRun++;
          else break;
        }
        let vertRun = 1;
        for (let uy = gy - 1; uy >= Math.max(0, gy - 16); uy--) {
          if (contrastMask[uy * GRID_W + gx] || chromaCandleMask[uy * GRID_W + gx]) vertRun++;
          else break;
        }
        for (let dy = gy + 1; dy <= Math.min(GRID_H - 1, gy + 16); dy++) {
          if (contrastMask[dy * GRID_W + gx] || chromaCandleMask[dy * GRID_W + gx]) vertRun++;
          else break;
        }
        if (horizRun >= 14 || (horizRun >= 7 && horizRun > vertRun * 1.8)) continue;
        if (!isChroma && horizRun <= 1 && vertRun >= Math.round(GRID_H * 0.58)) continue;

        const hasVertNeighbor =
          chromaCandleMask[(gy - 1) * GRID_W + gx] === 1 ||
          chromaCandleMask[(gy + 1) * GRID_W + gx] === 1 ||
          contrastMask[(gy - 1) * GRID_W + gx] === 1 ||
          contrastMask[(gy + 1) * GRID_W + gx] === 1;
        if (isChroma || (isContrast && hasVertNeighbor && horizRun <= 8)) {
          candleHitsY[gy] += isChroma ? 1 : 0.65;
        }
      }
    }
  }

  const activeRowIndices: number[] = [];
  for (let gy = 0; gy < GRID_H; gy++) {
    if (candleHitsY[gy] >= 1) {
      activeRowIndices.push(gy);
    }
  }

  let minGy = GRID_H;
  let maxGy = -1;
  if (activeRowIndices.length > 0) {
    const vSegments: GridSegment[] = [];
    let segMin = activeRowIndices[0];
    let segMax = activeRowIndices[0];
    let segCount = 1;
    let segHits = candleHitsY[activeRowIndices[0]];

    for (let i = 1; i < activeRowIndices.length; i++) {
      const gy = activeRowIndices[i];
      if (gy - activeRowIndices[i - 1] <= 15) {
        segMax = gy;
        segCount++;
        segHits += candleHitsY[gy];
      } else {
        vSegments.push({ minIdx: segMin, maxIdx: segMax, count: segCount, hits: segHits });
        segMin = gy;
        segMax = gy;
        segCount = 1;
        segHits = candleHitsY[gy];
      }
    }
    vSegments.push({ minIdx: segMin, maxIdx: segMax, count: segCount, hits: segHits });

    let maxBandHits = 0;
    for (const seg of vSegments) {
      if (seg.hits > maxBandHits) maxBandHits = seg.hits;
    }

    const hasUpperChart = vSegments.some(
      (seg) =>
        seg.minIdx < Math.round(GRID_H * 0.72) &&
        seg.maxIdx - seg.minIdx + 1 >= 6 &&
        seg.hits >= Math.max(8, maxBandHits * 0.22)
    );

    const keptVSegments = vSegments.filter((seg, idx) => {
      const spanRows = seg.maxIdx - seg.minIdx + 1;
      const isBottomSubPane = hasUpperChart && idx === vSegments.length - 1 && seg.minIdx >= Math.round(GRID_H * 0.72);
      const isTinyTopUi = vSegments.length > 1 && idx === 0 && seg.maxIdx <= 12 && spanRows <= 5 && seg.hits < maxBandHits * 0.15;
      return !isBottomSubPane && !isTinyTopUi;
    });

    const finalVSegments = keptVSegments.length > 0 ? keptVSegments : vSegments;
    minGy = finalVSegments[0].minIdx;
    maxGy = finalVSegments[finalVSegments.length - 1].maxIdx;
  }

  // Recount totalCandleSamples inside isolated chart bounds so non-chart UI counts accurately
  totalCandleSamples = 0;
  if (maxGx >= minGx && maxGy >= minGy) {
    for (let gx = minGx; gx <= maxGx; gx++) {
      totalCandleSamples += candleHitsX[gx];
    }
  }

  const candleDensityScore = totalCandleSamples / (GRID_W * GRID_H);
  const spanX = maxGx >= minGx ? (maxGx - minGx + 1) / GRID_W : 0;
  const spanY = maxGy >= minGy ? (maxGy - minGy + 1) / GRID_H : 0;

  let failureReason: LocalFrameDiagnostics['failureReason'] = null;
  if (totalCandleSamples < 9) failureReason = 'insufficient_candle_samples';
  else if (activeColumns < 4) failureReason = 'insufficient_active_columns';
  else if (spanX < 0.10) failureReason = 'insufficient_horizontal_span';
  else if (spanY < 0.04) failureReason = 'insufficient_vertical_span';

  // Genuine candlestick chart requires >= 4 distinct candle columns and vertical body span (including tight M1 ranges)
  const chartDetected = failureReason === null;

  const padXLeft = 0.03;
  const padXRight = 0.03;
  const padY = 0.05;
  const left = Math.max(0, minGx / GRID_W - padXLeft);
  const top = Math.max(0, minGy / GRID_H - padY);
  let rightCandleNormX = (maxGx + 1) / GRID_W;

  // Fine pixel-level rightward check so newly opened 2px forming M1 candles between GRID_H rows are not clipped out of chartBounds
  if (chartDetected) {
    const scanStartX = Math.max(0, Math.floor(rightCandleNormX * width));
    const scanEndX = Math.min(width - 3, Math.ceil((rightCandleNormX + 0.065) * width));
    const scanTopY = Math.max(2, Math.floor(top * height));
    const scanBotY = Math.min(height - 3, Math.ceil((Math.min(1, (maxGy + 1) / GRID_H + padY)) * height));
    const maxBtnSpan = Math.max(18, Math.round(width * 0.032));

    for (let px = scanStartX; px <= scanEndX; px++) {
      let colColoredHits = 0;
      let segStartPy = -1;
      const segMidRows: number[] = [];

      for (let py = scanTopY; py <= scanBotY; py++) {
        const idx = (py * width + px) * 4;
        const k = classifyCandlePixel(rgba[idx], rgba[idx + 1], rgba[idx + 2], bg);
        if (k === 'BULL' || k === 'BEAR') {
          colColoredHits++;
          if (segStartPy < 0) segStartPy = py;
        } else if (segStartPy >= 0) {
          if (py - segStartPy >= 2) {
            segMidRows.push(Math.floor((segStartPy + py - 1) / 2));
          }
          segStartPy = -1;
        }
      }
      if (segStartPy >= 0 && scanBotY - segStartPy + 1 >= 2) {
        segMidRows.push(Math.floor((segStartPy + scanBotY) / 2));
      }

      if (colColoredHits >= 2 && segMidRows.length > 0) {
        let maxHSpan = 0;
        for (let s = 0; s < segMidRows.length; s++) {
          const midPy = segMidRows[s];
          let hSpan = 1;
          for (let lx = px - 1; lx >= Math.max(0, px - maxBtnSpan); lx--) {
            const lIdx = (midPy * width + lx) * 4;
            if (classifyCandlePixel(rgba[lIdx], rgba[lIdx + 1], rgba[lIdx + 2], bg) !== null) hSpan++;
            else break;
          }
          for (let rx = px + 1; rx <= Math.min(width - 1, px + maxBtnSpan); rx++) {
            const rIdx = (midPy * width + rx) * 4;
            if (classifyCandlePixel(rgba[rIdx], rgba[rIdx + 1], rgba[rIdx + 2], bg) !== null) hSpan++;
            else break;
          }
          if (hSpan > maxHSpan) maxHSpan = hSpan;
          if (maxHSpan >= maxBtnSpan) break;
        }
        if (maxHSpan < maxBtnSpan) {
          let isDashedLine = false;
          if (colColoredHits <= 3 && segMidRows.length === 1) {
            const dashPy = segMidRows[0];
            let gapSeen = false;
            for (let dx = 2; dx <= 16 && px + dx < width; dx++) {
              const dIdx = (dashPy * width + px + dx) * 4;
              const dk = classifyCandlePixel(rgba[dIdx], rgba[dIdx + 1], rgba[dIdx + 2], bg);
              if (dk === null) {
                gapSeen = true;
              } else if (gapSeen) {
                isDashedLine = true;
                break;
              }
            }
          }
          if (!isDashedLine) {
            rightCandleNormX = Math.max(rightCandleNormX, (px + 1) / width);
          }
        }
      }
    }
  }

  const right = Math.min(1, rightCandleNormX + padXRight);
  const bottom = Math.min(1, (maxGy + 1) / GRID_H + padY);

  const chartBounds: ChartBounds | null = chartDetected
    ? {
        x: Number(left.toFixed(4)),
        y: Number(top.toFixed(4)),
        width: Number(Math.max(0.1, right - left).toFixed(4)),
        height: Number(Math.max(0.1, bottom - top).toFixed(4)),
      }
    : null;

  const priceLine =
    chartDetected && chartBounds
      ? detectChartPriceLine(rgba, width, height, bg, chartBounds)
      : null;

  return {
    chartDetected,
    chartBounds,
    priceLine,
    theme: bg.theme,
    candleDensityScore,
    diffScore,
    signature,
    diagnostics: {
      width,
      height,
      bg: { r: bg.r, g: bg.g, b: bg.b, luma: Math.round(bg.luma) },
      totalCandleSamples: Number(totalCandleSamples.toFixed(1)),
      activeColumns,
      activeRows: activeRowIndices.length,
      spanX: Number(spanX.toFixed(4)),
      spanY: Number(spanY.toFixed(4)),
      rejectedWideRuns,
      failureReason,
    },
  };
}

interface RightmostCandleInfo {
  xPx: number;
  topPy: number;
  bottomPy: number;
  closePy: number | null;
  confidence: number;
}

function classifyCandlePixel(
  r: number,
  g: number,
  b: number,
  bg: { r: number; g: number; b: number }
): 'BULL' | 'BEAR' | 'MONO' | null {
  const bgDiff = colorDist(r, g, b, bg.r, bg.g, bg.b);
  if (bgDiff < 30) return null;

  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const saturation = maxC - minC;

  if (saturation >= 18) {
    if ((g >= r + 10 && g >= b - 16) || (b >= r + 18 && g >= r + 8)) {
      return 'BULL';
    }
    if (r >= g + 12 && r >= b - 4) {
      return 'BEAR';
    }
  }

  if (bgDiff >= 75) {
    return 'MONO';
  }

  return null;
}

function findRightmostCandle(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bg: { r: number; g: number; b: number },
  bx0: number,
  bx1: number,
  by0: number,
  by1: number
): RightmostCandleInfo | null {
  const plotW = bx1 - bx0 + 1;
  const maxCandleSpan = Math.max(28, Math.round(plotW * 0.075));

  interface ColStats {
    px: number;
    minPy: number;
    maxPy: number;
    bull: number;
    bear: number;
    mono: number;
    bestRun: number;
    segmentCount: number;
    activeRows: number[];
  }

  interface VertSeg {
    startPy: number;
    endPy: number;
    bull: number;
    bear: number;
    mono: number;
  }

  const validCols: ColStats[] = [];
  const tinyColoredCols: ColStats[] = [];

  // Always scan colStep=1 so thin 1-2px M1 candles and wicks are never skipped
  for (let px = bx0 + 2; px <= bx1 - 2; px++) {
    let run = 0;
    let runStartPy = -1;
    const rawSegs: VertSeg[] = [];
    const tinySegs: VertSeg[] = [];

    const commitRun = (startPy: number, endPy: number) => {
      const len = endPy - startPy + 1;
      if (len < 2) return;

      let segBull = 0;
      let segBear = 0;
      let segMono = 0;
      for (let r = startPy; r <= endPy; r++) {
        const rIdx = (r * width + px) * 4;
        const k = classifyCandlePixel(rgba[rIdx], rgba[rIdx + 1], rgba[rIdx + 2], bg);
        if (k === 'BULL') segBull++;
        else if (k === 'BEAR') segBear++;
        else if (k === 'MONO') segMono++;
      }

      if (len >= 3) {
        rawSegs.push({ startPy, endPy, bull: segBull, bear: segBear, mono: segMono });
      } else if (len === 2 && (segBull >= 2 || segBear >= 2)) {
        tinySegs.push({ startPy, endPy, bull: segBull, bear: segBear, mono: 0 });
      }
    };

    for (let py = by0 + 2; py <= by1 - 2; py++) {
      const idx = (py * width + px) * 4;
      const kind = classifyCandlePixel(rgba[idx], rgba[idx + 1], rgba[idx + 2], bg);
      if (kind !== null) {
        if (run === 0) runStartPy = py;
        run++;
      } else if (run > 0) {
        commitRun(runStartPy, py - 1);
        run = 0;
      }
    }
    if (run > 0) {
      commitRun(runStartPy, by1 - 2);
    }

    // Separate candlestick body from disconnected lower volume histogram bar when a large vertical gap exists
    let segs = rawSegs;
    const plotH = by1 - by0 + 1;
    const volGapPx = Math.max(24, Math.round(plotH * 0.16));
    if (rawSegs.length >= 2) {
      for (let i = 1; i < rawSegs.length; i++) {
        if (
          rawSegs[i].startPy - rawSegs[i - 1].endPy >= volGapPx &&
          rawSegs[i].endPy >= by0 + plotH * 0.72 &&
          rawSegs[i - 1].endPy < by0 + plotH * 0.72
        ) {
          segs = rawSegs.slice(0, i);
          break;
        }
      }
    }

    let bestRun = 0;
    let bull = 0;
    let bear = 0;
    let mono = 0;
    let minPy = height;
    let maxPy = -1;
    const activeRows: number[] = [];
    for (const seg of segs) {
      const len = seg.endPy - seg.startPy + 1;
      if (len > bestRun) bestRun = len;
      if (seg.startPy < minPy) minPy = seg.startPy;
      if (seg.endPy > maxPy) maxPy = seg.endPy;
      bull += seg.bull;
      bear += seg.bear;
      mono += seg.mono;
      for (let r = seg.startPy; r <= seg.endPy; r++) {
        activeRows.push(r);
      }
    }

    if (bestRun >= 3 && activeRows.length >= 3) {
      validCols.push({
        px,
        minPy,
        maxPy,
        bull,
        bear,
        mono,
        bestRun,
        segmentCount: segs.length,
        activeRows,
      });
    } else if (tinySegs.length > 0) {
      let tinyBull = 0;
      let tinyBear = 0;
      let tinyMinPy = height;
      let tinyMaxPy = -1;
      const tinyRows: number[] = [];
      for (const seg of tinySegs) {
        tinyBull += seg.bull;
        tinyBear += seg.bear;
        if (seg.startPy < tinyMinPy) tinyMinPy = seg.startPy;
        if (seg.endPy > tinyMaxPy) tinyMaxPy = seg.endPy;
        for (let r = seg.startPy; r <= seg.endPy; r++) {
          tinyRows.push(r);
        }
      }
      if (tinyRows.length >= 2) {
        tinyColoredCols.push({
          px,
          minPy: tinyMinPy,
          maxPy: tinyMaxPy,
          bull: tinyBull,
          bear: tinyBear,
          mono: 0,
          bestRun: 2,
          segmentCount: tinySegs.length,
          activeRows: tinyRows,
        });
      }
    }
  }

  // Group localized tiny 2px colored clusters (e.g. newly opened M1 candle) ONLY when span <= 16px
  // so 2px horizontal price lines never merge into or spoof candles
  if (tinyColoredCols.length > 0) {
    let lastColoredValidPx = -1;
    for (let i = validCols.length - 1; i >= 0; i--) {
      if (validCols[i].bull + validCols[i].bear >= 2) {
        lastColoredValidPx = validCols[i].px;
        break;
      }
    }
    let tCluster: ColStats[] = [tinyColoredCols[0]];
    const flushTiny = () => {
      const span = tCluster[tCluster.length - 1].px - tCluster[0].px + 1;
      if (tCluster.length >= 2 && span <= 16 && tCluster[0].px > lastColoredValidPx) {
        validCols.push(...tCluster);
      }
    };
    for (let i = 1; i < tinyColoredCols.length; i++) {
      if (
        tinyColoredCols[i].px - tinyColoredCols[i - 1].px <= 2 &&
        Math.abs(tinyColoredCols[i].minPy - tinyColoredCols[i - 1].minPy) <= 1
      ) {
        tCluster.push(tinyColoredCols[i]);
      } else {
        flushTiny();
        tCluster = [tinyColoredCols[i]];
      }
    }
    flushTiny();
    validCols.sort((a, b) => a.px - b.px);
  }

  if (validCols.length === 0) return null;

  // Group into contiguous horizontal candle clusters, splitting mega-clusters bridged by 3px horizontal indicator/price lines
  const rawClusters: ColStats[][] = [];
  let current: ColStats[] = [validCols[0]];
  for (let i = 1; i < validCols.length; i++) {
    if (validCols[i].px - validCols[i - 1].px <= 3) {
      current.push(validCols[i]);
    } else {
      rawClusters.push(current);
      current = [validCols[i]];
    }
  }
  rawClusters.push(current);

  const clusters: ColStats[][] = [];
  for (const rc of rawClusters) {
    const spanPx = rc[rc.length - 1].px - rc[0].px + 1;
    if (spanPx <= maxCandleSpan) {
      clusters.push(rc);
    } else {
      const strongCols = rc.filter((col) => col.bestRun >= 5 || (col.maxPy - col.minPy + 1 >= 6 && col.activeRows.length >= 5));
      if (strongCols.length > 0) {
        let sub: ColStats[] = [strongCols[0]];
        for (let i = 1; i < strongCols.length; i++) {
          if (strongCols[i].px - strongCols[i - 1].px <= 3) {
            sub.push(strongCols[i]);
          } else {
            clusters.push(sub);
            sub = [strongCols[i]];
          }
        }
        clusters.push(sub);
      }
    }
  }

  // Filter out wide solid UI bars, horizontal-only price line streaks, flat right-axis pills, and stacked orderbook rows
  const candleClusters = clusters.filter((c) => {
    const spanPx = c[c.length - 1].px - c[0].px + 1;
    const totalPixels = c.reduce((acc, col) => acc + col.activeRows.length, 0);
    if (spanPx > maxCandleSpan || totalPixels < 3) return false;

    let minTop = height;
    let maxTop = -1;
    let minBot = height;
    let maxBot = -1;
    let fillSum = 0;
    let heightSum = 0;
    let segSum = 0;
    let bestRunMax = 0;
    for (const col of c) {
      if (col.minPy < minTop) minTop = col.minPy;
      if (col.minPy > maxTop) maxTop = col.minPy;
      if (col.maxPy < minBot) minBot = col.maxPy;
      if (col.maxPy > maxBot) maxBot = col.maxPy;
      const h = col.maxPy - col.minPy + 1;
      heightSum += h;
      fillSum += col.activeRows.length / Math.max(1, h);
      segSum += col.segmentCount;
      if (col.bestRun > bestRunMax) bestRunMax = col.bestRun;
    }
    const avgHeight = heightSum / c.length;
    const clusterVertSpan = maxBot - minTop + 1;

    // Exclude stacked vertically-separated UI lists (Order Books, Watchlists, depth ladders)
    if (segSum / c.length >= 3.5 && clusterVertSpan >= 40 && bestRunMax < clusterVertSpan * 0.35) {
      return false;
    }

    // Exclude wide 2px horizontal line streaks mistaken for candles
    if (spanPx >= 18 && avgHeight <= 2.2) {
      return false;
    }

    // Exclude horizontal or boundary-clipped right-axis UI price pills while keeping genuine interior wickless M1 candles
    const touchesRightBoundary = c[c.length - 1].px >= bx1 - 6;
    if (
      spanPx >= 8 &&
      c.length >= 4 &&
      avgHeight >= 5 &&
      avgHeight <= 24 &&
      (touchesRightBoundary || spanPx >= avgHeight * 2.1)
    ) {
      const flatTopBottom = maxTop - minTop <= 1 && maxBot - minBot <= 1;
      const solidFill = fillSum / c.length >= 0.88;
      if (flatTopBottom && solidFill) {
        return false;
      }
    }

    return true;
  });

  if (candleClusters.length === 0) return null;

  const hasColoredEarlier = candleClusters.some((c) => c.some((col) => col.bull + col.bear >= 2));
  let rightmost = candleClusters[candleClusters.length - 1];
  if (hasColoredEarlier) {
    for (let i = candleClusters.length - 1; i >= 0; i--) {
      const candidate = candleClusters[i];
      let cBull = 0;
      let cBear = 0;
      let cMono = 0;
      let cPixels = 0;
      let cMinPy = height;
      let cMaxPy = -1;
      for (const col of candidate) {
        cBull += col.bull;
        cBear += col.bear;
        cMono += col.mono;
        cPixels += col.activeRows.length;
        if (col.minPy < cMinPy) cMinPy = col.minPy;
        if (col.maxPy > cMaxPy) cMaxPy = col.maxPy;
      }
      if (cBull + cBear >= 2) {
        rightmost = candidate;
        break;
      }
      const cSpanPx = candidate[candidate.length - 1].px - candidate[0].px + 1;
      const cVertSpan = cMaxPy - cMinPy + 1;
      const cFillDensity = cPixels / Math.max(1, cSpanPx * cVertSpan);
      // Preserve tall solid monochrome rightmost candle (genuine ambiguous candle) while skipping countdown/icon UI artifacts
      if (cMono > 0 && cSpanPx >= 5 && cVertSpan >= 24 && cFillDensity >= 0.72) {
        rightmost = candidate;
        break;
      }
    }
  }
  let topPy = height;
  let bottomPy = -1;
  let bullTotal = 0;
  let bearTotal = 0;
  let monoTotal = 0;
  const rowCounts = new Map<number, number>();

  for (const col of rightmost) {
    if (col.minPy < topPy) topPy = col.minPy;
    if (col.maxPy > bottomPy) bottomPy = col.maxPy;
    bullTotal += col.bull;
    bearTotal += col.bear;
    monoTotal += col.mono;
    for (const r of col.activeRows) {
      rowCounts.set(r, (rowCounts.get(r) ?? 0) + 1);
    }
  }

  // Isolate candle body (rows thicker than a 1-column wick when multi-column body exists)
  const bodyThreshold = rightmost.length >= 3 ? Math.max(2, Math.ceil(rightmost.length * 0.5)) : 1;
  let bodyTop = height;
  let bodyBottom = -1;
  for (const [rowPy, count] of rowCounts.entries()) {
    if (count >= bodyThreshold) {
      if (rowPy < bodyTop) bodyTop = rowPy;
      if (rowPy > bodyBottom) bodyBottom = rowPy;
    }
  }
  if (bodyBottom < bodyTop) {
    bodyTop = topPy;
    bodyBottom = bottomPy;
  }

  const xPx = rightmost[rightmost.length - 1].px;
  let closePy: number | null = null;
  let confidence = 0;

  if (bullTotal >= 4 && bullTotal > bearTotal * 1.4) {
    closePy = bodyTop;
    confidence = 0.78;
  } else if (bearTotal >= 4 && bearTotal > bullTotal * 1.4) {
    closePy = bodyBottom;
    confidence = 0.78;
  } else if (monoTotal >= 5 && bodyBottom - bodyTop <= 4) {
    closePy = Math.round((bodyTop + bodyBottom) / 2);
    confidence = 0.72;
  }

  return {
    xPx,
    topPy,
    bottomPy,
    closePy,
    confidence,
  };
}

function hasRightAxisPricePill(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bg: { r: number; g: number; b: number },
  searchStartX: number,
  searchEndX: number,
  centerPy: number
): boolean {
  const x0 = Math.max(0, searchStartX);
  const x1 = Math.min(width - 1, searchEndX);
  if (x1 - x0 < 12) return false;

  // Locate horizontal contiguous solid pill segment at centerPy (height 5..20px, width >= 14px)
  let bestRun = 0;
  let run = 0;
  let runStart = x0;
  let bestStart = -1;
  let bestEnd = -1;

  for (let px = x0; px <= x1; px++) {
    const idx = (centerPy * width + px) * 4;
    const bgDiff = colorDist(rgba[idx], rgba[idx + 1], rgba[idx + 2], bg.r, bg.g, bg.b);
    if (bgDiff >= 50) {
      if (run === 0) runStart = px;
      run++;
      if (run > bestRun) {
        bestRun = run;
        bestStart = runStart;
        bestEnd = px;
      }
    } else {
      run = 0;
    }
  }

  if (bestRun < 14 || bestStart < 0) return false;

  // Verify the pill has solid thickness (>= 4 rows) around centerPy AND is bounded vertically (not a full sidebar)
  let thickRows = 0;
  for (let py = Math.max(0, centerPy - 9); py <= Math.min(height - 1, centerPy + 9); py++) {
    let hits = 0;
    let total = 0;
    for (let px = bestStart; px <= bestEnd; px += 2) {
      const idx = (py * width + px) * 4;
      if (colorDist(rgba[idx], rgba[idx + 1], rgba[idx + 2], bg.r, bg.g, bg.b) >= 42) hits++;
      total++;
    }
    if (total > 0 && hits / total >= 0.7) {
      thickRows++;
    }
  }

  let aboveHits = 0;
  let belowHits = 0;
  let samples = 0;
  const checkAbove = Math.max(0, centerPy - 15);
  const checkBelow = Math.min(height - 1, centerPy + 15);
  for (let px = bestStart; px <= bestEnd; px += 2) {
    const idxA = (checkAbove * width + px) * 4;
    const idxB = (checkBelow * width + px) * 4;
    if (colorDist(rgba[idxA], rgba[idxA + 1], rgba[idxA + 2], bg.r, bg.g, bg.b) >= 42) aboveHits++;
    if (colorDist(rgba[idxB], rgba[idxB + 1], rgba[idxB + 2], bg.r, bg.g, bg.b) >= 42) belowHits++;
    samples++;
  }

  const boundedVertically =
    samples > 0 && aboveHits / samples < 0.35 && belowHits / samples < 0.35;

  return thickRows >= 4 && thickRows <= 18 && boundedVertically;
}

/**
 * Identifies the live horizontal price position inside a verified chart region.
 * Never fabricates a price: returns null when neither a genuine live price line
 * nor an unambiguous colored rightmost candle close can be verified.
 */
export function detectChartPriceLine(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bg: { r: number; g: number; b: number },
  chartBounds: ChartBounds
): PriceLine | null {
  const bx0 = Math.max(0, Math.floor(chartBounds.x * width));
  const bx1 = Math.min(width - 1, Math.ceil((chartBounds.x + chartBounds.width) * width));
  const by0 = Math.max(0, Math.floor(chartBounds.y * height));
  const by1 = Math.min(height - 1, Math.ceil((chartBounds.y + chartBounds.height) * height));

  const plotW = bx1 - bx0 + 1;
  const plotH = by1 - by0 + 1;
  if (plotW < 40 || plotH < 30) return null;

  const rightmost = findRightmostCandle(rgba, width, height, bg, bx0, bx1, by0, by1);

  const rightSpanStart = rightmost
    ? Math.max(bx0 + 4, Math.min(bx1 - 8, rightmost.xPx))
    : Math.max(bx0 + 4, Math.round(bx0 + plotW * 0.58));
  const rightSpanEnd = Math.min(
    width - 4,
    Math.max(bx1 - 2, rightSpanStart + Math.round(width * 0.16))
  );
  const rightSpanCols = Math.max(1, rightSpanEnd - rightSpanStart + 1);
  const fullStep = plotW > 480 ? 3 : 2;
  const fullSpanCols = Math.max(1, Math.floor((bx1 - 2 - (bx0 + 4)) / fullStep) + 1);

  interface RowCandidate {
    py: number;
    rightCoverage: number;
    fullCoverage: number;
    avgR: number;
    avgG: number;
    avgB: number;
    saturation: number;
    avgBgDiff: number;
    hasAxisPill: boolean;
  }

  const rawRows: RowCandidate[] = [];

  for (let py = by0 + 3; py <= by1 - 3; py++) {
    let rightHits = 0;
    let isolatedRightHits = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumBgDiff = 0;

    for (let px = rightSpanStart; px <= rightSpanEnd; px++) {
      const idx = (py * width + px) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const diff = colorDist(r, g, b, bg.r, bg.g, bg.b);

      if (diff >= 28) {
        rightHits++;
        sumR += r;
        sumG += g;
        sumB += b;
        sumBgDiff += diff;

        // Check vertical thinness (rows +-3 must be close to background so solid bars/headers are rejected)
        const idxUp = ((py - 3) * width + px) * 4;
        const idxDn = ((py + 3) * width + px) * 4;
        const dUp = colorDist(rgba[idxUp], rgba[idxUp + 1], rgba[idxUp + 2], bg.r, bg.g, bg.b);
        const dDn = colorDist(rgba[idxDn], rgba[idxDn + 1], rgba[idxDn + 2], bg.r, bg.g, bg.b);
        if (dUp < 32 && dDn < 32) {
          isolatedRightHits++;
        }
      }
    }

    const rightCoverage = rightHits / rightSpanCols;
    const isolatedCoverage = isolatedRightHits / rightSpanCols;

    // Supports both solid price lines (>=0.45) and dashed/dotted broker lines (>=0.28 coverage)
    if (rightCoverage >= 0.28 && isolatedCoverage >= 0.20 && rightHits >= 6) {
      let fullHits = 0;
      for (let px = bx0 + 4; px <= bx1 - 2; px += fullStep) {
        const idx = (py * width + px) * 4;
        if (colorDist(rgba[idx], rgba[idx + 1], rgba[idx + 2], bg.r, bg.g, bg.b) >= 28) {
          fullHits++;
        }
      }
      const avgR = Math.round(sumR / rightHits);
      const avgG = Math.round(sumG / rightHits);
      const avgB = Math.round(sumB / rightHits);
      const maxC = Math.max(avgR, avgG, avgB);
      const minC = Math.min(avgR, avgG, avgB);

      rawRows.push({
        py,
        rightCoverage,
        fullCoverage: fullHits / fullSpanCols,
        avgR,
        avgG,
        avgB,
        saturation: maxC - minC,
        avgBgDiff: sumBgDiff / rightHits,
        hasAxisPill: false,
      });
    }
  }

  // Merge adjacent rows (1-3px thick horizontal lines) into bands
  const bands: RowCandidate[] = [];
  for (const row of rawRows) {
    const prev = bands[bands.length - 1];
    if (prev && row.py - prev.py <= 3) {
      if (row.rightCoverage > prev.rightCoverage) {
        bands[bands.length - 1] = row;
      }
    } else {
      bands.push(row);
    }
  }

  // Filter out repeating background horizontal grid lines:
  // Any color family appearing in >= 3 vertically separated bands across the full width is a grid.
  const filteredBands = bands.filter((band, idx) => {
    let similarCount = 0;
    for (let j = 0; j < bands.length; j++) {
      if (j === idx) {
        similarCount++;
        continue;
      }
      const other = bands[j];
      const sameTone = colorDist(band.avgR, band.avgG, band.avgB, other.avgR, other.avgG, other.avgB) <= 48;
      if (sameTone && other.fullCoverage >= 0.45 && band.fullCoverage >= 0.45) {
        similarCount++;
      }
    }
    // Reject repeating low-saturation grid lines
    if (similarCount >= 3 && band.saturation < 55) {
      return false;
    }
    return true;
  });

  // Score remaining horizontal line candidates
  const pillSearchStart = rightmost ? rightmost.xPx + 8 : Math.round(bx0 + plotW * 0.5);
  const pillSearchEnd = Math.min(width - 1, Math.max(bx1, rightSpanEnd) + Math.round(width * 0.08));

  let bestLine: { py: number; confidence: number } | null = null;
  for (const band of filteredBands) {
    band.hasAxisPill = hasRightAxisPricePill(
      rgba,
      width,
      height,
      bg,
      pillSearchStart,
      pillSearchEnd,
      band.py
    );

    const nearCandle =
      rightmost !== null &&
      band.py >= rightmost.topPy - 16 &&
      band.py <= rightmost.bottomPy + 16;

    let score = 0;
    if (band.rightCoverage >= 0.55) score += 0.35;
    else if (band.rightCoverage >= 0.40) score += 0.28;
    else if (band.rightCoverage >= 0.28) score += 0.22;

    if (band.hasAxisPill) score += 0.38;
    if (nearCandle) score += 0.28;
    if (band.saturation >= 40 || (band.avgBgDiff >= 105 && (band.saturation >= 20 || band.hasAxisPill))) {
      score += 0.16;
    }
    if (band.fullCoverage >= 0.65 && filteredBands.length === 1) score += 0.08;

    // Require either axis pill confirmation OR alignment with rightmost candle + clear line
    const verifiedAnchor = band.hasAxisPill || nearCandle;
    if (verifiedAnchor && score >= 0.68) {
      const clamped = Math.min(0.98, Number(score.toFixed(2)));
      if (!bestLine || clamped > bestLine.confidence) {
        bestLine = { py: band.py, confidence: clamped };
      }
    }
  }

  let finalPy: number | null = null;
  let source: 'PRICE_LINE' | 'CANDLE_CLOSE' = 'PRICE_LINE';
  let confidence = 0;

  if (bestLine) {
    finalPy = bestLine.py;
    source = 'PRICE_LINE';
    confidence = bestLine.confidence;
  } else if (rightmost && rightmost.closePy !== null && rightmost.confidence >= 0.72) {
    finalPy = rightmost.closePy;
    source = 'CANDLE_CLOSE';
    confidence = rightmost.confidence;
  }

  if (finalPy === null) {
    return null;
  }

  const normY = Math.max(0.02, Math.min(0.98, finalPy / height));
  const relY = Math.max(
    0.02,
    Math.min(0.98, (normY - chartBounds.y) / Math.max(0.05, chartBounds.height))
  );

  return {
    y: Number(normY.toFixed(4)),
    chartRelativeY: Number(relY.toFixed(4)),
    chartBounds,
    confidence,
    source,
    updatedAt: Date.now(),
  };
}
