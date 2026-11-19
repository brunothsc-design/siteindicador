using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ChartPulseOverlayAgent
{
    internal static class Win32Native
    {
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_LAYERED = 0x80000;
        public const int WS_EX_TRANSPARENT = 0x20;
        public const int WS_EX_TOPMOST = 0x8;
        public const int WS_EX_TOOLWINDOW = 0x80;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    }

    internal sealed class OverlayPayload
    {
        public bool Active;
        public string SessionId = string.Empty;
        public string Direction = string.Empty; // COMPRA or VENDA
        public double CandleX = 0.5;
        public double CandleY = 0.5;
        public double ChartRelativeX = 0.5;
        public double ChartRelativeY = 0.5;
        public bool HasBounds;
        public double BoundsX;
        public double BoundsY;
        public double BoundsW;
        public double BoundsH;
        public long ExpiresAtMs;

        public bool HasPriceLine;
        public double PriceY = 0.5;
        public double ChartRelativePriceY = 0.5;
        public bool HasPriceBounds;
        public double PriceBoundsX;
        public double PriceBoundsY;
        public double PriceBoundsW;
        public double PriceBoundsH;
        public long PriceUpdatedAtMs;

        public OverlayPayload Clone()
        {
            return (OverlayPayload)MemberwiseClone();
        }
    }

    internal sealed class OverlayForm : Form
    {
        private readonly object _stateLock = new object();
        private OverlayPayload _state = new OverlayPayload();
        private IntPtr _targetHwnd = IntPtr.Zero;
        private readonly System.Windows.Forms.Timer _trackTimer;

        private static readonly HashSet<string> IgnoredClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Progman",
            "WorkerW",
            "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd",
            "Windows.UI.Core.CoreWindow",
            "TaskManagerWindow"
        };

        public OverlayForm()
        {
            DoubleBuffered = true;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.Magenta;
            TransparencyKey = Color.Magenta;
            StartPosition = FormStartPosition.Manual;
            Bounds = new Rectangle(0, 0, 1, 1);

            _trackTimer = new System.Windows.Forms.Timer();
            _trackTimer.Interval = 50;
            _trackTimer.Tick += OnTrackTick;
            _trackTimer.Start();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            int exStyle = Win32Native.GetWindowLong(Handle, Win32Native.GWL_EXSTYLE);
            int nextStyle = exStyle
                | Win32Native.WS_EX_LAYERED
                | Win32Native.WS_EX_TRANSPARENT
                | Win32Native.WS_EX_TOPMOST
                | Win32Native.WS_EX_TOOLWINDOW
                | Win32Native.WS_EX_NOACTIVATE;
            Win32Native.SetWindowLong(Handle, Win32Native.GWL_EXSTYLE, nextStyle);
        }

        public void StartSession(string sessionId)
        {
            lock (_stateLock)
            {
                _state = new OverlayPayload
                {
                    Active = !string.IsNullOrEmpty(sessionId),
                    SessionId = sessionId ?? string.Empty
                };
            }
            RequestRepaint();
        }

        public void ClearOverlay()
        {
            lock (_stateLock)
            {
                _state = new OverlayPayload();
            }
            RequestRepaint();
        }

        public void UpdatePriceLine(
            string sessionId,
            bool hasPriceLine,
            double priceY,
            double chartRelativePriceY,
            bool hasPriceBounds,
            double bx,
            double by,
            double bw,
            double bh)
        {
            lock (_stateLock)
            {
                if (_state.SessionId != sessionId)
                {
                    _state = new OverlayPayload
                    {
                        Active = true,
                        SessionId = sessionId ?? string.Empty
                    };
                }
                _state.Active = true;
                _state.HasPriceLine = hasPriceLine;
                _state.PriceY = priceY;
                _state.ChartRelativePriceY = chartRelativePriceY;
                _state.HasPriceBounds = hasPriceBounds;
                _state.PriceBoundsX = bx;
                _state.PriceBoundsY = by;
                _state.PriceBoundsW = bw;
                _state.PriceBoundsH = bh;
                _state.PriceUpdatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            RequestRepaint();
        }

        public void UpdateSignal(
            string sessionId,
            string direction,
            double candleX,
            double candleY,
            double relX,
            double relY,
            bool hasBounds,
            double bx,
            double by,
            double bw,
            double bh,
            long expiresAtMs)
        {
            lock (_stateLock)
            {
                if (_state.SessionId != sessionId)
                {
                    _state = new OverlayPayload
                    {
                        Active = true,
                        SessionId = sessionId ?? string.Empty
                    };
                }
                _state.Active = true;
                _state.Direction = direction;
                _state.CandleX = candleX;
                _state.CandleY = candleY;
                _state.ChartRelativeX = relX;
                _state.ChartRelativeY = relY;
                _state.HasBounds = hasBounds;
                _state.BoundsX = bx;
                _state.BoundsY = by;
                _state.BoundsW = bw;
                _state.BoundsH = bh;
                _state.ExpiresAtMs = expiresAtMs;
            }
            RequestRepaint();
        }

        private void RequestRepaint()
        {
            if (IsHandleCreated)
            {
                BeginInvoke((Action)(() => Invalidate()));
            }
        }

        public bool IsAnalysisActive()
        {
            lock (_stateLock)
            {
                return _state.Active;
            }
        }

        private void OnTrackTick(object sender, EventArgs e)
        {
            OverlayPayload snapshot;
            lock (_stateLock)
            {
                snapshot = _state.Clone();
            }

            if (snapshot.Active && snapshot.ExpiresAtMs > 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > snapshot.ExpiresAtMs)
            {
                lock (_stateLock)
                {
                    if (_state.SessionId == snapshot.SessionId)
                    {
                        _state.Direction = string.Empty;
                        _state.ExpiresAtMs = 0;
                    }
                }
                Invalidate();
            }

            IntPtr fg = Win32Native.GetForegroundWindow();
            if (fg != IntPtr.Zero && fg != Handle)
            {
                StringBuilder clsSb = new StringBuilder(128);
                Win32Native.GetClassName(fg, clsSb, 128);
                string cls = clsSb.ToString();

                if (!IgnoredClasses.Contains(cls))
                {
                    StringBuilder titleSb = new StringBuilder(256);
                    Win32Native.GetWindowText(fg, titleSb, 256);
                    string title = titleSb.ToString();
                    if (!string.IsNullOrWhiteSpace(title) && title.IndexOf("ChartPulse AI", StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        _targetHwnd = fg;
                    }
                }
            }

            if (_targetHwnd != IntPtr.Zero && Win32Native.IsWindow(_targetHwnd))
            {
                if (Win32Native.IsIconic(_targetHwnd))
                {
                    if (Visible) Hide();
                    return;
                }

                Win32Native.RECT rect;
                int hr = Win32Native.DwmGetWindowAttribute(
                    _targetHwnd,
                    Win32Native.DWMWA_EXTENDED_FRAME_BOUNDS,
                    out rect,
                    Marshal.SizeOf(typeof(Win32Native.RECT))
                );
                bool hasRect = (hr == 0) || Win32Native.GetWindowRect(_targetHwnd, out rect);

                if (hasRect)
                {
                    int w = Math.Max(1, rect.Right - rect.Left);
                    int h = Math.Max(1, rect.Bottom - rect.Top);
                    Rectangle targetBounds = new Rectangle(rect.Left, rect.Top, w, h);
                    if (Bounds != targetBounds)
                    {
                        Bounds = targetBounds;
                        Invalidate();
                    }
                    if (!Visible) Show();
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            OverlayPayload snapshot;
            lock (_stateLock)
            {
                snapshot = _state.Clone();
            }

            bool hasSignal = snapshot.Active && (snapshot.Direction == "COMPRA" || snapshot.Direction == "VENDA");
            bool hasPriceLine = snapshot.Active && snapshot.HasPriceLine;

            if (!hasSignal && !hasPriceLine)
            {
                return;
            }

            Graphics g = e.Graphics;

            if (hasPriceLine)
            {
                double normLineY = snapshot.HasPriceBounds
                    ? snapshot.PriceBoundsY + snapshot.ChartRelativePriceY * snapshot.PriceBoundsH
                    : snapshot.PriceY;

                float lineY = (float)(Math.Max(0.02, Math.Min(0.98, normLineY)) * ClientSize.Height);
                float lineX0 = snapshot.HasPriceBounds
                    ? (float)(Math.Max(0.0, Math.Min(0.95, snapshot.PriceBoundsX)) * ClientSize.Width)
                    : (float)(0.04 * ClientSize.Width);
                float lineX1 = snapshot.HasPriceBounds
                    ? (float)(Math.Max(lineX0 + 20f, Math.Min(1.0, snapshot.PriceBoundsX + snapshot.PriceBoundsW) * ClientSize.Width))
                    : (float)(0.92 * ClientSize.Width);

                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
                using (Pen shadowPen = new Pen(Color.FromArgb(255, 8, 12, 18), 1f))
                using (Pen linePen = new Pen(Color.FromArgb(255, 56, 189, 248), 2f))
                {
                    g.DrawLine(shadowPen, lineX0, lineY + 1.5f, lineX1, lineY + 1.5f);
                    g.DrawLine(linePen, lineX0, lineY, lineX1, lineY);
                }
            }

            if (hasSignal)
            {
                double normX = snapshot.HasBounds
                    ? snapshot.BoundsX + snapshot.ChartRelativeX * snapshot.BoundsW
                    : snapshot.CandleX;
                double normY = snapshot.HasBounds
                    ? snapshot.BoundsY + snapshot.ChartRelativeY * snapshot.BoundsH
                    : snapshot.CandleY;

                float x = (float)(Math.Max(0.02, Math.Min(0.98, normX)) * ClientSize.Width);
                float y = (float)(Math.Max(0.02, Math.Min(0.98, normY)) * ClientSize.Height);

                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

                using (Font font = new Font("Consolas", 13f, FontStyle.Bold))
                using (SolidBrush shadowBrush = new SolidBrush(Color.FromArgb(245, 5, 5, 5)))
                using (SolidBrush textBrush = new SolidBrush(
                    snapshot.Direction == "COMPRA"
                        ? Color.FromArgb(255, 34, 197, 94)
                        : Color.FromArgb(255, 239, 68, 68)))
                {
                    SizeF size = g.MeasureString(snapshot.Direction, font);
                    float drawX = x - (size.Width / 2f);
                    float drawY = y - (size.Height / 2f);
                    g.DrawString(snapshot.Direction, font, shadowBrush, drawX + 1f, drawY + 1f);
                    g.DrawString(snapshot.Direction, font, textBrush, drawX, drawY);
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && _trackTimer != null)
            {
                _trackTimer.Stop();
                _trackTimer.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal static class Program
    {
        private const string ListenPrefix = "http://127.0.0.1:47821/";
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValueName = "ChartPulseAIOverlay";

        private static Mutex _singleInstanceMutex;
        private static OverlayForm _overlayForm;
        private static readonly List<string> ExtraOrigins = LoadCustomAllowedOrigins();

        [STAThread]
        private static void Main()
        {
            bool createdNew;
            _singleInstanceMutex = new Mutex(true, @"Local\ChartPulseAIOverlayAgent", out createdNew);
            if (!createdNew)
            {
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            _overlayForm = new OverlayForm();

            Thread httpThread = new Thread(RunLocalHttpServer);
            httpThread.IsBackground = true;
            httpThread.Start();

            Application.Run(_overlayForm);
            _singleInstanceMutex.ReleaseMutex();
        }

        private static List<string> LoadCustomAllowedOrigins()
        {
            List<string> list = new List<string>();
            try
            {
                string path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ChartPulseAI",
                    "allowed-origins.txt"
                );
                if (File.Exists(path))
                {
                    foreach (string line in File.ReadAllLines(path))
                    {
                        string trimmed = line.Trim().TrimEnd('/');
                        if (!string.IsNullOrEmpty(trimmed) && !trimmed.StartsWith("#"))
                        {
                            list.Add(trimmed);
                        }
                    }
                }
            }
            catch
            {
                // Ignore custom allowlist read errors
            }
            return list;
        }

        private static bool IsTrustedOrigin(string origin)
        {
            if (string.IsNullOrWhiteSpace(origin)) return false;
            string trimmed = origin.Trim().TrimEnd('/');
            Uri uri;
            if (!Uri.TryCreate(trimmed, UriKind.Absolute, out uri)) return false;

            string host = uri.Host.ToLowerInvariant();
            string scheme = uri.Scheme.ToLowerInvariant();

            if ((scheme == "http" || scheme == "https") && (host == "localhost" || host == "127.0.0.1"))
            {
                return true;
            }

            if (scheme == "https")
            {
                if (host.EndsWith(".netlify.app") && host.Length > ".netlify.app".Length) return true;
                if (host.EndsWith(".run.app") && host.Length > ".run.app".Length) return true;
            }

            foreach (string extra in ExtraOrigins)
            {
                if (string.Equals(extra, trimmed, StringComparison.OrdinalIgnoreCase)) return true;
            }

            return false;
        }

        private static bool IsAutoStartRegistered()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
                {
                    return key != null && key.GetValue(RunValueName) != null;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void RunLocalHttpServer()
        {
            HttpListener listener = new HttpListener();
            listener.Prefixes.Add(ListenPrefix);
            try
            {
                listener.Start();
            }
            catch
            {
                return;
            }

            while (listener.IsListening)
            {
                HttpListenerContext ctx = null;
                try
                {
                    ctx = listener.GetContext();
                    HandleRequest(ctx);
                }
                catch
                {
                    if (ctx != null)
                    {
                        try { ctx.Response.Close(); } catch { }
                    }
                }
            }
        }

        private static void WriteJson(HttpListenerResponse res, int status, string json)
        {
            byte[] buf = Encoding.UTF8.GetBytes(json);
            res.StatusCode = status;
            res.ContentType = "application/json; charset=utf-8";
            res.ContentLength64 = buf.Length;
            res.OutputStream.Write(buf, 0, buf.Length);
            res.OutputStream.Close();
        }

        private static void HandleRequest(HttpListenerContext ctx)
        {
            HttpListenerRequest req = ctx.Request;
            HttpListenerResponse res = ctx.Response;

            string origin = req.Headers["Origin"];
            if (!string.IsNullOrEmpty(origin))
            {
                if (!IsTrustedOrigin(origin))
                {
                    WriteJson(res, 403, "{\"ok\":false,\"error\":\"Origin not allowed\"}");
                    return;
                }
                res.Headers["Access-Control-Allow-Origin"] = origin;
                res.Headers["Vary"] = "Origin";
            }

            res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
            res.Headers["Access-Control-Allow-Headers"] = "Content-Type";
            res.Headers["Access-Control-Allow-Private-Network"] = "true";
            res.Headers["Cache-Control"] = "no-store";

            if (req.HttpMethod == "OPTIONS")
            {
                res.StatusCode = 204;
                res.OutputStream.Close();
                return;
            }

            // Require an approved Origin header for state-changing POST routes
            if (req.HttpMethod == "POST" && !IsTrustedOrigin(origin))
            {
                WriteJson(res, 403, "{\"ok\":false,\"error\":\"Trusted Origin required\"}");
                return;
            }

            string path = req.Url != null ? req.Url.AbsolutePath : "/";

            if (req.HttpMethod == "GET" && path == "/health")
            {
                bool active = _overlayForm.IsAnalysisActive();
                bool autoStart = IsAutoStartRegistered();
                WriteJson(
                    res,
                    200,
                    string.Format(
                        "{{\"ok\":true,\"component\":\"ChartPulseOverlay\",\"version\":\"1.1.0\",\"priceLineSupported\":true,\"active\":{0},\"autoStartEnabled\":{1}}}",
                        active ? "true" : "false",
                        autoStart ? "true" : "false"
                    )
                );
                return;
            }

            string bodyText = string.Empty;
            if (req.HasEntityBody)
            {
                using (StreamReader reader = new StreamReader(req.InputStream, Encoding.UTF8))
                {
                    bodyText = reader.ReadToEnd();
                }
            }

            if (req.HttpMethod == "POST" && path == "/overlay/session")
            {
                string sessionId = ExtractJsonString(bodyText, "sessionId");
                _overlayForm.StartSession(sessionId);
                WriteJson(res, 200, "{\"ok\":true}");
                return;
            }

            if (req.HttpMethod == "POST" && path == "/overlay/clear")
            {
                // Clears signals and tracking line immediately while keeping the background daemon alive
                _overlayForm.ClearOverlay();
                WriteJson(res, 200, "{\"ok\":true}");
                return;
            }

            if (req.HttpMethod == "POST" && path == "/overlay/price")
            {
                string sessionId = ExtractJsonString(bodyText, "sessionId");
                string priceObj = ExtractJsonObject(bodyText, "priceLine");
                if (string.IsNullOrEmpty(priceObj))
                {
                    _overlayForm.UpdatePriceLine(sessionId, false, 0.5, 0.5, false, 0, 0, 1, 1);
                    WriteJson(res, 200, "{\"ok\":true}");
                    return;
                }

                string boundsObj = ExtractJsonObject(priceObj, "chartBounds");
                string priceShallow = string.IsNullOrEmpty(boundsObj)
                    ? priceObj
                    : priceObj.Replace(boundsObj, "{}");

                double priceY = ExtractJsonDouble(priceShallow, "y", 0.5);
                double relPriceY = ExtractJsonDouble(priceShallow, "chartRelativeY", priceY);
                bool hasBounds = false;
                double bx = 0, by = 0, bw = 1, bh = 1;

                if (!string.IsNullOrEmpty(boundsObj))
                {
                    bx = ExtractJsonDouble(boundsObj, "x", 0);
                    by = ExtractJsonDouble(boundsObj, "y", 0);
                    bw = ExtractJsonDouble(boundsObj, "width", 1);
                    bh = ExtractJsonDouble(boundsObj, "height", 1);
                    hasBounds = bw > 0.05 && bh > 0.05;
                }

                _overlayForm.UpdatePriceLine(sessionId, true, priceY, relPriceY, hasBounds, bx, by, bw, bh);
                WriteJson(res, 200, "{\"ok\":true}");
                return;
            }

            if (req.HttpMethod == "POST" && path == "/overlay/signal")
            {
                string sessionId = ExtractJsonString(bodyText, "sessionId");
                string sigObj = ExtractJsonObject(bodyText, "signal");
                string sigSource = string.IsNullOrEmpty(sigObj) ? bodyText : sigObj;
                string boundsObj = ExtractJsonObject(sigSource, "chartBounds");
                string sigShallow = string.IsNullOrEmpty(boundsObj)
                    ? sigSource
                    : sigSource.Replace(boundsObj, "{}");

                string direction = ExtractJsonString(sigShallow, "direction");
                double candleX = ExtractJsonDouble(sigShallow, "candleX", 0.5);
                double candleY = ExtractJsonDouble(sigShallow, "candleY", 0.5);
                double relX = ExtractJsonDouble(sigShallow, "chartRelativeX", candleX);
                double relY = ExtractJsonDouble(sigShallow, "chartRelativeY", candleY);

                bool hasBounds = false;
                double bx = 0, by = 0, bw = 1, bh = 1;
                if (!string.IsNullOrEmpty(boundsObj))
                {
                    bx = ExtractJsonDouble(boundsObj, "x", 0);
                    by = ExtractJsonDouble(boundsObj, "y", 0);
                    bw = ExtractJsonDouble(boundsObj, "width", 1);
                    bh = ExtractJsonDouble(boundsObj, "height", 1);
                    hasBounds = bw > 0.05 && bh > 0.05;
                }

                _overlayForm.UpdateSignal(
                    sessionId,
                    direction,
                    candleX,
                    candleY,
                    relX,
                    relY,
                    hasBounds,
                    bx,
                    by,
                    bw,
                    bh,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 18000
                );
                WriteJson(res, 200, "{\"ok\":true}");
                return;
            }

            WriteJson(res, 404, "{\"ok\":false,\"error\":\"Not found\"}");
        }

        private static string ExtractJsonObject(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return string.Empty;
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\\{");
            if (!m.Success) return string.Empty;

            int start = m.Index + m.Length - 1;
            int depth = 0;
            bool inString = false;
            bool escaped = false;

            for (int i = start; i < json.Length; i++)
            {
                char c = json[i];
                if (escaped)
                {
                    escaped = false;
                    continue;
                }
                if (c == '\\' && inString)
                {
                    escaped = true;
                    continue;
                }
                if (c == '"')
                {
                    inString = !inString;
                    continue;
                }
                if (!inString)
                {
                    if (c == '{') depth++;
                    else if (c == '}')
                    {
                        depth--;
                        if (depth == 0)
                        {
                            return json.Substring(start, i - start + 1);
                        }
                    }
                }
            }
            return string.Empty;
        }

        private static string ExtractJsonString(string json, string key)
        {
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]*)\"");
            return m.Success ? m.Groups[1].Value : string.Empty;
        }

        private static double ExtractJsonDouble(string json, string key, double fallback)
        {
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");
            double val;
            if (m.Success && double.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out val))
            {
                return val;
            }
            return fallback;
        }
    }
}
