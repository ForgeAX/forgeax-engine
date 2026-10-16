$ErrorActionPreference='Stop'
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('forgeax-debug-collector-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
try {
    $fixture=Join-Path $fixtureRoot 'fixture.exe'
    Add-Type -OutputAssembly $fixture -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
public static class DebugFixture {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern void OutputDebugString(string text);
    public static void Main(string[] args) {
        if(args[0]=="message-burst") {
            for(int i=0;i<2048;i++) OutputDebugString("forgeax-warning-burst-"+i);
            OutputDebugString("D3D12 ERROR: forgeax-late-error-sentinel"); return;
        }
        if(args[0]=="child") { Thread.Sleep(300); OutputDebugString("forgeax-owned-child-after-parent"); return; }
        if(args[0]=="hang-child") { Thread.Sleep(60000); return; }
        if(args[0]=="parent" || args[0]=="hang-parent") { Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,args[0]=="parent"?"child":"hang-child") {UseShellExecute=false,CreateNoWindow=true}); return; }
        Thread.Sleep(1000); OutputDebugString("forgeax-next-root");
    }
}
'@
    Add-Type -TypeDefinition (Get-Content -LiteralPath "$PSScriptRoot/DebugOutputCollector.cs" -Raw -Encoding UTF8)
    $first=[DebugOutputCollector]::Run($fixture,[string[]]@('parent'),$fixtureRoot,(Join-Path $fixtureRoot 'first.log'),10000,$true)
    $second=[DebugOutputCollector]::Run($fixture,[string[]]@('wait'),$fixtureRoot,(Join-Path $fixtureRoot 'second.log'),10000,$true)
    if($first.exitCode -ne 0 -or $second.exitCode -ne 0){throw 'collector fixture did not exit cleanly'}
    if(-not($first.debugStrings -contains 'forgeax-owned-child-after-parent')){throw 'child debug output was lost after parent exit'}
    if(-not($second.debugStrings -contains 'forgeax-next-root')){throw 'next root debug output was lost'}
    if($second.debugStrings -contains 'forgeax-owned-child-after-parent'){throw 'previous child leaked into the next collection'}
    $timed=[DebugOutputCollector]::Run($fixture,[string[]]@('hang-parent'),$fixtureRoot,(Join-Path $fixtureRoot 'timeout.log'),1000,$true)
    if(-not $timed.timedOut -or $timed.exitCode -ne 124){throw 'descendant lifetime escaped the original deadline'}
    $afterTimeout=[DebugOutputCollector]::Run($fixture,[string[]]@('wait'),$fixtureRoot,(Join-Path $fixtureRoot 'after-timeout.log'),10000,$true)
    if($afterTimeout.exitCode -ne 0 -or -not($afterTimeout.debugStrings -contains 'forgeax-next-root')){throw 'timeout contaminated the next collection'}
    $burst=[DebugOutputCollector]::Run($fixture,[string[]]@('message-burst'),$fixtureRoot,(Join-Path $fixtureRoot 'burst.log'),10000,$true)
    if($burst.exitCode -ne 0){throw 'debug message burst fixture did not exit cleanly'}
    if(@($burst.debugStrings | Where-Object {$_ -like 'forgeax-warning-burst-*'}).Count -ne 2048){throw 'debug message burst was truncated'}
    if(-not($burst.debugStrings -contains 'D3D12 ERROR: forgeax-late-error-sentinel')){throw 'graphics error after message burst was lost'}
    Write-Output 'PASS: followed child output is drained before the next collection'
    Write-Output 'PASS: all 2048 debug messages and the following graphics error are retained'
} catch {
    Write-Output $_.Exception.ToString()
    throw
} finally {
    $resolved=[IO.Path]::GetFullPath($fixtureRoot)
    $temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if(-not $resolved.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase)){throw 'fixture cleanup escaped temporary directory'}
    try { Remove-Item -LiteralPath $resolved -Recurse -Force } catch { Write-Warning "Fixture cleanup failed: $($_.Exception.Message)" }
}
