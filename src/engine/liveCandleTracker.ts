import type {
  ChartBounds,
  LiveCandleDirection,
  LiveCandleTracker,
  PriceLine,
} from '../types/signals.ts';

function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
}

function estimateChartBackground(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ChartBounds
): { r: number; g: number; b: number } {
  const bx0 = Math.max(0, Math.floor(bounds.x * width));
  const bx1 = Math.min(width - 1, Math.ceil((bounds.x + bounds.width) * width));
  const by0 = Math.max(0, Math.floor(bounds.y * height));
  const by1 = Math.min(height - 1, Math.ceil((bounds.y + bounds.height) * height));

  const bins = new Uint16Array(16);
  const sumR = new Uint32Array(16);
  const sumG = new Uint32Array(16);
  const sumB = new Uint32Array(16);

  const stepX = Math.max(2, Math.floor((bx1 - bx0) / 32));
  const stepY = Math.max(2, Math.floor((by1 - by0) / 24));

  for (let py = by0 + 2; py <= by1 - 2; py += stepY) {
    for (let px = bx0 + 2; px <= bx1 - 2; px += stepX) {
      const idx = (py * width + px) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const lumaBin = Math.min(15, Math.floor((0.299 * r + 0.587 * g + 0.114 * b) / 16));
      bins[lumaBin]++;
      sumR[lumaBin] += r;
      sumG[lumaBin] += g;
      sumB[lumaBin] += b;
    }
  }

  let bestBin = 0;
  let bestCount = 0;
  for (let i = 0; i < 16; i++) {
    if (bins[i] > bestCount) {
      bestCount = bins[i];
      bestBin = i;
    }
  }

  const count = Math.max(1, bestCount);
  return {
    r: Math.round(sumR[bestBin] / count),
    g: Math.round(sumG[bestBin] / count),
    b: Math.round(sumB[bestBin] / count),
  };
}

function classifyPixel(
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

/**
 * Independent forming-candle tracker:
 * Detects the rightmost candle currently forming inside the verified chart region,
 * tracks its horizontal coordinate (X) and real-time price level (Y), and returns
 * null whenever detection or price positioning is not reliable (never invents values).
 */
export function detectLiveMovingCandle(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  chartBounds: ChartBounds | null,
  verifiedPriceLine: PriceLine | null
): LiveCandleTracker | null {
  if (!chartBounds || width < 40 || height < 30) {
    return null;
  }

  const bx0 = Math.max(0, Math.floor(chartBounds.x * width));
  const bx1 = Math.min(width - 1, Math.ceil((chartBounds.x + chartBounds.width) * width));
  const by0 = Math.max(0, Math.floor(chartBounds.y * height));
  const by1 = Math.min(height - 1, Math.ceil((chartBounds.y + chartBounds.height) * height));

  const plotW = bx1 - bx0 + 1;
  const plotH = by1 - by0 + 1;
  if (plotW < 40 || plotH < 30) {
    return null;
  }

  const bg = estimateChartBackground(rgba, width, height, chartBounds);
  const maxCandleSpan = Math.max(28, Math.round(plotW * 0.075));

  interface ColStats {
    px: number;
    minPy: number;
    maxPy: number;
    bull: number;
    bear: number;
    mono: number;
    activeRows: number[];
  }

  const validCols: ColStats[] = [];
  const tinyColoredCols: ColStats[] = [];

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
        const kind = classifyPixel(rgba[rIdx], rgba[rIdx + 1], rgba[rIdx + 2], bg);
        if (kind === 'BULL') segBull++;
        else if (kind === 'BEAR') segBear++;
        else if (kind === 'MONO') segMono++;
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
      const kind = classifyPixel(rgba[idx], rgba[idx + 1], rgba[idx + 2], bg);
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
      validCols.push({ px, minPy, maxPy, bull, bear, mono, activeRows });
    } else if (tinyRun === 2 && tinyRows.length >= 2) {
      tinyColoredCols.push({
        px,
        minPy: tinyMinPy,
        maxPy: tinyMaxPy,
        bull: tinyBull,
        bear: tinyBear,
        mono: 0,
        activeRows: tinyRows,
      });
    }
  }

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

  if (validCols.length === 0) {
    return null;
  }

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

  const candleClusters = clusters.filter((c) => {
    const spanPx = c[c.length - 1].px - c[0].px + 1;
    const totalPixels = c.reduce((acc, col) => acc + col.activeRows.length, 0);
    if (spanPx > maxCandleSpan || totalPixels < 2) return false;

    let minTop = height;
    let maxTop = -1;
    let minBot = height;
    let maxBot = -1;
    let fillSum = 0;
    let heightSum = 0;
    let clusterBull = 0;
    let clusterBear = 0;
    for (const col of c) {
      clusterBull += col.bull;
      clusterBear += col.bear;
      if (col.minPy < minTop) minTop = col.minPy;
      if (col.minPy > maxTop) maxTop = col.minPy;
      if (col.maxPy < minBot) minBot = col.maxPy;
      if (col.maxPy > maxBot) maxBot = col.maxPy;
      const h = col.maxPy - col.minPy + 1;
      heightSum += h;
      fillSum += col.activeRows.length / Math.max(1, h);
    }
    const avgHeight = heightSum / c.length;
    const clusterVertSpan = maxBot - minTop + 1;

    // Exclude thin horizontal line streaks
    if (spanPx >= 18 && avgHeight <= 2.2) {
      return false;
    }

    // Exclude thin 1-3px vertical divider/expiration/deadline lines (monochrome OR colored, solid OR dashed — IQ Option, Quotex, Pocket Option, TradingView)
    const totalFillDensity = totalPixels / Math.max(1, spanPx * clusterVertSpan);
    if (
      spanPx <= 3 &&
      (clusterVertSpan >= plotH * 0.55 ||
        (clusterVertSpan >= plotH * 0.35 && totalFillDensity <= 0.58))
    ) {
      return false;
    }

    // Exclude horizontal or boundary-clipped right-axis price pills while keeping genuine interior wickless M1 candles and newly opened 2-4px candles
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

  if (candleClusters.length === 0) {
    return null;
  }

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

  let direction: LiveCandleDirection = 'NEUTRAL';
  let closePy: number | null = null;
  let confidence = 0;

  if (bullTotal >= 2 && bullTotal >= bearTotal * 1.3) {
    direction = 'BULL';
    closePy = bodyTop;
    confidence = bullTotal >= 3 ? 0.8 : 0.74;
  } else if (bearTotal >= 2 && bearTotal >= bullTotal * 1.3) {
    direction = 'BEAR';
    closePy = bodyBottom;
    confidence = bearTotal >= 3 ? 0.8 : 0.74;
  } else if (monoTotal >= 4 && bodyBottom - bodyTop <= 4) {
    closePy = Math.round((bodyTop + bodyBottom) / 2);
    confidence = 0.72;
  } else if (bullTotal + bearTotal + monoTotal >= 3 && verifiedPriceLine) {
    closePy = Math.round((bodyTop + bodyBottom) / 2);
    confidence = 0.7;
  }

  // Anchor vertical price strictly to a real verified horizontal price line or unambiguous candle close
  let resolvedNormY: number | null = null;
  if (
    verifiedPriceLine &&
    (verifiedPriceLine.source === 'PRICE_LINE' || verifiedPriceLine.source === 'CANDLE_CLOSE') &&
    verifiedPriceLine.confidence >= 0.64
  ) {
    const linePy = verifiedPriceLine.y * height;
    if (linePy >= topPy - 24 && linePy <= bottomPy + 24) {
      resolvedNormY = verifiedPriceLine.y;
      confidence = Math.max(confidence, verifiedPriceLine.confidence);
    }
  }

  if (resolvedNormY === null && closePy !== null && confidence >= 0.72) {
    resolvedNormY = Math.max(0.02, Math.min(0.98, closePy / height));
  }

  if (resolvedNormY === null) {
    return null;
  }

  const centerPx = (rightmost[0].px + rightmost[rightmost.length - 1].px) / 2;
  const normX = Math.max(0.02, Math.min(0.98, centerPx / width));
  const relX = Math.max(
    0.02,
    Math.min(0.98, (normX - chartBounds.x) / Math.max(0.05, chartBounds.width))
  );
  const relY = Math.max(
    0.02,
    Math.min(0.98, (resolvedNormY - chartBounds.y) / Math.max(0.05, chartBounds.height))
  );

  return {
    x: Number(normX.toFixed(4)),
    y: Number(resolvedNormY.toFixed(4)),
    chartRelativeX: Number(relX.toFixed(4)),
    chartRelativeY: Number(relY.toFixed(4)),
    topY: Number(Math.max(0.01, Math.min(0.99, topPy / height)).toFixed(4)),
    bottomY: Number(Math.max(0.01, Math.min(0.99, bottomPy / height)).toFixed(4)),
    direction,
    chartBounds,
    confidence: Number(Math.min(0.98, confidence).toFixed(2)),
    updatedAt: Date.now(),
  };
}

export type CandleDetectionFailureReason =
  | 'chart_not_detected'
  | 'invalid_chart_bounds'
  | 'no_candle_columns_detected'
  | 'ambiguous_candle_or_filtered';

export function detectLiveMovingCandleWithReason(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  chartBounds: ChartBounds | null,
  verifiedPriceLine: PriceLine | null,
  chartDetected = true
): { candle: LiveCandleTracker | null; reason: CandleDetectionFailureReason | null } {
  if (!chartDetected) {
    return { candle: null, reason: 'chart_not_detected' };
  }
  if (!chartBounds || width < 40 || height < 30) {
    return { candle: null, reason: 'invalid_chart_bounds' };
  }
  const candle = detectLiveMovingCandle(rgba, width, height, chartBounds, verifiedPriceLine);
  if (candle) {
    return { candle, reason: null };
  }
  return { candle: null, reason: 'ambiguous_candle_or_filtered' };
}
