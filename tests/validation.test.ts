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
  checkDisplayCaptureEnvironment,
  classifyDisplayCaptureError,
} from '../src/engine/screenCaptureGuard.ts';
import {
  MIN_SIGNAL_CONFIDENCE,
  applySignalPrecisionFilter,
  classifyGeminiUpstreamError,
  executeGeminiFrameAnalysis,
} from '../server/analyzeFrameCore.ts';
import { isTrustedOverlayOrigin } from '../src/engine/localOverlayBridge.ts';
import netlifyAnalyzeHandler from '../netlify/functions/analyze-frame.ts';
import netlifyHealthHandler from '../netlify/functions/health.ts';
import netlifyOverlaySessionHandler from '../netlify/functions/overlay-session.ts';
import netlifyOverlayClearHandler from '../netlify/functions/overlay-clear.ts';
import netlifyOverlayStateHandler from '../netlify/functions/overlay-state.ts';
import netlifyOverlayPriceHandler from '../netlify/functions/overlay-price.ts';

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

describe('ChartPulse AI — Production Gemini Config (90% Confidence & Netlify Function)', () => {
  it('restores minimum signal confidence strictly to 90%', () => {
    assert.equal(MIN_SIGNAL_CONFIDENCE, 90);

    const below90 = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'COMPRA',
      confidence: 89,
      rawRegime: 'TRENDING_UP',
    });
    assert.equal(below90.signal, 'NONE');

    const at60 = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'VENDA',
      confidence: 60,
      rawRegime: 'TRENDING_DOWN',
    });
    assert.equal(at60.signal, 'NONE');

    const at90Buy = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'COMPRA',
      confidence: 90,
      rawRegime: 'TRENDING_UP',
    });
    assert.equal(at90Buy.signal, 'COMPRA');

    const at92Sell = applySignalPrecisionFilter({
      chartDetected: true,
      rawSignal: 'VENDA',
      confidence: 92,
      rawRegime: 'TRENDING_DOWN',
    });
    assert.equal(at92Sell.signal, 'VENDA');
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
