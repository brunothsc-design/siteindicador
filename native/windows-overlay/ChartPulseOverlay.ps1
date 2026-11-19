param(
    [string]$ServerUrl = "http://localhost:3000"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Win32Overlay {
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_LAYERED = 0x80000;
    public const int WS_EX_TRANSPARENT = 0x20;
    public const int WS_EX_TOPMOST = 0x8;
    public const int WS_EX_TOOLWINDOW = 0x80;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
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
"@

$script:TargetHwnd = [IntPtr]::Zero
$script:CurrentState = $null
$script:HttpClient = New-Object System.Net.Http.HttpClient
$script:HttpClient.Timeout = [TimeSpan]::FromMilliseconds(1500)

$script:IgnoredClasses = @(
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow",
    "TaskManagerWindow"
)

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Bounds = [System.Drawing.Rectangle]::new(0, 0, 1, 1)

$form.Add_Shown({
    $exStyle = [Win32Overlay]::GetWindowLong($form.Handle, [Win32Overlay]::GWL_EXSTYLE)
    $newStyle = $exStyle -bor [Win32Overlay]::WS_EX_LAYERED -bor [Win32Overlay]::WS_EX_TRANSPARENT -bor [Win32Overlay]::WS_EX_TOPMOST -bor [Win32Overlay]::WS_EX_TOOLWINDOW -bor [Win32Overlay]::WS_EX_NOACTIVATE
    [void][Win32Overlay]::SetWindowLong($form.Handle, [Win32Overlay]::GWL_EXSTYLE, $newStyle)
})

$form.Add_Paint({
    param($sender, $e)
    $state = $script:CurrentState
    if ($null -eq $state -or -not $state.active) {
        return
    }

    $hasPriceLine = $null -ne $state.priceLine
    $hasLiveCandle = $null -ne $state.liveCandle
    $dir = if ($null -ne $state.signal) { [string]$state.signal.direction } else { "" }
    $hasSignal = ($dir -eq "COMPRA" -or $dir -eq "VENDA")

    if (-not $hasPriceLine -and -not $hasLiveCandle -and -not $hasSignal) {
        return
    }

    $g = $e.Graphics

    if ($hasPriceLine) {
        $pBounds = if ($null -ne $state.priceLine.chartBounds) { $state.priceLine.chartBounds } else { $state.chartBounds }
        if ($null -ne $pBounds -and $null -ne $state.priceLine.chartRelativeY) {
            $normLineY = $pBounds.y + ($state.priceLine.chartRelativeY * $pBounds.height)
            $lineX0 = [float]([Math]::Max(0.0, [Math]::Min(0.95, $pBounds.x)) * $form.ClientSize.Width)
            $lineX1 = [float]([Math]::Max(0.1, [Math]::Min(1.0, $pBounds.x + $pBounds.width)) * $form.ClientSize.Width)
        } else {
            $normLineY = $state.priceLine.y
            $lineX0 = [float](0.04 * $form.ClientSize.Width)
            $lineX1 = [float](0.92 * $form.ClientSize.Width)
        }

        $lineY = [float]([Math]::Max(0.02, [Math]::Min(0.98, $normLineY)) * $form.ClientSize.Height)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $shadowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 8, 12, 18), 1)
        $linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 56, 189, 248), 2)
        $g.DrawLine($shadowPen, $lineX0, $lineY + 1.5, $lineX1, $lineY + 1.5)
        $g.DrawLine($linePen, $lineX0, $lineY, $lineX1, $lineY)
        $shadowPen.Dispose()
        $linePen.Dispose()
    }

    if ($hasLiveCandle) {
        $cBounds = if ($null -ne $state.liveCandle.chartBounds) { $state.liveCandle.chartBounds } else { $state.chartBounds }
        if ($null -ne $cBounds -and $null -ne $state.liveCandle.chartRelativeX -and $null -ne $state.liveCandle.chartRelativeY) {
            $normLiveX = $cBounds.x + ($state.liveCandle.chartRelativeX * $cBounds.width)
            $normLiveY = $cBounds.y + ($state.liveCandle.chartRelativeY * $cBounds.height)
        } else {
            $normLiveX = $state.liveCandle.x
            $normLiveY = $state.liveCandle.y
        }

        $cx = [float]([Math]::Max(0.02, [Math]::Min(0.98, $normLiveX)) * $form.ClientSize.Width)
        $cy = [float]([Math]::Max(0.02, [Math]::Min(0.98, $normLiveY)) * $form.ClientSize.Height)
        $cDir = [string]$state.liveCandle.direction
        $cColor = if ($cDir -eq "BULL") {
            [System.Drawing.Color]::FromArgb(255, 16, 185, 129)
        } elseif ($cDir -eq "BEAR") {
            [System.Drawing.Color]::FromArgb(255, 244, 63, 94)
        } else {
            [System.Drawing.Color]::FromArgb(255, 251, 191, 36)
        }

        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 11, 14, 17))
        $ringPen = New-Object System.Drawing.Pen($cColor, 2)
        $dotBrush = New-Object System.Drawing.SolidBrush($cColor)
        $g.FillEllipse($bgBrush, $cx - 8, $cy - 8, 16, 16)
        $g.DrawEllipse($ringPen, $cx - 7, $cy - 7, 14, 14)
        $g.FillEllipse($dotBrush, $cx - 3, $cy - 3, 6, 6)
        $bgBrush.Dispose()
        $ringPen.Dispose()
        $dotBrush.Dispose()
    }

    if ($hasSignal) {
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

        $bounds = if ($null -ne $state.signal.chartBounds) { $state.signal.chartBounds } else { $state.chartBounds }
        if ($null -ne $bounds -and $null -ne $state.signal.chartRelativeX -and $null -ne $state.signal.chartRelativeY) {
            $normX = $bounds.x + ($state.signal.chartRelativeX * $bounds.width)
            $normY = $bounds.y + ($state.signal.chartRelativeY * $bounds.height)
        } else {
            $normX = $state.signal.candleX
            $normY = $state.signal.candleY
        }

        $x = [float]($normX * $form.ClientSize.Width)
        $y = [float]($normY * $form.ClientSize.Height)

        $font = New-Object System.Drawing.Font("Consolas", 13, [System.Drawing.FontStyle]::Bold)
        $size = $g.MeasureString($dir, $font)
        $drawX = $x - ($size.Width / 2)
        $drawY = $y - ($size.Height / 2)

        $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(245, 5, 5, 5))
        $textColor = if ($dir -eq "COMPRA") {
            [System.Drawing.Color]::FromArgb(255, 34, 197, 94)
        } else {
            [System.Drawing.Color]::FromArgb(255, 239, 68, 68)
        }
        $textBrush = New-Object System.Drawing.SolidBrush($textColor)

        $g.DrawString($dir, $font, $shadowBrush, $drawX + 1, $drawY + 1)
        $g.DrawString($dir, $font, $textBrush, $drawX, $drawY)

        $font.Dispose()
        $shadowBrush.Dispose()
        $textBrush.Dispose()
    }
})

# Track whichever broker EXE or browser chart window the user focuses/clicks at 20Hz
$trackTimer = New-Object System.Windows.Forms.Timer
$trackTimer.Interval = 50
$trackTimer.Add_Tick({
    $fg = [Win32Overlay]::GetForegroundWindow()
    if ($fg -ne [IntPtr]::Zero -and $fg -ne $form.Handle) {
        $clsSb = New-Object System.Text.StringBuilder 128
        [void][Win32Overlay]::GetClassName($fg, $clsSb, 128)
        $cls = $clsSb.ToString()

        if (-not ($script:IgnoredClasses -contains $cls)) {
            $sb = New-Object System.Text.StringBuilder 256
            [void][Win32Overlay]::GetWindowText($fg, $sb, 256)
            $title = $sb.ToString()
            if ($title -and -not $title.Contains("ChartPulse AI")) {
                $script:TargetHwnd = $fg
            }
        }
    }

    if ($script:TargetHwnd -ne [IntPtr]::Zero -and [Win32Overlay]::IsWindow($script:TargetHwnd)) {
        if ([Win32Overlay]::IsIconic($script:TargetHwnd)) {
            if ($form.Visible) { $form.Hide() }
            return
        }
        $rect = New-Object Win32Overlay+RECT
        $hr = [Win32Overlay]::DwmGetWindowAttribute($script:TargetHwnd, [Win32Overlay]::DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32Overlay+RECT]))
        $hasRect = ($hr -eq 0) -or [Win32Overlay]::GetWindowRect($script:TargetHwnd, [ref]$rect)
        if ($hasRect) {
            $w = [Math]::Max(1, $rect.Right - $rect.Left)
            $h = [Math]::Max(1, $rect.Bottom - $rect.Top)
            $targetBounds = [System.Drawing.Rectangle]::new($rect.Left, $rect.Top, $w, $h)
            if ($form.Bounds -ne $targetBounds) {
                $form.Bounds = $targetBounds
                $form.Invalidate()
            }
            if (-not $form.Visible) { $form.Show() }
        }
    }
})
$trackTimer.Start()

# Poll ChartPulse AI signal state
$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 250
$pollTimer.Add_Tick({
    try {
        $json = $script:HttpClient.GetStringAsync("$ServerUrl/api/overlay/state").GetAwaiter().GetResult()
        $parsed = $json | ConvertFrom-Json
        $prevSig = if ($null -ne $script:CurrentState -and $null -ne $script:CurrentState.signal) { $script:CurrentState.signal.id } else { $null }
        $nextSig = if ($null -ne $parsed -and $null -ne $parsed.signal) { $parsed.signal.id } else { $null }
        $prevActive = if ($null -ne $script:CurrentState) { $script:CurrentState.active } else { $false }
        $prevUpdated = if ($null -ne $script:CurrentState) { $script:CurrentState.updatedAt } else { 0 }

        if ($prevSig -ne $nextSig -or $prevActive -ne $parsed.active -or $prevUpdated -ne $parsed.updatedAt) {
            $script:CurrentState = $parsed
            $form.Invalidate()
        }
    } catch {
        if ($null -ne $script:CurrentState) {
            $script:CurrentState = $null
            $form.Invalidate()
        }
    }
})
$pollTimer.Start()

[System.Windows.Forms.Application]::Run($form)
