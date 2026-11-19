import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import {
  emptyAnalyzeResponse,
  executeGeminiFrameAnalysis,
} from './server/analyzeFrameCore.ts';
import type {
  AnalyzeFrameRequest,
  LiveCandleTracker,
  OperationalStatusState,
  OverlayState,
  PriceLine,
  VisualSignal,
} from './src/types/signals.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Overlay state & deactivated session tracking (prevents stale in-flight signals from resurfacing)
const overlayState: OverlayState = {
  active: false,
  sessionId: null,
  signal: null,
  priceLine: null,
  liveCandle: null,
  operationalStatus: null,
  chartBounds: null,
  updatedAt: Date.now(),
};

const deactivatedSessions = new Set<string>();
const sseClients = new Set<Response>();

function broadcastOverlayState(): void {
  const payload = `data: ${JSON.stringify(overlayState)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'display-capture=(self)');
    next();
  });
  app.use(express.json({ limit: '6mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, active: overlayState.active });
  });

  app.get('/api/overlay/state', (_req: Request, res: Response) => {
    const now = Date.now();
    if (overlayState.active && overlayState.signal && now > overlayState.signal.expiresAt) {
      overlayState.signal = null;
      overlayState.operationalStatus = {
        status: 'AGUARDANDO',
        timeframe: 'M1',
        confidence: 0,
        chartBounds: overlayState.chartBounds,
        expiresAt: null,
        updatedAt: now,
      };
      overlayState.updatedAt = now;
    }
    res.json(overlayState);
  });

  app.get('/api/overlay/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);
    res.write(`data: ${JSON.stringify(overlayState)}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  app.post('/api/overlay/session', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string };
    const sessionId = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    if (!sessionId) {
      res.status(400).json({ ok: false, error: 'sessionId required' });
      return;
    }

    deactivatedSessions.delete(sessionId);
    const now = Date.now();
    overlayState.active = true;
    overlayState.sessionId = sessionId;
    overlayState.signal = null;
    overlayState.priceLine = null;
    overlayState.liveCandle = null;
    overlayState.operationalStatus = {
      status: 'AGUARDANDO',
      timeframe: 'M1',
      confidence: 0,
      chartBounds: null,
      expiresAt: null,
      updatedAt: now,
    };
    overlayState.chartBounds = null;
    overlayState.updatedAt = now;
    broadcastOverlayState();

    res.json({ ok: true, sessionId });
  });

  app.post('/api/overlay/price', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string; priceLine?: PriceLine | null };
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId || deactivatedSessions.has(sessionId) || overlayState.sessionId !== sessionId) {
      res.json({ ok: true, ignored: true });
      return;
    }

    const nextPrice = body?.priceLine ?? null;
    overlayState.priceLine = nextPrice;
    if (nextPrice?.chartBounds) {
      overlayState.chartBounds = nextPrice.chartBounds;
    }
    overlayState.updatedAt = Date.now();
    broadcastOverlayState();

    res.json({ ok: true });
  });

  app.post('/api/overlay/candle', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string; liveCandle?: LiveCandleTracker | null };
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId || deactivatedSessions.has(sessionId) || overlayState.sessionId !== sessionId) {
      res.json({ ok: true, ignored: true });
      return;
    }

    const nextCandle = body?.liveCandle ?? null;
    overlayState.liveCandle = nextCandle;
    if (nextCandle?.chartBounds) {
      overlayState.chartBounds = nextCandle.chartBounds;
    }
    overlayState.updatedAt = Date.now();
    broadcastOverlayState();

    res.json({ ok: true });
  });

  app.post('/api/overlay/status', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string; operationalStatus?: OperationalStatusState | null };
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId || deactivatedSessions.has(sessionId) || overlayState.sessionId !== sessionId) {
      res.json({ ok: true, ignored: true });
      return;
    }

    const incoming = body?.operationalStatus;
    const rawStatus = String(incoming?.status ?? 'AGUARDANDO').toUpperCase();
    const safeStatus =
      rawStatus === 'COMPRA' || rawStatus === 'VENDA' ? rawStatus : 'AGUARDANDO';

    const nextStatus: OperationalStatusState = {
      status: safeStatus,
      timeframe: 'M1',
      confidence: typeof incoming?.confidence === 'number' ? incoming.confidence : 0,
      chartBounds: incoming?.chartBounds ?? overlayState.chartBounds ?? null,
      expiresAt: typeof incoming?.expiresAt === 'number' ? incoming.expiresAt : null,
      updatedAt: Date.now(),
    };

    overlayState.operationalStatus = nextStatus;
    if (nextStatus.chartBounds) {
      overlayState.chartBounds = nextStatus.chartBounds;
    }
    overlayState.updatedAt = Date.now();
    broadcastOverlayState();

    res.json({ ok: true });
  });

  app.post('/api/overlay/clear', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string };
    if (typeof body?.sessionId === 'string' && body.sessionId) {
      deactivatedSessions.add(body.sessionId);
    }
    if (overlayState.sessionId) {
      deactivatedSessions.add(overlayState.sessionId);
    }
    if (deactivatedSessions.size > 100) {
      const oldest = deactivatedSessions.values().next().value;
      if (oldest) deactivatedSessions.delete(oldest);
    }

    overlayState.active = false;
    overlayState.sessionId = null;
    overlayState.signal = null;
    overlayState.priceLine = null;
    overlayState.liveCandle = null;
    overlayState.operationalStatus = null;
    overlayState.chartBounds = null;
    overlayState.updatedAt = Date.now();
    broadcastOverlayState();

    res.json({ ok: true });
  });

  app.post('/api/analyze-frame', async (req: Request, res: Response) => {
    const body = req.body as Partial<AnalyzeFrameRequest>;
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';

    if (!sessionId || deactivatedSessions.has(sessionId) || overlayState.sessionId !== sessionId) {
      res.json(emptyAnalyzeResponse(true));
      return;
    }

    const result = await executeGeminiFrameAnalysis(body, {
      isSessionCancelled: () =>
        deactivatedSessions.has(sessionId) || overlayState.sessionId !== sessionId,
    });

    if (result.status === 200 && result.body.ok) {
      if (result.body.chartBounds) {
        overlayState.chartBounds = result.body.chartBounds;
      }

      if (result.body.signal === 'COMPRA' || result.body.signal === 'VENDA') {
        const now = Date.now();
        const nextSignal: VisualSignal = {
          id: `${sessionId}-${now}`,
          direction: result.body.signal,
          candleX: result.body.candleX,
          candleY: result.body.candleY,
          chartRelativeX: result.body.chartRelativeX,
          chartRelativeY: result.body.chartRelativeY,
          chartBounds: result.body.chartBounds,
          confidence: result.body.confidence,
          candleId: result.body.candleId,
          marketRegime: result.body.marketRegime,
          createdAt: now,
          expiresAt: now + 18000,
        };
        overlayState.signal = nextSignal;
        overlayState.operationalStatus = {
          status: nextSignal.direction,
          timeframe: 'M1',
          confidence: nextSignal.confidence,
          chartBounds: nextSignal.chartBounds ?? overlayState.chartBounds,
          expiresAt: nextSignal.expiresAt,
          updatedAt: now,
        };
        overlayState.updatedAt = now;
        broadcastOverlayState();
      } else if (overlayState.signal && Date.now() > overlayState.signal.expiresAt) {
        const now = Date.now();
        overlayState.signal = null;
        overlayState.operationalStatus = {
          status: 'AGUARDANDO',
          timeframe: 'M1',
          confidence: 0,
          chartBounds: overlayState.chartBounds,
          expiresAt: null,
          updatedAt: now,
        };
        overlayState.updatedAt = now;
        broadcastOverlayState();
      }
    }

    res.status(result.status).json(result.body);
  });

  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ChartPulse AI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ChartPulse AI server:', err);
  process.exit(1);
});
