import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalOverlay, type VideoDisplayRect } from './components/SignalOverlay.tsx';
import { isSignalConfidenceValid } from './config/signalConfig.ts';
import {
  detectLiveMovingCandleWithReason,
  type CandleDetectionFailureReason,
} from './engine/liveCandleTracker.ts';
import { processFrameLocally } from './engine/localScreenProcessor.ts';
import {
  checkLocalOverlayHealth,
  clearLocalOverlaySignals,
  notifyLocalOverlaySession,
  pushLocalOverlayCandle,
  pushLocalOverlayPrice,
  pushLocalOverlaySignal,
  pushLocalOverlayStatus,
  type OverlayConnectionState,
} from './engine/localOverlayBridge.ts';
import {
  createInitialOperationalStatus,
  operationalStatusChanged,
  resolveOperationalStatus,
} from './engine/operationalStatus.ts';
import {
  checkDisplayCaptureEnvironment,
  classifyDisplayCaptureError,
} from './engine/screenCaptureGuard.ts';
import type {
  AnalyzeFrameResponse,
  ChartBounds,
  LiveCandleTracker,
  OperationalStatusState,
  PriceLine,
  VisualSignal,
} from './types/signals.ts';

const CAPTURE_POLL_MS = 2200;
const PRICE_POLL_MS = 250;
const MIN_API_INTERVAL_MS = 4500;
const SIGNAL_TTL_MS = 18000;
const OVERLAY_HEALTH_POLL_MS = 5000;

function priceLineChanged(prev: PriceLine | null, next: PriceLine | null): boolean {
  if (prev === null && next === null) return false;
  if (prev === null || next === null) return true;
  if (Math.abs(prev.y - next.y) >= 0.0015) return true;
  if (Math.abs(prev.chartRelativeY - next.chartRelativeY) >= 0.0015) return true;
  const pb = prev.chartBounds;
  const nb = next.chartBounds;
  if ((pb === null) !== (nb === null)) return true;
  if (pb && nb) {
    if (
      Math.abs(pb.x - nb.x) >= 0.005 ||
      Math.abs(pb.y - nb.y) >= 0.005 ||
      Math.abs(pb.width - nb.width) >= 0.005 ||
      Math.abs(pb.height - nb.height) >= 0.005
    ) {
      return true;
    }
  }
  return false;
}

function liveCandleChanged(
  prev: LiveCandleTracker | null,
  next: LiveCandleTracker | null
): boolean {
  if (prev === null && next === null) return false;
  if (prev === null || next === null) return true;
  if (prev.direction !== next.direction) return true;
  if (Math.abs(prev.x - next.x) >= 0.002 || Math.abs(prev.y - next.y) >= 0.0015) return true;
  if (
    Math.abs(prev.chartRelativeX - next.chartRelativeX) >= 0.002 ||
    Math.abs(prev.chartRelativeY - next.chartRelativeY) >= 0.0015
  ) {
    return true;
  }
  const pb = prev.chartBounds;
  const nb = next.chartBounds;
  if ((pb === null) !== (nb === null)) return true;
  if (pb && nb) {
    if (
      Math.abs(pb.x - nb.x) >= 0.005 ||
      Math.abs(pb.y - nb.y) >= 0.005 ||
      Math.abs(pb.width - nb.width) >= 0.005 ||
      Math.abs(pb.height - nb.height) >= 0.005
    ) {
      return true;
    }
  }
  return false;
}

export default function App() {
  const [isActive, setIsActive] = useState(false);
  const [activeSignal, setActiveSignal] = useState<VisualSignal | null>(null);
  const [priceLine, setPriceLine] = useState<PriceLine | null>(null);
  const [liveCandle, setLiveCandle] = useState<LiveCandleTracker | null>(null);
  const [operationalStatus, setOperationalStatus] = useState<OperationalStatusState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [videoRect, setVideoRect] = useState<VideoDisplayRect | null>(null);
  const [overlayStatus, setOverlayStatus] = useState<OverlayConnectionState>('checking');
  const [overlayAgentOutdated, setOverlayAgentOutdated] = useState(false);
  const [overlayAgentVersion, setOverlayAgentVersion] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const isActiveRef = useRef(false);
  const isRequestingCaptureRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const priceTimerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  const lastSignatureRef = useRef<Float32Array | null>(null);
  const lastApiCallAtRef = useRef(0);
  const cooldownUntilRef = useRef(0);
  const lastSignalRef = useRef<VisualSignal | null>(null);
  const lastPriceLineRef = useRef<PriceLine | null>(null);
  const lastPricePushAtRef = useRef(0);
  const lastLiveCandleRef = useRef<LiveCandleTracker | null>(null);
  const lastLiveCandlePushAtRef = useRef(0);
  const lastOperationalStatusRef = useRef<OperationalStatusState | null>(null);
  const lastStatusPushAtRef = useRef(0);
  const lastChartBoundsRef = useRef<ChartBounds | null>(null);
  const lastDiagStateRef = useRef<string>('');
  const localAgentReadyRef = useRef(false);
  const displaySurfaceRef = useRef<string>('window');

  const syncVideoRect = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setVideoRect(null);
      return;
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const videoAspect = video.videoWidth / video.videoHeight;
    const viewAspect = vw / vh;

    let width = vw;
    let height = vh;
    let left = 0;
    let top = 0;

    if (videoAspect > viewAspect) {
      width = vw;
      height = vw / videoAspect;
      top = (vh - height) / 2;
    } else {
      height = vh;
      width = vh * videoAspect;
      left = (vw - width) / 2;
    }

    setVideoRect({ left, top, width, height });
  }, []);

  const deactivate = useCallback(() => {
    const closingSession = sessionIdRef.current;

    isActiveRef.current = false;
    sessionIdRef.current = null;
    inFlightRef.current = false;
    lastSignatureRef.current = null;
    lastSignalRef.current = null;
    lastPriceLineRef.current = null;
    lastPricePushAtRef.current = 0;
    lastLiveCandleRef.current = null;
    lastLiveCandlePushAtRef.current = 0;
    lastOperationalStatusRef.current = null;
    lastStatusPushAtRef.current = 0;
    lastChartBoundsRef.current = null;
    lastDiagStateRef.current = '';
    localAgentReadyRef.current = false;
    displaySurfaceRef.current = 'window';
    cooldownUntilRef.current = 0;

    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (priceTimerRef.current !== null) {
      window.clearInterval(priceTimerRef.current);
      priceTimerRef.current = null;
    }

    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.onended = null;
        track.stop();
      }
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsActive(false);
    setActiveSignal(null);
    setPriceLine(null);
    setLiveCandle(null);
    setOperationalStatus(null);
    setVideoRect(null);

    if (closingSession) {
      void clearLocalOverlaySignals(closingSession);
      void fetch('/api/overlay/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: closingSession }),
      }).catch(() => {
        // Ignore network errors during immediate teardown
      });
    }
  }, []);

  const syncOperationalStatusState = useCallback(
    (
      latestBounds: ChartBounds | null,
      forcePush = false,
      latestCandle: LiveCandleTracker | null = lastLiveCandleRef.current,
      chartDetected = true
    ) => {
      if (!isActiveRef.current || !sessionIdRef.current) return;
      const now = Date.now();
      if (latestBounds) {
        lastChartBoundsRef.current = latestBounds;
      }

      if (lastSignalRef.current && now > lastSignalRef.current.expiresAt) {
        lastSignalRef.current = null;
        setActiveSignal(null);
      }

      const nextStatus = resolveOperationalStatus({
        isActive: isActiveRef.current,
        current: lastOperationalStatusRef.current,
        activeSignal: lastSignalRef.current,
        liveCandle: latestCandle,
        latestBounds: latestBounds ?? lastChartBoundsRef.current,
        chartDetected,
        now,
      });

      if (!nextStatus) return;

      const changed = operationalStatusChanged(lastOperationalStatusRef.current, nextStatus);
      const heartbeatDue = now - lastStatusPushAtRef.current >= 1000;

      // Refresh hold timestamp whenever live candle anchor is actively confirmed so transient hold window stays accurate
      if (
        !changed &&
        latestCandle !== null &&
        lastOperationalStatusRef.current?.anchor &&
        nextStatus.anchor
      ) {
        lastOperationalStatusRef.current = {
          ...lastOperationalStatusRef.current,
          anchor: {
            ...lastOperationalStatusRef.current.anchor,
            updatedAt: now,
          },
        };
      }

      if (forcePush || changed || heartbeatDue) {
        lastOperationalStatusRef.current = nextStatus;
        lastStatusPushAtRef.current = now;
        if (changed || forcePush) {
          setOperationalStatus(nextStatus);
        }

        const activeSession = sessionIdRef.current;
        if (activeSession) {
          void pushLocalOverlayStatus(activeSession, nextStatus);
          void fetch('/api/overlay/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: activeSession, operationalStatus: nextStatus }),
          }).catch(() => {
            // Non-fatal if backend overlay stream is not attached
          });
        }
      }
    },
    []
  );

  const trackCurrentPrice = useCallback(() => {
    if (!isActiveRef.current || !sessionIdRef.current) return;

    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    const canvas = canvasRef.current;
    const targetW = Math.min(1280, video.videoWidth);
    const targetH = Math.max(1, Math.round((targetW / video.videoWidth) * video.videoHeight));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, targetW, targetH);
    const imgData = ctx.getImageData(0, 0, targetW, targetH);

    const local = processFrameLocally(
      imgData.data,
      targetW,
      targetH,
      lastSignatureRef.current
    );

    const nextPrice = local.chartDetected ? local.priceLine : null;
    const changed = priceLineChanged(lastPriceLineRef.current, nextPrice);
    const now = Date.now();
    const heartbeatDue = nextPrice !== null && now - lastPricePushAtRef.current >= 1500;

    if (changed || heartbeatDue) {
      lastPriceLineRef.current = nextPrice;
      lastPricePushAtRef.current = now;
      if (changed) {
        setPriceLine(nextPrice);
      }

      const activeSession = sessionIdRef.current;
      if (activeSession) {
        void pushLocalOverlayPrice(activeSession, nextPrice);
        void fetch('/api/overlay/price', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: activeSession, priceLine: nextPrice }),
        }).catch(() => {
          // Non-fatal if backend overlay stream is not attached
        });
      }
    }

    // Separate forming-candle tracking indicator (independent from priceLine and COMPRA/VENDA signals)
    const candleDetect = detectLiveMovingCandleWithReason(
      imgData.data,
      targetW,
      targetH,
      local.chartBounds,
      nextPrice,
      local.chartDetected
    );
    const nextCandle = candleDetect.candle;
    const candleFailureReason: CandleDetectionFailureReason | null = candleDetect.reason;
    const candleChanged = liveCandleChanged(lastLiveCandleRef.current, nextCandle);
    const candleHeartbeatDue = nextCandle !== null && now - lastLiveCandlePushAtRef.current >= 1500;

    if (candleChanged || candleHeartbeatDue) {
      lastLiveCandleRef.current = nextCandle;
      lastLiveCandlePushAtRef.current = now;
      if (candleChanged) {
        setLiveCandle(nextCandle);
      }

      const activeSession = sessionIdRef.current;
      if (activeSession) {
        void pushLocalOverlayCandle(activeSession, nextCandle);
        void fetch('/api/overlay/candle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: activeSession, liveCandle: nextCandle }),
        }).catch(() => {
          // Non-fatal if backend overlay stream is not attached
        });
      }
    }

    if (local.chartDetected && local.chartBounds) {
      lastChartBoundsRef.current = local.chartBounds;
    }

    // Keep permanent operational status anchored directly above the detected forming candle without flicker
    syncOperationalStatusState(
      local.chartBounds ?? lastChartBoundsRef.current,
      false,
      nextCandle,
      local.chartDetected
    );

    const diagKey = `${local.chartDetected}|${Boolean(nextPrice)}|${nextPrice?.source ?? 'none'}|${Boolean(nextCandle)}|${nextCandle?.direction ?? 'none'}|${lastOperationalStatusRef.current?.status ?? 'none'}|${Boolean(lastOperationalStatusRef.current?.anchor)}|${candleFailureReason ?? 'ok'}`;
    if (diagKey !== lastDiagStateRef.current) {
      lastDiagStateRef.current = diagKey;
      if (!lastOperationalStatusRef.current?.anchor && candleFailureReason) {
        console.warn('[ChartPulse:Diag] AGUARDANDO oculto — vela M1 não identificada', {
          reason: candleFailureReason,
          chartDetected: local.chartDetected,
          chartBounds: local.chartBounds,
        });
      }
      console.info('[ChartPulse:Diag]', {
        frame: `${targetW}x${targetH}`,
        chartDetected: local.chartDetected,
        chartBounds: local.chartBounds,
        operationalStatus: lastOperationalStatusRef.current?.status ?? null,
        statusAnchor: lastOperationalStatusRef.current?.anchor ?? null,
        candleFailureReason,
        priceLine: nextPrice
          ? { y: nextPrice.y, source: nextPrice.source, conf: nextPrice.confidence }
          : null,
        liveCandle: nextCandle
          ? { x: nextCandle.x, y: nextCandle.y, dir: nextCandle.direction, conf: nextCandle.confidence }
          : null,
        localAgentConnected: localAgentReadyRef.current,
      });
    }
  }, [syncOperationalStatusState]);

  const analyzeCurrentFrame = useCallback(async () => {
    if (!isActiveRef.current || !sessionIdRef.current) return;

    const now = Date.now();
    if (lastSignalRef.current && now > lastSignalRef.current.expiresAt) {
      lastSignalRef.current = null;
      setActiveSignal(null);
    }

    if (inFlightRef.current) return;
    if (now < cooldownUntilRef.current) return;
    if (now - lastApiCallAtRef.current < MIN_API_INTERVAL_MS) return;

    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    const canvas = canvasRef.current;
    const targetW = Math.min(1280, video.videoWidth);
    const targetH = Math.max(1, Math.round((targetW / video.videoWidth) * video.videoHeight));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, targetW, targetH);
    const imgData = ctx.getImageData(0, 0, targetW, targetH);

    const local = processFrameLocally(
      imgData.data,
      targetW,
      targetH,
      lastSignatureRef.current
    );

    // Local gating: skip Gemini API if no candlestick chart is visible or frame has not meaningfully changed
    if (!local.chartDetected) {
      return;
    }
    if (lastSignatureRef.current !== null && local.diffScore < 0.0085) {
      return;
    }

    lastSignatureRef.current = local.signature;
    lastApiCallAtRef.current = now;

    const sessionAtSend = sessionIdRef.current;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);

    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;

    try {
      const response = await fetch('/api/analyze-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          imageBase64: dataUrl,
          mimeType: 'image/jpeg',
          chartBounds: local.chartBounds,
          sessionId: sessionAtSend,
          lastSignal: lastSignalRef.current
            ? {
                direction: lastSignalRef.current.direction,
                candleX: lastSignalRef.current.candleX,
                candleId: lastSignalRef.current.candleId,
                createdAt: lastSignalRef.current.createdAt,
              }
            : null,
        }),
      });

      const result = (await response.json()) as AnalyzeFrameResponse;

      // Discard stale responses if user deactivated or started a new session
      if (!isActiveRef.current || sessionIdRef.current !== sessionAtSend) {
        return;
      }

      if (response.status === 429 || result.rateLimited) {
        const waitMs = Math.max(8000, result.retryAfterMs ?? 15000);
        cooldownUntilRef.current = Date.now() + waitMs;
        setErrorMessage(result.error ?? 'Limite temporário de requisições. Aguardando...');
        return;
      }

      if (!response.ok || !result.ok) {
        setErrorMessage(result.error ?? null);
        return;
      }

      setErrorMessage(null);

      const hasValidSignal =
        (result.signal === 'COMPRA' || result.signal === 'VENDA') &&
        isSignalConfidenceValid(result.confidence);

      if (hasValidSignal && (result.signal === 'COMPRA' || result.signal === 'VENDA')) {
        const prev = lastSignalRef.current;
        const isDuplicate =
          prev !== null &&
          prev.direction === result.signal &&
          (Math.abs(prev.candleX - result.candleX) < 0.035 ||
            (result.candleId !== '' && prev.candleId === result.candleId)) &&
          Date.now() - prev.createdAt < 30000;

        if (!isDuplicate) {
          const nextSignal: VisualSignal = {
            id: `${sessionAtSend}-${Date.now()}`,
            direction: result.signal,
            candleX: result.candleX,
            candleY: result.candleY,
            chartRelativeX: result.chartRelativeX,
            chartRelativeY: result.chartRelativeY,
            chartBounds: result.chartBounds ?? local.chartBounds,
            confidence: result.confidence,
            candleId: result.candleId,
            marketRegime: result.marketRegime,
            createdAt: Date.now(),
            expiresAt: Date.now() + SIGNAL_TTL_MS,
          };
          lastSignalRef.current = nextSignal;
          setActiveSignal(nextSignal);
          syncOperationalStatusState(nextSignal.chartBounds, true);
          void pushLocalOverlaySignal(sessionAtSend, nextSignal);
        }
      } else if (lastSignalRef.current) {
        const prev = lastSignalRef.current;
        const expired = Date.now() > prev.expiresAt;
        const shiftedToNewCycle =
          Date.now() - prev.createdAt >= 10000 &&
          Math.abs(result.candleX - prev.candleX) >= 0.045 &&
          result.candleId !== '' &&
          result.candleId !== prev.candleId;
        if (expired || shiftedToNewCycle) {
          lastSignalRef.current = null;
          setActiveSignal(null);
          syncOperationalStatusState(result.chartBounds ?? local.chartBounds, true);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      if (isActiveRef.current) {
        setErrorMessage('Falha momentânea na análise visual. Tentando novamente...');
      }
    } finally {
      inFlightRef.current = false;
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [syncOperationalStatusState]);

  const activate = useCallback(async () => {
    if (isRequestingCaptureRef.current || isActiveRef.current) {
      return;
    }

    const envCheck = checkDisplayCaptureEnvironment();
    if (!envCheck.supported) {
      setErrorMessage(envCheck.message);
      return;
    }

    setErrorMessage(null);
    isRequestingCaptureRef.current = true;

    const isInIframe = (() => {
      try {
        return window.self !== window.top;
      } catch {
        return true;
      }
    })();

    const startedAt = Date.now();

    try {
      // Called synchronously inside the user's click gesture without any prior await
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack || videoTrack.readyState === 'ended') {
        stream.getTracks().forEach((t) => t.stop());
        setErrorMessage('Nenhuma tela ou janela ativa foi selecionada.');
        return;
      }

      if (typeof videoTrack.applyConstraints === 'function') {
        void videoTrack.applyConstraints({ frameRate: { ideal: 3, max: 5 } }).catch(() => {});
      }

      const newSessionId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      streamRef.current = stream;
      sessionIdRef.current = newSessionId;
      isActiveRef.current = true;
      lastSignatureRef.current = null;
      lastSignalRef.current = null;
      lastApiCallAtRef.current = 0;
      cooldownUntilRef.current = 0;

      videoTrack.onended = () => {
        deactivate();
      };

      const initialOpStatus = createInitialOperationalStatus(null, null, Date.now());
      lastOperationalStatusRef.current = initialOpStatus;
      lastStatusPushAtRef.current = Date.now();
      lastChartBoundsRef.current = null;

      setIsActive(true);
      setActiveSignal(null);
      setPriceLine(null);
      setLiveCandle(null);
      setOperationalStatus(initialOpStatus);

      const trackSettings =
        typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : {};
      const displaySurface =
        typeof (trackSettings as { displaySurface?: unknown }).displaySurface === 'string'
          ? String((trackSettings as { displaySurface?: string }).displaySurface)
          : 'window';
      displaySurfaceRef.current = displaySurface;

      console.info('[ChartPulse:Diag] Captura iniciada (Timeframe M1)', {
        sessionId: newSessionId,
        displaySurface,
        width: trackSettings.width,
        height: trackSettings.height,
        initialStatus: initialOpStatus.status,
      });

      void notifyLocalOverlaySession(newSessionId, displaySurface).then((connected) => {
        localAgentReadyRef.current = connected;
        setOverlayStatus(connected ? 'connected' : 'disconnected');
        if (connected && isActiveRef.current && sessionIdRef.current === newSessionId) {
          if (lastOperationalStatusRef.current) {
            void pushLocalOverlayStatus(newSessionId, lastOperationalStatusRef.current);
          }
          if (lastPriceLineRef.current) {
            void pushLocalOverlayPrice(newSessionId, lastPriceLineRef.current);
          }
          if (lastLiveCandleRef.current) {
            void pushLocalOverlayCandle(newSessionId, lastLiveCandleRef.current);
          }
        }
      });

      void fetch('/api/overlay/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: newSessionId, displaySurface }),
      })
        .then(() => {
          if (!isActiveRef.current || sessionIdRef.current !== newSessionId) return;
          if (lastOperationalStatusRef.current) {
            void fetch('/api/overlay/status', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: newSessionId,
                operationalStatus: lastOperationalStatusRef.current,
              }),
            }).catch(() => {});
          }
          if (lastPriceLineRef.current) {
            void fetch('/api/overlay/price', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: newSessionId,
                priceLine: lastPriceLineRef.current,
              }),
            }).catch(() => {});
          }
          if (lastLiveCandleRef.current) {
            void fetch('/api/overlay/candle', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: newSessionId,
                liveCandle: lastLiveCandleRef.current,
              }),
            }).catch(() => {});
          }
        })
        .catch(() => {
          // Non-fatal if SSE bridge isn't attached
        });

      // Wait a tick for the <video> element to mount and attach stream
      window.setTimeout(() => {
        if (!isActiveRef.current || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {});
        syncVideoRect();
        trackCurrentPrice();
        void analyzeCurrentFrame();
      }, 150);

      priceTimerRef.current = window.setInterval(() => {
        trackCurrentPrice();
      }, PRICE_POLL_MS);

      timerRef.current = window.setInterval(() => {
        void analyzeCurrentFrame();
      }, CAPTURE_POLL_MS);
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      setIsActive(false);
      isActiveRef.current = false;
      setErrorMessage(classifyDisplayCaptureError(err, elapsedMs, isInIframe));
    } finally {
      isRequestingCaptureRef.current = false;
    }
  }, [analyzeCurrentFrame, deactivate, syncVideoRect, trackCurrentPrice]);

  const handleToggle = useCallback(() => {
    if (isActiveRef.current) {
      deactivate();
    } else {
      void activate();
    }
  }, [activate, deactivate]);

  useEffect(() => {
    window.addEventListener('resize', syncVideoRect);
    return () => {
      window.removeEventListener('resize', syncVideoRect);
    };
  }, [syncVideoRect]);

  useEffect(() => {
    let cancelled = false;
    const probeOverlay = async () => {
      const health = await checkLocalOverlayHealth();
      const ok = Boolean(health?.ok);
      localAgentReadyRef.current = ok;
      const supportsStatus = Boolean(health?.operationalStatusSupported);
      if (!cancelled) {
        setOverlayStatus(ok ? 'connected' : 'disconnected');
        setOverlayAgentOutdated(ok && !supportsStatus);
        setOverlayAgentVersion(health?.version ?? null);
      }
      if (ok && health) {
        if (!supportsStatus) {
          console.warn(
            `[ChartPulse:Diag] Agente Windows instalado (${health.version ?? 'desconhecida'}) não suporta /overlay/status (AGUARDANDO). Recompile e reinstale ChartPulseOverlaySetup.exe (v1.3.1+).`
          );
        }
        // Auto-resync active browser session if Windows overlay restarted or missed /overlay/session
        const activeSid = sessionIdRef.current;
        if (
          isActiveRef.current &&
          activeSid &&
          (!health.active || health.operationalStatus === 'NONE')
        ) {
          void notifyLocalOverlaySession(activeSid, displaySurfaceRef.current).then((synced) => {
            if (!synced || !isActiveRef.current || sessionIdRef.current !== activeSid) return;
            if (lastOperationalStatusRef.current) {
              void pushLocalOverlayStatus(activeSid, lastOperationalStatusRef.current);
            }
            if (lastPriceLineRef.current) {
              void pushLocalOverlayPrice(activeSid, lastPriceLineRef.current);
            }
            if (lastLiveCandleRef.current) {
              void pushLocalOverlayCandle(activeSid, lastLiveCandleRef.current);
            }
            if (lastSignalRef.current) {
              void pushLocalOverlaySignal(activeSid, lastSignalRef.current);
            }
          });
        }
        console.info('[ChartPulse:Diag] Agente Windows', {
          version: health.version,
          active: health.active,
          overlayVisible: health.overlayVisible,
          overlayBounds: health.overlayBounds,
          targetBounds: health.targetBounds,
          targetWindowTitle: health.targetWindowTitle,
          priceLineSupported: health.priceLineSupported,
          liveCandleSupported: health.liveCandleSupported,
          operationalStatusSupported: health.operationalStatusSupported,
          hasStatusAnchor: health.hasStatusAnchor,
          hasLiveCandle: health.hasLiveCandle,
          hasPriceLine: health.hasPriceLine,
          operationalStatus: health.operationalStatus,
          lastStatusAnchorX: health.lastStatusAnchorX,
          lastStatusAnchorY: health.lastStatusAnchorY,
          priceLineUpdates: health.priceLineUpdates,
          liveCandleUpdates: health.liveCandleUpdates,
          statusUpdates: health.statusUpdates,
          paintCount: health.paintCount,
        });
      }
    };

    void probeOverlay();
    const id = window.setInterval(() => {
      void probeOverlay();
    }, OVERLAY_HEALTH_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (isActiveRef.current) {
        deactivate();
      }
    };
  }, [deactivate]);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#0B0E11] flex items-center justify-center">
      {isActive ? (
        <>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            onLoadedMetadata={syncVideoRect}
            onLoadedData={() => {
              syncVideoRect();
              trackCurrentPrice();
            }}
            onResize={syncVideoRect}
            className="h-full w-full object-contain pointer-events-none select-none"
          />

          <SignalOverlay
            active={isActive}
            signal={activeSignal}
            priceLine={priceLine}
            liveCandle={liveCandle}
            operationalStatus={operationalStatus}
            rect={videoRect}
          />

          {errorMessage && (
            <p
              role="status"
              className="pointer-events-none fixed top-5 left-1/2 -translate-x-1/2 z-30 text-xs text-slate-300/90 bg-black/70 px-3 py-1.5 rounded"
            >
              {errorMessage}
            </p>
          )}

          <button
            type="button"
            onClick={handleToggle}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 min-h-[44px] px-7 py-2.5 rounded-lg bg-[#DC2626] hover:bg-[#B91C1C] active:scale-[0.99] text-white font-semibold text-sm tracking-wide shadow-lg transition-all cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
          >
            DESATIVAR ANÁLISE
          </button>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center gap-6 px-6 text-center">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-100">
            ChartPulse AI
          </h1>

          <button
            type="button"
            onClick={handleToggle}
            className="min-h-[48px] px-9 py-3 rounded-lg bg-[#16A34A] hover:bg-[#15803D] active:scale-[0.99] text-white font-semibold text-base tracking-wide shadow-lg transition-all cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            ATIVAR ANÁLISE
          </button>

          {errorMessage && (
            <p role="alert" className="text-xs text-red-400 max-w-md leading-relaxed">
              {errorMessage}
            </p>
          )}

          <p className="text-xs max-w-md leading-relaxed text-slate-400">
            {overlayStatus === 'connected' ? (
              overlayAgentOutdated ? (
                <span className="text-amber-400">
                  Overlay Windows desatualizado ({overlayAgentVersion ?? 'v1.2.0'}) — recompile e reinstale ChartPulseOverlaySetup.exe (v1.3.1+) para exibir AGUARDANDO acima da vela na corretora.
                </span>
              ) : (
                <span className="text-emerald-400">
                  Overlay Windows: conectado em segundo plano ({overlayAgentVersion ?? 'v1.3.1'})
                </span>
              )
            ) : overlayStatus === 'checking' ? (
              'Overlay Windows: verificando conexão local...'
            ) : (
              'Overlay Windows: desligado — execute ChartPulseOverlaySetup.exe ou abra ChartPulseOverlay.exe no Windows para exibir sinais sobre a corretora.'
            )}
          </p>
        </div>
      )}
    </main>
  );
}
