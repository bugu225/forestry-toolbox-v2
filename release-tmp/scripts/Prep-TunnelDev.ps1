<#
.SYNOPSIS
  Prepare .env.local for local Vite + HTTPS tunnel + mobile GPS testing.
  Run from repo root:
    powershell -ExecutionPolicy Bypass -File .\scripts\Prep-TunnelDev.ps1
#>
$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

$envLocal = Join-Path $RepoRoot ".env.local"
$envExample = Join-Path $RepoRoot ".env.example"
$snippet = Join-Path $RepoRoot "docs\tunnel-env.snippet"

Write-Host ""
Write-Host "========== YOU must do (cannot be automated) ==========" -ForegroundColor Yellow
Write-Host " 1) Install a tunnel client, e.g.: winget install --id Cloudflare.cloudflared -e"
Write-Host " 2) Start backend + frontend, then in a NEW terminal run:"
Write-Host "      cloudflared tunnel --url http://127.0.0.1:5173"
Write-Host " 3) Copy the printed https URL (no trailing slash). Edit repo root .env.local:"
Write-Host "      Set CORS_ORIGINS to include that origin, e.g."
Write-Host "      CORS_ORIGINS=http://localhost:5173,https://YOUR-SUBDOMAIN.trycloudflare.com"
Write-Host "      Keep VITE_API_BASE=/api so /api is proxied by Vite to Flask."
Write-Host " 4) Restart Flask and npm run dev after editing .env.local."
Write-Host " 5) On phone use MOBILE DATA, open the https URL; allow location in OS + browser."
Write-Host "=========================================================" -ForegroundColor Yellow
Write-Host ""

if (-not (Test-Path $envLocal)) {
  if (Test-Path $envExample) {
    Copy-Item $envExample $envLocal
    Write-Host "DONE: Created .env.local from .env.example" -ForegroundColor Green
    $lines = Get-Content $envLocal
    $out = foreach ($line in $lines) {
      if ($line -match '^\s*CORS_ORIGINS=') {
        'CORS_ORIGINS=http://localhost:5173,https://CHANGEME'
      } elseif ($line -match '^\s*VITE_API_BASE=') {
        'VITE_API_BASE=/api'
      } else {
        $line
      }
    }
    $out | Set-Content -Path $envLocal -Encoding utf8
    Write-Host "DONE: Set tunnel placeholder in CORS_ORIGINS (https://CHANGEME). Replace CHANGEME with your tunnel host." -ForegroundColor Cyan
  } else {
    New-Item -ItemType File -Path $envLocal -Force | Out-Null
    Write-Host "DONE: Created empty .env.local (.env.example missing)" -ForegroundColor Green
    if (Test-Path $snippet) {
      Get-Content -Raw $snippet | Set-Content -Path $envLocal -Encoding utf8
    }
  }
} else {
  Write-Host "SKIP: .env.local already exists (not modified). Verify VITE_API_BASE=/api and CORS_ORIGINS includes your tunnel https origin." -ForegroundColor DarkYellow
  if (Test-Path $snippet) {
    Write-Host "      See docs/tunnel-env.snippet for a merge example." -ForegroundColor DarkYellow
  }
}

Write-Host ""
Write-Host "Checking cloudflared in PATH..." -ForegroundColor DarkGray
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cf) {
  Write-Host ('OK cloudflared: ' + $cf.Source) -ForegroundColor Green
} else {
  Write-Host "HINT: cloudflared not found. Run: winget install --id Cloudflare.cloudflared -e" -ForegroundColor DarkYellow
}
