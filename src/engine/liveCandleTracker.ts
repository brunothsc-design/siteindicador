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

export type CandleDetectionFailureReason =
  | 'chart_not_detected'
  | 'invalid_chart_bounds'
  | 'no_candle_columns_detected'
  | 'all_clusters_filtered'
  | 'ambiguous_candle_or_filtered'
  | 'unresolved_candle_close';

export interface CandleDetectionDiagnostics {
  plotW: number;
  plotH: number;
  bg: { r: number; g: number; b: number };
  validColsCount: number;
  tinyColoredColsCount: number;
  rawClustersCount: number;
  megaClustersSplitCount: number;
  filteredClustersCount: number;
  rejectedTooWideOrTiny: number;
  rejectedHorizontalStreak: number;
  rejectedCountdownText: number;
  rejectedExpirationLine: number;
  rejectedAxisPill: number;
  rightmostStats: {
    pxStart: number;
    pxEnd: number;
    bull: number;
    bear: number;
    mono: number;
  } | null;
}

interface InternalCandleDetectionResult {
  candle: LiveCandleTracker | null;
  reason: CandleDetectionFailureReason | null;
  diagnostics: CandleDetectionDiagnostics | null;
}

function detectLiveMovingCandleCore(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  chartBounds: ChartBounds | null,
  verifiedPriceLine: PriceLine | null,
  chartDetected = true
): InternalCandleDetectionResult {
  if (!chartDetected) {
    return { candle: null, reason: 'chart_not_detected', diagnostics: null };
  }
  if (!chartBounds || width < 40 || height < 30) {
    return { candle: null, reason: 'invalid_chart_bounds', diagnostics: null };
  }

  const bx0 = Math.max(0, Math.floor(chartBounds.x * width));
  const bx1 = Math.min(width - 1, Math.ceil((chartBounds.x + chartBounds.width) * width));
  const by0 = Math.max(0, Math.floor(chartBounds.y * height));
  const by1 = Math.min(height - 1, Math.ceil((chartBounds.y + chartBounds.height) * height));

  const plotW = bx1 - bx0 + 1;
  const plotH = by1 - by0 + 1;
  if (plotW < 40 || plotH < 30) {
    return { candle: null, reason: 'invalid_chart_bounds', diagnostics: null };
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
    bestRun: number;
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
      if (tCluster.length < 1 || span > 16 || tCluster[0].px <= lastColoredValidPx) {
        return;
      }
      // Reject segments belonging to a dashed horizontal price line (repeating 2px-tall dashes at identical Y across > 18px)
      const refMinPy = tCluster[0].minPy;
      const refMaxPy = tCluster[0].maxPy;
      const refPx = tCluster[0].px;
      let bandMinPx = refPx;
      let bandMaxPx = tCluster[tCluster.length - 1].px;
      for (const col of tinyColoredCols) {
        if (
          Math.abs(col.px - refPx) <= 120 &&
          Math.abs(col.minPy - refMinPy) <= 1 &&
          Math.abs(col.maxPy - refMaxPy) <= 1
        ) {
          if (col.px < bandMinPx) bandMinPx = col.px;
          if (col.px > bandMaxPx) bandMaxPx = col.px;
        }
      }
      if (bandMaxPx - bandMinPx + 1 > 18) {
        return;
      }
      validCols.push(...tCluster);
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

  const baseDiag: CandleDetectionDiagnostics = {
    plotW,
    plotH,
    bg,
    validColsCount: validCols.length,
    tinyColoredColsCount: tinyColoredCols.length,
    rawClustersCount: 0,
    megaClustersSplitCount: 0,
    filteredClustersCount: 0,
    rejectedTooWideOrTiny: 0,
    rejectedHorizontalStreak: 0,
    rejectedCountdownText: 0,
    rejectedExpirationLine: 0,
    rejectedAxisPill: 0,
    rightmostStats: null,
  };

  if (validCols.length === 0) {
    return { candle: null, reason: 'no_candle_columns_detected', diagnostics: baseDiag };
  }

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

  // Split any mega-cluster caused by a 3px horizontal indicator/MA/price line bridging adjacent candles
  const clusters: ColStats[][] = [];
  for (const rc of rawClusters) {
    const spanPx = rc[rc.length - 1].px - rc[0].px + 1;
    if (spanPx <= maxCandleSpan) {
      clusters.push(rc);
    } else {
      baseDiag.megaClustersSplitCount++;
      const strongCols = rc.filter(
        (col) => col.bestRun >= 5 || (col.maxPy - col.minPy + 1 >= 6 && col.activeRows.length >= 5)
      );
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
      } else {
        clusters.push(rc);
      }
    }
  }
  baseDiag.rawClustersCount = clusters.length;

  const candleClusters = clusters.filter((c) => {
    const spanPx = c[c.length - 1].px - c[0].px + 1;
    const totalPixels = c.reduce((acc, col) => acc + col.activeRows.length, 0);
    if (spanPx > maxCandleSpan || totalPixels < 2) {
      baseDiag.rejectedTooWideOrTiny++;
      return false;
    }

    let minTop = height;
    let maxTop = -1;
    let minBot = height;
    let maxBot = -1;
    let fillSum = 0;
    let heightSum = 0;
    let clusterBull = 0;
    let clusterBear = 0;
    let clusterMono = 0;
    for (const col of c) {
      clusterBull += col.bull;
      clusterBear += col.bear;
      clusterMono += col.mono;
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

    if (spanPx >= 18 && avgHeight <= 2.2) {
      baseDiag.rejectedHorizontalStreak++;
      return false;
    }

    if (
      clusterBull === 0 &&
      clusterBear === 0 &&
      clusterMono > 0 &&
      spanPx >= avgHeight * 1.35 &&
      avgHeight <= 15 &&
      c.length >= 4
    ) {
      baseDiag.rejectedCountdownText++;
      return false;
    }

    const totalFillDensity = totalPixels / Math.max(1, spanPx * clusterVertSpan);
    const minExpSpan = clusterBull + clusterBear > 0 ? plotH * 0.50 : plotH * 0.35;
    if (
      spanPx <= 3 &&
      (clusterVertSpan >= plotH * 0.55 ||
        (clusterVertSpan >= minExpSpan && totalFillDensity <= 0.58))
    ) {
      baseDiag.rejectedExpirationLine++;
      return false;
    }

    // Exclude right-axis price pills (wide flat labels or right-boundary clipped) while keeping flat interior M1 candles
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
        baseDiag.rejectedAxisPill++;
        return false;
      }
    }

    return true;
  });

  baseDiag.filteredClustersCount = candleClusters.length;
  if (candleClusters.length === 0) {
    return { candle: null, reason: 'all_clusters_filtered', diagnostics: baseDiag };
  }

  // Prefer the rightmost colored forming candle over trailing monochrome countdown/icon/crosshair artifacts,
  // while keeping genuine tall solid monochrome rightmost candles intact so ambiguous charts still return null.
  const hasColoredCandles = candleClusters.some((c) => c.some((col) => col.bull + col.bear >= 2));
  let rightmost = candleClusters[candleClusters.length - 1];
  if (hasColoredCandles) {
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

  baseDiag.rightmostStats = {
    pxStart: rightmost[0].px,
    pxEnd: rightmost[rightmost.length - 1].px,
    bull: bullTotal,
    bear: bearTotal,
    mono: monoTotal,
  };

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
  } else if (bullTotal + bearTotal >= 2) {
    direction = 'NEUTRAL';
    closePy = Math.round((bodyTop + bodyBottom) / 2);
    confidence = 0.73;
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
    if (linePy >= topPy - 42 && linePy <= bottomPy + 42) {
      resolvedNormY = verifiedPriceLine.y;
      confidence = Math.max(confidence, verifiedPriceLine.confidence);
    }
  }

  if (resolvedNormY === null && closePy !== null && confidence >= 0.72) {
    resolvedNormY = Math.max(0.02, Math.min(0.98, closePy / height));
  }

  if (resolvedNormY === null) {
    return { candle: null, reason: 'unresolved_candle_close', diagnostics: baseDiag };
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
    candle: {
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
    },
    reason: null,
    diagnostics: baseDiag,
  };
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
  return detectLiveMovingCandleCore(rgba, width, height, chartBounds, verifiedPriceLine, true)
    .candle;
}

export function detectLiveMovingCandleWithReason(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  chartBounds: ChartBounds | null,
  verifiedPriceLine: PriceLine | null,
  chartDetected = true
): {
  candle: LiveCandleTracker | null;
  reason: CandleDetectionFailureReason | null;
  diagnostics: CandleDetectionDiagnostics | null;
} {
  return detectLiveMovingCandleCore(
    rgba,
    width,
    height,
    chartBounds,
    verifiedPriceLine,
    chartDetected
  );
}
