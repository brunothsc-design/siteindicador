$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
$agentSrc = Join-Path $rootDir "win-agent\ChartPulseOverlayHost.cs"
$setupSrc = Join-Path $scriptDir "SetupWizard.cs"
$outDir = Join-Path $rootDir "dist-windows"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$cscCandidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $csc) {
    throw "Compilador .NET Framework (csc.exe) nao encontrado no Windows."
}

$overlayExe = Join-Path $outDir "ChartPulseOverlay.exe"
$setupExe = Join-Path $outDir "ChartPulseOverlaySetup.exe"

Remove-Item -Force -ErrorAction SilentlyContinue $overlayExe, $setupExe

Write-Host "Compilando ChartPulseOverlay.exe (v1.3.2)..."
& $csc /nologo /target:winexe /optimize+ /out:$overlayExe `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Net.Http.dll `
    $agentSrc

if ($LASTEXITCODE -ne 0) {
    throw "Erro ao compilar ChartPulseOverlay.exe"
}

Write-Host "Compilando instalador ChartPulseOverlaySetup.exe..."
& $csc /nologo /target:winexe /optimize+ /out:$setupExe `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll `
    /resource:"$overlayExe,ChartPulseOverlay.exe" `
    $setupSrc

if ($LASTEXITCODE -ne 0) {
    throw "Erro ao compilar ChartPulseOverlaySetup.exe"
}

Write-Host "Concluido:"
Write-Host "  Overlay:    $overlayExe"
Write-Host "  Instalador: $setupExe"
