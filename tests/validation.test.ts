import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_STRATEGY_CONFIG,
  runWalkForwardBacktest,
  type CandleBar,
} from '../src/engine/candleAnalysis.ts';
import { processFrameLocally } from '../src/engine/localScreenProcessor.ts';
import {
  detectLiveMovingCandle,
  detectLiveMovingCandleWithReason,
} from '../src/engine/liveCandleTracker.ts';
import {
  checkDisplayCaptureEnvironment,
  classifyDisplayCaptureError,
} from '../src/engine/screenCaptureGuard.ts';
import {
  MIN_SIGNAL_CONFIDENCE,
  applySignalPrecisionFilter,
  classifyGeminiUpstreamError,
  executeGeminiFrameAnalysis,
  isAuthorizedSameOriginRequest,
  sanitizeSecretFromText,
} from '../server/analyzeFrameCore.ts';
import {
  PRODUCTION_MIN_SIGNAL_CONFIDENCE,
  TEMPORARY_TEST_MIN_SIGNAL_CONFIDENCE,
  USE_TEMPORARY_TEST_CONFIDENCE,
  isSignalConfidenceValid,
} from '../src/config/signalConfig.ts';
import {
  buildOperationalStatusPayloadWithLiveCandle,
  clearLocalOverlaySignals,
  isTrustedOverlayOrigin,
  pushLocalOverlayCandle,
  pushLocalOverlayStatus,
} from '../src/engine/localOverlayBridge.ts';
import type { OperationalStatusState } from '../src/types/signals.ts';
import {
  CANDLE_ANCHOR_HOLD_MS,
  MANDATORY_TIMEFRAME,
  MIN_OPERATIONAL_CONFIDENCE,
  computeCandleStatusAnchor,
  createInitialOperationalStatus,
  operationalStatusChanged,
  resolveOperationalStatus,
} from '../src/engine/operationalStatus.ts';
import netlifyAnalyzeHandler from '../netlify/functions/analyze-frame.ts';
import netlifyHealthHandler from '../netlify/functions/health.ts';
import netlifyOverlaySessionHandler from '../netlify/functions/overlay-session.ts';
import netlifyOverlayClearHandler from '../netlify/functions/overlay-clear.ts';
import netlifyOverlayStateHandler from '../netlify/functions/overlay-state.ts';
import netlifyOverlayPriceHandler from '../netlify/functions/overlay-price.ts';
import netlifyOverlayCandleHandler from '../netlify/functions/overlay-candle.ts';
import netlifyOverlayStatusHandler from '../netlify/functions/overlay-status.ts';

function createSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Generates realistic multi-regime OHLCV candlestick series (uptrend, pullback, downtrend, sideways chop)
 * without any future peeking.
 */
function generateRealisticMarketSeries(totalBars: number, seed: number): CandleBar[] {
  const rng = createSeededRng(seed);
  const bars: CandleBar[] = [];
  let price = 100.0;
  const startTime = 1700000000000;

  for (let i = 0; i < totalBars; i++) {
    const phase = Math.floor(i / 75) % 4;
    let drift = 0;
    let vol = 0.0022;

    if (phase === 0) {
      // Sustained uptrend with small pullbacks
      drift = i % 11 === 0 || i % 11 === 1 ? -0.0018 : 0.0024;
      vol = 0.0018;
    } else if (phase === 1) {
      // Sideways choppy range
      drift = Math.sin(i * 0.9) * 0.0015;
      vol = 0.0024;
    } else if (phase === 2) {
      // Sustained downtrend with brief relief rallies
      drift = i % 11 === 0 || i % 11 === 1 ? 0.0018 : -0.0024;
      vol = 0.0018;
    } else {
      // Mixed noisy consolidation
      drift = (rng() - 0.5) * 0.002;
      vol = 0.0028;
    }

    const noise = (rng() - 0.5) * vol;
    const open = price;
    const close = Math.max(10, open * (1 + drift + noise));
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const upperWick = open * (0.0003 + rng() * 0.0009);
    const lowerWick = open * (0.0003 + rng() * 0.0009);

    bars.push({
      timestamp: startTime + i * 60000,
      open,
      high: bodyHigh + upperWick,
      low: Math.max(1, bodyLow - lowerWick),
      close,
      volume: 1000 + Math.round(rng() * 500),
    });

    price = close;
  }

  return bars;
}

function renderSyntheticChartRgba(
  width: number,
  height: number,
  candles: Array<{ xRatio: number; yTopRatio: number; yBottomRatio: number; bull: boolean }>
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  // Dark broker background (#0F172A)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 15;
    rgba[i * 4 + 1] = 23;
    rgba[i * 4 + 2] = 42;
    rgba[i * 4 + 3] = 255;
  }

  for (const c of candles) {
    const cx = Math.floor(c.xRatio * width);
    const halfW = Math.max(2, Math.floor(width * 0.012));
    const y0 = Math.max(0, Math.floor(c.yTopRatio * height));
    const y1 = Math.min(height - 1, Math.floor(c.yBottomRatio * height));
    for (let y = y0; y <= y1; y++) {
      for (let x = Math.max(0, cx - halfW); x <= Math.min(width - 1, cx + halfW); x++) {
        const idx = (y * width + x) * 4;
        if (c.bull) {
          rgba[idx] = 22;
          rgba[idx + 1] = 197;
          rgba[idx + 2] = 94;
        } else {
          rgba[idx] = 239;
          rgba[idx + 1] = 68;
          rgba[idx + 2] = 68;
        }
      }
    }
  }
  return rgba;
}

describe('ChartPulse AI — Local Screen & Chart Recognition', () => {
  it('rejects empty/non-chart frames to avoid unnecessary Gemini API calls', () => {
    const blankRgba = renderSyntheticChartRgba(320, 180, []);
    const digest = processFrameLocally(blankRgba, 320, 180, null);
    assert.equal(digest.chartDetected, false);
    assert.equal(digest.chartBounds, null);
  });

  it('detects candlestick chart region and detects visual change only when candles update', () => {
    const candles = Array.from({ length: 18 }, (_, i) => ({
      xRatio: 0.14 + i * 0.04,
      yTopRatio: 0.28 + (i % 3) * 0.05,
      yBottomRatio: 0.56 + (i % 3) * 0.05,
      bull: i % 2 === 0,
    }));

    const frame1 = renderSyntheticChartRgba(320, 180, candles);
    const d1 = processFrameLocally(frame1, 320, 180, null);
    assert.equal(d1.chartDetected, true);
    assert.ok(d1.chartBounds !== null);
    assert.ok(d1.chartBounds.width >= 0.4);

    // Identical frame -> diffScore must be ~0 (skips Gemini API)
    const d2 = processFrameLocally(frame1, 320, 180, d1.signature);
    assert.ok(d2.diffScore < 1e-6, `Expected identical frame diffScore < 1e-6, got ${d2.diffScore}`);

    // New strong candle on right edge -> diffScore > threshold
    const candlesMoved = [
      ...candles,
      { xRatio: 0.86, yTopRatio: 0.18, yBottomRatio: 0.52, bull: true },
      { xRatio: 0.90, yTopRatio: 0.14, yBottomRatio: 0.42, bull: true },
    ];
    const frame2 = renderSyntheticChartRgba(320, 180, candlesMoved);
    const d3 = processFrameLocally(frame2, 320, 180, d1.signature);
    assert.ok(d3.diffScore > 0.0085, `Expected diffScore > 0.0085, got ${d3.diffScore}`);
  });
});

describe('ChartPulse AI — Quantitative Confirmation, Zero Lookahead & Walk-Forward Validation', () => {
  it('uses strictly causal data (zero future lookahead)', () => {
    const bars = generateRealisticMarketSeries(300, 42);
    const mutatedBars = bars.map((b, idx) =>
      idx > 180 ? { ...b, open: b.open * 2, high: b.high * 2, low: b.low * 2, close: b.close * 2 } : b
    );

    const reportA = runWalkForwardBacktest(bars.slice(0, 181), DEFAULT_STRATEGY_CONFIG);
    const reportB = runWalkForwardBacktest(mutatedBars, DEFAULT_STRATEGY_CONFIG);

    const recordsUpTo178A = reportA.records.filter((r) => r.index <= 178);
    const recordsUpTo178B = reportB.records.filter((r) => r.index <= 178);
    assert.deepEqual(
      recordsUpTo178A.map((r) => ({ idx: r.index, dir: r.direction })),
      recordsUpTo178B.map((r) => ({ idx: r.index, dir: r.direction }))
    );
  });

  it('suppresses signals during sideways/choppy regimes', () => {
    const choppyBars: CandleBar[] = [];
    for (let i = 0; i < 160; i++) {
      const base = 100 + Math.sin(i * 0.85) * 0.6;
      const open = base;
      const close = base + (i % 2 === 0 ? 0.25 : -0.25);
      choppyBars.push({
        timestamp: 1700000000000 + i * 60000,
        open,
        high: Math.max(open, close) + 0.35,
        low: Math.min(open, close) - 0.35,
        close,
      });
    }
    const report = runWalkForwardBacktest(choppyBars, DEFAULT_STRATEGY_CONFIG);
    assert.equal(report.totalSignals, 0, 'Sideways market should yield 0 signals');
  });

  it('evaluates historical (in-sample) and unseen (out-of-sample) datasets for COMPRA and VENDA separately', () => {
    const inSampleBars = generateRealisticMarketSeries(2400, 101);
    const outOfSampleBars = generateRealisticMarketSeries(2400, 999);

    const inSample = runWalkForwardBacktest(inSampleBars, DEFAULT_STRATEGY_CONFIG);
    const outOfSample = runWalkForwardBacktest(outOfSampleBars, DEFAULT_STRATEGY_CONFIG);

    console.log('\n[ChartPulse AI Backtest Report — In-Sample (2400 bars, spread+fees applied)]');
    console.log(
      `Total: ${inSample.totalSignals} signals | Win Rate: ${inSample.overallWinRatePct}% | ` +
        `COMPRA: ${inSample.buy.wins}/${inSample.buy.signals} (${inSample.buy.winRatePct}%, avg ${inSample.buy.avgNetBps} bps) | ` +
        `VENDA: ${inSample.sell.wins}/${inSample.sell.signals} (${inSample.sell.winRatePct}%, avg ${inSample.sell.avgNetBps} bps)`
    );

    console.log('[ChartPulse AI Backtest Report — Out-of-Sample (2400 unseen bars, spread+fees applied)]');
    console.log(
      `Total: ${outOfSample.totalSignals} signals | Win Rate: ${outOfSample.overallWinRatePct}% | ` +
        `COMPRA: ${outOfSample.buy.wins}/${outOfSample.buy.signals} (${outOfSample.buy.winRatePct}%, avg ${outOfSample.buy.avgNetBps} bps) | ` +
        `VENDA: ${outOfSample.sell.wins}/${outOfSample.sell.signals} (${outOfSample.sell.winRatePct}%, avg ${outOfSample.sell.avgNetBps} bps)\n`
    );

    assert.ok(inSample.buy.signals > 0 && inSample.sell.signals > 0);
    assert.ok(outOfSample.buy.signals > 0 && outOfSample.sell.signals > 0);
    assert.ok(
      outOfSample.overallWinRatePct >= 65,
      `Expected disciplined out-of-sample win rate >= 65%, got ${outOfSample.overallWinRatePct}%`
    );
  });
});

describe('ChartPulse AI — Display Capture Environment & Error Classification', () => {
  it('detects insecure non-localhost context before calling getDisplayMedia', () => {
    const check = checkDisplayCaptureEnvironment(
      {
        isSecureContext: false,
        location: { hostname: '192.168.1.50' } as Location,
        self: {} as Window,
        top: {} as Window,
      },
      { mediaDevices: { getDisplayMedia: async () => new MediaStream() } as MediaDevices }
    );
    assert.equal(check.supported, false);
    assert.equal(check.reason, 'INSECURE_CONTEXT');
  });

  it('detects unavailable navigator.mediaDevices.getDisplayMedia', () => {
    const sameWin = {} as Window;
    const check = checkDisplayCaptureEnvironment(
      {
        isSecureContext: true,
        location: { hostname: 'localhost' } as Location,
        self: sameWin,
        top: sameWin,
      },
      { mediaDevices: {} as MediaDevices }
    );
    assert.equal(check.supported, false);
    assert.equal(check.reason, 'API_UNAVAILABLE');
  });

  it('detects when Preview iframe Permissions-Policy blocks display-capture', () => {
    const check = checkDisplayCaptureEnvironment(
      {
        isSecureContext: true,
        location: { hostname: 'example.run.app' } as Location,
        self: { id: 1 } as unknown as Window,
        top: { id: 2 } as unknown as Window,
      },
      { mediaDevices: { getDisplayMedia: async () => new MediaStream() } as MediaDevices },
      { permissionsPolicy: { allowsFeature: (f) => f !== 'display-capture' } }
    );
    assert.equal(check.supported, false);
    assert.equal(check.reason, 'IFRAME_POLICY_BLOCKED');
    assert.match(check.message ?? '', /Preview do Google AI Studio/i);
  });

  it('differentiates iframe policy block, user cancellation, OS denial, and missing API errors', () => {
    const iframePolicyMsg = classifyDisplayCaptureError(
      new DOMException('Access to the feature "display-capture" is disallowed by permissions policy', 'NotAllowedError'),
      25,
      true
    );
    assert.match(iframePolicyMsg, /Preview do Google AI Studio/i);

    const userCancelMsg = classifyDisplayCaptureError(
      new DOMException('Permission denied', 'NotAllowedError'),
      1400,
      false
    );
    assert.match(userCancelMsg, /cancelado/i);

    const abortCancelMsg = classifyDisplayCaptureError(
      new DOMException('Aborted', 'AbortError'),
      800,
      false
    );
    assert.match(abortCancelMsg, /cancelada/i);

    const osDeniedMsg = classifyDisplayCaptureError(
      new DOMException('Permission denied by system', 'NotAllowedError'),
      600,
      false
    );
    assert.match(osDeniedMsg, /sistema operacional/i);
  });
});

interface BrokerLayoutProfile {
  name: string;
  bg: [number, number, number];
  bullColor: [number, number, number];
  bearColor: [number, number, number];
  plotBox: { x0: number; y0: number; x1: number; y1: number };
  uiButtons?: Array<{ x0: number; y0: number; x1: number; y1: number; color: [number, number, number] }>;
}

function renderBrokerLayoutFrame(
  width: number,
  height: number,
  profile: BrokerLayoutProfile,
  includeCandles = true
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = profile.bg[0];
    rgba[i * 4 + 1] = profile.bg[1];
    rgba[i * 4 + 2] = profile.bg[2];
    rgba[i * 4 + 3] = 255;
  }

  // Draw optional broker sidebars / solid Buy-Sell buttons outside the chart plot
  for (const btn of profile.uiButtons ?? []) {
    const bx0 = Math.floor(btn.x0 * width);
    const bx1 = Math.floor(btn.x1 * width);
    const by0 = Math.floor(btn.y0 * height);
    const by1 = Math.floor(btn.y1 * height);
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const idx = (y * width + x) * 4;
        rgba[idx] = btn.color[0];
        rgba[idx + 1] = btn.color[1];
        rgba[idx + 2] = btn.color[2];
      }
    }
  }

  if (includeCandles) {
    const { x0, y0, x1, y1 } = profile.plotBox;
    const candleCount = 22;
    const stepX = (x1 - x0) / (candleCount + 1);
    for (let c = 0; c < candleCount; c++) {
      const cx = Math.floor((x0 + (c + 1) * stepX) * width);
      const halfW = Math.max(1, Math.floor(width * 0.008));
      const cyTop = Math.floor((y0 + 0.12 * (y1 - y0) + (c % 4) * 0.08 * (y1 - y0)) * height);
      const cyBot = Math.floor((y0 + 0.55 * (y1 - y0) + (c % 3) * 0.1 * (y1 - y0)) * height);
      const color = c % 2 === 0 ? profile.bullColor : profile.bearColor;

      for (let y = cyTop; y <= cyBot; y++) {
        for (let x = Math.max(0, cx - halfW); x <= Math.min(width - 1, cx + halfW); x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = color[0];
          rgba[idx + 1] = color[1];
          rgba[idx + 2] = color[2];
        }
      }
    }
  }

  return rgba;
}

describe('ChartPulse AI — Universal Multi-Broker Layout Recognition', () => {
  const profiles: BrokerLayoutProfile[] = [
    {
      name: 'IQ Option (dark slate + right Buy/Sell panel)',
      bg: [28, 32, 48],
      bullColor: [34, 197, 94],
      bearColor: [239, 68, 68],
      plotBox: { x0: 0.08, y0: 0.14, x1: 0.80, y1: 0.85 },
      uiButtons: [
        { x0: 0.86, y0: 0.38, x1: 0.96, y1: 0.48, color: [34, 197, 94] },
        { x0: 0.86, y0: 0.52, x1: 0.96, y1: 0.62, color: [239, 68, 68] },
      ],
    },
    {
      name: 'Quotex (navy + teal/coral candles + right order buttons)',
      bg: [19, 23, 34],
      bullColor: [14, 203, 129],
      bearColor: [246, 70, 93],
      plotBox: { x0: 0.07, y0: 0.12, x1: 0.78, y1: 0.86 },
      uiButtons: [
        { x0: 0.85, y0: 0.40, x1: 0.97, y1: 0.50, color: [14, 203, 129] },
        { x0: 0.85, y0: 0.54, x1: 0.97, y1: 0.64, color: [246, 70, 93] },
      ],
    },
    {
      name: 'Binomo (charcoal + emerald/red candles)',
      bg: [30, 34, 45],
      bullColor: [46, 204, 113],
      bearColor: [231, 76, 60],
      plotBox: { x0: 0.06, y0: 0.15, x1: 0.82, y1: 0.84 },
      uiButtons: [
        { x0: 0.87, y0: 0.44, x1: 0.96, y1: 0.54, color: [46, 204, 113] },
      ],
    },
    {
      name: 'Pocket Option (blue-gray + left toolbar + right quick trade)',
      bg: [24, 32, 50],
      bullColor: [22, 185, 120],
      bearColor: [235, 77, 75],
      plotBox: { x0: 0.10, y0: 0.14, x1: 0.79, y1: 0.86 },
      uiButtons: [
        { x0: 0.85, y0: 0.35, x1: 0.96, y1: 0.46, color: [22, 185, 120] },
        { x0: 0.85, y0: 0.50, x1: 0.96, y1: 0.61, color: [235, 77, 75] },
      ],
    },
    {
      name: 'MetaTrader 4/5 (classic black theme, lime/white bars, left Market Watch + bottom Terminal)',
      bg: [0, 0, 0],
      bullColor: [0, 255, 0],
      bearColor: [255, 255, 255],
      plotBox: { x0: 0.24, y0: 0.12, x1: 0.94, y1: 0.70 },
    },
    {
      name: 'MetaTrader 4/5 (light theme, white background, black/green bars)',
      bg: [255, 255, 255],
      bullColor: [0, 150, 70],
      bearColor: [20, 20, 20],
      plotBox: { x0: 0.22, y0: 0.12, x1: 0.94, y1: 0.72 },
    },
    {
      name: 'TradingView (dark theme, teal/coral candles + right watchlist)',
      bg: [19, 23, 34],
      bullColor: [8, 153, 129],
      bearColor: [242, 54, 69],
      plotBox: { x0: 0.06, y0: 0.10, x1: 0.78, y1: 0.88 },
    },
    {
      name: 'TradingView (light theme, white background, teal/coral candles)',
      bg: [255, 255, 255],
      bullColor: [8, 153, 129],
      bearColor: [242, 54, 69],
      plotBox: { x0: 0.06, y0: 0.10, x1: 0.78, y1: 0.88 },
    },
  ];

  for (const profile of profiles) {
    it(`recognizes chart region and isolates candles on ${profile.name}`, () => {
      const rgba = renderBrokerLayoutFrame(320, 180, profile, true);
      const digest = processFrameLocally(rgba, 320, 180, null);
      assert.equal(digest.chartDetected, true, `Failed to detect chart on ${profile.name}`);
      assert.ok(digest.chartBounds !== null);
      // Must not over-expand into right-side UI Buy/Sell buttons when present
      assert.ok(
        digest.chartBounds.x + digest.chartBounds.width <= Math.min(1, profile.plotBox.x1 + 0.08),
        `Chart bounds leaked into side UI on ${profile.name}: x+w=${digest.chartBounds.x + digest.chartBounds.width}`
      );
      // Must verify relative coordinate mapping remains strictly inside detected bounds
      const relX = 0.85;
      const relY = 0.45;
      const mappedX = digest.chartBounds.x + relX * digest.chartBounds.width;
      const mappedY = digest.chartBounds.y + relY * digest.chartBounds.height;
      assert.ok(mappedX >= digest.chartBounds.x && mappedX <= digest.chartBounds.x + digest.chartBounds.width);
      assert.ok(mappedY >= digest.chartBounds.y && mappedY <= digest.chartBounds.y + digest.chartBounds.height);
    });
  }

  it('rejects non-chart windows containing only solid green/red UI buttons', () => {
    const nonChartRgba = renderBrokerLayoutFrame(320, 180, profiles[0], false);
    const digest = processFrameLocally(nonChartRgba, 320, 180, null);
    assert.equal(digest.chartDetected, false);
    assert.equal(digest.chartBounds, null);
  });
});

describe('ChartPulse AI — Temporary Test Confidence (65%) & Preserved Production Config (90%)', () => {
  it('enforces temporary 65% signal confidence across all validators while preserving original 90% production constant', () => {
    assert.equal(PRODUCTION_MIN_SIGNAL_CONFIDENCE, 90);
    assert.equal(TEMPORARY_TEST_MIN_SIGNAL_CONFIDENCE, 65);
    assert.equal(USE_TEMPORARY_TEST_CONFIDENCE, true);
    assert.equal(MIN_SIGNAL_CONFIDENCE, 65);
    assert.equal(MIN_OPERATIONAL_CONFIDENCE, 65);

    const below65 = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'COMPRA',
      confidence: 64,
      rawRegime: 'TRENDING_UP',
    });
    assert.equal(below65.signal, 'NONE');
    assert.equal(below65.confidence, 64);

    const at58 = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'VENDA',
      confidence: 58,
      rawRegime: 'TRENDING_DOWN',
    });
    assert.equal(at58.signal, 'NONE');
    assert.equal(at58.confidence, 58);

    const at65Buy = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'COMPRA',
      confidence: 65,
      rawRegime: 'TRENDING_UP',
    });
    assert.equal(at65Buy.signal, 'COMPRA');
    assert.equal(at65Buy.confidence, 65);

    const at72Sell = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'VENDA',
      confidence: 72,
      rawRegime: 'TRENDING_DOWN',
    });
    assert.equal(at72Sell.signal, 'VENDA');
    assert.equal(at72Sell.confidence, 72);

    const at92Buy = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'COMPRA',
      confidence: 92,
      rawRegime: 'TRENDING_UP',
    });
    assert.equal(at92Buy.signal, 'COMPRA');
    assert.equal(at92Buy.confidence, 92);

    assert.equal(isSignalConfidenceValid(64), false);
    assert.equal(isSignalConfidenceValid(65), true);
  });

  it('classifies auth, quota 429, and API unavailability errors safely without leaking keys', () => {
    const authErr = classifyGeminiUpstreamError({ status: 403, message: 'PERMISSION_DENIED AIzaSecret123' });
    assert.equal(authErr.category, 'AUTH');
    assert.equal(authErr.httpStatus, 401);
    assert.equal(authErr.userMessage.includes('AIzaSecret123'), false);

    const quotaErr = classifyGeminiUpstreamError({ status: 429, message: 'RESOURCE_EXHAUSTED' });
    assert.equal(quotaErr.category, 'RATE_LIMIT');
    assert.equal(quotaErr.httpStatus, 429);

    const unavailableErr = classifyGeminiUpstreamError({ status: 503, message: 'Service Unavailable' });
    assert.equal(unavailableErr.category, 'UNAVAILABLE');
    assert.equal(unavailableErr.httpStatus, 503);
  });

  it('returns clear 503 configuration message via Netlify Function when GEMINI_API_KEY is unset', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const validDummyBase64 = 'A'.repeat(200);
      const coreResult = await executeGeminiFrameAnalysis({
        imageBase64: validDummyBase64,
        mimeType: 'image/jpeg',
        sessionId: 'netlify-test-session',
      });
      assert.equal(coreResult.status, 503);
      assert.match(coreResult.body.error ?? '', /GEMINI_API_KEY/);

      const webReq = new Request('https://example.netlify.app/api/analyze-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: validDummyBase64,
          mimeType: 'image/jpeg',
          sessionId: 'netlify-test-session',
        }),
      });
      const webRes = await netlifyAnalyzeHandler(webReq);
      assert.equal(webRes.status, 503);
      const parsed = (await webRes.json()) as { ok: boolean; error?: string };
      assert.equal(parsed.ok, false);
      assert.match(parsed.error ?? '', /GEMINI_API_KEY/);
    } finally {
      if (originalKey !== undefined) {
        process.env.GEMINI_API_KEY = originalKey;
      }
    }
  });
});

describe('ChartPulse AI — Local Windows Overlay Origin Security', () => {
  it('allows Netlify HTTPS sites, localhost, and configured custom origins while blocking untrusted external sites', () => {
    assert.equal(isTrustedOverlayOrigin('https://chartpulse-ai.netlify.app'), true);
    assert.equal(isTrustedOverlayOrigin('http://localhost:3000'), true);
    assert.equal(isTrustedOverlayOrigin('http://127.0.0.1:3000'), true);
    assert.equal(
      isTrustedOverlayOrigin('https://custom-domain.com', ['https://custom-domain.com']),
      true
    );

    // Reject untrusted external websites, null origins, and suffix-spoofed domains
    assert.equal(isTrustedOverlayOrigin('https://evil.com'), false);
    assert.equal(isTrustedOverlayOrigin('https://netlify.app.evil.com'), false);
    assert.equal(isTrustedOverlayOrigin('http://chartpulse.netlify.app'), false);
    assert.equal(isTrustedOverlayOrigin(''), false);
  });
});

describe('ChartPulse AI — Netlify Deploy, SPA Fallback & All 5 Functions', () => {
  it('verifies netlify.toml publish=dist, functions directory, and non-conflicting SPA fallback', () => {
    const toml = fs.readFileSync(path.resolve('netlify.toml'), 'utf8');
    assert.match(toml, /command\s*=\s*"npm run build"/);
    assert.match(toml, /publish\s*=\s*"dist"/);
    assert.match(toml, /directory\s*=\s*"netlify\/functions"/);
    assert.match(toml, /from\s*=\s*"\/api\/analyze-frame"/);
    assert.match(toml, /from\s*=\s*"\/api\/health"/);
    assert.match(toml, /from\s*=\s*"\/api\/overlay\/session"/);
    assert.match(toml, /from\s*=\s*"\/api\/overlay-session"/);
    assert.match(toml, /from\s*=\s*"\/\*"\s*\n\s*to\s*=\s*"\/index\.html"\s*\n\s*status\s*=\s*200/);
  });

  it('verifies dist/index.html and dist/_redirects are generated after Vite build', () => {
    const distIndex = path.resolve('dist/index.html');
    const distRedirects = path.resolve('dist/_redirects');
    assert.equal(fs.existsSync(distIndex), true, 'dist/index.html must exist after build');
    assert.equal(fs.existsSync(distRedirects), true, 'dist/_redirects must exist after build');

    const html = fs.readFileSync(distIndex, 'utf8');
    assert.match(html, /<title>ChartPulse AI<\/title>/);

    const redirects = fs.readFileSync(distRedirects, 'utf8');
    const apiIdx = redirects.indexOf('/api/analyze-frame');
    const spaIdx = redirects.indexOf('/* /index.html 200');
    assert.ok(apiIdx >= 0 && spaIdx > apiIdx, 'API redirects must precede SPA fallback');
  });

  it('verifies health, overlay-session, overlay-clear, and overlay-state Netlify Functions', async () => {
    const healthRes = await netlifyHealthHandler();
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { ok: boolean };
    assert.equal(healthJson.ok, true);

    const sessReq = new Request('https://example.netlify.app/api/overlay/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-netlify-1' }),
    });
    const sessRes = await netlifyOverlaySessionHandler(sessReq);
    assert.equal(sessRes.status, 200);
    const sessJson = (await sessRes.json()) as { ok: boolean; sessionId: string };
    assert.equal(sessJson.ok, true);
    assert.equal(sessJson.sessionId, 'sess-netlify-1');

    const clearReq = new Request('https://example.netlify.app/api/overlay/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-netlify-1' }),
    });
    const clearRes = await netlifyOverlayClearHandler(clearReq);
    assert.equal(clearRes.status, 200);

    const stateRes = await netlifyOverlayStateHandler();
    assert.equal(stateRes.status, 200);
    const stateJson = (await stateRes.json()) as { active: boolean; priceLine: unknown };
    assert.equal(stateJson.active, false);
    assert.equal(stateJson.priceLine, null);

    const priceReq = new Request('https://example.netlify.app/api/overlay/price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-netlify-1',
        priceLine: {
          y: 0.44,
          chartRelativeY: 0.48,
          chartBounds: { x: 0.05, y: 0.1, width: 0.78, height: 0.75 },
          confidence: 0.94,
          source: 'PRICE_LINE',
          updatedAt: Date.now(),
        },
      }),
    });
    const priceRes = await netlifyOverlayPriceHandler(priceReq);
    assert.equal(priceRes.status, 200);
  });
});

function renderChartWithLivePriceFrame(params: {
  width: number;
  height: number;
  bg: [number, number, number];
  bullColor: [number, number, number];
  bearColor: [number, number, number];
  priceRowFrac?: number;
  drawPriceLine?: boolean;
  drawRightAxisPill?: boolean;
  drawGridLines?: boolean;
  monochromeRightmost?: boolean;
}): Uint8ClampedArray {
  const {
    width,
    height,
    bg,
    bullColor,
    bearColor,
    priceRowFrac = 0.42,
    drawPriceLine = true,
    drawRightAxisPill = true,
    drawGridLines = true,
    monochromeRightmost = false,
  } = params;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }

  const paintRect = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: [number, number, number]
  ) => {
    for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
        const idx = (y * width + x) * 4;
        rgba[idx] = color[0];
        rgba[idx + 1] = color[1];
        rgba[idx + 2] = color[2];
      }
    }
  };

  const plotX0 = Math.round(width * 0.06);
  const plotX1 = Math.round(width * 0.80);
  const plotY0 = Math.round(height * 0.12);
  const plotY1 = Math.round(height * 0.86);

  // Repeating low-saturation background grid lines (must be ignored by price line detector)
  if (drawGridLines) {
    const gridColor: [number, number, number] = [
      Math.min(255, bg[0] + 40),
      Math.min(255, bg[1] + 40),
      Math.min(255, bg[2] + 40),
    ];
    for (const frac of [0.22, 0.37, 0.52, 0.67, 0.80]) {
      const gy = Math.round(height * frac);
      paintRect(plotX0, gy, plotX1, gy, gridColor);
    }
  }

  // Draw 10 candlesticks inside the plot
  const totalCandles = 10;
  const candlesSpan = Math.round((plotX1 - plotX0) * 0.72);
  const stepX = Math.max(10, Math.floor(candlesSpan / totalCandles));
  const priceY = Math.round(height * priceRowFrac);

  for (let i = 0; i < totalCandles; i++) {
    const cx = plotX0 + 18 + i * stepX;
    const isLast = i === totalCandles - 1;
    const isBull = i % 2 === 0;
    const color: [number, number, number] =
      isLast && monochromeRightmost
        ? [240, 240, 240]
        : isBull
          ? bullColor
          : bearColor;

    const bodyTop = isLast
      ? isBull
        ? priceY
        : Math.max(plotY0 + 8, priceY - 24)
      : plotY0 + 25 + ((i * 11) % 55);
    const bodyBottom = isLast
      ? isBull
        ? Math.min(plotY1 - 8, priceY + 24)
        : priceY
      : bodyTop + 20;

    paintRect(cx + 3, bodyTop - 6, cx + 3, bodyBottom + 6, color);
    paintRect(cx, bodyTop, cx + 6, bodyBottom, color);
  }

  if (drawPriceLine) {
    const lineColor: [number, number, number] = [56, 189, 248];
    const lineStart = plotX0 + 18 + (totalCandles - 1) * stepX + 3;
    paintRect(lineStart, priceY, plotX1, priceY + 1, lineColor);
  }

  if (drawRightAxisPill) {
    paintRect(plotX1 + 2, priceY - 5, plotX1 + 30, priceY + 5, [56, 189, 248]);
  }

  return rgba;
}

describe('ChartPulse AI — Real-Time Price Tracking Line & Windows Overlay Sync', () => {
  it('detects live horizontal price line accurately across dark and light charts while ignoring grid lines', () => {
    const darkRgba = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [19, 23, 34],
      bullColor: [8, 153, 129],
      bearColor: [242, 54, 69],
      priceRowFrac: 0.38,
      drawPriceLine: true,
      drawRightAxisPill: true,
      drawGridLines: true,
    });
    const darkDigest = processFrameLocally(darkRgba, 640, 360, null);
    assert.equal(darkDigest.chartDetected, true);
    assert.ok(darkDigest.priceLine !== null);
    assert.equal(darkDigest.priceLine.source, 'PRICE_LINE');
    assert.ok(
      Math.abs(darkDigest.priceLine.y - 0.38) <= 0.015,
      `Expected dark priceLine.y near 0.38, got ${darkDigest.priceLine.y}`
    );

    const lightRgba = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [255, 255, 255],
      bullColor: [8, 153, 129],
      bearColor: [242, 54, 69],
      priceRowFrac: 0.61,
      drawPriceLine: true,
      drawRightAxisPill: true,
      drawGridLines: true,
    });
    const lightDigest = processFrameLocally(lightRgba, 640, 360, null);
    assert.equal(lightDigest.chartDetected, true);
    assert.ok(lightDigest.priceLine !== null);
    assert.ok(
      Math.abs(lightDigest.priceLine.y - 0.61) <= 0.015,
      `Expected light priceLine.y near 0.61, got ${lightDigest.priceLine.y}`
    );
  });

  it('tracks vertical price movement dynamically when the active price shifts', () => {
    const frameUp = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [19, 23, 34],
      bullColor: [34, 197, 94],
      bearColor: [239, 68, 68],
      priceRowFrac: 0.30,
      drawPriceLine: true,
      drawRightAxisPill: true,
    });
    const frameDown = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [19, 23, 34],
      bullColor: [34, 197, 94],
      bearColor: [239, 68, 68],
      priceRowFrac: 0.66,
      drawPriceLine: true,
      drawRightAxisPill: true,
    });

    const d1 = processFrameLocally(frameUp, 640, 360, null);
    const d2 = processFrameLocally(frameDown, 640, 360, d1.signature);
    assert.ok(d1.priceLine !== null && d2.priceLine !== null);
    assert.ok(d2.priceLine.y > d1.priceLine.y + 0.30);
  });

  it('falls back to unambiguous colored rightmost candle close when no horizontal price line is drawn, and returns null when ambiguous', () => {
    const coloredCloseRgba = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [19, 23, 34],
      bullColor: [34, 197, 94],
      bearColor: [239, 68, 68],
      priceRowFrac: 0.45,
      drawPriceLine: false,
      drawRightAxisPill: false,
      drawGridLines: false,
    });
    const coloredDigest = processFrameLocally(coloredCloseRgba, 640, 360, null);
    assert.equal(coloredDigest.chartDetected, true);
    assert.ok(coloredDigest.priceLine !== null);
    assert.equal(coloredDigest.priceLine.source, 'CANDLE_CLOSE');
    assert.ok(Math.abs(coloredDigest.priceLine.y - 0.45) <= 0.02);

    // Monochrome candle with no horizontal price line -> ambiguous close -> must NOT invent a line
    const ambiguousRgba = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [0, 0, 0],
      bullColor: [0, 255, 0],
      bearColor: [255, 255, 255],
      priceRowFrac: 0.45,
      drawPriceLine: false,
      drawRightAxisPill: false,
      drawGridLines: false,
      monochromeRightmost: true,
    });
    const ambiguousDigest = processFrameLocally(ambiguousRgba, 640, 360, null);
    assert.equal(ambiguousDigest.priceLine, null);

    // Empty frame -> must NOT invent a line
    const emptyRgba = new Uint8ClampedArray(640 * 360 * 4);
    const emptyDigest = processFrameLocally(emptyRgba, 640, 360, null);
    assert.equal(emptyDigest.chartDetected, false);
    assert.equal(emptyDigest.priceLine, null);
  });

  it('verifies ChartPulseOverlayHost.cs supports click-through transparent tracking line, window tracking, and /overlay/price', () => {
    const cs = fs.readFileSync(
      path.resolve('native/windows-overlay/win-agent/ChartPulseOverlayHost.cs'),
      'utf8'
    );
    assert.match(cs, /WS_EX_TRANSPARENT/);
    assert.match(cs, /WS_EX_LAYERED/);
    assert.match(cs, /DwmGetWindowAttribute/);
    assert.match(cs, /"\/overlay\/price"/);
    assert.match(cs, /UpdatePriceLine/);
    assert.match(cs, /HasPriceLine/);
    assert.match(cs, /priceLineSupported/);
  });
});

describe('ChartPulse AI — Additional Live Forming Candle Tracking', () => {
  it('tracks the most recent forming candle vertically and horizontally without modifying priceLine or 90% signals', () => {
    const upFrame = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [19, 23, 34],
      bullColor: [34, 197, 94],
      bearColor: [239, 68, 68],
      priceRowFrac: 0.34,
      drawPriceLine: true,
      drawRightAxisPill: true,
      drawGridLines: true,
    });
    const upDigest = processFrameLocally(upFrame, 640, 360, null);
    assert.equal(upDigest.chartDetected, true);
    assert.ok(upDigest.priceLine !== null);

    const upCandle = detectLiveMovingCandle(
      upFrame,
      640,
      360,
      upDigest.chartBounds,
      upDigest.priceLine
    );
    assert.ok(upCandle !== null);
    assert.equal(upCandle.direction, 'BEAR');
    assert.ok(
      Math.abs(upCandle.y - 0.34) <= 0.02,
      `Expected forming candle y near 0.34, got ${upCandle.y}`
    );
    assert.ok(upCandle.x > 0.5 && upCandle.x < 0.8);

    const downFrame = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [19, 23, 34],
      bullColor: [34, 197, 94],
      bearColor: [239, 68, 68],
      priceRowFrac: 0.64,
      drawPriceLine: true,
      drawRightAxisPill: true,
      drawGridLines: true,
    });
    const downDigest = processFrameLocally(downFrame, 640, 360, upDigest.signature);
    const downCandle = detectLiveMovingCandle(
      downFrame,
      640,
      360,
      downDigest.chartBounds,
      downDigest.priceLine
    );
    assert.ok(downCandle !== null);
    assert.ok(downCandle.y > upCandle.y + 0.25);

    // Centralized signal precision filter accepts >= 65% (temporary test limit) and rejects < 65%
    assert.equal(MIN_SIGNAL_CONFIDENCE, 65);
    const rejected64 = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'COMPRA',
      confidence: 64,
      rawRegime: 'TRENDING_UP',
    });
    assert.equal(rejected64.signal, 'NONE');
    const accepted68 = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'COMPRA',
      confidence: 68,
      rawRegime: 'TRENDING_UP',
    });
    assert.equal(accepted68.signal, 'COMPRA');
    assert.equal(accepted68.confidence, 68);
  });

  it('tracks colored forming candle close even without a horizontal priceLine, and returns null when ambiguous or missing chart', () => {
    const coloredOnly = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [19, 23, 34],
      bullColor: [16, 185, 129],
      bearColor: [244, 63, 94],
      priceRowFrac: 0.48,
      drawPriceLine: false,
      drawRightAxisPill: true,
      drawGridLines: false,
    });
    const digest = processFrameLocally(coloredOnly, 640, 360, null);
    assert.equal(digest.chartDetected, true);
    const live = detectLiveMovingCandle(coloredOnly, 640, 360, digest.chartBounds, null);
    assert.ok(live !== null);
    assert.ok(Math.abs(live.y - 0.48) <= 0.02);

    const empty = new Uint8ClampedArray(640 * 360 * 4);
    assert.equal(detectLiveMovingCandle(empty, 640, 360, digest.chartBounds, null), null);
    assert.equal(detectLiveMovingCandle(coloredOnly, 640, 360, null, null), null);

    const ambiguousMono = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [0, 0, 0],
      bullColor: [0, 255, 0],
      bearColor: [255, 255, 255],
      priceRowFrac: 0.45,
      drawPriceLine: false,
      drawRightAxisPill: false,
      drawGridLines: false,
      monochromeRightmost: true,
    });
    const monoDigest = processFrameLocally(ambiguousMono, 640, 360, null);
    assert.equal(
      detectLiveMovingCandle(ambiguousMono, 640, 360, monoDigest.chartBounds, null),
      null
    );
  });

  it('verifies Netlify overlay-candle, overlay-state, redirects, and Windows C# agent v1.2.0 contract', async () => {
    const stateRes = await netlifyOverlayStateHandler();
    assert.equal(stateRes.status, 200);
    const stateJson = (await stateRes.json()) as { liveCandle: unknown; priceLine: unknown };
    assert.equal(stateJson.liveCandle, null);
    assert.equal(stateJson.priceLine, null);

    const badReq = new Request('https://example.netlify.app/api/overlay/candle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const badRes = await netlifyOverlayCandleHandler(badReq);
    assert.equal(badRes.status, 400);

    const candleReq = new Request('https://example.netlify.app/api/overlay/candle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-candle-1',
        liveCandle: {
          x: 0.68,
          y: 0.44,
          chartRelativeX: 0.82,
          chartRelativeY: 0.46,
          topY: 0.38,
          bottomY: 0.49,
          direction: 'BULL',
          chartBounds: { x: 0.05, y: 0.1, width: 0.78, height: 0.75 },
          confidence: 0.88,
          updatedAt: Date.now(),
        },
      }),
    });
    const candleRes = await netlifyOverlayCandleHandler(candleReq);
    assert.equal(candleRes.status, 200);

    const toml = fs.readFileSync(path.resolve('netlify.toml'), 'utf8');
    assert.match(toml, /from\s*=\s*"\/api\/overlay\/candle"/);
    assert.match(toml, /from\s*=\s*"\/api\/overlay-candle"/);

    const cs = fs.readFileSync(
      path.resolve('native/windows-overlay/win-agent/ChartPulseOverlayHost.cs'),
      'utf8'
    );
    assert.match(cs, /"\/overlay\/candle"/);
    assert.match(cs, /UpdateLiveCandle/);
    assert.match(cs, /HasLiveCandle/);
    assert.match(cs, /liveCandleSupported/);
    assert.match(cs, /\\"version\\":\\"1\.3\.2\\"/);
    assert.match(cs, /"\/overlay\/price"/);
    assert.match(cs, /"\/overlay\/signal"/);
  });
});

describe('ChartPulse AI — M1 Timeframe (1 Minute) End-to-End Detection & Windows Overlay Audit', () => {
  it('detects narrow zoomed-out M1 candles with tight vertical range and dashed horizontal price line', () => {
    const width = 1280;
    const height = 720;
    const bg: [number, number, number] = [19, 23, 34];
    const bull: [number, number, number] = [14, 203, 129];
    const bear: [number, number, number] = [246, 70, 93];
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
      rgba[i * 4 + 3] = 255;
    }

    const paint = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
      for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = c[0];
          rgba[idx + 1] = c[1];
          rgba[idx + 2] = c[2];
        }
      }
    };

    // 55 narrow 3px-wide M1 candles in a tight 8% vertical consolidation band
    const basePy = Math.round(height * 0.44);
    const livePricePy = Math.round(height * 0.41);
    let lastCandleX = 0;
    for (let i = 0; i < 55; i++) {
      const cx = Math.round(width * 0.08) + i * 11;
      lastCandleX = cx;
      const isLast = i === 54;
      const isBull = i % 2 === 0;
      const color = isBull ? bull : bear;
      const top = isLast ? livePricePy : basePy + ((i * 5) % 24);
      const bot = isLast ? livePricePy + 18 : top + 12 + (i % 8);
      paint(cx + 1, top - 4, cx + 1, bot + 4, color); // 1px wick
      paint(cx, top, cx + 2, bot, color); // 3px wide M1 body
    }

    // Right-side solid Buy/Sell broker buttons (must be excluded from chartBounds)
    paint(Math.round(width * 0.87), Math.round(height * 0.35), Math.round(width * 0.96), Math.round(height * 0.45), bull);
    paint(Math.round(width * 0.87), Math.round(height * 0.50), Math.round(width * 0.96), Math.round(height * 0.60), bear);

    // Dashed M1 horizontal price line (4px on, 4px off -> ~50% dashed coverage) + right axis pill
    for (let x = lastCandleX + 2; x <= Math.round(width * 0.81); x++) {
      if (Math.floor(x / 4) % 2 === 0) {
        paint(x, livePricePy, x, livePricePy + 1, [56, 189, 248]);
      }
    }
    paint(Math.round(width * 0.815), livePricePy - 7, Math.round(width * 0.855), livePricePy + 7, [56, 189, 248]);

    const digest = processFrameLocally(rgba, width, height, null);
    assert.equal(digest.chartDetected, true, 'Must detect M1 chart with narrow 3px candles');
    assert.ok(digest.chartBounds !== null);
    assert.ok(digest.chartBounds.x + digest.chartBounds.width < 0.86, 'Must not leak into Buy/Sell panel');
    assert.ok(digest.priceLine !== null, 'Must detect dashed M1 price line');
    assert.equal(digest.priceLine.source, 'PRICE_LINE');
    assert.ok(Math.abs(digest.priceLine.y - 0.41) <= 0.015);

    const liveCandle = detectLiveMovingCandle(rgba, width, height, digest.chartBounds, digest.priceLine);
    assert.ok(liveCandle !== null, 'Must locate forming M1 candle');
    assert.equal(liveCandle.direction, 'BULL');
    assert.ok(Math.abs(liveCandle.y - 0.41) <= 0.015);
    assert.ok(Math.abs(liveCandle.x - lastCandleX / width) <= 0.015);
  });

  it('tracks zoomed-in wickless Marubozu M1 candle and newly opened 2px M1 candle cleanly', () => {
    const width = 640;
    const height = 360;
    const bg: [number, number, number] = [28, 32, 48];
    const bull: [number, number, number] = [34, 197, 94];
    const bear: [number, number, number] = [239, 68, 68];

    const makeFrame = (lastHeightPx: number, lastWidthPx: number) => {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = bg[0];
        rgba[i * 4 + 1] = bg[1];
        rgba[i * 4 + 2] = bg[2];
        rgba[i * 4 + 3] = 255;
      }
      const paint = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
        for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
          for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
            const idx = (y * width + x) * 4;
            rgba[idx] = c[0];
            rgba[idx + 1] = c[1];
            rgba[idx + 2] = c[2];
          }
        }
      };

      // Draw 8 zoomed-in M1 candles, ending with a wickless Marubozu or newly-opened 2px M1 candle
      for (let i = 0; i < 8; i++) {
        const x0 = 70 + i * 48;
        const isLast = i === 7;
        const c = i % 2 === 0 ? bear : bull;
        if (isLast) {
          paint(x0, 150, x0 + lastWidthPx - 1, 150 + lastHeightPx - 1, bull);
        } else {
          paint(x0 + 5, 110 + i * 5, x0 + 5, 190 + i * 4, c);
          paint(x0, 125 + i * 5, x0 + 10, 175 + i * 4, c);
        }
      }
      return rgba;
    };

    // Case 1: Zoomed-in 14px-wide x 36px-tall wickless M1 candle (must NOT be rejected as pill)
    const marubozuRgba = makeFrame(36, 14);
    const dMaru = processFrameLocally(marubozuRgba, width, height, null);
    assert.equal(dMaru.chartDetected, true);
    assert.ok(dMaru.priceLine !== null, 'Wickless M1 candle must yield CANDLE_CLOSE priceLine');
    const cMaru = detectLiveMovingCandle(marubozuRgba, width, height, dMaru.chartBounds, dMaru.priceLine);
    assert.ok(cMaru !== null, 'Must track wickless M1 Marubozu candle');
    assert.equal(cMaru.direction, 'BULL');
    assert.ok(Math.abs(cMaru.x - (70 + 7 * 48 + 6.5) / width) <= 0.02);

    // Case 2: Newly-opened 2px-tall colored M1 candle (start of the 1-minute candle)
    const tinyOpenRgba = makeFrame(2, 8);
    const dTiny = processFrameLocally(tinyOpenRgba, width, height, null);
    assert.equal(dTiny.chartDetected, true);
    const cTiny = detectLiveMovingCandle(tinyOpenRgba, width, height, dTiny.chartBounds, dTiny.priceLine);
    assert.ok(cTiny !== null, 'Must track newly opened 2px M1 candle');
    assert.equal(cTiny.direction, 'BULL');
    assert.ok(Math.abs(cTiny.y - 150 / height) <= 0.015);
  });

  it('verifies Windows overlay Win32 DPI awareness, Z-order, monitor surface mapping, and diagnostics', () => {
    const cs = fs.readFileSync(
      path.resolve('native/windows-overlay/win-agent/ChartPulseOverlayHost.cs'),
      'utf8'
    );
    assert.match(cs, /SetProcessDPIAware/);
    assert.match(cs, /CreateParams/);
    assert.match(cs, /ShowWithoutActivation/);
    assert.match(cs, /HWND_TOPMOST/);
    assert.match(cs, /SetWindowPos/);
    assert.match(cs, /DisplaySurface == "monitor"/);
    assert.match(cs, /BuildDiagnosticsJson/);
    assert.match(cs, /overlay-debug\.log/);
  });
});

describe('ChartPulse AI — Permanent M1 Operational Status Indicator (AGUARDANDO / COMPRA / VENDA)', () => {
  it('positions AGUARDANDO/COMPRA/VENDA centered directly above the forming M1 candle and tracks movement without inventing fallback positions', () => {
    assert.equal(MANDATORY_TIMEFRAME, 'M1');
    const bounds = { x: 0.06, y: 0.1, width: 0.76, height: 0.74 };
    const t0 = 1_700_000_000_000;

    // 1. No candle identified yet => anchor must be null (never invent fixed screen coordinates)
    const initial = createInitialOperationalStatus(bounds, null, t0);
    assert.equal(initial.status, 'AGUARDANDO');
    assert.equal(initial.timeframe, 'M1');
    assert.equal(initial.anchor, null);
    assert.equal(computeCandleStatusAnchor(null, bounds, t0), null);

    // 2. Render two real M1 chart frames where the forming M1 candle moves upward and verify live anchor tracks it above its top
    const frameLower = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [19, 23, 34],
      bullColor: [34, 197, 94],
      bearColor: [239, 68, 68],
      priceRowFrac: 0.56,
      drawPriceLine: true,
      drawRightAxisPill: true,
      drawGridLines: true,
    });
    const digestLower = processFrameLocally(frameLower, 640, 360, null);
    assert.equal(digestLower.chartDetected, true);
    const liveLower = detectLiveMovingCandle(
      frameLower,
      640,
      360,
      digestLower.chartBounds,
      digestLower.priceLine
    );
    assert.ok(liveLower !== null);

    const statusLower = resolveOperationalStatus({
      isActive: true,
      current: initial,
      activeSignal: null,
      liveCandle: liveLower,
      latestBounds: digestLower.chartBounds,
      chartDetected: true,
      now: t0 + 350,
    });
    assert.ok(statusLower !== null && statusLower.anchor !== null);
    assert.equal(statusLower.status, 'AGUARDANDO');
    assert.ok(
      Math.abs(statusLower.anchor.x - liveLower.x) <= 0.015,
      `Expected status horizontally centered on candle x=${liveLower.x}, got ${statusLower.anchor.x}`
    );
    assert.ok(
      statusLower.anchor.y < liveLower.topY,
      `Expected status strictly above candle topY=${liveLower.topY}, got ${statusLower.anchor.y}`
    );

    const frameHigher = renderChartWithLivePriceFrame({
      width: 640,
      height: 360,
      bg: [19, 23, 34],
      bullColor: [34, 197, 94],
      bearColor: [239, 68, 68],
      priceRowFrac: 0.34,
      drawPriceLine: true,
      drawRightAxisPill: true,
      drawGridLines: true,
    });
    const digestHigher = processFrameLocally(frameHigher, 640, 360, digestLower.signature);
    const liveHigher = detectLiveMovingCandle(
      frameHigher,
      640,
      360,
      digestHigher.chartBounds,
      digestHigher.priceLine
    );
    assert.ok(liveHigher !== null);

    const statusHigher = resolveOperationalStatus({
      isActive: true,
      current: statusLower,
      activeSignal: null,
      liveCandle: liveHigher,
      latestBounds: digestHigher.chartBounds,
      chartDetected: true,
      now: t0 + 700,
    });
    assert.ok(statusHigher !== null && statusHigher.anchor !== null);
    assert.equal(statusHigher.status, 'AGUARDANDO');
    assert.ok(
      statusHigher.anchor.y < statusLower.anchor.y - 0.1,
      `Expected status anchor Y to rise with candle (${statusHigher.anchor.y} < ${statusLower.anchor.y})`
    );
    assert.ok(operationalStatusChanged(statusLower, statusHigher));

    // 3. Momentary weak candidate (< 65%) stays AGUARDANDO at the exact candle anchor
    const filteredWeak = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'COMPRA',
      confidence: 62,
      rawRegime: 'TRENDING_UP',
    });
    assert.equal(filteredWeak.signal, 'NONE');

    const weakCandidateSig = {
      id: 'sig-weak-1',
      direction: 'COMPRA' as const,
      candleX: liveHigher.x,
      candleY: liveHigher.y,
      chartRelativeX: liveHigher.chartRelativeX,
      chartRelativeY: liveHigher.chartRelativeY,
      chartBounds: digestHigher.chartBounds,
      confidence: 62,
      candleId: 'm1-right-weak',
      marketRegime: 'TRENDING_UP' as const,
      createdAt: t0 + 800,
      expiresAt: t0 + 18800,
    };
    const weakStatus = resolveOperationalStatus({
      isActive: true,
      current: statusHigher,
      activeSignal: weakCandidateSig,
      liveCandle: liveHigher,
      latestBounds: digestHigher.chartBounds,
      chartDetected: true,
      now: t0 + 900,
    });
    assert.ok(weakStatus !== null && weakStatus.anchor !== null);
    assert.equal(weakStatus.status, 'AGUARDANDO');

    // 4. Confirmed M1 COMPRA (>= 65% temporary test threshold) replaces AGUARDANDO -> COMPRA while keeping exact candle anchor above candle
    const buySig = {
      id: 'sig-buy-1',
      direction: 'COMPRA' as const,
      candleX: liveHigher.x,
      candleY: liveHigher.y,
      chartRelativeX: liveHigher.chartRelativeX,
      chartRelativeY: liveHigher.chartRelativeY,
      chartBounds: digestHigher.chartBounds,
      confidence: 67,
      candleId: 'm1-right-buy',
      marketRegime: 'TRENDING_UP' as const,
      createdAt: t0 + 1000,
      expiresAt: t0 + 19000,
    };
    const buyState = resolveOperationalStatus({
      isActive: true,
      current: statusHigher,
      activeSignal: buySig,
      liveCandle: liveHigher,
      latestBounds: digestHigher.chartBounds,
      chartDetected: true,
      now: t0 + 1200,
    });
    assert.ok(buyState !== null && buyState.anchor !== null);
    assert.equal(buyState.status, 'COMPRA');
    assert.equal(buyState.confidence, 67);
    assert.equal(buyState.anchor.x, statusHigher.anchor.x);
    assert.equal(buyState.anchor.y, statusHigher.anchor.y);

    // 5. Short transient frame miss holds anchor briefly without flickering, then clears if candle disappears past hold window
    const briefHold = resolveOperationalStatus({
      isActive: true,
      current: buyState,
      activeSignal: buySig,
      liveCandle: null,
      latestBounds: digestHigher.chartBounds,
      chartDetected: true,
      now: t0 + 1200 + Math.floor(CANDLE_ANCHOR_HOLD_MS / 2),
    });
    assert.ok(briefHold !== null && briefHold.anchor !== null, 'Holds anchor across brief single-frame jitter');

    // Signal expires -> reverts smoothly to AGUARDANDO while keeping real candle anchor when candle present
    const afterBuyExpire = resolveOperationalStatus({
      isActive: true,
      current: briefHold,
      activeSignal: buySig,
      liveCandle: liveHigher,
      latestBounds: digestHigher.chartBounds,
      chartDetected: true,
      now: t0 + 20000,
    });
    assert.ok(afterBuyExpire !== null && afterBuyExpire.anchor !== null);
    assert.equal(afterBuyExpire.status, 'AGUARDANDO');

    // Prolonged candle loss (or non-chart screen) clears anchor rather than inventing a position
    const lostCandle = resolveOperationalStatus({
      isActive: true,
      current: afterBuyExpire,
      activeSignal: null,
      liveCandle: null,
      latestBounds: null,
      chartDetected: false,
      now: t0 + 25000,
    });
    assert.ok(lostCandle !== null);
    assert.equal(lostCandle.anchor, null);

    // 6. Confirmed M1 VENDA (>= 65% temporary test threshold) switches AGUARDANDO -> VENDA above the candle and stays inside chartBounds when near top/right edges
    const edgeCandle = {
      ...liveHigher,
      x: bounds.x + bounds.width - 0.005,
      y: bounds.y + 0.02,
      topY: bounds.y + 0.01,
      chartRelativeX: 0.99,
      chartRelativeY: 0.02,
      chartBounds: bounds,
    };
    const sellSig = {
      id: 'sig-sell-1',
      direction: 'VENDA' as const,
      candleX: edgeCandle.x,
      candleY: edgeCandle.y,
      chartRelativeX: edgeCandle.chartRelativeX,
      chartRelativeY: edgeCandle.chartRelativeY,
      chartBounds: bounds,
      confidence: 65,
      candleId: 'm1-right-sell',
      marketRegime: 'TRENDING_DOWN' as const,
      createdAt: t0 + 26000,
      expiresAt: t0 + 44000,
    };
    const sellState = resolveOperationalStatus({
      isActive: true,
      current: afterBuyExpire,
      activeSignal: sellSig,
      liveCandle: edgeCandle,
      latestBounds: bounds,
      chartDetected: true,
      now: t0 + 26500,
    });
    assert.ok(sellState !== null && sellState.anchor !== null);
    assert.equal(sellState.status, 'VENDA');
    assert.ok(sellState.anchor.x >= bounds.x && sellState.anchor.x <= bounds.x + bounds.width);
    assert.ok(sellState.anchor.y >= bounds.y && sellState.anchor.y <= bounds.y + bounds.height);

    // 7. Deactivating clears operational status completely
    const deactivated = resolveOperationalStatus({
      isActive: false,
      current: sellState,
      activeSignal: null,
      liveCandle: edgeCandle,
      latestBounds: bounds,
      chartDetected: true,
      now: t0 + 45000,
    });
    assert.equal(deactivated, null);
  });

  it('enforces M1 prompt rules without 30s logic and enforces temporary 65% threshold + Netlify Function validation', async () => {
    assert.equal(MIN_SIGNAL_CONFIDENCE, 65);
    assert.equal(PRODUCTION_MIN_SIGNAL_CONFIDENCE, 90);
    const analyzeCoreSrc = fs.readFileSync(path.resolve('server/analyzeFrameCore.ts'), 'utf8');
    assert.match(analyzeCoreSrc, /1 MINUTO \(M1\)/);
    assert.doesNotMatch(analyzeCoreSrc, /30\s*segundos|timeframe\s*30s|M30s/i);

    const stateRes = await netlifyOverlayStateHandler();
    assert.equal(stateRes.status, 200);
    const stateJson = (await stateRes.json()) as { operationalStatus?: unknown };
    assert.equal(stateJson.operationalStatus, null);

    // Below 65% confidence on COMPRA must be downgraded to AGUARDANDO by Netlify overlay-status
    const rejectedStatusReq = new Request('https://example.netlify.app/api/overlay/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-m1-status',
        operationalStatus: {
          status: 'COMPRA',
          timeframe: 'M1',
          confidence: 64,
          anchor: { x: 0.72, y: 0.35, chartRelativeX: 0.84, chartRelativeY: 0.33 },
        },
      }),
    });
    const rejectedStatusRes = await netlifyOverlayStatusHandler(rejectedStatusReq);
    assert.equal(rejectedStatusRes.status, 200);
    const rejectedStatusBody = (await rejectedStatusRes.json()) as {
      ok: boolean;
      status: string;
    };
    assert.equal(rejectedStatusBody.status, 'AGUARDANDO');

    // >= 65% confidence on COMPRA is accepted by Netlify overlay-status
    const acceptedStatusReq = new Request('https://example.netlify.app/api/overlay/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-m1-status',
        operationalStatus: {
          status: 'COMPRA',
          timeframe: 'M1',
          confidence: 66,
          anchor: { x: 0.72, y: 0.35, chartRelativeX: 0.84, chartRelativeY: 0.33 },
        },
      }),
    });
    const acceptedStatusRes = await netlifyOverlayStatusHandler(acceptedStatusReq);
    assert.equal(acceptedStatusRes.status, 200);
    const acceptedStatusBody = (await acceptedStatusRes.json()) as {
      ok: boolean;
      status: string;
      timeframe: string;
      hasAnchor: boolean;
    };
    assert.equal(acceptedStatusBody.ok, true);
    assert.equal(acceptedStatusBody.status, 'COMPRA');
    assert.equal(acceptedStatusBody.timeframe, 'M1');
    assert.equal(acceptedStatusBody.hasAnchor, true);

    const toml = fs.readFileSync(path.resolve('netlify.toml'), 'utf8');
    assert.match(toml, /from\s*=\s*"\/api\/overlay\/status"/);
    const redirects = fs.readFileSync(path.resolve('public/_redirects'), 'utf8');
    assert.match(redirects, /\/api\/overlay\/status\s+\/\.netlify\/functions\/overlay-status\s+200!/);

    const cs = fs.readFileSync(
      path.resolve('native/windows-overlay/win-agent/ChartPulseOverlayHost.cs'),
      'utf8'
    );
    assert.match(cs, /\\"version\\":\\"1\.3\.2\\"/);
    assert.match(cs, /\\"buildId\\":\\"2026-11-20-hwnd\\"/);
    assert.match(cs, /UpdateLayeredWindow/);
    assert.match(cs, /DWMWA_CLOAKED/);
    assert.match(cs, /OverlayApplicationContext/);
    assert.match(cs, /PresentLayeredFrame/);
    assert.match(cs, /operationalStatusSupported/);
    assert.match(cs, /hasStatusAnchor/);
    assert.match(cs, /"\/overlay\/status"/);
    assert.match(cs, /HasStatusAnchor/);
    assert.match(cs, /_smoothStatusNormX/);
    assert.match(cs, /AGUARDANDO/);
    assert.match(cs, /SetProcessDpiAwarenessContext/);
    assert.match(cs, /IsWindowVisible/);
    assert.match(cs, /FindBestBrokerFallbackWindow/);
    assert.match(cs, /ThreadPool\.QueueUserWorkItem/);
    assert.match(cs, /LiveCandleTopY/);
    assert.match(cs, /UtcNowMs\(\)/);
    // Opaque status background avoids TransparencyKey Magenta bleed on WinForms layered windows
    assert.match(cs, /statusBg = new SolidBrush\(Color\.FromArgb\(255, 11, 14, 17\)\)/);
  });

  it('ignores vertical expiration/axis lines right of M1 candles, detects 2px forming candles without priceLine, and logs explicit reason when no candle exists', () => {
    const width = 640;
    const height = 360;
    const bg: [number, number, number] = [19, 23, 34];
    const bull: [number, number, number] = [34, 197, 94];
    const bear: [number, number, number] = [239, 68, 68];

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
      rgba[i * 4 + 3] = 255;
    }
    const paint = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
      for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = c[0];
          rgba[idx + 1] = c[1];
          rgba[idx + 2] = c[2];
        }
      }
    };

    // Previous M1 candles + newly opened 2px tall forming green M1 candle at x=392..395 without priceLine
    for (let i = 0; i < 12; i++) {
      const x0 = 120 + i * 22;
      const c = i % 2 === 0 ? bear : bull;
      paint(x0 + 3, 120 + i * 3, x0 + 3, 210 + i * 2, c);
      paint(x0, 140 + i * 3, x0 + 6, 185 + i * 2, c);
    }
    // Newly opened 2px M1 candle (bullTotal = 2 per column, no horizontal price line)
    const newCandleX0 = 392;
    paint(newCandleX0, 162, newCandleX0 + 3, 163, bull);

    // Full-height 1px vertical expiration line (IQ Option / Quotex style) to the right inside chartBounds
    const expLineX = 416;
    paint(expLineX, 40, expLineX, 310, [215, 222, 235]);

    const digest = processFrameLocally(rgba, width, height, null);
    assert.equal(digest.chartDetected, true);

    const detected = detectLiveMovingCandleWithReason(
      rgba,
      width,
      height,
      digest.chartBounds,
      null,
      digest.chartDetected
    );
    assert.equal(detected.reason, null);
    assert.ok(detected.candle !== null, 'Must lock onto newly opened 2px M1 candle instead of vertical expiration line');
    assert.ok(
      Math.abs(detected.candle.x - (newCandleX0 + 1.5) / width) <= 0.015,
      `Expected forming candle near ${newCandleX0}, got x=${detected.candle.x}`
    );

    const anchor = computeCandleStatusAnchor(detected.candle, digest.chartBounds);
    assert.ok(anchor !== null);
    assert.ok(anchor.y < detected.candle.topY, 'AGUARDANDO anchor must sit strictly above the 2px forming candle');

    // Non-chart frame must report explicit reason and produce null anchor (never invent position)
    const missingChart = detectLiveMovingCandleWithReason(rgba, width, height, null, null, false);
    assert.equal(missingChart.candle, null);
    assert.equal(missingChart.reason, 'chart_not_detected');
    assert.equal(computeCandleStatusAnchor(missingChart.candle, null), null);
  });

  it('enforces single dynamic rounded callout with downward arrow across web preview and native Windows overlays without duplicates', () => {
    const signalOverlaySrc = fs.readFileSync(path.resolve('src/components/SignalOverlay.tsx'), 'utf8');
    assert.match(signalOverlaySrc, /data-status-callout=\{displayStatus\}/);
    assert.match(signalOverlaySrc, /rounded-lg/);
    assert.match(signalOverlaySrc, /#22C55E/);
    assert.match(signalOverlaySrc, /#EF4444/);
    assert.match(signalOverlaySrc, /#FBBF24/);
    assert.match(signalOverlaySrc, /<polygon points="1,0 15,0 8,7"/);
    assert.doesNotMatch(signalOverlaySrc, /\{validSignal && \(/);

    const csSrc = fs.readFileSync(
      path.resolve('native/windows-overlay/win-agent/ChartPulseOverlayHost.cs'),
      'utf8'
    );
    assert.match(csSrc, /using System\.Drawing\.Drawing2D;/);
    assert.match(csSrc, /GraphicsPath callout = new GraphicsPath\(\)/);
    assert.match(csSrc, /callout\.AddArc\(/);
    assert.match(csSrc, /callout\.AddLine\(tipX \+ arrowHalfW, boxBot, tipX, boxBot \+ arrowH\)/);
    assert.match(csSrc, /Color\.FromArgb\(255, 34, 197, 94\)/);
    assert.match(csSrc, /Color\.FromArgb\(255, 239, 68, 68\)/);
    assert.match(csSrc, /Color\.FromArgb\(255, 251, 191, 36\)/);
    assert.doesNotMatch(csSrc, /\bif\s*\(hasSignal\)/);
    assert.doesNotMatch(csSrc, /MeasureString\(snapshot\.Direction/);

    const ps1Src = fs.readFileSync(path.resolve('native/windows-overlay/ChartPulseOverlay.ps1'), 'utf8');
    assert.match(ps1Src, /System\.Drawing\.Drawing2D\.GraphicsPath/);
    assert.match(ps1Src, /\$callout\.AddArc\(/);
    assert.match(ps1Src, /\$callout\.AddLine\(\$tipX \+ \$arrowHalfW, \$boxBot, \$tipX, \$boxBot \+ \$arrowH\)/);
    assert.doesNotMatch(ps1Src, /^\s*if\s*\(\$hasSignal\)/m);
    assert.doesNotMatch(ps1Src, /MeasureString\(\$dir/);

    const electronSrc = fs.readFileSync(path.resolve('native/windows-overlay/electron-main.cjs'), 'utf8');
    assert.match(electronSrc, /id="opStatus"/);
    assert.match(electronSrc, /id="opBox"/);
    assert.match(electronSrc, /id="opArrow"/);
    assert.match(electronSrc, /border-radius:\s*8px/);
    assert.doesNotMatch(electronSrc, /id="sig"/);
  });

  it('ignores colored and dashed broker vertical expiration lines so AGUARDANDO anchors to the real forming M1 candle', () => {
    const width = 640;
    const height = 360;
    const bg: [number, number, number] = [28, 32, 48];
    const bull: [number, number, number] = [14, 203, 129];
    const bear: [number, number, number] = [246, 70, 93];

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
      rgba[i * 4 + 3] = 255;
    }
    const paint = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
      for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = c[0];
          rgba[idx + 1] = c[1];
          rgba[idx + 2] = c[2];
        }
      }
    };

    for (let i = 0; i < 10; i++) {
      const x0 = 110 + i * 24;
      const c = i % 2 === 0 ? bear : bull;
      paint(x0 + 3, 125 + i * 2, x0 + 3, 210 + i * 2, c);
      paint(x0, 145 + i * 2, x0 + 6, 188 + i * 2, c);
    }

    const activeX0 = 362;
    paint(activeX0 + 3, 130, activeX0 + 3, 185, bull);
    paint(activeX0, 142, activeX0 + 6, 174, bull);

    // Colored dashed IQ Option / Quotex vertical deadline line right of the active M1 candle
    for (let py = 30; py <= 315; py += 8) {
      paint(410, py, 411, Math.min(315, py + 4), [245, 130, 32]);
    }

    const digest = processFrameLocally(rgba, width, height, null);
    assert.equal(digest.chartDetected, true);

    const detected = detectLiveMovingCandleWithReason(
      rgba,
      width,
      height,
      digest.chartBounds,
      digest.priceLine,
      digest.chartDetected
    );
    assert.equal(detected.reason, null);
    assert.ok(detected.candle !== null);
    assert.ok(
      Math.abs(detected.candle.x - (activeX0 + 3) / width) <= 0.015,
      `Expected forming M1 candle at ${activeX0 + 3}, got x=${detected.candle.x}`
    );

    const anchor = computeCandleStatusAnchor(detected.candle, digest.chartBounds);
    assert.ok(anchor !== null);
    assert.ok(Math.abs(anchor.x - detected.candle.x) <= 0.015);
    assert.ok(anchor.y < detected.candle.topY);
  });
});

describe('ChartPulse AI — Gemini API Key Protection & Bundle Isolation', () => {
  it('sanitizes AIza patterns and active GEMINI_API_KEY values from upstream error strings', () => {
    const previousKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = 'custom_secret_token_987654321';
      const msg1 = sanitizeSecretFromText('Upstream failed for key custom_secret_token_987654321 at endpoint');
      assert.equal(msg1.includes('custom_secret_token_987654321'), false);
      assert.match(msg1, /\[REDACTED\]/);

      const msg2 = sanitizeSecretFromText('Invalid API key AIzaSyD_example_1234567890abcdef');
      assert.equal(msg2.includes('AIzaSyD_example_1234567890abcdef'), false);
      assert.match(msg2, /\[REDACTED\]/);
    } finally {
      if (previousKey === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = previousKey;
      }
    }
  });

  it('rejects cross-site origins and allows same-origin, localhost, or origin-less server requests', () => {
    assert.equal(isAuthorizedSameOriginRequest('https://evil.com', 'chartpulse.netlify.app', null), false);
    assert.equal(isAuthorizedSameOriginRequest('https://chartpulse.netlify.app', 'chartpulse.netlify.app', 'cross-site'), false);
    assert.equal(isAuthorizedSameOriginRequest('https://chartpulse.netlify.app', 'chartpulse.netlify.app', 'same-origin'), true);
    assert.equal(isAuthorizedSameOriginRequest('http://localhost:3000', 'localhost:3000', 'same-origin'), true);
    assert.equal(isAuthorizedSameOriginRequest('http://127.0.0.1:3000', '127.0.0.1:3000', 'same-origin'), true);
    assert.equal(isAuthorizedSameOriginRequest(undefined, 'chartpulse.netlify.app', undefined), true);
  });

  it('returns 403 on cross-origin requests to /.netlify/functions/analyze-frame and 503 safely when key is absent on same origin', async () => {
    const evilReq = new Request('https://example.netlify.app/api/analyze-frame', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.com',
        Host: 'example.netlify.app',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ imageBase64: 'AAAA', sessionId: 'sec-test-1' }),
    });
    const evilRes = await netlifyAnalyzeHandler(evilReq);
    assert.equal(evilRes.status, 403);
    assert.equal(evilRes.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(evilRes.headers.get('Referrer-Policy'), 'no-referrer');

    const previousKey = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      const sameOriginReq = new Request('https://example.netlify.app/api/analyze-frame', {
        method: 'POST',
        headers: {
          Origin: 'https://example.netlify.app',
          Host: 'example.netlify.app',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ imageBase64: 'A'.repeat(120), sessionId: 'sec-test-2' }),
      });
      const res = await netlifyAnalyzeHandler(sameOriginReq);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
      const body = (await res.json()) as { ok: boolean; error?: string };
      assert.equal(body.ok, false);
      assert.equal((body.error ?? '').includes('AIza'), false);
    } finally {
      if (previousKey !== undefined) {
        process.env.GEMINI_API_KEY = previousKey;
      }
    }
  });

  it('keeps GEMINI_API_KEY, AIza prefixes, and @google/genai completely out of src/, vite.config.ts, and built dist/assets', () => {
    const forbiddenPatterns = [/GEMINI_API_KEY/, /AIza[0-9A-Za-z_-]{8,}/, /@google\/genai/];

    const walkFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const results: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walkFiles(full));
        } else {
          results.push(full);
        }
      }
      return results;
    };

    const srcFiles = walkFiles(path.resolve('src')).filter((f) => /\.(ts|tsx|js|jsx|html)$/.test(f));
    assert.ok(srcFiles.length > 0);
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(content, pattern, `Unexpected secret/SDK match in client file ${file}`);
      }
    }

    const viteConfig = fs.readFileSync(path.resolve('vite.config.ts'), 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(viteConfig, pattern, 'Unexpected GEMINI_API_KEY/SDK injection in vite.config.ts');
    }

    const distAssetsDir = path.resolve('dist/assets');
    assert.equal(fs.existsSync(distAssetsDir), true, 'dist/assets must exist (run npm run build before npm test)');
    const bundleFiles = walkFiles(distAssetsDir).filter((f) => f.endsWith('.js'));
    assert.ok(bundleFiles.length > 0);
    for (const bundle of bundleFiles) {
      const content = fs.readFileSync(bundle, 'utf8');
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(content, pattern, `Unexpected secret/SDK leakage in built bundle ${bundle}`);
      }
    }
  });

  it('protects local .env files via .gitignore and keeps .env.example free of real keys', () => {
    const gitignore = fs.readFileSync(path.resolve('.gitignore'), 'utf8');
    assert.match(gitignore, /^\.env\*$/m);
    assert.match(gitignore, /^!\.env\.example$/m);

    const envExample = fs.readFileSync(path.resolve('.env.example'), 'utf8');
    assert.match(envExample, /^GEMINI_API_KEY="MY_GEMINI_API_KEY"$/m);
    assert.doesNotMatch(envExample, /AIza[0-9A-Za-z_-]{8,}/);
  });
});

describe('ChartPulse AI — 8-Stage Real-Time Broker Overlay Pipeline & Non-Economy Verification', () => {
  it('Stage 1 & 2: detects zoomed-out anti-aliased thin M1 candles and ignores trailing monochrome countdown labels', () => {
    const width = 1280;
    const height = 720;
    const bg: [number, number, number] = [19, 23, 34];
    const thinBull: [number, number, number] = [28, 126, 92]; // anti-aliased dim green M1 candle
    const thinBear: [number, number, number] = [132, 48, 62]; // anti-aliased dim red M1 candle

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
      rgba[i * 4 + 3] = 255;
    }

    const paint = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
      for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = c[0];
          rgba[idx + 1] = c[1];
          rgba[idx + 2] = c[2];
        }
      }
    };

    // Draw 48 zoomed-out 3px wide M1 candles
    let activeCandleX = 0;
    for (let i = 0; i < 48; i++) {
      const cx = 130 + i * 16;
      activeCandleX = cx;
      const isBull = i % 3 !== 0;
      const c = isBull ? thinBull : thinBear;
      const top = i === 47 ? 248 : 260 + ((i * 7) % 50);
      const bot = i === 47 ? 286 : top + 18 + (i % 10);
      paint(cx + 1, top - 5, cx + 1, bot + 5, c);
      paint(cx, top, cx + 2, bot, c);
    }

    // Monochrome horizontal countdown text badge ("00:34") to the right of the forming candle inside chartBounds
    const countdownX0 = activeCandleX + 12;
    paint(countdownX0, 265, countdownX0 + 22, 274, [210, 215, 224]);

    const digest = processFrameLocally(rgba, width, height, null);
    assert.equal(digest.chartDetected, true, 'Stage 1: Must recognize M1 broker chart frame');
    assert.ok(digest.chartBounds !== null);

    const detected = detectLiveMovingCandleWithReason(
      rgba,
      width,
      height,
      digest.chartBounds,
      digest.priceLine,
      digest.chartDetected
    );
    assert.equal(detected.reason, null);
    assert.ok(detected.candle !== null, 'Stage 2: Must detect forming M1 candle');
    assert.ok(
      Math.abs(detected.candle.x - (activeCandleX + 1) / width) <= 0.015,
      `Stage 2: Must anchor on colored candle at x=${activeCandleX + 1}, not countdown label (got ${detected.candle.x * width})`
    );

    // Stage 3: Coordinate calculation strictly above forming candle & inside chartBounds
    const anchor = computeCandleStatusAnchor(detected.candle, digest.chartBounds, 1700000000000);
    assert.ok(anchor !== null, 'Stage 3: Must calculate valid anchor above forming candle');
    assert.ok(anchor.y < detected.candle.topY, 'Stage 3: Anchor must be strictly above candle topY');
    assert.ok(anchor.x >= digest.chartBounds.x && anchor.x <= digest.chartBounds.x + digest.chartBounds.width);
    assert.ok(anchor.y >= digest.chartBounds.y && anchor.y <= digest.chartBounds.y + digest.chartBounds.height);
  });

  it('Stage 4: enforces continuous Gemini calls without artificial economy skips while keeping 1500ms stability limit', () => {
    const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
    assert.match(appSrc, /const CAPTURE_POLL_MS = 1500;/);
    assert.match(appSrc, /const MIN_API_INTERVAL_MS = 1500;/);
    assert.doesNotMatch(appSrc, /diffScore\s*<\s*0\.0085/);
    assert.doesNotMatch(appSrc, /if\s*\(!local\.chartDetected\)\s*\{\s*return;\s*\}/);
    assert.match(appSrc, /geminiChartBoundsRef/);
    assert.match(appSrc, /geminiVisionCandleRef/);
  });

  it('Stage 5 & 6: validates Windows agent v1.3.2 UpdateLayeredWindow rendering contract, SetupWizard launch flags, and clean installer build', async () => {
    const cs = fs.readFileSync(
      path.resolve('native/windows-overlay/win-agent/ChartPulseOverlayHost.cs'),
      'utf8'
    );
    // Win32 UpdateLayeredWindow 32-bit premultiplied alpha composition (replaces TransparencyKey Magenta)
    assert.doesNotMatch(cs, /TransparencyKey\s*=/);
    assert.match(cs, /PixelFormat\.Format32bppPArgb/);
    assert.match(cs, /Win32Native\.UpdateLayeredWindow/);
    assert.match(cs, /Win32Native\.SetWindowPos/);
    assert.match(cs, /HWND_TOPMOST/);
    assert.match(cs, /SWP_NOACTIVATE/);
    assert.match(cs, /DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2/);
    assert.match(cs, /BrokerWindowSelectorForm/);
    assert.match(cs, /NotifyIcon/);
    assert.match(cs, /SetManualBrokerWindow/);
    assert.match(cs, /EnumerateCandidateWindows/);
    assert.match(cs, /ConvertCaptureNormToOverlayPx/);
    assert.match(cs, /TARGET_MINIMIZED/);
    assert.match(cs, /TARGET_WINDOW hwnd=/);
    assert.match(cs, /DRAW status=/);
    assert.match(cs, /ULW_FAIL/);
    assert.match(cs, /WM_NCHITTEST/);
    assert.match(cs, /WM_MOUSEACTIVATE/);
    assert.match(cs, /DWMWA_CLOAKED/);
    assert.match(cs, /exePath/);
    assert.match(cs, /lastRenderError/);
    assert.doesNotMatch(cs, /nowMs\s*-\s*_state\.StatusUpdatedAtMs\s*>\s*450/);

    const wizard = fs.readFileSync(
      path.resolve('native/windows-overlay/installer/SetupWizard.cs'),
      'utf8'
    );
    assert.doesNotMatch(wizard, /ProcessWindowStyle\.Hidden/);
    assert.doesNotMatch(wizard, /CreateNoWindow\s*=\s*true/);

    const buildPs1 = fs.readFileSync(
      path.resolve('native/windows-overlay/installer/Build-ChartPulseInstaller.ps1'),
      'utf8'
    );
    assert.match(buildPs1, /Remove-Item\s+-Force\s+-ErrorAction\s+SilentlyContinue\s+\$overlayExe,\s*\$setupExe/);

    // Stage 5 server endpoints receive status + candle payloads cleanly
    const candleRes = await netlifyOverlayCandleHandler(
      new Request('https://example.netlify.app/api/overlay/candle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'stage5-sess',
          liveCandle: {
            x: 0.72,
            y: 0.48,
            chartRelativeX: 0.85,
            chartRelativeY: 0.45,
            topY: 0.41,
            bottomY: 0.52,
            direction: 'BULL',
            chartBounds: { x: 0.05, y: 0.1, width: 0.8, height: 0.75 },
            confidence: 0.9,
            updatedAt: Date.now(),
          },
        }),
      })
    );
    assert.equal(candleRes.status, 200);

    const statusRes = await netlifyOverlayStatusHandler(
      new Request('https://example.netlify.app/api/overlay/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'stage5-sess',
          operationalStatus: {
            status: 'AGUARDANDO',
            timeframe: 'M1',
            confidence: 0,
            anchor: { x: 0.72, y: 0.39, chartRelativeX: 0.85, chartRelativeY: 0.39 },
          },
        }),
      })
    );
    assert.equal(statusRes.status, 200);
  });

  it('Stage 7 & 8: tracks multi-update M1 candle movement smoothly and switches AGUARDANDO <-> COMPRA/VENDA seamlessly', () => {
    const bounds = { x: 0.05, y: 0.1, width: 0.8, height: 0.75 };
    const t0 = 1_700_000_000_000;
    const makeCandle = (y: number, topY: number, dir: 'BULL' | 'BEAR') => ({
      x: 0.74,
      y,
      chartRelativeX: (0.74 - bounds.x) / bounds.width,
      chartRelativeY: (y - bounds.y) / bounds.height,
      topY,
      bottomY: Math.min(0.84, y + 0.05),
      direction: dir,
      chartBounds: bounds,
      confidence: 0.92,
      updatedAt: t0,
    });

    // Stage 7: Multi-update vertical movement while in AGUARDANDO
    let status = resolveOperationalStatus({
      isActive: true,
      current: createInitialOperationalStatus(bounds, null, t0),
      activeSignal: null,
      liveCandle: makeCandle(0.55, 0.50, 'BULL'),
      latestBounds: bounds,
      chartDetected: true,
      now: t0 + 250,
    });
    assert.ok(status && status.anchor);
    const yStep1 = status.anchor.y;

    status = resolveOperationalStatus({
      isActive: true,
      current: status,
      activeSignal: null,
      liveCandle: makeCandle(0.42, 0.37, 'BULL'),
      latestBounds: bounds,
      chartDetected: true,
      now: t0 + 500,
    });
    assert.ok(status && status.anchor);
    assert.ok(status.anchor.y < yStep1 - 0.08, 'Stage 7: AGUARDANDO rises smoothly with upward M1 candle');

    status = resolveOperationalStatus({
      isActive: true,
      current: status,
      activeSignal: null,
      liveCandle: makeCandle(0.62, 0.58, 'BEAR'),
      latestBounds: bounds,
      chartDetected: true,
      now: t0 + 750,
    });
    assert.ok(status && status.anchor);
    assert.ok(status.anchor.y > yStep1, 'Stage 7: AGUARDANDO drops smoothly with downward M1 candle');

    // Stage 8: Transitions AGUARDANDO -> COMPRA (65%) -> AGUARDANDO -> VENDA (68%) -> AGUARDANDO
    const buySig = {
      id: 's8-buy',
      direction: 'COMPRA' as const,
      candleX: 0.74,
      candleY: 0.62,
      chartRelativeX: (0.74 - bounds.x) / bounds.width,
      chartRelativeY: (0.62 - bounds.y) / bounds.height,
      chartBounds: bounds,
      confidence: 65,
      candleId: 'c-1',
      marketRegime: 'TRENDING_UP' as const,
      createdAt: t0 + 800,
      expiresAt: t0 + 4000,
    };
    const buyStatus = resolveOperationalStatus({
      isActive: true,
      current: status,
      activeSignal: buySig,
      liveCandle: makeCandle(0.62, 0.58, 'BULL'),
      latestBounds: bounds,
      chartDetected: true,
      now: t0 + 1000,
    });
    assert.equal(buyStatus?.status, 'COMPRA');
    assert.ok(buyStatus?.anchor !== null);

    const backToWait = resolveOperationalStatus({
      isActive: true,
      current: buyStatus,
      activeSignal: buySig,
      liveCandle: makeCandle(0.60, 0.56, 'BULL'),
      latestBounds: bounds,
      chartDetected: true,
      now: t0 + 4500,
    });
    assert.equal(backToWait?.status, 'AGUARDANDO');
    assert.ok(backToWait?.anchor !== null);

    const sellSig = {
      id: 's8-sell',
      direction: 'VENDA' as const,
      candleX: 0.74,
      candleY: 0.60,
      chartRelativeX: (0.74 - bounds.x) / bounds.width,
      chartRelativeY: (0.60 - bounds.y) / bounds.height,
      chartBounds: bounds,
      confidence: 68,
      candleId: 'c-2',
      marketRegime: 'TRENDING_DOWN' as const,
      createdAt: t0 + 4600,
      expiresAt: t0 + 8000,
    };
    const sellStatus = resolveOperationalStatus({
      isActive: true,
      current: backToWait,
      activeSignal: sellSig,
      liveCandle: makeCandle(0.60, 0.56, 'BEAR'),
      latestBounds: bounds,
      chartDetected: true,
      now: t0 + 4800,
    });
    assert.equal(sellStatus?.status, 'VENDA');
    assert.ok(sellStatus?.anchor !== null);

    const cleared = resolveOperationalStatus({
      isActive: false,
      current: sellStatus,
      activeSignal: null,
      liveCandle: null,
      latestBounds: bounds,
      chartDetected: true,
      now: t0 + 5000,
    });
    assert.equal(cleared, null);
  });

  it('detects 2px IQ Option/Quotex M1 candles + monochrome badge, bridges real anchor via localOverlayBridge without inventing coordinates, and confirms C# AGUARDANDO paint path', async () => {
    const width = 1280;
    const height = 720;
    const bg: [number, number, number] = [28, 32, 48];
    const bull: [number, number, number] = [34, 197, 94];
    const bear: [number, number, number] = [239, 68, 68];
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
      rgba[i * 4 + 3] = 255;
    }
    const paint = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
      for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = c[0];
          rgba[idx + 1] = c[1];
          rgba[idx + 2] = c[2];
        }
      }
    };

    // 40 narrow 2px-wide M1 candles + 1 active forming green candle + 9x19 monochrome countdown badge
    let activeX0 = 0;
    for (let i = 0; i < 40; i++) {
      const cx = 140 + i * 16;
      activeX0 = cx;
      const isBull = i % 2 === 0 || i === 39;
      const c = isBull ? bull : bear;
      const top = i === 39 ? 290 : 285 + ((i * 9) % 45);
      const bot = i === 39 ? 334 : top + 16 + (i % 8);
      paint(cx, top - 6, cx, bot + 6, c); // 1px wick
      paint(cx, top, cx + 1, bot, c); // 2px body
    }

    // Monochrome white countdown pill right of the forming M1 candle (9x19)
    paint(activeX0 + 14, 302, activeX0 + 22, 320, [226, 232, 240]);

    const digest = processFrameLocally(rgba, width, height, null);
    assert.equal(digest.chartDetected, true, 'Must detect narrow 2px M1 chart');
    assert.ok(digest.chartBounds !== null);

    const detected = detectLiveMovingCandleWithReason(
      rgba,
      width,
      height,
      digest.chartBounds,
      digest.priceLine,
      digest.chartDetected
    );
    assert.equal(detected.reason, null);
    assert.ok(detected.candle !== null, 'Must detect 2px forming candle despite monochrome 9x19 countdown badge');
    assert.ok(
      Math.abs(detected.candle.x - (activeX0 + 0.5) / width) <= 0.015,
      `Expected forming candle near x=${activeX0}, got ${detected.candle.x * width}`
    );

    const anchor = computeCandleStatusAnchor(detected.candle, digest.chartBounds, 1700000000000);
    assert.ok(anchor !== null && anchor.y < detected.candle.topY);

    // Bridge test: push real liveCandle and verify /overlay/status populates real anchor when status.anchor is null,
    // and never invents coordinates after clearLocalOverlaySignals
    const originalFetch = globalThis.fetch;
    const sentBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push({
        url: String(input),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await clearLocalOverlaySignals('bridge-sess-1');
      const noCandlePayload = buildOperationalStatusPayloadWithLiveCandle('bridge-sess-1', {
        status: 'AGUARDANDO',
        timeframe: 'M1',
        confidence: 0,
        anchor: null,
        chartBounds: digest.chartBounds,
        expiresAt: null,
        updatedAt: Date.now(),
      });
      assert.equal(noCandlePayload?.anchor, null, 'Must never invent anchor when no liveCandle exists');

      const candleOk = await pushLocalOverlayCandle('bridge-sess-1', detected.candle);
      assert.equal(candleOk, true);

      const statusOk = await pushLocalOverlayStatus('bridge-sess-1', {
        status: 'AGUARDANDO',
        timeframe: 'M1',
        confidence: 0,
        anchor: null,
        chartBounds: digest.chartBounds,
        expiresAt: null,
        updatedAt: Date.now(),
      });
      assert.equal(statusOk, true);

      const lastStatusCall = sentBodies.find((c) => c.url.endsWith('/overlay/status'));
      assert.ok(lastStatusCall);
      const sentOp = lastStatusCall.body.operationalStatus as OperationalStatusState;
      assert.ok(sentOp.anchor !== null, 'Bridge must supply real candle anchor to /overlay/status (hasStatusAnchor=true)');
      assert.equal(sentOp.status, 'AGUARDANDO');
      assert.ok(sentOp.anchor.y < detected.candle.topY);
    } finally {
      await clearLocalOverlaySignals('bridge-sess-1');
      globalThis.fetch = originalFetch;
    }

    // C# host check: AGUARDANDO renders and increments _paintCount whenever HasStatusAnchor is true, even without COMPRA/VENDA
    const cs = fs.readFileSync(
      path.resolve('native/windows-overlay/win-agent/ChartPulseOverlayHost.cs'),
      'utf8'
    );
    assert.match(cs, /bool hasOpStatus = snapshot\.Active && snapshot\.HasStatusAnchor;/);
    assert.match(cs, /if \(!hasPriceLine && !hasLiveCandle && !hasOpStatus\)/);
    assert.match(cs, /long paintSeq = Interlocked\.Increment\(ref _paintCount\);/);
    assert.match(cs, /UpdateOperationalStatus/);
    assert.match(cs, /nowMs - _state\.LiveCandleUpdatedAtMs <= 2500/);
  });
});






