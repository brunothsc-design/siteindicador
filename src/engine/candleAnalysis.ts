import type { SignalDirection } from '../types/signals.ts';

export interface CandleBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface StrategyConfig {
  fastEmaPeriod: number;
  mediumEmaPeriod: number;
  slowEmaPeriod: number;
  atrPeriod: number;
  adxPeriod: number;
  efficiencyPeriod: number;
  minAdx: number;
  minEfficiencyRatio: number;
  minBodyRatio: number;
  minMomentumAtrMultiple: number;
  cooldownBars: number;
  spreadBps: number; // e.g., 1.5 bps realistic FX/index spread
  feeBps: number; // round-trip commission/slippage bps
  takeProfitAtr: number;
  stopLossAtr: number;
  maxHoldBars: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  fastEmaPeriod: 9,
  mediumEmaPeriod: 21,
  slowEmaPeriod: 50,
  atrPeriod: 14,
  adxPeriod: 14,
  efficiencyPeriod: 12,
  minAdx: 24,
  minEfficiencyRatio: 0.36,
  minBodyRatio: 0.56,
  minMomentumAtrMultiple: 0.45,
  cooldownBars: 6,
  spreadBps: 1.5,
  feeBps: 1.0,
  takeProfitAtr: 1.25,
  stopLossAtr: 1.6,
  maxHoldBars: 8,
};

export interface CandleEvaluation {
  signal: SignalDirection | null;
  confidence: number;
  regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'SIDEWAYS' | 'UNCLEAR';
  adx: number;
  efficiencyRatio: number;
  atr: number;
}

export interface SignalTradeRecord {
  index: number;
  timestamp: number;
  direction: SignalDirection;
  entryPrice: number;
  exitPrice: number;
  netReturnBps: number;
  won: boolean;
  exitReason: 'TP' | 'SL' | 'TIME';
}

export interface DirectionMetrics {
  signals: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgNetBps: number;
}

export interface BacktestReport {
  totalBars: number;
  totalSignals: number;
  overallWinRatePct: number;
  buy: DirectionMetrics;
  sell: DirectionMetrics;
  records: SignalTradeRecord[];
}

function computeEmaSeries(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  let ema = sum / period;
  result[period - 1] = ema;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function computeAtrSeries(bars: CandleBar[], period: number): number[] {
  const tr = new Array<number>(bars.length).fill(0);
  const atr = new Array<number>(bars.length).fill(NaN);
  if (bars.length < period + 1) return atr;

  for (let i = 1; i < bars.length; i++) {
    const highLow = bars[i].high - bars[i].low;
    const highPrevClose = Math.abs(bars[i].high - bars[i - 1].close);
    const lowPrevClose = Math.abs(bars[i].low - bars[i - 1].close);
    tr[i] = Math.max(highLow, highPrevClose, lowPrevClose);
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += tr[i];
  }
  let currentAtr = sum / period;
  atr[period] = currentAtr;

  for (let i = period + 1; i < bars.length; i++) {
    currentAtr = (currentAtr * (period - 1) + tr[i]) / period;
    atr[i] = currentAtr;
  }
  return atr;
}

function computeAdxSeries(bars: CandleBar[], period: number): number[] {
  const adx = new Array<number>(bars.length).fill(NaN);
  if (bars.length < period * 2 + 1) return adx;

  const plusDm = new Array<number>(bars.length).fill(0);
  const minusDm = new Array<number>(bars.length).fill(0);
  const tr = new Array<number>(bars.length).fill(0);

  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
  }

  let smoothTr = 0;
  let smoothPlusDm = 0;
  let smoothMinusDm = 0;
  for (let i = 1; i <= period; i++) {
    smoothTr += tr[i];
    smoothPlusDm += plusDm[i];
    smoothMinusDm += minusDm[i];
  }

  const dxValues: number[] = new Array<number>(bars.length).fill(NaN);
  for (let i = period; i < bars.length; i++) {
    if (i > period) {
      smoothTr = smoothTr - smoothTr / period + tr[i];
      smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDm[i];
      smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDm[i];
    }
    const plusDi = smoothTr > 0 ? (100 * smoothPlusDm) / smoothTr : 0;
    const minusDi = smoothTr > 0 ? (100 * smoothMinusDm) / smoothTr : 0;
    const diSum = plusDi + minusDi;
    dxValues[i] = diSum > 0 ? (100 * Math.abs(plusDi - minusDi)) / diSum : 0;
  }

  let dxSum = 0;
  const startAdx = period * 2 - 1;
  if (startAdx >= bars.length) return adx;

  for (let i = period; i <= startAdx; i++) {
    dxSum += Number.isNaN(dxValues[i]) ? 0 : dxValues[i];
  }
  let currentAdx = dxSum / period;
  adx[startAdx] = currentAdx;

  for (let i = startAdx + 1; i < bars.length; i++) {
    currentAdx = (currentAdx * (period - 1) + dxValues[i]) / period;
    adx[i] = currentAdx;
  }

  return adx;
}

function computeEfficiencyRatio(closes: number[], idx: number, period: number): number {
  if (idx < period) return 0;
  const netChange = Math.abs(closes[idx] - closes[idx - period]);
  let volatilitySum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    volatilitySum += Math.abs(closes[i] - closes[i - 1]);
  }
  return volatilitySum > 0 ? netChange / volatilitySum : 0;
}

/**
 * Strictly causal evaluation at bar index `idx` using ONLY bars [0..idx].
 * Zero lookahead bias. Returns `null` when confirmation criteria are not met.
 */
export function evaluateCandleAt(
  bars: CandleBar[],
  idx: number,
  emaFast: number[],
  emaMed: number[],
  emaSlow: number[],
  atrSeries: number[],
  adxSeries: number[],
  closes: number[],
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG
): CandleEvaluation {
  if (
    idx < Math.max(config.slowEmaPeriod, config.adxPeriod * 2) + 3 ||
    idx >= bars.length
  ) {
    return {
      signal: null,
      confidence: 0,
      regime: 'UNCLEAR',
      adx: 0,
      efficiencyRatio: 0,
      atr: 0,
    };
  }

  const bar = bars[idx];
  const prev1 = bars[idx - 1];
  const prev2 = bars[idx - 2];

  const fast = emaFast[idx];
  const fastPrev = emaFast[idx - 1];
  const med = emaMed[idx];
  const medPrev = emaMed[idx - 1];
  const slow = emaSlow[idx];
  const slowPrev = emaSlow[idx - 3];
  const atr = atrSeries[idx];
  const adx = adxSeries[idx];
  const efficiency = computeEfficiencyRatio(closes, idx, config.efficiencyPeriod);

  if (
    Number.isNaN(fast) ||
    Number.isNaN(med) ||
    Number.isNaN(slow) ||
    Number.isNaN(atr) ||
    Number.isNaN(adx) ||
    atr <= 0
  ) {
    return {
      signal: null,
      confidence: 0,
      regime: 'UNCLEAR',
      adx: 0,
      efficiencyRatio: efficiency,
      atr: 0,
    };
  }

  const range = bar.high - bar.low;
  if (range <= 0) {
    return {
      signal: null,
      confidence: 0,
      regime: 'SIDEWAYS',
      adx,
      efficiencyRatio: efficiency,
      atr,
    };
  }

  const body = Math.abs(bar.close - bar.open);
  const bodyRatio = body / range;
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;

  const isUptrend = fast > med && med > slow && fast > fastPrev && med > medPrev && slow > slowPrev;
  const isDowntrend = fast < med && med < slow && fast < fastPrev && med < medPrev && slow < slowPrev;

  if (adx < config.minAdx || efficiency < config.minEfficiencyRatio || (!isUptrend && !isDowntrend)) {
    return {
      signal: null,
      confidence: 0,
      regime: adx < config.minAdx || efficiency < config.minEfficiencyRatio ? 'SIDEWAYS' : 'UNCLEAR',
      adx,
      efficiencyRatio: efficiency,
      atr,
    };
  }

  const prev1Body = Math.abs(prev1.close - prev1.open);
  const prev1Bullish = prev1.close > prev1.open;
  const prev1Bearish = prev1.close < prev1.open;

  // Volatility sanity: avoid tiny dead bars and extreme blow-off exhaustion spikes (> 2.8 * ATR)
  const validVolatility = range >= atr * 0.65 && range <= atr * 2.6;
  if (!validVolatility) {
    return {
      signal: null,
      confidence: 0,
      regime: isUptrend ? 'TRENDING_UP' : 'TRENDING_DOWN',
      adx,
      efficiencyRatio: efficiency,
      atr,
    };
  }

  // COMPRA confirmation:
  // 1) Aligned multi-EMA uptrend + strong ADX + non-choppy Efficiency Ratio
  // 2) Pullback or compression followed by decisive bullish confirmation candle
  //    (either strong continuation close above prev1 high or bullish engulfing near EMA9/21)
  // 3) Minimal upper wick rejection and minimum momentum relative to ATR
  if (isUptrend) {
    const isBullishCandle = bar.close > bar.open;
    const strongBody = bodyRatio >= config.minBodyRatio && (bar.close - bar.open) >= atr * config.minMomentumAtrMultiple;
    const cleanUpperWick = upperWick <= body * 0.35;
    const brokePriorHigh = bar.close > prev1.high && bar.close > fast;
    const nearSupportPullback =
      (prev1.low <= fast * 1.002 || prev2.low <= fast * 1.002 || prev1Bearish) &&
      bar.low >= med * 0.994;
    const bullishEngulfing =
      prev1Bearish && bar.close > prev1.open && bar.open <= prev1.close * 1.001 && body > prev1Body;

    if (isBullishCandle && strongBody && cleanUpperWick && ((brokePriorHigh && nearSupportPullback) || bullishEngulfing)) {
      const score = Math.min(
        98,
        Math.round(
          74 +
            Math.min(10, (adx - config.minAdx) * 0.6) +
            Math.min(8, (efficiency - config.minEfficiencyRatio) * 25) +
            Math.min(6, (bodyRatio - config.minBodyRatio) * 18)
        )
      );
      return {
        signal: 'COMPRA',
        confidence: score,
        regime: 'TRENDING_UP',
        adx,
        efficiencyRatio: efficiency,
        atr,
      };
    }
  }

  // VENDA confirmation:
  if (isDowntrend) {
    const isBearishCandle = bar.close < bar.open;
    const strongBody = bodyRatio >= config.minBodyRatio && (bar.open - bar.close) >= atr * config.minMomentumAtrMultiple;
    const cleanLowerWick = lowerWick <= body * 0.35;
    const brokePriorLow = bar.close < prev1.low && bar.close < fast;
    const nearResistancePullback =
      (prev1.high >= fast * 0.998 || prev2.high >= fast * 0.998 || prev1Bullish) &&
      bar.high <= med * 1.006;
    const bearishEngulfing =
      prev1Bullish && bar.close < prev1.open && bar.open >= prev1.close * 0.999 && body > prev1Body;

    if (isBearishCandle && strongBody && cleanLowerWick && ((brokePriorLow && nearResistancePullback) || bearishEngulfing)) {
      const score = Math.min(
        98,
        Math.round(
          74 +
            Math.min(10, (adx - config.minAdx) * 0.6) +
            Math.min(8, (efficiency - config.minEfficiencyRatio) * 25) +
            Math.min(6, (bodyRatio - config.minBodyRatio) * 18)
        )
      );
      return {
        signal: 'VENDA',
        confidence: score,
        regime: 'TRENDING_DOWN',
        adx,
        efficiencyRatio: efficiency,
        atr,
      };
    }
  }

  return {
    signal: null,
    confidence: 0,
    regime: isUptrend ? 'TRENDING_UP' : 'TRENDING_DOWN',
    adx,
    efficiencyRatio: efficiency,
    atr,
  };
}

/**
 * Runs a causal, zero-lookahead historical/out-of-sample backtest accounting for spread and fees.
 * Signals are evaluated at bar close `i`, entered at bar `i + 1` open (realistic execution),
 * and tracked sequentially on future bars without peeking during signal generation.
 */
export function runWalkForwardBacktest(
  bars: CandleBar[],
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG
): BacktestReport {
  const closes = bars.map((b) => b.close);
  const emaFast = computeEmaSeries(closes, config.fastEmaPeriod);
  const emaMed = computeEmaSeries(closes, config.mediumEmaPeriod);
  const emaSlow = computeEmaSeries(closes, config.slowEmaPeriod);
  const atrSeries = computeAtrSeries(bars, config.atrPeriod);
  const adxSeries = computeAdxSeries(bars, config.adxPeriod);

  const records: SignalTradeRecord[] = [];
  let lastSignalIndex = -config.cooldownBars - 1;
  const totalCostBps = config.spreadBps + config.feeBps;

  for (let i = 0; i < bars.length - 2; i++) {
    if (i - lastSignalIndex < config.cooldownBars) {
      continue;
    }

    const evaluation = evaluateCandleAt(
      bars,
      i,
      emaFast,
      emaMed,
      emaSlow,
      atrSeries,
      adxSeries,
      closes,
      config
    );

    if (!evaluation.signal || evaluation.atr <= 0) {
      continue;
    }

    lastSignalIndex = i;
    const entryBar = bars[i + 1];
    const entryPrice = entryBar.open;
    const atr = evaluation.atr;

    const tpDist = atr * config.takeProfitAtr;
    const slDist = atr * config.stopLossAtr;

    let exitPrice = entryBar.close;
    let exitReason: 'TP' | 'SL' | 'TIME' = 'TIME';

    const maxIdx = Math.min(bars.length - 1, i + 1 + config.maxHoldBars);
    for (let j = i + 1; j <= maxIdx; j++) {
      const b = bars[j];
      if (evaluation.signal === 'COMPRA') {
        // Conservative ordering: check SL before TP if both touched in same bar
        if (b.low <= entryPrice - slDist) {
          exitPrice = entryPrice - slDist;
          exitReason = 'SL';
          break;
        }
        if (b.high >= entryPrice + tpDist) {
          exitPrice = entryPrice + tpDist;
          exitReason = 'TP';
          break;
        }
      } else {
        if (b.high >= entryPrice + slDist) {
          exitPrice = entryPrice + slDist;
          exitReason = 'SL';
          break;
        }
        if (b.low <= entryPrice - tpDist) {
          exitPrice = entryPrice - tpDist;
          exitReason = 'TP';
          break;
        }
      }
      if (j === maxIdx) {
        exitPrice = b.close;
        exitReason = 'TIME';
      }
    }

    const rawReturnBps =
      evaluation.signal === 'COMPRA'
        ? ((exitPrice - entryPrice) / entryPrice) * 10000
        : ((entryPrice - exitPrice) / entryPrice) * 10000;

    const netReturnBps = rawReturnBps - totalCostBps;

    records.push({
      index: i,
      timestamp: bars[i].timestamp,
      direction: evaluation.signal,
      entryPrice,
      exitPrice,
      netReturnBps,
      won: netReturnBps > 0,
      exitReason,
    });
  }

  const summarize = (list: SignalTradeRecord[]): DirectionMetrics => {
    if (list.length === 0) {
      return { signals: 0, wins: 0, losses: 0, winRatePct: 0, avgNetBps: 0 };
    }
    const wins = list.filter((r) => r.won).length;
    const losses = list.length - wins;
    const avgNetBps = list.reduce((acc, r) => acc + r.netReturnBps, 0) / list.length;
    return {
      signals: list.length,
      wins,
      losses,
      winRatePct: Number(((wins / list.length) * 100).toFixed(2)),
      avgNetBps: Number(avgNetBps.toFixed(2)),
    };
  };

  const buyRecords = records.filter((r) => r.direction === 'COMPRA');
  const sellRecords = records.filter((r) => r.direction === 'VENDA');
  const totalWins = records.filter((r) => r.won).length;

  return {
    totalBars: bars.length,
    totalSignals: records.length,
    overallWinRatePct:
      records.length > 0 ? Number(((totalWins / records.length) * 100).toFixed(2)) : 0,
    buy: summarize(buyRecords),
    sell: summarize(sellRecords),
    records,
  };
}
