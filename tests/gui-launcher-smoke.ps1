# GUI Launcher (WinExe, no-console) QA —— task-8 独立只读验收
#
# 范围（小 QA，不重复旧 21 项 GUI 验收）：
#  1) 静态：PE 可选头 Subsystem == 2 (WINDOWS_GUI，无控制台) + 图标可提取；
#  2) 源码：GuiLauncher.cs 不得调用 cmd/powershell/pwsh/wscript/cscript/ShellExecute；
#  3) 动态（隔离临时目录 + fake target probe，绝不启动真实用户 profile）：
#     - 污染父环境 ELECTRON_RUN_AS_NODE=1 / NODE_OPTIONS / NODE_PATH；
#     - GUI launcher 指向 probe.exe（cli-dev 提供测试钩子；无钩子则标 SKIP，不伪造通过）；
#     - 断言 probe 观察到三个 env 已清空、args 透传、cwd 合理、launcher 秒退；
#     - 断言该窗口内无 cmd.exe/powershell.exe/pwsh.exe/wscript.exe 子进程。
#  4) 启动前**动态枚举**现有 3CT-Auto 进程（不按旧 PID 假定）；只读快照，不 kill/重启。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\gui-launcher-smoke.ps1
#   powershell ... -File tests\gui-launcher-smoke.ps1 -SkipDynamic     # 只做静态
# 结果：artifacts\gui-launcher-result.json；退出码 0=全过（SKIP 不算失败）
#
param(
  [string]$RootLauncher = "",
  [string]$CopyLauncher = "",
  [string]$LauncherSource = "desktop\GuiLauncher.cs",
  [switch]$SkipDynamic
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$resultPath = Join-Path $artifacts 'gui-launcher-result.json'

$checks = @()
function Add-Check([string]$name, [bool]$ok, [string]$detail) {
  $script:checks += [ordered]@{ name = $name; ok = $ok; detail = "$detail" }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host "[$mark] $name :: $detail"
}
function Add-Skip([string]$name, [string]$detail) {
  $script:checks += [ordered]@{ name = $name; ok = $true; skipped = $true; detail = "$detail" }
  Write-Host "[SKIP] $name :: $detail"
}

# ── 辅助：进程动态枚举（只读）──
function Get-3ctProcesses {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('3CT-Auto.exe', '3CT.exe', '启动3CT自动版.exe') } |
    Select-Object ProcessId, Name, CommandLine
}

# ── 辅助：PE 可选头 Subsystem（2=GUI）──
function Get-PeSubsystem([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  if ($bytes.Length -lt 0x40) { throw "文件过小，非 PE: $path" }
  $peOff = [BitConverter]::ToInt32($bytes, 0x3C)
  if ($bytes[$peOff] -ne 0x50 -or $bytes[$peOff + 1] -ne 0x45) { throw "非 PE 签名: $path" }
  $optOff = $peOff + 24
  $magic = [BitConverter]::ToUInt16($bytes, $optOff)
  # PE32: Subsystem @ opt+68；PE32+: Subsystem @ opt+68 同样位置（Standard 部分 68 字节）
  if ($magic -ne 0x10B -and $magic -ne 0x20B) { throw ("未知可选头 magic=0x{0:X}" -f $magic) }
  $subsystem = [BitConverter]::ToUInt16($bytes, $optOff + 68)
  $pe32plus = ($magic -eq 0x20B)
  return [pscustomobject]@{ Subsystem = $subsystem; Pe32Plus = $pe32plus; Size = $bytes.Length }
}

# ── 1) 定位 GUI launcher 文件 ──
if ($RootLauncher -eq "") { $RootLauncher = Join-Path $root '启动3CT自动版.exe' }
if ($CopyLauncher -eq "") { $CopyLauncher = Join-Path $root '3CT-Auto\启动3CT自动版.exe' }
$launchers = @()
if (Test-Path $RootLauncher) { $launchers += $RootLauncher }
if (Test-Path $CopyLauncher) { $launchers += $CopyLauncher }
if ($launchers.Count -eq 0) {
  Add-Check 'GUI launcher exe 存在' $false "root=$RootLauncher copy=$CopyLauncher 均不存在（等 cli-dev ready）"
} else {
  Add-Check 'GUI launcher exe 存在' $true ($launchers -join ' ; ')
}

# ── 2) PE subsystem + 图标 ──
foreach ($exe in $launchers) {
  $name = Split-Path $exe -Leaf
  try {
    $pe = Get-PeSubsystem $exe
    Add-Check "$name PE Subsystem == 2 (WINDOWS_GUI/无控制台)" ($pe.Subsystem -eq 2) ("subsystem=$($pe.Subsystem) pe32plus=$($pe.Pe32Plus) size=$($pe.Size)")
    $iconOk = $false; $iconDetail = ''
    try {
      Add-Type -AssemblyName System.Drawing -ErrorAction Stop
      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
      $iconOk = ($null -ne $icon)
      $iconDetail = if ($iconOk) { "icon=$($icon.Width)x$($icon.Height)" } else { 'icon=null' }
    } catch { $iconDetail = "icon 检查异常: $($_.Exception.Message)" }
    Add-Check "$name 图标可提取" $iconOk $iconDetail
  } catch {
    Add-Check "$name PE 解析/图标" $false $_.Exception.Message
  }
}

# ── 3) 源码扫描：不得通过 shell 拉起 ──
$srcPath = Join-Path $root $LauncherSource
if (-not (Test-Path $srcPath)) {
  Add-Skip '源码扫描（GuiLauncher.cs 未就绪）' "missing: $srcPath"
} else {
  $src = Get-Content $srcPath -Raw
  # 允许 UseShellExecute=false（显式禁用 shell）；只拦截真正“通过 shell 拉起”的用法
  $srcNoFlag = $src -replace 'UseShellExecute\s*=\s*false', ''
  $bad = @()
  foreach ($pat in @('cmd\.exe', 'cmd\s+/c', 'powershell', 'pwsh', 'wscript', 'cscript', 'ShellExecute', 'runas')) {
    if ($srcNoFlag -match $pat) { $bad += $pat }
  }
  Add-Check 'GuiLauncher.cs 未调用 cmd/pwsh/wscript/ShellExecute/runas' ($bad.Count -eq 0) ("命中: " + ($bad -join ', '))
  $usesProcessStart = $src -match 'ProcessStartInfo|Process\.Start|CreateProcess'
  Add-Check 'GuiLauncher.cs 使用 Process.Start/CreateProcess 直启 exe' $usesProcessStart "ProcessStart=$usesProcessStart"
  $clearsEnv = $src -match 'ELECTRON_RUN_AS_NODE'
  Add-Check 'GuiLauncher.cs 显式清理 ELECTRON_RUN_AS_NODE' $clearsEnv "clearEnv=$clearsEnv"
  $noShellFlag = $src -match 'UseShellExecute\s*=\s*false'
  Add-Check 'GuiLauncher.cs 显式 UseShellExecute=false' $noShellFlag "noShell=$noShellFlag"
}

# ── 4) 启动前动态枚举现有 3CT 进程（只读快照，不碰）──
$existing = @(Get-3ctProcesses)
$snapshot = $existing | ForEach-Object { "{0}({1})" -f $_.Name, $_.ProcessId }
if ($existing.Count -eq 0) {
  Add-Check '启动前动态枚举：无现有 3CT 进程（不会触发 guard/不会误判）' $true 'none'
} else {
  Add-Skip '启动前动态枚举：存在现有 3CT 进程（只读快照，不 kill/不重启/不新开）' ($snapshot -join ', ')
}

# ── 5) 动态 fake probe（隔离临时目录：复制 launcher + 同目录 probe 命名 3CT-Auto.exe）──
# 不要求生产任意 target 钩子：同目录/子目录放 3CT-Auto.exe，launcher 按真实 resolve 启动它；
# 因临时目录没有真实 app，无风险。active 实例前台激活项明确标「未测」（不影响无控制台交付）。
if ($SkipDynamic) {
  Add-Skip '动态 probe' '-SkipDynamic'
} elseif ($launchers.Count -eq 0) {
  Add-Skip '动态 probe' 'launcher 未就绪'
} else {
  $tmp = Join-Path $artifacts ("gui-probe-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    # 5a) 现编 probe.exe（ASCII 路径，记录 env/args/cwd 后退出），随后复制/命名为 3CT-Auto.exe
    $probeSrc = @'
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
class Probe {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  static void Main(string[] a) {
    var outPath = Environment.GetEnvironmentVariable("AUTO3CT_PROBE_OUT");
    var sb = new StringBuilder();
    sb.Append("{");
    sb.Append("\"pid\":" + Process.GetCurrentProcess().Id + ",");
    sb.Append("\"cwd\":\"" + Escape(Directory.GetCurrentDirectory()) + "\",");
    sb.Append("\"args\":[" + string.Join(",", a.Select(x => "\"" + Escape(x) + "\"")) + "],");
    sb.Append("\"consoleWindow\":" + (GetConsoleWindow() == IntPtr.Zero ? "0" : "1") + ",");
    sb.Append("\"ELECTRON_RUN_AS_NODE\":\"" + Escape(Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE")) + "\",");
    sb.Append("\"NODE_OPTIONS\":\"" + Escape(Environment.GetEnvironmentVariable("NODE_OPTIONS")) + "\",");
    sb.Append("\"NODE_PATH\":\"" + Escape(Environment.GetEnvironmentVariable("NODE_PATH")) + "\"");
    sb.Append("}");
    if (!string.IsNullOrEmpty(outPath)) File.WriteAllText(outPath, sb.ToString());
  }
  static string Escape(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }
}
'@
    $probeRaw = Join-Path $tmp 'probe-raw.exe'
    # 用 .NET Framework csc 编译（PS7 的 Add-Type 不支持 -OutputType ConsoleApplication）
    $cscCandidates = @(
      "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
      "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    )
    $csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $csc) { throw '找不到 .NET Framework csc.exe，无法编译 probe' }
    $probeSrcPath = Join-Path $tmp 'probe.cs'
    Set-Content -LiteralPath $probeSrcPath -Value $probeSrc -Encoding ASCII
    & $csc /nologo /target:exe "/out:$probeRaw" $probeSrcPath 2>&1 | Out-Null
    if (-not (Test-Path $probeRaw)) { throw "csc 编译 probe 失败: $probeRaw" }
    Add-Check 'probe 已编译（csc，临时目录）' (Test-Path $probeRaw) $probeRaw

    # 5b) 复制 GUI launcher 到临时目录；probe 放到同目录与子目录 3CT-Auto\，模拟真实 resolve
    $tmpLauncher = Join-Path $tmp (Split-Path $launchers[0] -Leaf)
    Copy-Item -LiteralPath $launchers[0] -Destination $tmpLauncher -Force
    $tmpProbeSameDir = Join-Path $tmp '3CT-Auto.exe'
    Copy-Item -LiteralPath $probeRaw -Destination $tmpProbeSameDir -Force
    Add-Check '临时目录 launcher 副本已就位' (Test-Path $tmpLauncher) $tmpLauncher

    # 5c) 污染父 env（不手动清）→ 启动临时 launcher 副本；probe 落盘环境快照
    $probeOut = Join-Path $tmp 'probe-result.json'
    $saved = @{
      ELECTRON_RUN_AS_NODE = $env:ELECTRON_RUN_AS_NODE
      NODE_OPTIONS = $env:NODE_OPTIONS
      NODE_PATH = $env:NODE_PATH
      AUTO3CT_PROBE_OUT = $env:AUTO3CT_PROBE_OUT
    }
    try {
      $env:ELECTRON_RUN_AS_NODE = '1'
      $env:NODE_OPTIONS = '--trace-warnings'
      $env:NODE_PATH = 'C:\fake-node-path'
      $env:AUTO3CT_PROBE_OUT = $probeOut
      $before = @(Get-Process cmd, powershell, pwsh, wscript, cscript -ErrorAction SilentlyContinue).Count
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $p = Start-Process -FilePath $tmpLauncher -ArgumentList @('--probe-arg-1', '--probe-arg-2') -WorkingDirectory $tmp -PassThru
      $exited = $p.WaitForExit(15000)
      $sw.Stop()
      Add-Check 'GUI launcher 启动后快速退出（无 console 阻塞）' ($exited -and $sw.ElapsedMilliseconds -lt 15000) ("exited=$exited ms=$($sw.ElapsedMilliseconds)")
      # 等 probe 落盘
      $deadline = (Get-Date).AddSeconds(10)
      while ((Get-Date) -lt $deadline -and -not (Test-Path $probeOut)) { Start-Sleep -Milliseconds 100 }
      Add-Check 'probe 已被 launcher 拉起并写出环境快照' (Test-Path $probeOut) $probeOut
      if (Test-Path $probeOut) {
        $probe = Get-Content $probeOut -Raw | ConvertFrom-Json
        Add-Check '子进程 ELECTRON_RUN_AS_NODE 已清空' ([string]::IsNullOrEmpty($probe.ELECTRON_RUN_AS_NODE)) ("=[$($probe.ELECTRON_RUN_AS_NODE)]")
        Add-Check '子进程 NODE_OPTIONS 已清空' ([string]::IsNullOrEmpty($probe.NODE_OPTIONS)) ("=[$($probe.NODE_OPTIONS)]")
        Add-Check '子进程 NODE_PATH 已清空' ([string]::IsNullOrEmpty($probe.NODE_PATH)) ("=[$($probe.NODE_PATH)]")
        Add-Check '子进程无控制台窗口（GetConsoleWindow()==0）' ([int]$probe.consoleWindow -eq 0) ("consoleWindow=$($probe.consoleWindow)")
        $argsOk = ($probe.args -contains '--probe-arg-1') -and ($probe.args -contains '--probe-arg-2')
        Add-Check '参数原样透传到子进程' $argsOk ($probe.args -join ' ')
        Add-Check '子进程工作目录为临时隔离目录（非用户 profile）' ($probe.cwd -like "$tmp*") $probe.cwd
      }
      $during = @(Get-Process cmd, powershell, pwsh, wscript, cscript -ErrorAction SilentlyContinue).Count
      Add-Check '启动窗口内无 shell 进程被拉起' ($during -le $before) "before=$before during=$during"
      Add-Skip 'active 实例前台激活（不新开）' '未测：本轮只验证无控制台+resolve/env/args/cwd；不启动真实用户副本'
    } finally {
      foreach ($k in $saved.Keys) { Set-Item -Path "Env:$k" -Value $saved[$k] -ErrorAction SilentlyContinue }
      if ((Test-Path $tmp) -and -not $env:AUTO3CT_KEEP_PROBE) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
  } catch {
    Add-Check '动态 probe 执行' $false $_.Exception.Message
  }
}

# ── 汇总 ──
$passed = @($checks | Where-Object { $_.ok -and -not $_.skipped }).Count
$failed = @($checks | Where-Object { -not $_.ok }).Count
$skipped = @($checks | Where-Object { $_.skipped }).Count
$summary = [ordered]@{
  at = (Get-Date).ToString('o')
  root = $root
  launchers = $launchers
  existingProcessesAtStart = $existing
  checks = $checks
  passed = $passed
  failed = $failed
  skipped = $skipped
  ok = ($failed -eq 0)
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8
Write-Host ""
Write-Host "结果：$passed passed / $failed failed / $skipped skipped -> $resultPath"
if ($failed -gt 0) { exit 1 } else { exit 0 }
