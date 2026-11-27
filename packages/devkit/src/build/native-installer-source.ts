function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function nativeInstallerSource(options: {
  readonly name: string;
  readonly shortcutName: string;
  readonly publisher: string;
  readonly version: string;
  readonly installKey: string;
  readonly upgradeCode: string;
  readonly productCode: string;
}): string {
  return `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="${xml(options.name)}" Manufacturer="${xml(options.publisher)}"
           Version="${options.version}" Scope="perMachine" UpgradeCode="${options.upgradeCode}"
           ProductCode="${options.productCode}">
    <MajorUpgrade DowngradeErrorMessage="A newer version of this game is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <Property Id="DISABLEADVTSHORTCUTS" Value="1" />
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="${options.installKey}">
        <Directory Id="GameFolder" Name="game" />
        <Directory Id="RuntimeFolder" Name="runtime" />
        <Component Id="Launcher">
          <File Id="LauncherExe" Source="payload\\Game.exe" KeyPath="yes">
            <Shortcut Id="LaunchGame" Name="${xml(options.shortcutName)}"
                      Advertise="yes" Directory="ProgramMenuFolder" WorkingDirectory="INSTALLFOLDER" />
          </File>
        </Component>
      </Directory>
    </StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder" />
    <Feature Id="Game" Title="${xml(options.name)}" Level="1">
      <ComponentRef Id="Launcher" />
      <ComponentGroupRef Id="GameFiles" />
      <ComponentGroupRef Id="RuntimeFiles" />
    </Feature>
  </Package>
  <Fragment>
    <ComponentGroup Id="GameFiles" Directory="GameFolder">
      <Files Include="payload\\game\\**" />
    </ComponentGroup>
    <ComponentGroup Id="RuntimeFiles" Directory="RuntimeFolder">
      <Files Include="payload\\runtime\\**" />
    </ComponentGroup>
  </Fragment>
</Wix>
`;
}

export function nativeLauncherSource(installKey: string): string {
  return String.raw`using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Windows.Forms;

internal static class ForgeaXLauncher
{
    [STAThread]
    private static int Main()
    {
        string logPath = null;
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (String.IsNullOrWhiteSpace(local))
                local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string logs = Path.Combine(local, "ForgeaX", "${installKey}", "logs");
            Directory.CreateDirectory(logs);
            string stamp = DateTime.UtcNow.ToString("yyyyMMddTHHmmssfff", CultureInfo.InvariantCulture);
            logPath = Path.Combine(logs, stamp + "-" + Process.GetCurrentProcess().Id + ".log");
            string runtime = Path.Combine(root, "runtime");
            var game = new ProcessStartInfo
            {
                FileName = Path.Combine(runtime, "node.exe"),
                WorkingDirectory = Path.Combine(root, "game"),
                Arguments = "game.mjs",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var writer = new StreamWriter(new FileStream(logPath,
                FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite)))
            using (var process = new Process { StartInfo = game })
            {
                writer.AutoFlush = true;
                var writeLock = new object();
                process.OutputDataReceived += (sender, e) =>
                {
                    if (e.Data != null) lock (writeLock) writer.WriteLine(e.Data);
                };
                process.ErrorDataReceived += (sender, e) =>
                {
                    if (e.Data != null) lock (writeLock) writer.WriteLine("[stderr] " + e.Data);
                };
                process.Start();
                writer.WriteLine("GAME_PID=" + process.Id);
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                writer.WriteLine("GAME_EXIT=" + process.ExitCode);
                if (process.ExitCode == 0) return 0;
            }
            MessageBox.Show("The game stopped with an error. Log: " + logPath,
                "ForgeaX game", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message + (logPath == null ? "" : "\nLog: " + logPath),
                "ForgeaX game", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        return 1;
    }
}
`;
}
