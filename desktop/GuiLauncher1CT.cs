using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

// 1CT 图形启动器（WinExe：双击无控制台窗口）。
//
// 与 GuiLauncher.cs（3CT 自动版）保持同样的安全边界，只换目标与提示文案：
// 1. 定位真实 Electron 主程序：同目录 1CT.exe 或兄弟目录 1CT\1CT.exe；
// 2. 直接 Process.Start 启动它（UseShellExecute=false / CreateNoWindow=true），
//    仅对子进程清除 ELECTRON_RUN_AS_NODE / NODE_OPTIONS / NODE_PATH；
// 3. 1CT 已在运行时按 resolved 全路径匹配只激活其主窗口，不重复启动；
// 4. **独立 userData（默认）**：1CT 使用 %APPDATA%\1CT（由 bootstrap-1ct.cjs 设置），
//    有自己的单实例锁，因此**可以与 3CT / 3CT-Auto 同时运行**。
//    只有加了 `--shared-user-data`（或环境变量 CT_SHARE_USER_DATA=1）才回到
//    共用 userData 的旧模式，那时才会提示先退出 3CT / 3CT-Auto。
//    本启动器绝不 kill / 结束任何已有进程，也不修改主程序 exe 或 app.asar。
//
// 不调用任何命令行解释器或脚本宿主，不修改环境变量，不读取用户 profile。
// 测试钩子（普通用户不会用到）：`--diagnose <json路径>` 只解析并写 JSON，不启动/不弹框。
internal static class GuiLauncher
{
    private const string TargetName = "1CT.exe";
    private const string CopyDirName = "1CT";
    private const string Title = "1CT";
    private const string SharedUserDataFlag = "--shared-user-data";
    private const string SharedUserDataEnv = "CT_SHARE_USER_DATA";
    private const int SW_RESTORE = 9;

    private static readonly string[] NodeEnv =
    {
        "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH",
    };

    //: 仅在共用 userData 模式下，这些进程会与 1CT 抢同一把单实例锁。
    private static readonly string[] ConflictingProcessNames =
    {
        "3CT", "3CT-Auto",
    };

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [STAThread]
    private static int Main(string[] args)
    {
        bool diagnose = args.Length > 0 && args[0] == "--diagnose";
        string diagnosePath = diagnose && args.Length > 1 ? args[1] : null;
        var forward = new List<string>();
        for (int i = diagnose ? (diagnosePath == null ? 1 : 2) : 0; i < args.Length; i++)
        {
            forward.Add(args[i]);
        }
        try
        {
            return Run(diagnose, diagnosePath, forward);
        }
        catch (Exception ex)
        {
            if (diagnose)
            {
                TryWrite(diagnosePath, "{\"error\":" + Json(ex.Message) + "}");
                return 1;
            }
            MessageBox.Show("启动失败：" + ex.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static int Run(bool diagnose, string diagnosePath, List<string> forward)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string target = ResolveTarget(baseDir);
        bool exists = File.Exists(target);
        string workDir = exists ? Path.GetDirectoryName(target) : Path.Combine(baseDir, CopyDirName);
        string arguments = JoinQuoted(forward);

        // 独立 userData（默认）时，3CT / 3CT-Auto 在跑也不冲突，不去检测它们。
        bool sharedUserData = WantsSharedUserData(forward);
        List<string> conflicting = sharedUserData ? FindConflictingProcesses() : new List<string>();
        Process runningCopy = exists ? FindRunningCopy(target) : null;

        if (diagnose)
        {
            TryWrite(diagnosePath, DiagnoseJson(target, exists, workDir, arguments, forward, conflicting, runningCopy != null, sharedUserData));
            return 0;
        }
        if (!exists)
        {
            MessageBox.Show(
                "找不到主程序：\n" + target + "\n\n请先在仓库根目录运行：\npython desktop\\install_1ct.py build\n" +
                "（若只缺启动器，再运行：python desktop\\build_gui_launcher.py --brand 1ct）",
                Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        if (runningCopy != null)
        {
            try
            {
                Activate(runningCopy);
            }
            finally
            {
                runningCopy.Dispose();
            }
            return 0;
        }
        if (conflicting.Count > 0)
        {
            MessageBox.Show(
                "检测到 " + string.Join(" / ", conflicting.ToArray()) + " 正在运行。\n\n" +
                "当前是 --shared-user-data（共用用户数据）模式：1CT 与 3CT / 3CT 自动版\n" +
                "共享同一 userData（%APPDATA%\\3CT）和单实例锁，无法同时运行。\n" +
                "请先完全退出正在运行的程序（含托盘图标右键退出），再双击本程序；\n" +
                "或去掉 --shared-user-data 使用默认的独立用户数据模式（%APPDATA%\\1CT，可同时运行）。\n\n" +
                "本启动器不会结束或修改任何已有的 3CT / 3CT-Auto 进程。",
                Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }
        StartTarget(target, workDir, arguments);
        return 0;
    }

    /// <summary>是否要求与 3CT 共用 userData（命令行开关优先，其次环境变量）。</summary>
    private static bool WantsSharedUserData(List<string> forward)
    {
        foreach (string argument in forward)
        {
            if (string.Equals(argument, SharedUserDataFlag, StringComparison.OrdinalIgnoreCase)
                || string.Equals(argument, SharedUserDataFlag + "=true", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        string env = null;
        try
        {
            env = Environment.GetEnvironmentVariable(SharedUserDataEnv);
        }
        catch
        {
            env = null;
        }
        return env != null && env.Trim() == "1";
    }

    private static string ResolveTarget(string baseDir)
    {
        string sibling = Path.Combine(baseDir, CopyDirName, TargetName);
        if (File.Exists(sibling))
        {
            return Path.GetFullPath(sibling);
        }
        string sameDir = Path.Combine(baseDir, TargetName);
        if (File.Exists(sameDir))
        {
            return Path.GetFullPath(sameDir);
        }
        return Path.GetFullPath(sibling);
    }

    /// <summary>返回正在运行的、与 1CT 共享 userData 的其它版本进程名（不杀进程）。</summary>
    private static List<string> FindConflictingProcesses()
    {
        var names = new List<string>();
        foreach (string name in ConflictingProcessNames)
        {
            Process[] processes = null;
            try
            {
                processes = Process.GetProcessesByName(name);
            }
            catch
            {
                continue;
            }
            try
            {
                if (processes.Length > 0)
                {
                    names.Add(name + ".exe");
                }
            }
            finally
            {
                foreach (Process process in processes)
                {
                    process.Dispose();
                }
            }
        }
        return names;
    }

    /// <summary>
    /// 按 resolved 全路径匹配正在运行的 1CT（不读 userData）。
    /// Electron 的 renderer/GPU/utility 子进程也是同一路径且 MainWindowHandle=0，
    /// 因此优先返回有主窗口的进程；没有窗口时回退到第一个匹配进程（激活为空操作）。
    /// </summary>
    private static Process FindRunningCopy(string target)
    {
        string normalized = Path.GetFullPath(target);
        Process fallback = null;
        foreach (Process candidate in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(TargetName)))
        {
            string path = null;
            try
            {
                path = candidate.MainModule == null ? null : candidate.MainModule.FileName;
            }
            catch
            {
                path = null;
            }
            if (path == null || !string.Equals(Path.GetFullPath(path), normalized, StringComparison.OrdinalIgnoreCase))
            {
                candidate.Dispose();
                continue;
            }
            if (candidate.MainWindowHandle != IntPtr.Zero)
            {
                if (fallback != null)
                {
                    fallback.Dispose();
                }
                return candidate;
            }
            if (fallback == null)
            {
                fallback = candidate;
            }
            else
            {
                candidate.Dispose();
            }
        }
        return fallback;
    }

    private static void Activate(Process process)
    {
        try
        {
            IntPtr handle = process.MainWindowHandle;
            if (handle != IntPtr.Zero)
            {
                ShowWindow(handle, SW_RESTORE);
                SetForegroundWindow(handle);
            }
        }
        catch
        {
            // 激活失败只忽略，绝不 kill/重启。
        }
    }

    private static void StartTarget(string target, string workDir, string arguments)
    {
        var info = new ProcessStartInfo
        {
            FileName = target,
            Arguments = arguments,
            WorkingDirectory = workDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (string name in NodeEnv)
        {
            info.EnvironmentVariables.Remove(name);
        }
        Process.Start(info);
    }

    /// <summary>Windows 命令行引用规则（与 CLR/CreateProcess 解析一致）。</summary>
    private static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return argument;
        }
        var builder = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\')
            {
                slashes++;
            }
            else if (c == '"')
            {
                builder.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
            }
            else
            {
                builder.Append('\\', slashes).Append(c);
                slashes = 0;
            }
        }
        return builder.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static string JoinQuoted(List<string> arguments)
    {
        var builder = new StringBuilder();
        for (int i = 0; i < arguments.Count; i++)
        {
            if (i > 0) builder.Append(' ');
            builder.Append(Quote(arguments[i]));
        }
        return builder.ToString();
    }

    private static string DiagnoseJson(
        string target,
        bool exists,
        string workDir,
        string arguments,
        List<string> forward,
        List<string> conflicting,
        bool copyRunning,
        bool sharedUserData)
    {
        var builder = new StringBuilder("{");
        builder.Append("\"exe\":").Append(Json(target)).Append(',');
        builder.Append("\"exeExists\":").Append(exists ? "true" : "false").Append(',');
        builder.Append("\"workingDirectory\":").Append(Json(workDir)).Append(',');
        builder.Append("\"argsCommandLine\":").Append(Json(arguments)).Append(',');
        builder.Append("\"forwardedArgs\":[");
        for (int i = 0; i < forward.Count; i++)
        {
            if (i > 0) builder.Append(',');
            builder.Append(Json(forward[i]));
        }
        builder.Append("],");
        builder.Append("\"sharedUserData\":").Append(sharedUserData ? "true" : "false").Append(',');
        builder.Append("\"userDataMode\":").Append(Json(sharedUserData ? "shared" : "independent")).Append(',');
        builder.Append("\"copyRunning\":").Append(copyRunning ? "true" : "false").Append(',');
        builder.Append("\"conflictingProcesses\":[");
        for (int i = 0; i < conflicting.Count; i++)
        {
            if (i > 0) builder.Append(',');
            builder.Append(Json(conflicting[i]));
        }
        builder.Append("],");
        builder.Append("\"envToClear\":[");
        for (int i = 0; i < NodeEnv.Length; i++)
        {
            if (i > 0) builder.Append(',');
            builder.Append(Json(NodeEnv[i]));
        }
        builder.Append("]}");
        return builder.ToString();
    }

    private static string Json(string value)
    {
        if (value == null)
        {
            return "null";
        }
        var builder = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '\\') builder.Append("\\\\");
            else if (c == '"') builder.Append("\\\"");
            else if (c == '\n') builder.Append("\\n");
            else if (c == '\r') builder.Append("\\r");
            else if (c == '\t') builder.Append("\\t");
            else if (c < ' ') builder.Append("\\u").Append(((int)c).ToString("x4"));
            else builder.Append(c);
        }
        return builder.Append('"').ToString();
    }

    private static void TryWrite(string path, string json)
    {
        if (string.IsNullOrEmpty(path))
        {
            return;
        }
        try
        {
            File.WriteAllText(path, json, new UTF8Encoding(false));
        }
        catch
        {
            // 诊断输出失败不弹框，避免自动化验收卡住。
        }
    }
}
