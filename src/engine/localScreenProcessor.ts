import type { ChartBounds, PriceLine } from '../types/signals.ts';

export type ChartTheme = 'DARK' | 'LIGHT';

export interface LocalFrameDigest {
  chartDetected: boolean;
  chartBounds: ChartBounds | null;
  priceLine: PriceLine | null;
  theme: ChartTheme;
  candleDensityScore: number;
  diffScore: number;
  signature: Float32Array;
}

const GRID_W = 192;
const GRID_H = 108;

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
      for (let lx = gx - 1; lx >= Math.max(0, gx - 10); lx--) {
        if (contrastMask[gy * GRID_W + lx] || chromaCandleMask[gy * GRID_W + lx]) horizRun++;
        else break;
      }
      for (let rx = gx + 1; rx <= Math.min(GRID_W - 1, gx + 10); rx++) {
        if (contrastMask[gy * GRID_W + rx] || chromaCandleMask[gy * GRID_W + rx]) horizRun++;
        else break;
      }

      if (horizRun >= 7) {
        continue; // Likely a solid UI button, axis price pill, or panel border — not a candle
      }

      // Check vertical stroke continuity (candle body or wick, +-1 or +-2 cells)
      const hasVertNeighbor =
        chromaCandleMask[(gy - 1) * GRID_W + gx] === 1 ||
        chromaCandleMask[(gy + 1) * GRID_W + gx] === 1 ||
        contrastMask[(gy - 1) * GRID_W + gx] === 1 ||
        contrastMask[(gy + 1) * GRID_W + gx] === 1;

      if (isChroma || (isContrast && hasVertNeighbor && horizRun <= 6)) {
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

  // Trim isolated extreme outlier UI icons only if enough columns/rows exist
  let minGx = GRID_W;
  let maxGx = -1;
  if (activeColIndices.length >= 6) {
    let startIdx = 0;
    let endIdx = activeColIndices.length - 1;
    if (activeColIndices[1] - activeColIndices[0] >= 16) startIdx = 1;
    if (activeColIndices[endIdx] - activeColIndices[endIdx - 1] >= 16) endIdx--;
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
    if (activeRowIndices[1] - activeRowIndices[0] >= 14) startIdx = 1;
    if (activeRowIndices[endIdx] - activeRowIndices[endIdx - 1] >= 14) endIdx--;
    minGy = activeRowIndices[startIdx];
    maxGy = activeRowIndices[endIdx];
  } else if (activeRowIndices.length > 0) {
    minGy = activeRowIndices[0];
    maxGy = activeRowIndices[activeRowIndices.length - 1];
  }

  const candleDensityScore = totalCandleSamples / (GRID_W * GRID_H);
  const spanX = maxGx >= minGx ? (maxGx - minGx + 1) / GRID_W : 0;
  const spanY = maxGy >= minGy ? (maxGy - minGy + 1) / GRID_H : 0;

  // Genuine candlestick chart requires >= 5 distinct candle columns, vertical body span (including tight M1 ranges), and sufficient samples
  const chartDetected =
    totalCandleSamples >= 12 &&
    activeColumns >= 5 &&
    spanX >= 0.14 &&
    spanY >= 0.055;

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
    const maxBtnSpan = Math.max(24, Math.round(width * 0.04));

    for (let px = scanStartX; px <= scanEndX; px++) {
      let colColoredHits = 0;
      let hitMinPy = height;
      let hitMaxPy = -1;
      for (let py = scanTopY; py <= scanBotY; py++) {
        const idx = (py * width + px) * 4;
        const k = classifyCandlePixel(rgba[idx], rgba[idx + 1], rgba[idx + 2], bg);
        if (k === 'BULL' || k === 'BEAR') {
          colColoredHits++;
          if (py < hitMinPy) hitMinPy = py;
          if (py > hitMaxPy) hitMaxPy = py;
        }
      }
      if (colColoredHits >= 2) {
        // Verify it is not a wide solid UI button/panel on the right
        const midPy = Math.round((hitMinPy + hitMaxPy) / 2);
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
        if (hSpan < maxBtnSpan) {
          rightCandleNormX = Math.max(rightCandleNormX, (px + 1) / width);
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
  if (bgDiff < 42) return null;

  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const saturation = maxC - minC;

  if (saturation >= 28) {
    if ((g >= r + 14 && g >= b - 10) || (b >= r + 24 && g >= r + 12)) {
      return 'BULL';
    }
    if (r >= g + 16 && r >= b + 6) {
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
    activeRows: number[];
  }

  const validCols: ColStats[] = [];
  const tinyColoredCols: ColStats[] = [];

  // Always scan colStep=1 so thin 1-2px M1 candles and wicks are never skipped
  for (let px = bx0 + 2; px <= bx1 - 2; px++) {
    let run = 0;
    let runStartPy = -1;
    let bestRun = 0;
    let bull = 0;
    let bear = 0;
    let mono = 0;
    let minPy = height;
    let maxPy = -1;
    const activeRows: number[] = [];

    let tinyRun = 0;
    let tinyBull = 0;
    let tinyBear = 0;
    let tinyMinPy = height;
    let tinyMaxPy = -1;
    const tinyRows: number[] = [];

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
        if (len > bestRun) bestRun = len;
        if (startPy < minPy) minPy = startPy;
        if (endPy > maxPy) maxPy = endPy;
        bull += segBull;
        bear += segBear;
        mono += segMono;
        for (let r = startPy; r <= endPy; r++) {
          activeRows.push(r);
        }
      } else if (len === 2 && (segBull >= 2 || segBear >= 2)) {
        tinyRun = Math.max(tinyRun, 2);
        tinyBull += segBull;
        tinyBear += segBear;
        if (startPy < tinyMinPy) tinyMinPy = startPy;
        if (endPy > tinyMaxPy) tinyMaxPy = endPy;
        for (let r = startPy; r <= endPy; r++) {
          tinyRows.push(r);
        }
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

    if (bestRun >= 3 && activeRows.length >= 3) {
      validCols.push({ px, minPy, maxPy, bull, bear, mono, bestRun, activeRows });
    } else if (tinyRun === 2 && tinyRows.length >= 2) {
      tinyColoredCols.push({
        px,
        minPy: tinyMinPy,
        maxPy: tinyMaxPy,
        bull: tinyBull,
        bear: tinyBear,
        mono: 0,
        bestRun: 2,
        activeRows: tinyRows,
      });
    }
  }

  // Group localized tiny 2px colored clusters (e.g. newly opened M1 candle) ONLY when span <= 16px
  // so 2px horizontal price lines never merge into or spoof candles
  if (tinyColoredCols.length > 0) {
    let tCluster: ColStats[] = [tinyColoredCols[0]];
    const flushTiny = () => {
      const span = tCluster[tCluster.length - 1].px - tCluster[0].px + 1;
      if (tCluster.length >= 2 && span <= 16) {
        const lastValidPx = validCols.length > 0 ? validCols[validCols.length - 1].px : -1;
        if (tCluster[0].px > lastValidPx) {
          validCols.push(...tCluster);
        }
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

  // Group into contiguous horizontal candle clusters
  const clusters: ColStats[][] = [];
  let current: ColStats[] = [validCols[0]];
  for (let i = 1; i < validCols.length; i++) {
    if (validCols[i].px - validCols[i - 1].px <= 3) {
      current.push(validCols[i]);
    } else {
      clusters.push(current);
      current = [validCols[i]];
    }
  }
  clusters.push(current);

  // Filter out wide solid UI bars, horizontal-only price line streaks, and flat horizontal right-axis price pills
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
    for (const col of c) {
      if (col.minPy < minTop) minTop = col.minPy;
      if (col.minPy > maxTop) maxTop = col.minPy;
      if (col.maxPy < minBot) minBot = col.maxPy;
      if (col.maxPy > maxBot) maxBot = col.maxPy;
      const h = col.maxPy - col.minPy + 1;
      heightSum += h;
      fillSum += col.activeRows.length / Math.max(1, h);
    }
    const avgHeight = heightSum / c.length;

    // Exclude wide 2px horizontal line streaks mistaken for candles
    if (spanPx >= 18 && avgHeight <= 2.2) {
      return false;
    }

    // Exclude horizontal or boundary-clipped right-axis UI price pills while keeping genuine interior wickless M1 candles and newly opened 2-4px candles
    const touchesRightBoundary = c[c.length - 1].px >= bx1 - 6;
    if (
      spanPx >= 8 &&
      c.length >= 4 &&
      avgHeight >= 5 &&
      avgHeight <= 24 &&
      (spanPx >= avgHeight * 1.1 || touchesRightBoundary)
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

  const rightmost = candleClusters[candleClusters.length - 1];
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
