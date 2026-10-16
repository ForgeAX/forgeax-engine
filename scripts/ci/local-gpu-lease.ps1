param([Parameter(Mandatory = $true)][string]$LockPath)

$ErrorActionPreference = 'Stop'
$closed = [Console]::OpenStandardInput().CopyToAsync([IO.Stream]::Null)
$directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LockPath))
[IO.Directory]::CreateDirectory($directory) | Out-Null
$lease = $null
try {
    while (-not $closed.IsCompleted) {
        try {
            $lease = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            break
        } catch [IO.IOException] {
            $code = $_.Exception.HResult -band 0xffff
            if ($code -ne 32 -and $code -ne 33) { throw }
            [Threading.Thread]::Sleep(100)
        }
    }
    if ($null -ne $lease -and -not $closed.IsCompleted) {
        [Console]::Out.WriteLine('{"acquired":true}')
        [Console]::Out.Flush()
        $closed.GetAwaiter().GetResult()
    }
} finally {
    if ($null -ne $lease) { $lease.Dispose() }
}
