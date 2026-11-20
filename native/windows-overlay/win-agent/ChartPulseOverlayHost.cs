using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
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
        public const int DWMWA_CLOAKED = 14;

        public const int WM_ERASEBKGND = 0x0014;
        public const int WM_MOUSEACTIVATE = 0x0021;
        public const int WM_DPICHANGED = 0x02E0;
        public const int WM_DISPLAYCHANGE = 0x007E;
        public const int WM_NCHITTEST = 0x0084;
        public const int HTTRANSPARENT = -1;
        public const int MA_NOACTIVATE = 3;

        public static readonly uint CurrentProcessId = (uint)Process.GetCurrentProcess().Id;

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
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SIZE
        {
            public int Width;
            public int Height;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        public struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        public const byte AC_SRC_OVER = 0x00;
        public const byte AC_SRC_ALPHA = 0x01;
        public const int ULW_ALPHA = 0x00000002;

        [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
        public static extern bool UpdateLayeredWindow(
            IntPtr hwnd,
            IntPtr hdcDst,
            ref POINT pptDst,
            ref SIZE psize,
            IntPtr hdcSrc,
            ref POINT pptSrc,
            int crKey,
            ref BLENDFUNCTION pblend,
            int dwFlags
        );

        [DllImport("user32.dll", ExactSpelling = true)]
        public static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll", ExactSpelling = true)]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        public static extern IntPtr CreateCompatibleDC(IntPtr hDC);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        public static extern bool DeleteDC(IntPtr hdc);

        [DllImport("gdi32.dll", ExactSpelling = true)]
        public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        public static extern bool DeleteObject(IntPtr hObject);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr hIcon);
    }

    internal sealed class BrokerWindowCandidate
    {
        public IntPtr Hwnd;
        public string Title = string.Empty;
        public string ProcessName = string.Empty;
        public Rectangle PhysicalBounds;
        public bool IsMinimized;
        public bool IsLikelyBroker;

        public override string ToString()
        {
            string tag = IsLikelyBroker ? "[CORRETORA]" : "[JANELA]";
            string stateTag = IsMinimized ? " (Minimizada)" : string.Format(" ({0}x{1})", PhysicalBounds.Width, PhysicalBounds.Height);
            string proc = string.IsNullOrEmpty(ProcessName) ? string.Empty : (" [" + ProcessName + "]");
            return string.Format("{0} {1}{2}{3} — 0x{4:X}", tag, Title, proc, stateTag, Hwnd.ToInt64());
        }
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
        public double LiveCandleTopY = 0.5;
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
        public bool HasStatusAnchor;
        public double StatusAnchorX;
        public double StatusAnchorY;
        public double StatusRelativeX;
        public double StatusRelativeY;
        public long StatusUpdatedAtMs;

        public OverlayPayload Clone()
        {
            return (OverlayPayload)MemberwiseClone();
        }
    }

    internal sealed class OverlayForm : Form
    {
        private static readonly DateTime UnixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        private static long UtcNowMs()
        {
            return (long)(DateTime.UtcNow - UnixEpoch).TotalMilliseconds;
        }

        private readonly object _stateLock = new object();
        private OverlayPayload _state = new OverlayPayload();
        private IntPtr _manualSelectedHwnd = IntPtr.Zero;
        private IntPtr _targetHwnd = IntPtr.Zero;
        private string _targetTitle = string.Empty;
        private readonly System.Windows.Forms.Timer _trackTimer;

        private long _priceLineUpdates;
        private long _liveCandleUpdates;
        private long _statusUpdates;
        private long _signalUpdates;
        private long _paintCount;
        private long _cloakedSkipped;
        private int _repaintQueued;
        private string _lastRenderError = string.Empty;

        private Rectangle _lastTargetBounds = new Rectangle(0, 0, 1, 1);
        private Rectangle _lastCaptureMonitorBounds = new Rectangle(0, 0, 1280, 720);
        private bool _targetMinimized;

        private IntPtr _loggedTargetHwnd = IntPtr.Zero;
        private Rectangle _loggedTargetBounds = Rectangle.Empty;
        private bool _loggedMinimized;
        private string _lastDrawLogKey = string.Empty;
        private long _lastDrawLogAtMs;
        private float _lastDrawnScreenX;
        private float _lastDrawnScreenY;

        private Bitmap _layeredSurface;
        private int _layeredWidth;
        private int _layeredHeight;
        private string _lastRenderSignature = string.Empty;
        private bool _forceRepaint = true;

        private bool _hasSmoothedStatus;
        private double _smoothStatusNormX;
        private double _smoothStatusNormY;

        private static readonly HashSet<string> IgnoredClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Progman",
            "WorkerW",
            "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd",
            "Windows.UI.Core.CoreWindow",
            "TaskManagerWindow",
            "#32768",
            "tooltips_class32",
            "ForegroundStaging",
            "MultitaskingViewFrame",
            "NotifyIconOverflowWindow",
            "XamlExplorerHostIslandWindow",
            "SearchHost",
            "CEF-OSC-WIDGET"
        };

        private static readonly string[] PreferredBrokerKeywords = new string[]
        {
            "IQ Option",
            "Quotex",
            "Pocket Option",
            "Binomo",
            "Olymp Trade",
            "Exnova",
            "TradingView",
            "MetaTrader",
            "Deriv",
            "Binance",
            "Bybit",
            "BullEx",
            "ExpertOption",
            "Spectre",
            "cTrader",
            "NinjaTrader",
            "Thinkorswim",
            "Polarium",
            "Stockity",
            "Homebroker",
            "Avalon"
        };

        public OverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;

            // Keep WinForms GDI background/WM_PAINT from fighting UpdateLayeredWindow
            SetStyle(ControlStyles.Opaque, true);
            SetStyle(ControlStyles.OptimizedDoubleBuffer, false);

            Rectangle initialScreen = Screen.PrimaryScreen != null
                ? Screen.PrimaryScreen.Bounds
                : new Rectangle(0, 0, 1280, 720);
            _lastTargetBounds = initialScreen;
            _lastCaptureMonitorBounds = initialScreen;

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

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            // Prevent WinForms GDI background fill on UpdateLayeredWindow HWND
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            // Drawing is handled exclusively by UpdateLayeredWindow on UI thread
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Win32Native.WM_ERASEBKGND)
            {
                m.Result = (IntPtr)1;
                return;
            }
            if (m.Msg == Win32Native.WM_NCHITTEST)
            {
                m.Result = (IntPtr)Win32Native.HTTRANSPARENT;
                return;
            }
            if (m.Msg == Win32Native.WM_MOUSEACTIVATE)
            {
                m.Result = (IntPtr)Win32Native.MA_NOACTIVATE;
                return;
            }
            if (m.Msg == Win32Native.WM_DPICHANGED || m.Msg == Win32Native.WM_DISPLAYCHANGE)
            {
                _forceRepaint = true;
                RequestRepaint();
            }
            base.WndProc(ref m);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ApplyOverlayStylesAndTopMost(_lastTargetBounds);
        }

        private void ApplyOverlayStylesAndTopMost(Rectangle targetRect)
        {
            if (!IsHandleCreated || IsDisposed) return;
            if (WindowState == FormWindowState.Minimized)
            {
                WindowState = FormWindowState.Normal;
            }
            int exStyle = Win32Native.GetWindowLong(Handle, Win32Native.GWL_EXSTYLE);
            int requiredStyle = Win32Native.WS_EX_LAYERED
                | Win32Native.WS_EX_TRANSPARENT
                | Win32Native.WS_EX_TOPMOST
                | Win32Native.WS_EX_TOOLWINDOW
                | Win32Native.WS_EX_NOACTIVATE;
            if ((exStyle & requiredStyle) != requiredStyle)
            {
                Win32Native.SetWindowLong(Handle, Win32Native.GWL_EXSTYLE, exStyle | requiredStyle);
            }

            int x = targetRect.X;
            int y = targetRect.Y;
            int w = Math.Max(100, targetRect.Width);
            int h = Math.Max(100, targetRect.Height);

            Win32Native.SetWindowPos(
                Handle,
                Win32Native.HWND_TOPMOST,
                x,
                y,
                w,
                h,
                Win32Native.SWP_NOACTIVATE | Win32Native.SWP_SHOWWINDOW
            );
        }

        private void EnsureOverlayVisibleAndTopMost(Rectangle targetRect)
        {
            if (!IsHandleCreated || IsDisposed) return;
            if (WindowState == FormWindowState.Minimized)
            {
                WindowState = FormWindowState.Normal;
            }
            if (!Visible)
            {
                Show();
            }
            ApplyOverlayStylesAndTopMost(targetRect);
        }

        private void HideOverlaySafely()
        {
            if (!IsHandleCreated || IsDisposed) return;
            if (Visible)
            {
                Hide();
            }
        }

        public void SetManualBrokerWindow(IntPtr hwnd, string title)
        {
            lock (_stateLock)
            {
                _manualSelectedHwnd = hwnd;
                _targetHwnd = hwnd;
                _targetTitle = title ?? string.Empty;
                _targetMinimized = false;
                _forceRepaint = true;
            }
            Program.WriteDiagnosticLog(string.Format("WINDOW_SELECT mode=manual hwnd=0x{0:X} ({0}) title=\"{1}\"", hwnd.ToInt64(), title ?? string.Empty));
            RequestRepaint();
        }

        public void ClearManualBrokerSelection()
        {
            lock (_stateLock)
            {
                _manualSelectedHwnd = IntPtr.Zero;
                _forceRepaint = true;
            }
            Program.WriteDiagnosticLog("WINDOW_SELECT mode=auto");
            RequestRepaint();
        }

        public string GetCurrentTargetSummary(out bool isManual)
        {
            lock (_stateLock)
            {
                isManual = _manualSelectedHwnd != IntPtr.Zero;
                IntPtr activeHwnd = isManual ? _manualSelectedHwnd : _targetHwnd;
                string title = string.IsNullOrEmpty(_targetTitle) ? "Aguardando janela da corretora" : _targetTitle;
                if (activeHwnd == IntPtr.Zero)
                {
                    return title;
                }
                return string.Format("{0} (0x{1:X}, {2}x{3})", title, activeHwnd.ToInt64(), _lastTargetBounds.Width, _lastTargetBounds.Height);
            }
        }

        public List<BrokerWindowCandidate> EnumerateCandidateWindows()
        {
            List<BrokerWindowCandidate> results = new List<BrokerWindowCandidate>();
            Win32Native.EnumWindows((hwnd, lParam) =>
            {
                Rectangle bounds;
                string title;
                string procName;
                bool isMin;
                if (TryInspectWindow(hwnd, true, out bounds, out title, out procName, out isMin))
                {
                    results.Add(new BrokerWindowCandidate
                    {
                        Hwnd = hwnd,
                        Title = title,
                        ProcessName = procName,
                        PhysicalBounds = bounds,
                        IsMinimized = isMin,
                        IsLikelyBroker = IsBrokerWindowTitle(title)
                    });
                }
                return true;
            }, IntPtr.Zero);

            results.Sort((a, b) =>
            {
                if (a.IsLikelyBroker != b.IsLikelyBroker) return a.IsLikelyBroker ? -1 : 1;
                if (a.IsMinimized != b.IsMinimized) return a.IsMinimized ? 1 : -1;
                long areaA = (long)a.PhysicalBounds.Width * a.PhysicalBounds.Height;
                long areaB = (long)b.PhysicalBounds.Width * b.PhysicalBounds.Height;
                return areaB.CompareTo(areaA);
            });
            return results;
        }

        public void StartSession(string sessionId, string displaySurface)
        {
            string normalizedSurface = string.IsNullOrEmpty(displaySurface) ? "window" : displaySurface;
            lock (_stateLock)
            {
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
                _forceRepaint = true;
            }
            RequestRepaint();
        }

        public void ClearOverlay()
        {
            lock (_stateLock)
            {
                _state = new OverlayPayload();
                _forceRepaint = true;
            }
            if (IsHandleCreated && !IsDisposed)
            {
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        _hasSmoothedStatus = false;
                        _lastRenderSignature = string.Empty;
                        PresentLayeredFrame(true);
                        HideOverlaySafely();
                    }));
                }
                catch
                {
                    // Ignore handle disposal race
                }
            }
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
                        SessionId = sessionId ?? string.Empty,
                        OperationalStatus = "AGUARDANDO"
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
                _state.PriceUpdatedAtMs = UtcNowMs();
                _forceRepaint = true;
            }
            Interlocked.Increment(ref _priceLineUpdates);
            RequestRepaint();
        }

        public void UpdateLiveCandle(
            string sessionId,
            bool hasLiveCandle,
            double candleX,
            double candleY,
            double candleTopY,
            double chartRelativeX,
            double chartRelativeY,
            string direction,
            bool hasLiveCandleBounds,
            double bx,
            double by,
            double bw,
            double bh)
        {
            long nowMs = UtcNowMs();
            lock (_stateLock)
            {
                if (_state.SessionId != sessionId)
                {
                    _state = new OverlayPayload
                    {
                        Active = true,
                        SessionId = sessionId ?? string.Empty,
                        OperationalStatus = "AGUARDANDO"
                    };
                }
                _state.Active = true;
                _state.HasLiveCandle = hasLiveCandle;
                _state.LiveCandleX = candleX;
                _state.LiveCandleY = candleY;
                _state.LiveCandleTopY = candleTopY;
                _state.ChartRelativeLiveX = chartRelativeX;
                _state.ChartRelativeLiveY = chartRelativeY;
                _state.LiveCandleDirection = string.IsNullOrEmpty(direction) ? "NEUTRAL" : direction;
                _state.HasLiveCandleBounds = hasLiveCandleBounds;
                _state.LiveCandleBoundsX = bx;
                _state.LiveCandleBoundsY = by;
                _state.LiveCandleBoundsW = bw;
                _state.LiveCandleBoundsH = bh;
                _state.LiveCandleUpdatedAtMs = nowMs;

                if (hasLiveCandle)
                {
                    double topNorm = Math.Max(0.01, Math.Min(0.98, Math.Min(candleTopY, candleY)));
                    double rawAnchorY = topNorm - 0.016;
                    if (hasLiveCandleBounds && bw > 0.05 && bh > 0.05)
                    {
                        double rawCandleX = bx + chartRelativeX * bw;
                        double marginX = Math.Min(0.012, bw * 0.04);
                        double clampedX = Math.Max(bx + marginX, Math.Min(bx + bw - marginX, rawCandleX));
                        double minY = by + Math.Min(0.014, bh * 0.05);
                        double maxY = Math.Max(minY, by + bh - 0.015);
                        double clampedY = Math.Max(minY, Math.Min(maxY, rawAnchorY));
                        _state.HasStatusBounds = true;
                        _state.StatusBoundsX = bx;
                        _state.StatusBoundsY = by;
                        _state.StatusBoundsW = bw;
                        _state.StatusBoundsH = bh;
                        _state.StatusAnchorX = clampedX;
                        _state.StatusAnchorY = clampedY;
                        _state.StatusRelativeX = Math.Max(0.01, Math.Min(0.99, (clampedX - bx) / bw));
                        _state.StatusRelativeY = Math.Max(0.02, Math.Min(0.98, (clampedY - by) / bh));
                    }
                    else
                    {
                        _state.HasStatusBounds = false;
                        _state.StatusAnchorX = Math.Max(0.06, Math.Min(0.94, candleX));
                        _state.StatusAnchorY = Math.Max(0.05, Math.Min(0.96, rawAnchorY));
                        _state.StatusRelativeX = _state.StatusAnchorX;
                        _state.StatusRelativeY = _state.StatusAnchorY;
                    }
                    _state.HasStatusAnchor = true;
                    if (string.IsNullOrEmpty(_state.OperationalStatus))
                    {
                        _state.OperationalStatus = "AGUARDANDO";
                    }
                }
                _forceRepaint = true;
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
            double bh,
            bool hasAnchor,
            double anchorX,
            double anchorY,
            double relX,
            double relY)
        {
            string safeStatus = (status == "COMPRA" || status == "VENDA") ? status : "AGUARDANDO";
            long nowMs = UtcNowMs();
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
                if (safeStatus == "AGUARDANDO")
                {
                    _state.Direction = string.Empty;
                    _state.ExpiresAtMs = 0;
                }
                if (hasStatusBounds)
                {
                    _state.HasStatusBounds = true;
                    _state.StatusBoundsX = bx;
                    _state.StatusBoundsY = by;
                    _state.StatusBoundsW = bw;
                    _state.StatusBoundsH = bh;
                }
                else if (hasAnchor)
                {
                    _state.HasStatusBounds = false;
                }
                if (hasAnchor)
                {
                    _state.HasStatusAnchor = true;
                    _state.StatusAnchorX = anchorX;
                    _state.StatusAnchorY = anchorY;
                    _state.StatusRelativeX = relX;
                    _state.StatusRelativeY = relY;
                }
                else
                {
                    bool recentCandle = _state.HasLiveCandle && (nowMs - _state.LiveCandleUpdatedAtMs <= 2500);
                    if (!recentCandle)
                    {
                        _state.HasStatusAnchor = false;
                    }
                    else if (_state.HasStatusAnchor)
                    {
                        _forceRepaint = true;
                    }
                }
                _state.StatusUpdatedAtMs = nowMs;
                _forceRepaint = true;
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
                if (!_state.HasStatusAnchor && candleX >= 0.02 && candleX <= 0.98 && candleY >= 0.02 && candleY <= 0.98)
                {
                    _state.HasStatusBounds = hasBounds;
                    _state.StatusBoundsX = bx;
                    _state.StatusBoundsY = by;
                    _state.StatusBoundsW = bw;
                    _state.StatusBoundsH = bh;
                    _state.StatusAnchorX = candleX;
                    _state.StatusAnchorY = Math.Max(0.05, candleY - 0.02);
                    _state.StatusRelativeX = relX;
                    _state.StatusRelativeY = Math.Max(0.03, relY - 0.02);
                    _state.HasStatusAnchor = true;
                }
                _forceRepaint = true;
            }
            Interlocked.Increment(ref _signalUpdates);
            RequestRepaint();
        }

        private void RequestRepaint()
        {
            if (IsHandleCreated && !IsDisposed)
            {
                if (Interlocked.CompareExchange(ref _repaintQueued, 1, 0) != 0)
                {
                    return;
                }
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        Interlocked.Exchange(ref _repaintQueued, 0);
                        SyncWindowGeometryAndPresent();
                    }));
                }
                catch
                {
                    Interlocked.Exchange(ref _repaintQueued, 0);
                }
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
            bool hasStatusAnchor;
            bool hasLiveCandle;
            bool hasPriceLine;
            double ax;
            double ay;
            double lx;
            double ly;
            Rectangle b;
            bool isMin;
            bool isManual;
            IntPtr hwnd;
            string currentTitle;
            string renderErr;
            float drawnScreenX;
            float drawnScreenY;

            lock (_stateLock)
            {
                active = _state.Active;
                surface = _state.DisplaySurface;
                hasStatusAnchor = _state.HasStatusAnchor;
                hasLiveCandle = _state.HasLiveCandle;
                hasPriceLine = _state.HasPriceLine;
                ax = _state.StatusAnchorX;
                ay = _state.StatusAnchorY;
                lx = _state.LiveCandleX;
                ly = _state.LiveCandleY;
                opStatus = string.IsNullOrEmpty(_state.OperationalStatus)
                    ? (active ? "AGUARDANDO" : "NONE")
                    : _state.OperationalStatus;
                b = _lastTargetBounds;
                isMin = _targetMinimized;
                isManual = _manualSelectedHwnd != IntPtr.Zero;
                hwnd = isManual ? _manualSelectedHwnd : _targetHwnd;
                currentTitle = _targetTitle ?? string.Empty;
                renderErr = _lastRenderError ?? string.Empty;
                drawnScreenX = _lastDrawnScreenX;
                drawnScreenY = _lastDrawnScreenY;
            }

            Rectangle ob = Bounds;
            if (IsHandleCreated && !IsDisposed)
            {
                Win32Native.RECT wRect;
                if (Win32Native.GetWindowRect(Handle, out wRect))
                {
                    ob = new Rectangle(wRect.Left, wRect.Top, wRect.Right - wRect.Left, wRect.Bottom - wRect.Top);
                }
            }
            bool isVis = Visible;
            string boundsText = string.Format("{0},{1},{2}x{3}", b.X, b.Y, b.Width, b.Height);
            string overlayBoundsText = string.Format("{0},{1},{2}x{3}", ob.X, ob.Y, ob.Width, ob.Height);
            string safeTitle = currentTitle.Replace("\\", "\\\\").Replace("\"", "'");
            string safeExe = (Application.ExecutablePath ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "'");
            string safeErr = renderErr.Replace("\\", "\\\\").Replace("\"", "'");
            string hwndHex = hwnd == IntPtr.Zero ? "0x0" : string.Format("0x{0:X}", hwnd.ToInt64());

            return string.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "{{\"ok\":true,\"component\":\"ChartPulseOverlay\",\"version\":\"1.3.2\",\"buildId\":\"2026-11-20-hwnd\",\"exePath\":\"{21}\",\"processId\":{22},\"lastRenderError\":\"{23}\",\"targetHwnd\":\"{24}\",\"selectionMode\":\"{25}\",\"targetMinimized\":{26},\"lastDrawnScreenX\":{27:0.0},\"lastDrawnScreenY\":{28:0.0},\"priceLineSupported\":true,\"liveCandleSupported\":true,\"operationalStatusSupported\":true,\"hasStatusAnchor\":{10},\"hasLiveCandle\":{11},\"hasPriceLine\":{12},\"active\":{0},\"autoStartEnabled\":{1},\"displaySurface\":\"{2}\",\"operationalStatus\":\"{3}\",\"targetBounds\":\"{4}\",\"overlayBounds\":\"{13}\",\"overlayVisible\":{14},\"targetWindowTitle\":\"{15}\",\"lastStatusAnchorX\":{16:0.0000},\"lastStatusAnchorY\":{17:0.0000},\"lastCandleX\":{18:0.0000},\"lastCandleY\":{19:0.0000},\"priceLineUpdates\":{5},\"liveCandleUpdates\":{6},\"statusUpdates\":{7},\"signalUpdates\":{8},\"paintCount\":{9},\"cloakedSkipped\":{20}}}",
                active ? "true" : "false",
                autoStart ? "true" : "false",
                surface,
                opStatus,
                boundsText,
                Interlocked.Read(ref _priceLineUpdates),
                Interlocked.Read(ref _liveCandleUpdates),
                Interlocked.Read(ref _statusUpdates),
                Interlocked.Read(ref _signalUpdates),
                Interlocked.Read(ref _paintCount),
                hasStatusAnchor ? "true" : "false",
                hasLiveCandle ? "true" : "false",
                hasPriceLine ? "true" : "false",
                overlayBoundsText,
                isVis ? "true" : "false",
                safeTitle,
                ax,
                ay,
                lx,
                ly,
                Interlocked.Read(ref _cloakedSkipped),
                safeExe,
                Win32Native.CurrentProcessId,
                safeErr,
                hwndHex,
                isManual ? "manual" : "auto",
                isMin ? "true" : "false",
                drawnScreenX,
                drawnScreenY
            );
        }

        private static bool IsBrokerWindowTitle(string title)
        {
            if (string.IsNullOrWhiteSpace(title)) return false;
            for (int i = 0; i < PreferredBrokerKeywords.Length; i++)
            {
                if (title.IndexOf(PreferredBrokerKeywords[i], StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }
            }
            return false;
        }

        private bool TryInspectWindow(
            IntPtr hwnd,
            bool allowMinimized,
            out Rectangle bounds,
            out string title,
            out string processName,
            out bool isMinimized)
        {
            bounds = Rectangle.Empty;
            title = string.Empty;
            processName = string.Empty;
            isMinimized = false;

            if (hwnd == IntPtr.Zero || hwnd == Handle || !Win32Native.IsWindow(hwnd) || !Win32Native.IsWindowVisible(hwnd))
            {
                return false;
            }

            isMinimized = Win32Native.IsIconic(hwnd);
            if (isMinimized && !allowMinimized)
            {
                return false;
            }

            uint pid;
            Win32Native.GetWindowThreadProcessId(hwnd, out pid);
            if (pid == Win32Native.CurrentProcessId)
            {
                return false;
            }

            int cloaked = 0;
            if (Win32Native.DwmGetWindowAttribute(hwnd, Win32Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0)
            {
                Interlocked.Increment(ref _cloakedSkipped);
                return false;
            }

            StringBuilder clsSb = new StringBuilder(128);
            Win32Native.GetClassName(hwnd, clsSb, 128);
            string cls = clsSb.ToString();
            if (IgnoredClasses.Contains(cls))
            {
                return false;
            }

            StringBuilder titleSb = new StringBuilder(256);
            Win32Native.GetWindowText(hwnd, titleSb, 256);
            title = titleSb.ToString().Trim();
            if (string.IsNullOrWhiteSpace(title) ||
                title.IndexOf("ChartPulse AI", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("Selecionar Janela da Corretora", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return false;
            }

            try
            {
                using (Process proc = Process.GetProcessById((int)pid))
                {
                    processName = proc.ProcessName;
                }
            }
            catch
            {
                processName = string.Empty;
            }

            if (isMinimized)
            {
                bounds = new Rectangle(0, 0, 0, 0);
                return true;
            }

            Win32Native.RECT rect;
            int hr = Win32Native.DwmGetWindowAttribute(
                hwnd,
                Win32Native.DWMWA_EXTENDED_FRAME_BOUNDS,
                out rect,
                Marshal.SizeOf(typeof(Win32Native.RECT))
            );
            if (hr != 0 && !Win32Native.GetWindowRect(hwnd, out rect))
            {
                return false;
            }

            int w = rect.Right - rect.Left;
            int h = rect.Bottom - rect.Top;
            if (w < 280 || h < 200)
            {
                return false;
            }

            Rectangle candidate = new Rectangle(rect.Left, rect.Top, w, h);
            if (!SystemInformation.VirtualScreen.IntersectsWith(candidate))
            {
                return false;
            }

            bounds = candidate;
            return true;
        }

        private bool TryGetValidWindowBounds(IntPtr hwnd, out Rectangle bounds, out string title)
        {
            string proc;
            bool isMin;
            return TryInspectWindow(hwnd, false, out bounds, out title, out proc, out isMin);
        }

        private IntPtr FindBestBrokerFallbackWindow(bool keywordOnly)
        {
            IntPtr keywordMatch = IntPtr.Zero;
            IntPtr largestWindow = IntPtr.Zero;
            long largestArea = 0;

            Win32Native.EnumWindows((hwnd, lParam) =>
            {
                Rectangle r;
                string title;
                if (!TryGetValidWindowBounds(hwnd, out r, out title))
                {
                    return true;
                }

                if (IsBrokerWindowTitle(title))
                {
                    keywordMatch = hwnd;
                    return false;
                }

                if (!keywordOnly)
                {
                    long area = (long)r.Width * r.Height;
                    if (area > largestArea)
                    {
                        largestArea = area;
                        largestWindow = hwnd;
                    }
                }
                return true;
            }, IntPtr.Zero);

            return keywordMatch != IntPtr.Zero ? keywordMatch : (keywordOnly ? IntPtr.Zero : largestWindow);
        }

        private void OnTrackTick(object sender, EventArgs e)
        {
            SyncWindowGeometryAndPresent();
        }

        private void SyncWindowGeometryAndPresent()
        {
            if (InvokeRequired)
            {
                RequestRepaint();
                return;
            }

            OverlayPayload snapshot;
            IntPtr manualHwnd;
            lock (_stateLock)
            {
                snapshot = _state.Clone();
                manualHwnd = _manualSelectedHwnd;
            }

            if (!snapshot.Active)
            {
                lock (_stateLock)
                {
                    _targetMinimized = false;
                }
                HideOverlaySafely();
                return;
            }

            if (snapshot.ExpiresAtMs > 0 && UtcNowMs() > snapshot.ExpiresAtMs)
            {
                lock (_stateLock)
                {
                    if (_state.SessionId == snapshot.SessionId)
                    {
                        _state.Direction = string.Empty;
                        _state.ExpiresAtMs = 0;
                        _state.OperationalStatus = "AGUARDANDO";
                        _forceRepaint = true;
                        snapshot = _state.Clone();
                    }
                }
            }

            if (snapshot.HasStatusAnchor)
            {
                double targetNormX = snapshot.HasStatusBounds
                    ? snapshot.StatusBoundsX + snapshot.StatusRelativeX * snapshot.StatusBoundsW
                    : snapshot.StatusAnchorX;
                double targetNormY = snapshot.HasStatusBounds
                    ? snapshot.StatusBoundsY + snapshot.StatusRelativeY * snapshot.StatusBoundsH
                    : snapshot.StatusAnchorY;

                if (!double.IsNaN(targetNormX) && !double.IsInfinity(targetNormX) &&
                    !double.IsNaN(targetNormY) && !double.IsInfinity(targetNormY))
                {
                    if (!_hasSmoothedStatus)
                    {
                        _smoothStatusNormX = targetNormX;
                        _smoothStatusNormY = targetNormY;
                        _hasSmoothedStatus = true;
                        _forceRepaint = true;
                    }
                    else
                    {
                        double dx = targetNormX - _smoothStatusNormX;
                        double dy = targetNormY - _smoothStatusNormY;
                        if (Math.Abs(dx) >= 0.0004 || Math.Abs(dy) >= 0.0004)
                        {
                            _smoothStatusNormX += dx * 0.45;
                            _smoothStatusNormY += dy * 0.45;
                            if (Math.Abs(targetNormX - _smoothStatusNormX) < 0.0004) _smoothStatusNormX = targetNormX;
                            if (Math.Abs(targetNormY - _smoothStatusNormY) < 0.0004) _smoothStatusNormY = targetNormY;
                            _forceRepaint = true;
                        }
                    }
                }
            }
            else if (_hasSmoothedStatus)
            {
                _hasSmoothedStatus = false;
                _forceRepaint = true;
            }

            IntPtr resolvedHwnd = IntPtr.Zero;
            Rectangle targetBounds = Rectangle.Empty;
            string targetTitle = string.Empty;
            bool isTargetMinimized = false;

            if (manualHwnd != IntPtr.Zero)
            {
                if (!Win32Native.IsWindow(manualHwnd))
                {
                    Program.WriteDiagnosticLog(string.Format("TARGET_LOST hwnd=0x{0:X} mode=manual", manualHwnd.ToInt64()));
                    lock (_stateLock)
                    {
                        _manualSelectedHwnd = IntPtr.Zero;
                    }
                    manualHwnd = IntPtr.Zero;
                }
                else
                {
                    string proc;
                    bool inspected = TryInspectWindow(manualHwnd, true, out targetBounds, out targetTitle, out proc, out isTargetMinimized);
                    if (inspected)
                    {
                        resolvedHwnd = manualHwnd;
                    }
                    else if (Win32Native.IsIconic(manualHwnd))
                    {
                        resolvedHwnd = manualHwnd;
                        isTargetMinimized = true;
                    }
                }
            }

            if (manualHwnd == IntPtr.Zero)
            {
                // Keep tracking a locked broker window if minimized so restoring it brings back the overlay cleanly
                if (_targetHwnd != IntPtr.Zero && Win32Native.IsWindow(_targetHwnd) && Win32Native.IsIconic(_targetHwnd) && IsBrokerWindowTitle(_targetTitle))
                {
                    resolvedHwnd = _targetHwnd;
                    targetTitle = _targetTitle;
                    isTargetMinimized = true;
                }
                else
                {
                    IntPtr fg = Win32Native.GetForegroundWindow();
                    Rectangle fgBounds;
                    string fgTitle;
                    if (TryGetValidWindowBounds(fg, out fgBounds, out fgTitle))
                    {
                        _targetHwnd = fg;
                        targetBounds = fgBounds;
                        targetTitle = fgTitle;
                        resolvedHwnd = fg;
                    }

                    bool currentValid = resolvedHwnd != IntPtr.Zero || TryGetValidWindowBounds(_targetHwnd, out targetBounds, out targetTitle);
                    if (currentValid && resolvedHwnd == IntPtr.Zero)
                    {
                        resolvedHwnd = _targetHwnd;
                    }

                    if (!currentValid || !IsBrokerWindowTitle(targetTitle))
                    {
                        IntPtr brokerMatch = FindBestBrokerFallbackWindow(true);
                        Rectangle brokerBounds;
                        string brokerTitle;
                        if (brokerMatch != IntPtr.Zero && TryGetValidWindowBounds(brokerMatch, out brokerBounds, out brokerTitle))
                        {
                            resolvedHwnd = brokerMatch;
                            _targetHwnd = brokerMatch;
                            targetBounds = brokerBounds;
                            targetTitle = brokerTitle;
                            currentValid = true;
                        }
                        else if (!currentValid)
                        {
                            IntPtr autoTarget = FindBestBrokerFallbackWindow(false);
                            if (TryGetValidWindowBounds(autoTarget, out targetBounds, out targetTitle))
                            {
                                resolvedHwnd = autoTarget;
                                _targetHwnd = autoTarget;
                                currentValid = true;
                            }
                        }
                    }
                }
            }

            if (isTargetMinimized)
            {
                lock (_stateLock)
                {
                    _targetHwnd = resolvedHwnd;
                    _targetMinimized = true;
                }
                if (!_loggedMinimized || _loggedTargetHwnd != resolvedHwnd)
                {
                    _loggedMinimized = true;
                    _loggedTargetHwnd = resolvedHwnd;
                    Program.WriteDiagnosticLog(string.Format("TARGET_MINIMIZED hwnd=0x{0:X} title=\"{1}\" -> hiding overlay", resolvedHwnd.ToInt64(), targetTitle));
                }
                HideOverlaySafely();
                return;
            }

            if (_loggedMinimized)
            {
                _loggedMinimized = false;
                _forceRepaint = true;
                Program.WriteDiagnosticLog(string.Format("TARGET_RESTORED hwnd=0x{0:X} title=\"{1}\"", resolvedHwnd.ToInt64(), targetTitle));
            }

            Screen monitorScreen = (resolvedHwnd != IntPtr.Zero && Win32Native.IsWindow(resolvedHwnd))
                ? Screen.FromHandle(resolvedHwnd)
                : (Screen.FromPoint(Cursor.Position) ?? Screen.PrimaryScreen);
            Rectangle monitorBounds = monitorScreen != null ? monitorScreen.Bounds : new Rectangle(0, 0, 1280, 720);

            if (snapshot.DisplaySurface == "monitor" && manualHwnd == IntPtr.Zero)
            {
                targetBounds = monitorBounds;
                if (string.IsNullOrEmpty(targetTitle))
                {
                    targetTitle = monitorScreen != null ? (monitorScreen.DeviceName ?? "PrimaryMonitor") : "PrimaryMonitor";
                }
            }
            else if (resolvedHwnd == IntPtr.Zero || targetBounds.Width < 100 || targetBounds.Height < 100)
            {
                targetBounds = monitorBounds;
                targetTitle = monitorScreen != null ? (monitorScreen.DeviceName ?? "PrimaryScreen") : "PrimaryScreen";
            }

            bool geometryChanged = resolvedHwnd != _loggedTargetHwnd || targetBounds != _loggedTargetBounds;
            if (geometryChanged)
            {
                _loggedTargetHwnd = resolvedHwnd;
                _loggedTargetBounds = targetBounds;
                _forceRepaint = true;
                Program.WriteDiagnosticLog(string.Format(
                    "TARGET_WINDOW hwnd=0x{0:X} ({0}) mode={1} surface={2} title=\"{3}\" physicalRect={4},{5},{6}x{7} monitor={8},{9},{10}x{11}",
                    resolvedHwnd.ToInt64(),
                    manualHwnd != IntPtr.Zero ? "manual" : "auto",
                    snapshot.DisplaySurface,
                    targetTitle,
                    targetBounds.X,
                    targetBounds.Y,
                    targetBounds.Width,
                    targetBounds.Height,
                    monitorBounds.X,
                    monitorBounds.Y,
                    monitorBounds.Width,
                    monitorBounds.Height
                ));
            }

            lock (_stateLock)
            {
                _targetHwnd = resolvedHwnd;
                _targetTitle = targetTitle;
                _targetMinimized = false;
                _lastTargetBounds = targetBounds;
                _lastCaptureMonitorBounds = monitorBounds;
            }

            PresentLayeredFrame(_forceRepaint);
            EnsureOverlayVisibleAndTopMost(targetBounds);
        }

        private void ConvertCaptureNormToOverlayPx(
            double normX,
            double normY,
            string displaySurface,
            Rectangle targetRect,
            Rectangle monitorRect,
            out float localPxX,
            out float localPxY,
            out float screenPxX,
            out float screenPxY)
        {
            double clampedX = Math.Max(0.0, Math.Min(1.0, normX));
            double clampedY = Math.Max(0.0, Math.Min(1.0, normY));

            if (displaySurface == "monitor" && monitorRect.Width > 10 && monitorRect.Height > 10)
            {
                screenPxX = monitorRect.X + (float)(clampedX * monitorRect.Width);
                screenPxY = monitorRect.Y + (float)(clampedY * monitorRect.Height);
                localPxX = screenPxX - targetRect.X;
                localPxY = screenPxY - targetRect.Y;
            }
            else
            {
                localPxX = (float)(clampedX * Math.Max(100, targetRect.Width));
                localPxY = (float)(clampedY * Math.Max(100, targetRect.Height));
                screenPxX = targetRect.X + localPxX;
                screenPxY = targetRect.Y + localPxY;
            }
        }

        private void EnsureLayeredBitmapSize(int width, int height)
        {
            if (_layeredSurface != null && _layeredWidth == width && _layeredHeight == height)
            {
                return;
            }
            if (_layeredSurface != null)
            {
                _layeredSurface.Dispose();
                _layeredSurface = null;
            }
            _layeredSurface = new Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
            _layeredWidth = width;
            _layeredHeight = height;
            _lastRenderSignature = string.Empty;
        }

        private void PresentLayeredFrame(bool forceRepaint)
        {
            if (!IsHandleCreated || IsDisposed) return;

            OverlayPayload snapshot;
            Rectangle targetRect;
            Rectangle monitorRect;
            lock (_stateLock)
            {
                snapshot = _state.Clone();
                targetRect = _lastTargetBounds;
                monitorRect = _lastCaptureMonitorBounds;
            }

            int width = Math.Max(100, targetRect.Width > 10 ? targetRect.Width : Bounds.Width);
            int height = Math.Max(100, targetRect.Height > 10 ? targetRect.Height : Bounds.Height);
            int dstX = targetRect.Width > 10 ? targetRect.X : Bounds.X;
            int dstY = targetRect.Height > 10 ? targetRect.Y : Bounds.Y;

            string renderSig = string.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "{0}|{1}|{2}|{3}|{4:0.0000},{5:0.0000}|{6}|{7:0.0000}|{8}|{9:0.0000},{10:0.0000}|{11}x{12}@{13},{14}",
                snapshot.Active ? 1 : 0,
                snapshot.DisplaySurface,
                snapshot.OperationalStatus,
                snapshot.HasStatusAnchor ? 1 : 0,
                _hasSmoothedStatus ? _smoothStatusNormX : snapshot.StatusAnchorX,
                _hasSmoothedStatus ? _smoothStatusNormY : snapshot.StatusAnchorY,
                snapshot.HasPriceLine ? 1 : 0,
                snapshot.HasPriceBounds ? (snapshot.PriceBoundsY + snapshot.ChartRelativePriceY * snapshot.PriceBoundsH) : snapshot.PriceY,
                snapshot.HasLiveCandle ? 1 : 0,
                snapshot.HasLiveCandleBounds ? (snapshot.LiveCandleBoundsX + snapshot.ChartRelativeLiveX * snapshot.LiveCandleBoundsW) : snapshot.LiveCandleX,
                snapshot.HasLiveCandleBounds ? (snapshot.LiveCandleBoundsY + snapshot.ChartRelativeLiveY * snapshot.LiveCandleBoundsH) : snapshot.LiveCandleY,
                width,
                height,
                dstX,
                dstY
            );

            if (!forceRepaint && _layeredSurface != null && renderSig == _lastRenderSignature)
            {
                return;
            }

            _forceRepaint = false;
            _lastRenderSignature = renderSig;

            EnsureLayeredBitmapSize(width, height);

            using (Graphics g = Graphics.FromImage(_layeredSurface))
            {
                g.Clear(Color.Transparent);
                RenderOverlayGraphics(g, targetRect, monitorRect, snapshot);
            }

            IntPtr screenDc = Win32Native.GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero)
            {
                string err = "GetDC(NULL) returned IntPtr.Zero win32err=" + Marshal.GetLastWin32Error();
                lock (_stateLock) { _lastRenderError = err; }
                Program.WriteDiagnosticLog("RENDER_ERR " + err);
                return;
            }

            IntPtr memDc = Win32Native.CreateCompatibleDC(screenDc);
            IntPtr hBitmap = IntPtr.Zero;
            IntPtr oldBitmap = IntPtr.Zero;
            try
            {
                hBitmap = _layeredSurface.GetHbitmap(Color.FromArgb(0));
                oldBitmap = Win32Native.SelectObject(memDc, hBitmap);

                Win32Native.POINT dstPt = new Win32Native.POINT { X = dstX, Y = dstY };
                Win32Native.SIZE bmpSize = new Win32Native.SIZE { Width = width, Height = height };
                Win32Native.POINT srcPt = new Win32Native.POINT { X = 0, Y = 0 };
                Win32Native.BLENDFUNCTION blend = new Win32Native.BLENDFUNCTION
                {
                    BlendOp = Win32Native.AC_SRC_OVER,
                    BlendFlags = 0,
                    SourceConstantAlpha = 255,
                    AlphaFormat = Win32Native.AC_SRC_ALPHA
                };

                bool ok = Win32Native.UpdateLayeredWindow(
                    Handle,
                    screenDc,
                    ref dstPt,
                    ref bmpSize,
                    memDc,
                    ref srcPt,
                    0,
                    ref blend,
                    Win32Native.ULW_ALPHA
                );

                if (!ok)
                {
                    string err = "UpdateLayeredWindow win32err=" + Marshal.GetLastWin32Error();
                    lock (_stateLock) { _lastRenderError = err; }
                    Program.WriteDiagnosticLog(string.Format("ULW_FAIL {0} hwnd=0x{1:X} rect={2},{3},{4}x{5}", err, Handle.ToInt64(), dstX, dstY, width, height));
                }
                else
                {
                    lock (_stateLock) { _lastRenderError = string.Empty; }
                }
            }
            catch (Exception ex)
            {
                lock (_stateLock) { _lastRenderError = ex.Message; }
                Program.WriteDiagnosticLog("RENDER_EXCEPTION " + ex.Message);
            }
            finally
            {
                if (hBitmap != IntPtr.Zero)
                {
                    Win32Native.SelectObject(memDc, oldBitmap);
                    Win32Native.DeleteObject(hBitmap);
                }
                if (memDc != IntPtr.Zero)
                {
                    Win32Native.DeleteDC(memDc);
                }
                Win32Native.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        private void RenderOverlayGraphics(Graphics g, Rectangle targetRect, Rectangle monitorRect, OverlayPayload snapshot)
        {
            int surfaceW = Math.Max(100, targetRect.Width);
            int surfaceH = Math.Max(100, targetRect.Height);

            bool hasSignal = snapshot.Active && (snapshot.Direction == "COMPRA" || snapshot.Direction == "VENDA");
            bool hasPriceLine = snapshot.Active && snapshot.HasPriceLine;
            bool hasLiveCandle = snapshot.Active && snapshot.HasLiveCandle;
            bool hasOpStatus = snapshot.Active && snapshot.HasStatusAnchor;

            if (!hasPriceLine && !hasLiveCandle && !hasOpStatus)
            {
                return;
            }

            long paintSeq = Interlocked.Increment(ref _paintCount);

            if (hasOpStatus)
            {
                string statusText = (snapshot.OperationalStatus == "COMPRA" || snapshot.OperationalStatus == "VENDA")
                    ? snapshot.OperationalStatus
                    : (hasSignal ? snapshot.Direction : "AGUARDANDO");

                double targetNormX = snapshot.HasStatusBounds
                    ? snapshot.StatusBoundsX + snapshot.StatusRelativeX * snapshot.StatusBoundsW
                    : snapshot.StatusAnchorX;
                double targetNormY = snapshot.HasStatusBounds
                    ? snapshot.StatusBoundsY + snapshot.StatusRelativeY * snapshot.StatusBoundsH
                    : snapshot.StatusAnchorY;

                double normStatusX = _hasSmoothedStatus ? _smoothStatusNormX : targetNormX;
                double normStatusY = _hasSmoothedStatus ? _smoothStatusNormY : targetNormY;
                if (double.IsNaN(normStatusX) || double.IsInfinity(normStatusX)) normStatusX = 0.5;
                if (double.IsNaN(normStatusY) || double.IsInfinity(normStatusY)) normStatusY = 0.5;

                float anchorPxX;
                float anchorPxY;
                float screenPxX;
                float screenPxY;
                ConvertCaptureNormToOverlayPx(
                    Math.Max(0.02, Math.Min(0.98, normStatusX)),
                    Math.Max(0.02, Math.Min(0.98, normStatusY)),
                    snapshot.DisplaySurface,
                    targetRect,
                    monitorRect,
                    out anchorPxX,
                    out anchorPxY,
                    out screenPxX,
                    out screenPxY
                );

                lock (_stateLock)
                {
                    _lastDrawnScreenX = screenPxX;
                    _lastDrawnScreenY = screenPxY;
                }

                Color statusColor = statusText == "COMPRA"
                    ? Color.FromArgb(255, 34, 197, 94)
                    : (statusText == "VENDA"
                        ? Color.FromArgb(255, 239, 68, 68)
                        : Color.FromArgb(255, 251, 191, 36));

                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (Font statusFont = new Font("Segoe UI", 12.5f, FontStyle.Bold))
                using (SolidBrush statusBg = new SolidBrush(Color.FromArgb(255, 11, 14, 17)))
                using (Pen statusBorder = new Pen(statusColor, 2f))
                using (SolidBrush statusBrush = new SolidBrush(statusColor))
                using (StringFormat centered = new StringFormat())
                {
                    centered.Alignment = StringAlignment.Center;
                    centered.LineAlignment = StringAlignment.Center;

                    SizeF stSize = g.MeasureString(statusText, statusFont);
                    float padX = 14f;
                    float padY = 6f;
                    float boxW = Math.Max(104f, stSize.Width + padX * 2f);
                    float boxH = stSize.Height + padY * 2f;
                    float arrowH = 7f;
                    float arrowHalfW = 7f;
                    float totalH = boxH + arrowH;
                    float cornerR = Math.Min(8f, Math.Min(boxW, boxH) / 3f);
                    float diam = cornerR * 2f;

                    float drawX = anchorPxX - (boxW / 2f);
                    float drawY = anchorPxY - totalH;

                    float minLeft = 4f;
                    float maxRight = surfaceW - 4f;
                    float minTop = 4f;
                    float maxBottom = surfaceH - 4f;

                    if (snapshot.HasStatusBounds)
                    {
                        float bLeft;
                        float bTop;
                        float bRight;
                        float bBottom;
                        float tmpX;
                        float tmpY;
                        ConvertCaptureNormToOverlayPx(snapshot.StatusBoundsX, snapshot.StatusBoundsY, snapshot.DisplaySurface, targetRect, monitorRect, out bLeft, out bTop, out tmpX, out tmpY);
                        ConvertCaptureNormToOverlayPx(snapshot.StatusBoundsX + snapshot.StatusBoundsW, snapshot.StatusBoundsY + snapshot.StatusBoundsH, snapshot.DisplaySurface, targetRect, monitorRect, out bRight, out bBottom, out tmpX, out tmpY);
                        minLeft = Math.Max(4f, bLeft + 4f);
                        maxRight = Math.Min(surfaceW - 4f, bRight - 4f);
                        minTop = Math.Max(4f, bTop + 4f);
                        maxBottom = Math.Min(surfaceH - 4f, bBottom - 4f);
                    }

                    drawX = Math.Max(minLeft, Math.Min(Math.Max(minLeft, maxRight - boxW), drawX));
                    drawY = Math.Max(minTop, Math.Min(Math.Max(minTop, maxBottom - totalH), drawY));

                    float tipX = Math.Max(drawX + cornerR + arrowHalfW, Math.Min(drawX + boxW - cornerR - arrowHalfW, anchorPxX));
                    float boxBot = drawY + boxH;

                    using (GraphicsPath callout = new GraphicsPath())
                    {
                        callout.AddArc(drawX, drawY, diam, diam, 180f, 90f);
                        callout.AddArc(drawX + boxW - diam, drawY, diam, diam, 270f, 90f);
                        callout.AddArc(drawX + boxW - diam, boxBot - diam, diam, diam, 0f, 90f);
                        callout.AddLine(drawX + boxW - cornerR, boxBot, tipX + arrowHalfW, boxBot);
                        callout.AddLine(tipX + arrowHalfW, boxBot, tipX, boxBot + arrowH);
                        callout.AddLine(tipX, boxBot + arrowH, tipX - arrowHalfW, boxBot);
                        callout.AddLine(tipX - arrowHalfW, boxBot, drawX + cornerR, boxBot);
                        callout.AddArc(drawX, boxBot - diam, diam, diam, 90f, 90f);
                        callout.CloseFigure();

                        g.FillPath(statusBg, callout);
                        g.DrawPath(statusBorder, callout);
                    }

                    RectangleF textRect = new RectangleF(drawX, drawY, boxW, boxH);
                    g.DrawString(statusText, statusFont, statusBrush, textRect, centered);

                    long nowMs = UtcNowMs();
                    string drawKey = string.Format("{0}|{1:0},{2:0}", statusText, Math.Round(drawX / 4f), Math.Round(drawY / 4f));
                    if (drawKey != _lastDrawLogKey && (nowMs - _lastDrawLogAtMs >= 500 || statusText != "AGUARDANDO" || paintSeq <= 3))
                    {
                        _lastDrawLogKey = drawKey;
                        _lastDrawLogAtMs = nowMs;
                        Program.WriteDiagnosticLog(string.Format(
                            System.Globalization.CultureInfo.InvariantCulture,
                            "DRAW status={0} paint={1} norm=({2:0.000},{3:0.000}) screenPx=({4:0},{5:0}) localBox=({6:0},{7:0},{8:0}x{9:0})",
                            statusText,
                            paintSeq,
                            normStatusX,
                            normStatusY,
                            screenPxX,
                            screenPxY,
                            drawX,
                            drawY,
                            boxW,
                            boxH
                        ));
                    }
                }
            }

            if (hasPriceLine)
            {
                double normLineY = snapshot.HasPriceBounds
                    ? snapshot.PriceBoundsY + snapshot.ChartRelativePriceY * snapshot.PriceBoundsH
                    : snapshot.PriceY;
                double normX0 = snapshot.HasPriceBounds ? snapshot.PriceBoundsX : 0.04;
                double normX1 = snapshot.HasPriceBounds ? (snapshot.PriceBoundsX + snapshot.PriceBoundsW) : 0.92;

                float lineX0;
                float lineY;
                float lineX1;
                float tmp;
                ConvertCaptureNormToOverlayPx(normX0, Math.Max(0.02, Math.Min(0.98, normLineY)), snapshot.DisplaySurface, targetRect, monitorRect, out lineX0, out lineY, out tmp, out tmp);
                ConvertCaptureNormToOverlayPx(normX1, Math.Max(0.02, Math.Min(0.98, normLineY)), snapshot.DisplaySurface, targetRect, monitorRect, out lineX1, out tmp, out tmp, out tmp);
                lineX1 = Math.Max(lineX0 + 20f, lineX1);

                g.SmoothingMode = SmoothingMode.None;
                using (Pen shadowPen = new Pen(Color.FromArgb(200, 8, 12, 18), 3f))
                using (Pen linePen = new Pen(Color.FromArgb(255, 56, 189, 248), 2f))
                {
                    g.DrawLine(shadowPen, lineX0, lineY, lineX1, lineY);
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

                float cx;
                float cy;
                float tmpX;
                float tmpY;
                ConvertCaptureNormToOverlayPx(
                    Math.Max(0.02, Math.Min(0.98, normLiveX)),
                    Math.Max(0.02, Math.Min(0.98, normLiveY)),
                    snapshot.DisplaySurface,
                    targetRect,
                    monitorRect,
                    out cx,
                    out cy,
                    out tmpX,
                    out tmpY
                );

                Color markerColor = snapshot.LiveCandleDirection == "BULL"
                    ? Color.FromArgb(255, 16, 185, 129)
                    : (snapshot.LiveCandleDirection == "BEAR"
                        ? Color.FromArgb(255, 244, 63, 94)
                        : Color.FromArgb(255, 251, 191, 36));

                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (SolidBrush outerDark = new SolidBrush(Color.FromArgb(220, 11, 14, 17)))
                using (Pen ringPen = new Pen(markerColor, 2f))
                using (SolidBrush coreBrush = new SolidBrush(markerColor))
                {
                    g.FillEllipse(outerDark, cx - 8f, cy - 8f, 16f, 16f);
                    g.DrawEllipse(ringPen, cx - 7f, cy - 7f, 14f, 14f);
                    g.FillEllipse(coreBrush, cx - 3f, cy - 3f, 6f, 6f);
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_trackTimer != null)
                {
                    _trackTimer.Stop();
                    _trackTimer.Dispose();
                }
                if (_layeredSurface != null)
                {
                    _layeredSurface.Dispose();
                    _layeredSurface = null;
                }
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class BrokerWindowSelectorForm : Form
    {
        private readonly OverlayForm _overlayForm;
        private readonly ListBox _listBox;
        private readonly Label _infoLabel;

        public BrokerWindowSelectorForm(OverlayForm overlayForm)
        {
            _overlayForm = overlayForm;

            Text = "Selecionar Janela da Corretora — ChartPulse AI";
            ClientSize = new Size(560, 340);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            TopMost = true;
            BackColor = Color.FromArgb(15, 20, 28);
            ForeColor = Color.FromArgb(241, 245, 249);

            Label header = new Label
            {
                Text = "Escolha a janela da corretora onde o overlay transparente deve ser fixado:",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(16, 14)
            };

            _listBox = new ListBox
            {
                BackColor = Color.FromArgb(23, 30, 42),
                ForeColor = Color.FromArgb(226, 232, 240),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Segoe UI", 9f),
                Location = new Point(16, 44),
                Size = new Size(528, 200)
            };
            _listBox.DoubleClick += (s, e) => ApplySelection();

            _infoLabel = new Label
            {
                Text = "Janelas marcadas com [CORRETORA] foram detectadas automaticamente.",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(148, 163, 184),
                AutoSize = true,
                Location = new Point(16, 254)
            };

            Button selectBtn = new Button
            {
                Text = "Fixar na Janela",
                BackColor = Color.FromArgb(22, 163, 74),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                Size = new Size(140, 34),
                Location = new Point(16, 288)
            };
            selectBtn.FlatAppearance.BorderSize = 0;
            selectBtn.Click += (s, e) => ApplySelection();

            Button autoBtn = new Button
            {
                Text = "Modo Automático",
                BackColor = Color.FromArgb(51, 65, 85),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9f),
                Size = new Size(135, 34),
                Location = new Point(166, 288)
            };
            autoBtn.FlatAppearance.BorderSize = 0;
            autoBtn.Click += (s, e) =>
            {
                _overlayForm.ClearManualBrokerSelection();
                _infoLabel.Text = "Modo automático reativado (detecção dinâmica da corretora).";
            };

            Button refreshBtn = new Button
            {
                Text = "Atualizar Lista",
                BackColor = Color.FromArgb(30, 41, 59),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9f),
                Size = new Size(120, 34),
                Location = new Point(311, 288)
            };
            refreshBtn.FlatAppearance.BorderSize = 0;
            refreshBtn.Click += (s, e) => RefreshList();

            Button closeBtn = new Button
            {
                Text = "Fechar",
                BackColor = Color.FromArgb(30, 41, 59),
                ForeColor = Color.FromArgb(203, 213, 225),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9f),
                Size = new Size(98, 34),
                Location = new Point(446, 288)
            };
            closeBtn.FlatAppearance.BorderSize = 0;
            closeBtn.Click += (s, e) => Hide();

            Controls.Add(header);
            Controls.Add(_listBox);
            Controls.Add(_infoLabel);
            Controls.Add(selectBtn);
            Controls.Add(autoBtn);
            Controls.Add(refreshBtn);
            Controls.Add(closeBtn);

            FormClosing += (s, e) =>
            {
                if (e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    Hide();
                }
            };

            RefreshList();
        }

        public void RefreshList()
        {
            _listBox.Items.Clear();
            List<BrokerWindowCandidate> list = _overlayForm.EnumerateCandidateWindows();
            foreach (BrokerWindowCandidate item in list)
            {
                _listBox.Items.Add(item);
            }
            if (_listBox.Items.Count > 0)
            {
                _listBox.SelectedIndex = 0;
            }
            _infoLabel.Text = list.Count > 0
                ? string.Format("{0} janela(s) aberta(s) identificada(s). Dê duplo clique para fixar.", list.Count)
                : "Nenhuma janela externa aberta encontrada no momento.";
        }

        private void ApplySelection()
        {
            BrokerWindowCandidate selected = _listBox.SelectedItem as BrokerWindowCandidate;
            if (selected == null)
            {
                _infoLabel.Text = "Selecione uma janela da lista primeiro.";
                return;
            }
            _overlayForm.SetManualBrokerWindow(selected.Hwnd, selected.Title);
            _infoLabel.Text = string.Format("Fixado em: {0} (HWND 0x{1:X})", selected.Title, selected.Hwnd.ToInt64());
        }
    }

    internal sealed class OverlayApplicationContext : ApplicationContext
    {
        private readonly OverlayForm _overlayForm;
        private readonly NotifyIcon _trayIcon;
        private readonly IntPtr _trayIconHandle;
        private readonly ToolStripMenuItem _targetInfoItem;
        private BrokerWindowSelectorForm _selectorForm;

        public OverlayApplicationContext(OverlayForm form)
        {
            _overlayForm = form;
            IntPtr ensureHandle = form.Handle;
            if (ensureHandle == IntPtr.Zero)
            {
                throw new InvalidOperationException("OverlayForm handle creation failed.");
            }

            ContextMenuStrip menu = new ContextMenuStrip();
            _targetInfoItem = new ToolStripMenuItem("Alvo: Modo Automático") { Enabled = false };
            ToolStripMenuItem selectWindowItem = new ToolStripMenuItem("Selecionar janela da corretora...");
            ToolStripMenuItem autoModeItem = new ToolStripMenuItem("Modo Automático (Detectar Corretora)");
            ToolStripMenuItem openLogsItem = new ToolStripMenuItem("Abrir pasta de logs (overlay-debug.log)");
            ToolStripMenuItem exitItem = new ToolStripMenuItem("Sair do Overlay");

            selectWindowItem.Click += (s, e) => OpenWindowSelector();
            autoModeItem.Click += (s, e) => _overlayForm.ClearManualBrokerSelection();
            openLogsItem.Click += (s, e) => OpenLogsDirectory();
            exitItem.Click += (s, e) => ExitThread();

            menu.Opening += (s, e) =>
            {
                bool isManual;
                string summary = _overlayForm.GetCurrentTargetSummary(out isManual);
                _targetInfoItem.Text = (isManual ? "[Fixado] " : "[Auto] ") + summary;
            };

            menu.Items.Add(_targetInfoItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(selectWindowItem);
            menu.Items.Add(autoModeItem);
            menu.Items.Add(openLogsItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            _trayIconHandle = CreateTrayIconHandle();
            _trayIcon = new NotifyIcon
            {
                Icon = Icon.FromHandle(_trayIconHandle),
                Text = "ChartPulse AI — Overlay Nativo",
                ContextMenuStrip = menu,
                Visible = true
            };
            _trayIcon.DoubleClick += (s, e) => OpenWindowSelector();
        }

        private void OpenWindowSelector()
        {
            if (_selectorForm == null || _selectorForm.IsDisposed)
            {
                _selectorForm = new BrokerWindowSelectorForm(_overlayForm);
            }
            _selectorForm.RefreshList();
            if (!_selectorForm.Visible)
            {
                _selectorForm.Show();
            }
            _selectorForm.BringToFront();
        }

        private static void OpenLogsDirectory()
        {
            try
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ChartPulseAI"
                );
                Directory.CreateDirectory(dir);
                Process.Start("explorer.exe", dir);
            }
            catch
            {
                // Ignore explorer launch errors
            }
        }

        private static IntPtr CreateTrayIconHandle()
        {
            using (Bitmap bmp = new Bitmap(16, 16, System.Drawing.Imaging.PixelFormat.Format32bppPArgb))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (SolidBrush bg = new SolidBrush(Color.FromArgb(255, 11, 14, 17)))
                using (Pen border = new Pen(Color.FromArgb(255, 251, 191, 36), 1.5f))
                using (SolidBrush dot = new SolidBrush(Color.FromArgb(255, 34, 197, 94)))
                {
                    g.FillEllipse(bg, 1, 1, 14, 14);
                    g.DrawEllipse(border, 1, 1, 13, 13);
                    g.FillEllipse(dot, 5, 5, 6, 6);
                }
                return bmp.GetHicon();
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_selectorForm != null && !_selectorForm.IsDisposed)
                {
                    _selectorForm.Dispose();
                }
                if (_trayIcon != null)
                {
                    _trayIcon.Visible = false;
                    _trayIcon.Dispose();
                }
                if (_trayIconHandle != IntPtr.Zero)
                {
                    Win32Native.DestroyIcon(_trayIconHandle);
                }
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

            try
            {
                Win32Native.SetProcessDpiAwarenessContext(Win32Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            catch
            {
                try { Win32Native.SetProcessDPIAware(); } catch { }
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            _overlayForm = new OverlayForm();
            WriteDiagnosticLog("AGENT_START version=1.3.2 buildId=2026-11-20-hwnd pid=" + Win32Native.CurrentProcessId);

            Thread httpThread = new Thread(RunLocalHttpServer);
            httpThread.IsBackground = true;
            httpThread.Start();

            Application.Run(new OverlayApplicationContext(_overlayForm));
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

        private static readonly DateTime ProgramUnixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        private static long ProgramUtcNowMs()
        {
            return (long)(DateTime.UtcNow - ProgramUnixEpoch).TotalMilliseconds;
        }

        private static void RunLocalHttpServer()
        {
            HttpListener listener = new HttpListener();
            listener.Prefixes.Add(ListenPrefix);
            try
            {
                listener.Start();
            }
            catch (Exception ex)
            {
                WriteDiagnosticLog("HTTP_START_FAIL " + ex.Message);
                return;
            }

            while (listener.IsListening)
            {
                HttpListenerContext ctx = null;
                try
                {
                    ctx = listener.GetContext();
                    HttpListenerContext capturedCtx = ctx;
                    ThreadPool.QueueUserWorkItem(_ =>
                    {
                        try
                        {
                            HandleRequest(capturedCtx);
                        }
                        catch (Exception ex)
                        {
                            WriteDiagnosticLog("HTTP_HANDLE_ERR " + ex.Message);
                            try { capturedCtx.Response.Close(); } catch { }
                        }
                    });
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
            res.Close();
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

            string reqHeaders = req.Headers["Access-Control-Request-Headers"];
            res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
            res.Headers["Access-Control-Allow-Headers"] = !string.IsNullOrWhiteSpace(reqHeaders)
                ? reqHeaders
                : "Content-Type, Accept";
            res.Headers["Access-Control-Allow-Private-Network"] = "true";
            res.Headers["Cache-Control"] = "no-store";

            if (req.HttpMethod == "OPTIONS")
            {
                res.StatusCode = 204;
                res.ContentLength64 = 0;
                res.Close();
                return;
            }

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
                    WriteDiagnosticLog(string.Format(System.Globalization.CultureInfo.InvariantCulture, "PRICE_LINE y={0:0.000} relY={1:0.000} hasBounds={2}", priceY, relPriceY, hasBounds));
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
                    _overlayForm.UpdateLiveCandle(sessionId, false, 0.5, 0.5, 0.5, 0.5, 0.5, "NEUTRAL", false, 0, 0, 1, 1);
                    WriteJson(res, 200, "{\"ok\":true}");
                    return;
                }

                string boundsObj = ExtractJsonObject(candleObj, "chartBounds");
                string candleShallow = string.IsNullOrEmpty(boundsObj)
                    ? candleObj
                    : candleObj.Replace(boundsObj, "{}");

                double liveX = ExtractJsonDouble(candleShallow, "x", 0.5);
                double liveY = ExtractJsonDouble(candleShallow, "y", 0.5);
                double liveTopY = ExtractJsonDouble(candleShallow, "topY", liveY);
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
                    liveTopY,
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
                    WriteDiagnosticLog(string.Format(System.Globalization.CultureInfo.InvariantCulture, "LIVE_CANDLE x={0:0.000} y={1:0.000} topY={2:0.000} dir={3} hasBounds={4}", liveX, liveY, liveTopY, dir, hasBounds));
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
                    ProgramUtcNowMs() + 18000
                );
                WriteDiagnosticLog(string.Format(System.Globalization.CultureInfo.InvariantCulture, "SIGNAL dir={0} x={1:0.000} y={2:0.000}", direction, candleX, candleY));
                WriteJson(res, 200, "{\"ok\":true}");
                return;
            }

            if (req.HttpMethod == "POST" && path == "/overlay/status")
            {
                string sessionId = ExtractJsonString(bodyText, "sessionId");
                string statusObj = ExtractJsonObject(bodyText, "operationalStatus");
                string statusSource = string.IsNullOrEmpty(statusObj) ? bodyText : statusObj;
                string boundsObj = ExtractJsonObject(statusSource, "chartBounds");
                string anchorObj = ExtractJsonObject(statusSource, "anchor");
                string statusShallow = statusSource;
                if (!string.IsNullOrEmpty(boundsObj)) statusShallow = statusShallow.Replace(boundsObj, "{}");
                if (!string.IsNullOrEmpty(anchorObj)) statusShallow = statusShallow.Replace(anchorObj, "{}");

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

                bool hasAnchor = !string.IsNullOrEmpty(anchorObj);
                double ax = 0, ay = 0, relX = 0, relY = 0;
                if (hasAnchor)
                {
                    ax = ExtractJsonDouble(anchorObj, "x", -1);
                    ay = ExtractJsonDouble(anchorObj, "y", -1);
                    relX = ExtractJsonDouble(anchorObj, "chartRelativeX", ax);
                    relY = ExtractJsonDouble(anchorObj, "chartRelativeY", ay);
                    hasAnchor = ax >= 0 && ax <= 1 && ay >= 0 && ay <= 1;
                }

                _overlayForm.UpdateOperationalStatus(
                    sessionId,
                    statusVal,
                    hasBounds,
                    bx,
                    by,
                    bw,
                    bh,
                    hasAnchor,
                    ax,
                    ay,
                    relX,
                    relY
                );
                _statusLogTick++;
                if (_statusLogTick == 1 || _statusLogTick % 20 == 0 || statusVal == "COMPRA" || statusVal == "VENDA")
                {
                    WriteDiagnosticLog(string.Format(System.Globalization.CultureInfo.InvariantCulture, "OP_STATUS status={0} hasAnchor={1} ax={2:0.000} ay={3:0.000}", statusVal, hasAnchor, ax, ay));
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
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)");
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

        internal static void WriteDiagnosticLog(string message)
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
