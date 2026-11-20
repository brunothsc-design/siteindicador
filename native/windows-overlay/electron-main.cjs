// Minimal Electron native overlay wrapper for ChartPulse AI EXE builds.
// Keeps the main ATIVAR IA / DESATIVAR IA window separate from a transparent
// click-through overlay window that renders ONLY COMPRA/VENDA over broker programs.
const { app, BrowserWindow } = require('electron');

const APP_URL = process.env.CHARTPULSE_URL || 'http://localhost:3000';

let controlWindow = null;
let overlayWindow = null;

function createWindows() {
  controlWindow = new BrowserWindow({
    width: 420,
    height: 280,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#0B0E11',
    title: 'ChartPulse AI',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  controlWindow.loadURL(APP_URL);

  overlayWindow = new BrowserWindow({
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Pass all mouse clicks and movements directly through to the broker EXE
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  const overlayHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
html, body { margin:0; padding:0; width:100vw; height:100vh; overflow:hidden; background:transparent; pointer-events:none; user-select:none; }
#line { position:fixed; height:2px; background:#38BDF8; box-shadow:0 0 4px #000,0 1px 1px #000; transform:translateY(-50%); display:none; }
#live { position:fixed; width:16px; height:16px; border-radius:9999px; border:2px solid #FBBF24; background:rgba(11,14,17,0.45); box-shadow:0 0 6px #000; transform:translate(-50%,-50%); display:none; align-items:center; justify-content:center; }
#liveDot { width:6px; height:6px; border-radius:9999px; background:#FBBF24; }
#opStatus { position:fixed; transform:translate(-50%,-100%); display:none; flex-direction:column; align-items:center; transition:left 200ms ease-out, top 200ms ease-out; }
#opBox { padding:6px 14px; border-radius:8px; font:700 15px/1.15 system-ui,-apple-system,Segoe UI,sans-serif; letter-spacing:0.06em; text-align:center; white-space:nowrap; background:rgba(11,14,17,0.94); box-shadow:0 4px 12px rgba(0,0,0,0.85); transition:color 150ms, border-color 150ms; }
#opArrow { margin-top:-2px; display:block; overflow:visible; }
</style></head>
<body>
<div id="opStatus"><div id="opBox"></div><svg id="opArrow" width="16" height="8" viewBox="0 0 16 8"><polygon points="1,0 15,0 8,7" fill="rgba(11,14,17,0.94)" /><polyline id="opArrowStroke" points="1,0 8,7 15,0" fill="none" stroke="#FBBF24" stroke-width="2" stroke-linejoin="round" /></svg></div>
<div id="line"></div>
<div id="live"><div id="liveDot"></div></div>
<script>
const opEl = document.getElementById('opStatus');
const opBoxEl = document.getElementById('opBox');
const opArrowStrokeEl = document.getElementById('opArrowStroke');
const lineEl = document.getElementById('line');
const liveEl = document.getElementById('live');
const liveDotEl = document.getElementById('liveDot');
const es = new EventSource('${APP_URL}/api/overlay/stream');
es.onmessage = (ev) => {
  try {
    const s = JSON.parse(ev.data);
    if (!s.active) {
      opEl.style.display = 'none';
      lineEl.style.display = 'none';
      liveEl.style.display = 'none';
      return;
    }
    const anchor = s.operationalStatus && s.operationalStatus.anchor;
    if (anchor) {
      const statusText = (s.operationalStatus && s.operationalStatus.status) || (s.signal && s.signal.direction) || 'AGUARDANDO';
      const sb = (s.operationalStatus && s.operationalStatus.chartBounds) || s.chartBounds;
      let sLeft = sb ? sb.x + anchor.chartRelativeX * sb.width : anchor.x;
      let sTop = sb ? sb.y + anchor.chartRelativeY * sb.height : anchor.y;
      if (sb) {
        const px = Math.min(0.012, sb.width * 0.04);
        sLeft = Math.max(sb.x + px, Math.min(sb.x + sb.width - px, sLeft));
        sTop = Math.max(sb.y + Math.min(0.068, sb.height * 0.2), Math.min(sb.y + sb.height - 0.015, sTop));
      }
      const sColor = statusText === 'COMPRA' ? '#22C55E' : (statusText === 'VENDA' ? '#EF4444' : '#FBBF24');
      opBoxEl.textContent = statusText;
      opEl.style.left = (sLeft * 100) + '%';
      opEl.style.top = (sTop * 100) + '%';
      opBoxEl.style.color = sColor;
      opBoxEl.style.border = '2px solid ' + sColor;
      opArrowStrokeEl.setAttribute('stroke', sColor);
      opEl.style.display = 'flex';
    } else {
      opEl.style.display = 'none';
    }
    if (s.priceLine) {
      const b = s.priceLine.chartBounds || s.chartBounds;
      const top = b ? b.y + s.priceLine.chartRelativeY * b.height : s.priceLine.y;
      lineEl.style.left = ((b ? b.x : 0.04) * 100) + '%';
      lineEl.style.width = ((b ? b.width : 0.88) * 100) + '%';
      lineEl.style.top = (top * 100) + '%';
      lineEl.style.display = 'block';
    } else {
      lineEl.style.display = 'none';
    }
    if (s.liveCandle) {
      const cb = s.liveCandle.chartBounds || s.chartBounds;
      const cx = cb ? cb.x + s.liveCandle.chartRelativeX * cb.width : s.liveCandle.x;
      const cy = cb ? cb.y + s.liveCandle.chartRelativeY * cb.height : s.liveCandle.y;
      const cColor = s.liveCandle.direction === 'BULL' ? '#10B981' : (s.liveCandle.direction === 'BEAR' ? '#F43F5E' : '#FBBF24');
      liveEl.style.left = (cx * 100) + '%';
      liveEl.style.top = (cy * 100) + '%';
      liveEl.style.borderColor = cColor;
      liveDotEl.style.background = cColor;
      liveEl.style.display = 'flex';
    } else {
      liveEl.style.display = 'none';
    }
  } catch {
    opEl.style.display = 'none';
    lineEl.style.display = 'none';
    liveEl.style.display = 'none';
  }
};
es.onerror = () => { opEl.style.display = 'none'; lineEl.style.display = 'none'; liveEl.style.display = 'none'; };
</script>
</body>
</html>`;

  overlayWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(overlayHtml));

  controlWindow.on('closed', () => {
    controlWindow = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
    }
  });
}

app.whenReady().then(createWindows);
app.on('window-all-closed', () => app.quit());
