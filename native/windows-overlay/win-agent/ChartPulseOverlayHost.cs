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

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    }

    internal sealed class OverlayPayload
    {
        public bool Active;
        public string SessionId = string.Empty;
        public string DisplaySurface = "window"; // "window", "monitor", or "browser"
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

        public bool HasLiveCandle;
        public double LiveCandleX = 0.5;
        public double LiveCandleY = 0.5;
        public double ChartRelativeLiveX = 0.5;
        public double ChartRelativeLiveY = 0.5;
        public string LiveCandleDirection = "NEUTRAL";
        public bool HasLiveCandleBounds;
        public double LiveCandleBoundsX;
        public double LiveCandleBoundsY;
        public double LiveCandleBoundsW;
        public double LiveCandleBoundsH;
        public long LiveCandleUpdatedAtMs;

        public string OperationalStatus = string.Empty; // AGUARDANDO, COMPRA, VENDA
        public bool HasStatusBounds;
        public double StatusBoundsX;
        public double StatusBoundsY;
        public double StatusBoundsW;
        public double StatusBoundsH;
        public long StatusUpdatedAtMs;

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
        private long _priceLineUpdates;
        private long _liveCandleUpdates;
        private long _statusUpdates;
        private long _signalUpdates;
        private long _paintCount;
        private Rectangle _lastTargetBounds = new Rectangle(0, 0, 1, 1);

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
            Rectangle initialScreen = Screen.PrimaryScreen != null
                ? Screen.PrimaryScreen.Bounds
                : new Rectangle(0, 0, 1280, 720);
            Bounds = initialScreen;
            _lastTargetBounds = initialScreen;

            _trackTimer = new System.Windows.Forms.Timer();
            _trackTimer.Interval = 50;
            _trackTimer.Tick += OnTrackTick;
            _trackTimer.Start();
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= Win32Native.WS_EX_LAYERED
                    | Win32Native.WS_EX_TRANSPARENT
                    | Win32Native.WS_EX_TOPMOST
                    | Win32Native.WS_EX_TOOLWINDOW
                    | Win32Native.WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ApplyOverlayStylesAndTopMost();
        }

        private void ApplyOverlayStylesAndTopMost()
        {
            if (!IsHandleCreated) return;
            int exStyle = Win32Native.GetWindowLong(Handle, Win32Native.GWL_EXSTYLE);
            int nextStyle = exStyle
                | Win32Native.WS_EX_LAYERED
                | Win32Native.WS_EX_TRANSPARENT
                | Win32Native.WS_EX_TOPMOST
                | Win32Native.WS_EX_TOOLWINDOW
                | Win32Native.WS_EX_NOACTIVATE;
            Win32Native.SetWindowLong(Handle, Win32Native.GWL_EXSTYLE, nextStyle);
            Win32Native.SetWindowPos(
                Handle,
                Win32Native.HWND_TOPMOST,
                0,
                0,
                0,
                0,
                Win32Native.SWP_NOMOVE | Win32Native.SWP_NOSIZE | Win32Native.SWP_NOACTIVATE
            );
        }

        public void StartSession(string sessionId, string displaySurface)
        {
            string normalizedSurface = string.IsNullOrEmpty(displaySurface) ? "window" : displaySurface;
            lock (_stateLock)
            {
                // Preserve early price/candle/status updates if /overlay/session arrives slightly after them for the same sessionId
                if (!string.IsNullOrEmpty(sessionId) && _state.SessionId == sessionId)
                {
                    _state.Active = true;
                    _state.DisplaySurface = normalizedSurface;
                    if (string.IsNullOrEmpty(_state.OperationalStatus))
                    {
                        _state.OperationalStatus = "AGUARDANDO";
                    }
                }
                else
                {
                    _state = new OverlayPayload
                    {
                        Active = !string.IsNullOrEmpty(sessionId),
                        SessionId = sessionId ?? string.Empty,
                        DisplaySurface = normalizedSurface,
                        OperationalStatus = !string.IsNullOrEmpty(sessionId) ? "AGUARDANDO" : string.Empty
                    };
                }
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
            Interlocked.Increment(ref _priceLineUpdates);
            RequestRepaint();
        }

        public void UpdateLiveCandle(
            string sessionId,
            bool hasLiveCandle,
            double candleX,
            double candleY,
            double chartRelativeX,
            double chartRelativeY,
            string direction,
            bool hasLiveCandleBounds,
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
                _state.HasLiveCandle = hasLiveCandle;
                _state.LiveCandleX = candleX;
                _state.LiveCandleY = candleY;
                _state.ChartRelativeLiveX = chartRelativeX;
                _state.ChartRelativeLiveY = chartRelativeY;
                _state.LiveCandleDirection = string.IsNullOrEmpty(direction) ? "NEUTRAL" : direction;
                _state.HasLiveCandleBounds = hasLiveCandleBounds;
                _state.LiveCandleBoundsX = bx;
                _state.LiveCandleBoundsY = by;
                _state.LiveCandleBoundsW = bw;
                _state.LiveCandleBoundsH = bh;
                _state.LiveCandleUpdatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            Interlocked.Increment(ref _liveCandleUpdates);
            RequestRepaint();
        }

        public void UpdateOperationalStatus(
            string sessionId,
            string status,
            bool hasStatusBounds,
            double bx,
            double by,
            double bw,
            double bh)
        {
            string safeStatus = (status == "COMPRA" || status == "VENDA") ? status : "AGUARDANDO";
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
                _state.OperationalStatus = safeStatus;
                if (hasStatusBounds)
                {
                    _state.HasStatusBounds = true;
                    _state.StatusBoundsX = bx;
                    _state.StatusBoundsY = by;
                    _state.StatusBoundsW = bw;
                    _state.StatusBoundsH = bh;
                }
                _state.StatusUpdatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            Interlocked.Increment(ref _statusUpdates);
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
                _state.OperationalStatus = (direction == "COMPRA" || direction == "VENDA") ? direction : "AGUARDANDO";
            }
            Interlocked.Increment(ref _signalUpdates);
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

        public string BuildDiagnosticsJson(bool autoStart)
        {
            bool active;
            string surface;
            string opStatus;
            lock (_stateLock)
            {
                active = _state.Active;
                surface = _state.DisplaySurface;
                opStatus = string.IsNullOrEmpty(_state.OperationalStatus)
                    ? (active ? "AGUARDANDO" : "NONE")
                    : _state.OperationalStatus;
            }
            Rectangle b = _lastTargetBounds;
            string boundsText = string.Format("{0},{1},{2}x{3}", b.X, b.Y, b.Width, b.Height);
            return string.Format(
                "{{\"ok\":true,\"component\":\"ChartPulseOverlay\",\"version\":\"1.3.0\",\"priceLineSupported\":true,\"liveCandleSupported\":true,\"operationalStatusSupported\":true,\"active\":{0},\"autoStartEnabled\":{1},\"displaySurface\":\"{2}\",\"operationalStatus\":\"{3}\",\"targetBounds\":\"{4}\",\"priceLineUpdates\":{5},\"liveCandleUpdates\":{6},\"statusUpdates\":{7},\"signalUpdates\":{8},\"paintCount\":{9}}}",
                active ? "true" : "false",
                autoStart ? "true" : "false",
                surface,
                opStatus,
                boundsText,
                Interlocked.Read(ref _priceLineUpdates),
                Interlocked.Read(ref _liveCandleUpdates),
                Interlocked.Read(ref _statusUpdates),
                Interlocked.Read(ref _signalUpdates),
                Interlocked.Read(ref _paintCount)
            );
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
                        _state.OperationalStatus = "AGUARDANDO";
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

            if (snapshot.DisplaySurface == "monitor")
            {
                Screen activeScreen = Screen.FromPoint(Cursor.Position) ?? Screen.PrimaryScreen;
                Rectangle monitorBounds = activeScreen != null ? activeScreen.Bounds : new Rectangle(0, 0, 1280, 720);
                _lastTargetBounds = monitorBounds;
                if (Bounds != monitorBounds)
                {
                    Bounds = monitorBounds;
                    Invalidate();
                }
                if (snapshot.Active)
                {
                    if (!Visible) Show();
                    ApplyOverlayStylesAndTopMost();
                }
                return;
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
                    _lastTargetBounds = targetBounds;
                    if (Bounds != targetBounds)
                    {
                        Bounds = targetBounds;
                        Invalidate();
                    }
                    if (!Visible) Show();
                    if (snapshot.Active) ApplyOverlayStylesAndTopMost();
                }
            }
            else if (snapshot.Active)
            {
                // Fallback so overlay never stays trapped at 1x1 pixel before another foreground window is clicked
                Screen fallbackScreen = Screen.FromPoint(Cursor.Position) ?? Screen.PrimaryScreen;
                if (fallbackScreen != null)
                {
                    _lastTargetBounds = fallbackScreen.Bounds;
                    if (Bounds != fallbackScreen.Bounds)
                    {
                        Bounds = fallbackScreen.Bounds;
                        Invalidate();
                    }
                    if (!Visible) Show();
                    ApplyOverlayStylesAndTopMost();
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
            bool hasLiveCandle = snapshot.Active && snapshot.HasLiveCandle;
            bool hasOpStatus = snapshot.Active;

            if (!hasSignal && !hasPriceLine && !hasLiveCandle && !hasOpStatus)
            {
                return;
            }

            Interlocked.Increment(ref _paintCount);
            Graphics g = e.Graphics;

            if (hasOpStatus)
            {
                string statusText = (snapshot.OperationalStatus == "COMPRA" || snapshot.OperationalStatus == "VENDA")
                    ? snapshot.OperationalStatus
                    : (hasSignal ? snapshot.Direction : "AGUARDANDO");

                double anchorBx = snapshot.HasStatusBounds
                    ? snapshot.StatusBoundsX
                    : (snapshot.HasPriceBounds
                        ? snapshot.PriceBoundsX
                        : (snapshot.HasLiveCandleBounds
                            ? snapshot.LiveCandleBoundsX
                            : (snapshot.HasBounds ? snapshot.BoundsX : 0.045)));
                double anchorBy = snapshot.HasStatusBounds
                    ? snapshot.StatusBoundsY
                    : (snapshot.HasPriceBounds
                        ? snapshot.PriceBoundsY
                        : (snapshot.HasLiveCandleBounds
                            ? snapshot.LiveCandleBoundsY
                            : (snapshot.HasBounds ? snapshot.BoundsY : 0.04)));

                float sx = (float)(Math.Min(0.82, Math.Max(0.02, anchorBx + 0.015)) * ClientSize.Width);
                float sy = (float)(Math.Min(0.85, Math.Max(0.03, anchorBy + 0.02)) * ClientSize.Height);

                Color statusColor = statusText == "COMPRA"
                    ? Color.FromArgb(255, 34, 197, 94)
                    : (statusText == "VENDA"
                        ? Color.FromArgb(255, 239, 68, 68)
                        : Color.FromArgb(255, 251, 191, 36));

                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
                using (Font statusFont = new Font("Consolas", 11f, FontStyle.Bold))
                using (SolidBrush statusBg = new SolidBrush(Color.FromArgb(245, 11, 14, 17)))
                using (Pen statusBorder = new Pen(statusColor, 1f))
                using (SolidBrush statusBrush = new SolidBrush(statusColor))
                {
                    SizeF stSize = g.MeasureString(statusText, statusFont);
                    float padX = 7f;
                    float padY = 3f;
                    RectangleF box = new RectangleF(sx, sy, stSize.Width + padX * 2f, stSize.Height + padY * 2f);
                    g.FillRectangle(statusBg, box);
                    g.DrawRectangle(statusBorder, box.X, box.Y, box.Width, box.Height);
                    g.DrawString(statusText, statusFont, statusBrush, sx + padX, sy + padY);
                }
            }

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

            if (hasLiveCandle)
            {
                double normLiveX = snapshot.HasLiveCandleBounds
                    ? snapshot.LiveCandleBoundsX + snapshot.ChartRelativeLiveX * snapshot.LiveCandleBoundsW
                    : snapshot.LiveCandleX;
                double normLiveY = snapshot.HasLiveCandleBounds
                    ? snapshot.LiveCandleBoundsY + snapshot.ChartRelativeLiveY * snapshot.LiveCandleBoundsH
                    : snapshot.LiveCandleY;

                float cx = (float)(Math.Max(0.02, Math.Min(0.98, normLiveX)) * ClientSize.Width);
                float cy = (float)(Math.Max(0.02, Math.Min(0.98, normLiveY)) * ClientSize.Height);

                Color markerColor = snapshot.LiveCandleDirection == "BULL"
                    ? Color.FromArgb(255, 16, 185, 129)
                    : (snapshot.LiveCandleDirection == "BEAR"
                        ? Color.FromArgb(255, 244, 63, 94)
                        : Color.FromArgb(255, 251, 191, 36));

                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
                using (SolidBrush outerDark = new SolidBrush(Color.FromArgb(255, 11, 14, 17)))
                using (Pen ringPen = new Pen(markerColor, 2f))
                using (SolidBrush coreBrush = new SolidBrush(markerColor))
                {
                    g.FillEllipse(outerDark, cx - 8f, cy - 8f, 16f, 16f);
                    g.DrawEllipse(ringPen, cx - 7f, cy - 7f, 14f, 14f);
                    g.FillEllipse(coreBrush, cx - 3f, cy - 3f, 6f, 6f);
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

            try { Win32Native.SetProcessDPIAware(); } catch { }
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
                bool autoStart = IsAutoStartRegistered();
                WriteJson(res, 200, _overlayForm.BuildDiagnosticsJson(autoStart));
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
                string displaySurface = ExtractJsonString(bodyText, "displaySurface");
                _overlayForm.StartSession(sessionId, displaySurface);
                WriteDiagnosticLog(string.Format("SESSION id={0} surface={1}", sessionId, string.IsNullOrEmpty(displaySurface) ? "window" : displaySurface));
                WriteJson(res, 200, "{\"ok\":true}");
                return;
            }

            if (req.HttpMethod == "POST" && path == "/overlay/clear")
            {
                // Clears signals and tracking line immediately while keeping the background daemon alive
                _overlayForm.ClearOverlay();
                WriteDiagnosticLog("CLEAR");
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
                _priceLogTick++;
                if (_priceLogTick == 1 || _priceLogTick % 20 == 0)
                {
                    WriteDiagnosticLog(string.Format("PRICE_LINE y={0:0.000} relY={1:0.000} hasBounds={2}", priceY, relPriceY, hasBounds));
                }
                WriteJson(res, 200, "{\"ok\":true}");
                return;
            }

            if (req.HttpMethod == "POST" && path == "/overlay/candle")
            {
                string sessionId = ExtractJsonString(bodyText, "sessionId");
                string candleObj = ExtractJsonObject(bodyText, "liveCandle");
                if (string.IsNullOrEmpty(candleObj))
                {
                    _overlayForm.UpdateLiveCandle(sessionId, false, 0.5, 0.5, 0.5, 0.5, "NEUTRAL", false, 0, 0, 1, 1);
                    WriteJson(res, 200, "{\"ok\":true}");
                    return;
                }

                string boundsObj = ExtractJsonObject(candleObj, "chartBounds");
                string candleShallow = string.IsNullOrEmpty(boundsObj)
                    ? candleObj
                    : candleObj.Replace(boundsObj, "{}");

                double liveX = ExtractJsonDouble(candleShallow, "x", 0.5);
                double liveY = ExtractJsonDouble(candleShallow, "y", 0.5);
                double relLiveX = ExtractJsonDouble(candleShallow, "chartRelativeX", liveX);
                double relLiveY = ExtractJsonDouble(candleShallow, "chartRelativeY", liveY);
                string dir = ExtractJsonString(candleShallow, "direction");
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

                _overlayForm.UpdateLiveCandle(
                    sessionId,
                    true,
                    liveX,
                    liveY,
                    relLiveX,
                    relLiveY,
                    dir,
                    hasBounds,
                    bx,
                    by,
                    bw,
                    bh
                );
                _candleLogTick++;
                if (_candleLogTick == 1 || _candleLogTick % 20 == 0)
                {
                    WriteDiagnosticLog(string.Format("LIVE_CANDLE x={0:0.000} y={1:0.000} dir={2} hasBounds={3}", liveX, liveY, dir, hasBounds));
                }
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
                WriteDiagnosticLog(string.Format("SIGNAL dir={0} x={1:0.000} y={2:0.000}", direction, candleX, candleY));
                WriteJson(res, 200, "{\"ok\":true}");
                return;
            }

            if (req.HttpMethod == "POST" && path == "/overlay/status")
            {
                string sessionId = ExtractJsonString(bodyText, "sessionId");
                string statusObj = ExtractJsonObject(bodyText, "operationalStatus");
                string statusSource = string.IsNullOrEmpty(statusObj) ? bodyText : statusObj;
                string boundsObj = ExtractJsonObject(statusSource, "chartBounds");
                string statusShallow = string.IsNullOrEmpty(boundsObj)
                    ? statusSource
                    : statusSource.Replace(boundsObj, "{}");

                string statusVal = ExtractJsonString(statusShallow, "status");
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

                _overlayForm.UpdateOperationalStatus(sessionId, statusVal, hasBounds, bx, by, bw, bh);
                _statusLogTick++;
                if (_statusLogTick == 1 || _statusLogTick % 20 == 0 || statusVal == "COMPRA" || statusVal == "VENDA")
                {
                    WriteDiagnosticLog(string.Format("OP_STATUS status={0} hasBounds={1}", statusVal, hasBounds));
                }
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

        private static readonly object _logLock = new object();
        private static long _priceLogTick;
        private static long _candleLogTick;
        private static long _statusLogTick;
        private static void WriteDiagnosticLog(string message)
        {
            try
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ChartPulseAI"
                );
                Directory.CreateDirectory(dir);
                string logPath = Path.Combine(dir, "overlay-debug.log");
                lock (_logLock)
                {
                    if (File.Exists(logPath) && new FileInfo(logPath).Length > 65536)
                    {
                        File.WriteAllText(logPath, string.Empty, Encoding.UTF8);
                    }
                    File.AppendAllText(
                        logPath,
                        DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine,
                        Encoding.UTF8
                    );
                }
            }
            catch
            {
                // Ignore log I/O failures cleanly
            }
        }
    }
}
