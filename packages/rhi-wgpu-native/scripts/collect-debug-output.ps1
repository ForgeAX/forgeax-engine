param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition (Get-Content -LiteralPath "$PSScriptRoot/DebugOutputCollector.cs" -Raw -Encoding UTF8)
$config = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
$result = [DebugOutputCollector]::Run($config.executable, [string[]]$config.arguments, $config.cwd, $config.log, $config.timeoutMs, [bool]$config.followChildren)
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $config.report -Encoding UTF8
Get-Content -LiteralPath $config.log -Raw
$startup = @($result.debugStrings | Where-Object { $_ -like '*GPU-Based Validation is enabled*' }).Count
$errors = @($result.debugStrings | Where-Object { $_ -match 'D3D Error|(D3D12|DXGI).*(ERROR|CORRUPTION)' })
$warnings = @($result.debugStrings | Where-Object { $_ -match '(D3D12|DXGI) WARNING' }).Count
Write-Output "[debug-capture] startup=$startup errors=$($errors.Count) warnings=$warnings report=$($config.report)"
foreach ($message in $errors) { Write-Output "[OutputDebugString] $message" }
if ($errors.Count -gt 0) { exit 1 }
exit $result.exitCode
