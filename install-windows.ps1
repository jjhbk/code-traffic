param(
  [ValidateSet('x64', 'arm64')]
  [string]$Architecture
)

$ErrorActionPreference = 'Stop'
$repo = 'jjhbk/code-traffic'
if (-not $Architecture) {
  $Architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
}

$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
$asset = $release.assets | Where-Object { $_.name -match "-$Architecture\.exe$" } | Select-Object -First 1
if (-not $asset) { throw "No Signal Box Windows $Architecture release was found." }

$installer = Join-Path $env:TEMP ("signal-box-$Architecture.exe")
Write-Host "Downloading Signal Box for Windows $Architecture..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
Start-Process -FilePath $installer -Wait
Remove-Item $installer -Force
Write-Host 'Signal Box installed successfully.'
