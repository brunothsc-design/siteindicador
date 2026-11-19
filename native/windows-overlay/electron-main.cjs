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
#sig { position:fixed; transform:translate(-50%,-50%); font:700 16px/1 Consolas,monospace; letter-spacing:0.06em; text-shadow:0 1px 2px #000,0 0 8px #000; display:none; }
</style></head>
<body>
<div id="line"></div>
<div id="sig"></div>
<script>
const lineEl = document.getElementById('line');
const el = document.getElementById('sig');
const es = new EventSource('${APP_URL}/api/overlay/stream');
es.onmessage = (ev) => {
  try {
    const s = JSON.parse(ev.data);
    if (!s.active) {
      lineEl.style.display = 'none';
      el.style.display = 'none';
      return;
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
    if (!s.signal || (s.signal.direction !== 'COMPRA' && s.signal.direction !== 'VENDA')) {
      el.style.display = 'none';
      return;
    }
    el.textContent = s.signal.direction;
    el.style.color = s.signal.direction === 'COMPRA' ? '#22C55E' : '#EF4444';
    el.style.left = (s.signal.candleX * 100) + '%';
    el.style.top = (s.signal.candleY * 100) + '%';
    el.style.display = 'block';
  } catch {
    lineEl.style.display = 'none';
    el.style.display = 'none';
  }
};
es.onerror = () => { lineEl.style.display = 'none'; el.style.display = 'none'; };
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
