param(
  [ValidateSet('auto', 'x64', 'arm64')]
  [string]$Architecture = 'auto'
)

$ErrorActionPreference = 'Stop'
$repo = 'jjhbk/code-traffic'
if ($Architecture -eq 'auto') {
  # Query the hardware so an emulated PowerShell does not select the wrong build.
  $processor = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
  $Architecture = switch ($processor.Architecture) {
    9 { 'x64' }
    12 { 'arm64' }
    default { throw "Unsupported Windows processor architecture: $($processor.Architecture)" }
  }
}
Write-Host "Using Windows architecture: $Architecture"

$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
$asset = $release.assets | Where-Object { $_.name -match "-$Architecture\.exe$" } | Select-Object -First 1
if (-not $asset) { throw "No Signal Box Windows $Architecture release was found." }

$installer = Join-Path $env:TEMP ("signal-box-$Architecture.exe")
Write-Host "Downloading Signal Box for Windows $Architecture..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
Start-Process -FilePath $installer -Wait
Remove-Item $installer -Force
Write-Host 'Signal Box installed successfully.'
