using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

// 升级1CT.exe —— 单文件双击升级器（WinExe：双击没有控制台窗口）。
//
// 用户诉求：「有没有那种双击就能升级的，而不是再解压覆盖目录感觉这样好麻烦」，
// 以及「只发一个 exe 给别人，双击就行吗？它会自动找到原来的 1CT 目录吗？」。
// 所以这个 exe **自带**新版 resources\app.asar（编译时 /resource: 内嵌），双击即完成：
//
//   定位 1CT 目录 → 关掉 1CT（含托盘）→ 备份旧 app.asar → 覆盖 → 校验 → 重启 1CT
//
// 定位链（把 exe 发给别人、随便放哪都能找到原来的 1CT；每一步都写进 upgrade.log，
// 最终结果写进 UPGRADE-PLAN 的 locate= 字段）：
//   arg     --target 指定（最高优先级，指定了就不走 S1–S6）
//   self    S1 升级器自身所在目录就是安装根（有 1CT.exe + resources\app.asar）
//   sibling S2 自身目录下的 1CT\ 子目录
//   logs    S3 %APPDATA%\1CT\logs\*.log 里的 Electron 栈帧（…\1CT\resources\app.asar\…）
//   scan    S4 常见位置有界扫描（限深 ≤2、限时 4s；跳过 %APPDATA% / 系统目录 / 回收站）
//   list    S5 候选列表对话框里用户点「立即升级这个」的那个
//   dialog  S6 用户自己用文件夹选择框选的目录
// 多候选且无法交互（--silent / --dry-run）→ 退出码 6，绝不静默挑一个。
//
// 硬边界（改代码前请先读）：
// 1. 只改 1CT 目录里的 resources\app.asar、VERSION-1CT.txt、.1ct-install.json，
//    以及新建 .backup\<时间戳>\；**绝不**碰 %APPDATA%\1CT（用户数据、成员、照片）。
//    目标目录若落在 %APPDATA%\1CT 内，直接拒绝（见 IsInsideUserData）。
// 2. 目标必须同时有 1CT.exe 与 resources\app.asar，否则报错退出，不乱写别人的目录。
// 3. 覆盖前一定先备份；覆盖后重新算 sha256，不一致就自动回滚（把备份复制回去）。
// 4. 幂等：目标 asar 的 sha256 已等于内嵌 payload → 不覆盖、不重启。
// 5. 关进程只按镜像名 taskkill /IM 1CT.exe，绝不按路径猜测去杀别的程序；
//    本进程镜像名是「升级1CT」，不会被自己杀掉；「启动1CT.exe」也不在名单里。
//
// 命令行（测试与静默升级用；普通用户双击不需要任何参数）：
//   --target <dir>   指定 1CT 目录（最高优先级：跳过自动定位与文件夹选择框）
//   --silent         不弹任何对话框，用退出码表达结果
//   --no-launch      升级成功后不自动重启 1CT
//   --no-kill        不结束正在运行的 1CT（文件被占用时写失败 → 走回滚）
//   --dry-run        只把计划打到 stdout/日志，不改任何文件（隐含不弹框）
//   --no-scan        跳过 S3 日志线索与 S4 有界扫描（只做 S1/S2/S6，排错与测试用）
//   --log-dir <dir>  覆盖「日志线索」的扫描目录（默认 %APPDATA%\1CT\logs；测试注入用）
//   --scan-root <dir> 覆盖「有界扫描」的根目录，可重复（默认按 S4 的常见位置；测试注入用）
//
// 退出码：0 成功（或 GUI 模式的“已是最新”）/ 2 已是最新（--silent）/ 3 目标不合法 /
//         4 写失败（已回滚或目标未被改动）/ 5 用户取消 /
//         6 找到多个 1CT 且无法交互（需要人工选择，什么都没改）/ 1 其它异常。
//
// 机器可读标记（stdout，纯 ASCII，避免中文 Windows 管道编码问题）：
//   UPGRADE-PLAN v1 / target= / locate= / backup_dir= / old_sha256= / new_sha256= /
//   new_size= / already_latest=yes|no
//   candidate=<n>=<dir>（仅多候选、退出码 6 时）
//   UPGRADE-RESULT status=success|already-latest|invalid-target|write-failed|
//                  dry-run|cancelled|need-selection|error exit=<n>
internal static class Updater1CT
{
    private const string UpdaterName = "升级1CT.exe";
    private const string TargetExeName = "1CT.exe";
    private const string ResourcesDirName = "resources";
    private const string AsarName = "app.asar";
    private const string VersionFileName = "VERSION-1CT.txt";
    private const string InstallMarkerName = ".1ct-install.json";
    private const string BackupDirName = ".backup";
    private const string LogFileName = "upgrade.log";
    private const string MarkerOwner = "升级1CT.exe";
    private const string Title = "1CT 升级";
    private const int KillTimeoutMs = 15000;
    private const int KillForceTimeoutMs = 5000;

    //: S3 只读日志尾部这么多字节（大日志也不拖慢启动）。
    private const int LogTailBytes = 256 * 1024;
    //: S4 扫描的总时间预算（毫秒）；超过就带着已找到的候选收工。
    private const int ScanBudgetMs = 4000;
    //: S4 最多访问多少个目录（防极端目录树）。
    private const int ScanMaxDirs = 40000;
    //: 默认扫描根（桌面/下载/文档/用户目录/盘根/Program Files）的深度上限。
    private const int ScanDefaultDepth = 2;
    //: 显式 --scan-root 时的深度上限（给测试/排错多留一层）。
    private const int ScanExplicitDepth = 3;

    private const int ExitOk = 0;
    private const int ExitError = 1;
    private const int ExitAlreadyLatest = 2;
    private const int ExitInvalidTarget = 3;
    private const int ExitWriteFailed = 4;
    private const int ExitCancelled = 5;
    //: 找到多个合法 1CT、又没有交互能力（--silent / --dry-run）：需要人工选择。
    private const int ExitNeedSelection = 6;

    [STAThread]
    private static int Main(string[] args)
    {
        Options options = null;
        try
        {
            options = Options.Parse(args);
        }
        catch (Exception ex)
        {
            Out("UPGRADE-RESULT status=invalid-args exit=" + ExitError);
            ShowDialog(true, "参数错误：" + ex.Message + "\n\n" + UsageText(), MessageBoxIcon.Error);
            return ExitError;
        }

        try
        {
            return Run(options);
        }
        catch (Exception ex)
        {
            Out("UPGRADE-RESULT status=error exit=" + ExitError + " detail=" + OneLine(ex.Message));
            ShowDialog(
                options.Silent || options.DryRun,
                "升级失败：" + ex.Message + "\n\n如果 1CT 打不开，可把 .backup\\<时间戳>\\app.asar\n复制回 resources\\app.asar 恢复旧版本。",
                MessageBoxIcon.Error);
            return ExitError;
        }
    }

    // ================= 主流程 =================

    private static int Run(Options options)
    {
        bool quiet = options.Silent || options.DryRun;
        var log = new UpgradeLog();

        Payload payload = Payload.Load();
        string newSha = payload.AsarSha256;
        if (payload.DeclaredSha256 != null
            && !string.Equals(payload.DeclaredSha256, newSha, StringComparison.OrdinalIgnoreCase))
        {
            // 声明与内嵌字节不一致 = 坏包 / 串包（下载损坏、构建时资源错配）。
            // 升级会覆盖用户的程序本体，这里必须硬失败且不写盘：
            // 「按实际字节继续」等于把一份来路不明的 asar 装给用户，事后无法察觉。
            log.Path = TempLogPath("payload-mismatch");
            log.Append("payload.json 声明 asarSha256 = " + payload.DeclaredSha256);
            log.Append("内嵌 asar 实际 sha256 = " + newSha);
            log.Append("两者不一致，拒绝升级（未写任何文件）");
            Out("payload-declared=" + payload.DeclaredSha256);
            Out("payload-actual=" + newSha);
            return Finish(
                options, log, ExitInvalidTarget, "payload-mismatch", "升级包损坏，已停止",
                "这个 " + UpdaterName + " 内嵌的 app.asar 与它声明的 sha256 不一致，"
                + "通常是下载/复制过程中损坏，或构建时资源错配。\n\n"
                + "声明 sha256: " + payload.DeclaredSha256 + "\n"
                + "实际 sha256: " + newSha + "\n\n"
                + "已停止，没有改动你的 1CT 任何文件。请重新获取升级包。");
        }

        LocateResult located = ResolveTarget(options, quiet, log);
        if (located.Cancelled)
        {
            log.Path = TempLogPath("cancelled");
            log.Append("用户取消了目标选择");
            return Finish(options, log, ExitCancelled, "cancelled", "已取消升级", "没有做任何修改。");
        }
        if (located.NeedsSelection)
        {
            // 找到多个 1CT、又不能交互：明确报错，绝不静默挑一个。
            log.Path = TempLogPath("need-selection");
            log.Append("找到 " + located.Candidates.Count + " 个 1CT 安装目录，非交互模式无法选择");
            log.Flush();
            for (int i = 0; i < located.Candidates.Count; i++)
            {
                Out("candidate=" + (i + 1) + "=" + located.Candidates[i]);
            }
            Out("UPGRADE-RESULT status=need-selection exit=" + ExitNeedSelection);
            ShowDialog(
                quiet,
                "找到多个 1CT 安装目录，需要你选一个：\n\n"
                + string.Join("\n", located.Candidates.ToArray())
                + "\n\n双击运行时会弹出候选列表；命令行请加 --target <目录>。",
                MessageBoxIcon.Warning);
            return ExitNeedSelection;
        }
        if (located.Dir == null)
        {
            log.Path = TempLogPath("invalid-target");
            log.Append("没有定位到 1CT 目录（S1/S2/S3/S4 全部未命中）");
            Out("locate=none");
            return Finish(
                options, log, ExitInvalidTarget, "invalid-target", "找不到 1CT 目录",
                "需要同时存在 1CT.exe 与 resources\\app.asar 的目录。\n\n"
                + "已经自动找过：exe 所在目录、它下面的 1CT\\ 子目录、"
                + "%APPDATA%\\1CT\\logs 里的日志线索、桌面/下载/文档/Program Files 等常见位置。\n\n"
                + "请用 --target <目录> 指定，或把 " + UpdaterName + " 放进 1CT 目录再双击。");
        }

        string targetDir = located.Dir;
        string locateStep = located.Step ?? "none";
        log.Append("定位结果: locate=" + locateStep + " → " + targetDir);
        // 真实升级（非 --dry-run）不打印整份计划，但 locate= 与 target= 一定要有：
        // 日志和命令行都要能看出这次是链条哪一步、找到了哪个目录。
        Out("locate=" + locateStep);
        Out("target=" + targetDir);

        string targetExe = Path.Combine(targetDir, TargetExeName);
        string targetAsar = Path.Combine(targetDir, ResourcesDirName, AsarName);

        if (IsInsideUserData(targetDir))
        {
            log.Path = TempLogPath("invalid-target");
            log.Append("拒绝升级用户数据目录: " + targetDir);
            return Finish(
                options, log, ExitInvalidTarget, "invalid-target", "目标目录是用户数据目录",
                "这个目录放的是 1CT 的用户数据（成员、配置、执行历史），升级不会碰它。\n"
                + "请选择包含 1CT.exe 与 resources\\app.asar 的程序目录。");
        }

        var missing = new List<string>();
        if (!Directory.Exists(targetDir)) missing.Add("目录不存在: " + targetDir);
        if (!File.Exists(targetExe)) missing.Add("缺少 " + TargetExeName);
        if (!File.Exists(targetAsar)) missing.Add("缺少 " + ResourcesDirName + "\\" + AsarName);
        if (missing.Count > 0)
        {
            log.Path = TempLogPath("invalid-target");
            log.Append("目标不合法: " + string.Join("; ", missing.ToArray()));
            return Finish(
                options, log, ExitInvalidTarget, "invalid-target", "目标目录不合法",
                string.Join("\n", missing.ToArray()) + "\n\n目录: " + targetDir
                + "\n\n没有写入任何文件。");
        }

        string oldSha = Sha256File(targetAsar);
        bool alreadyLatest = string.Equals(oldSha, newSha, StringComparison.OrdinalIgnoreCase);
        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        string backupDir = Path.Combine(Path.Combine(targetDir, BackupDirName), stamp);
        string backupAsar = Path.Combine(backupDir, AsarName);

        string plan = string.Join("\n", new string[]
        {
            "UPGRADE-PLAN v1",
            "target=" + targetDir,
            "locate=" + locateStep,
            "target_exe=" + targetExe,
            "target_asar=" + targetAsar,
            "backup_dir=" + backupDir,
            "old_sha256=" + oldSha,
            "new_sha256=" + newSha,
            "new_size=" + payload.AsarBytes.Length.ToString(CultureInfo.InvariantCulture),
            "version_line=" + OneLine(payload.VersionLine),
            "already_latest=" + (alreadyLatest ? "yes" : "no"),
            "kill=" + (options.NoKill ? "skip" : "taskkill /IM " + TargetExeName),
            "launch=" + (options.NoLaunch ? "skip" : targetExe),
            "dry_run=" + (options.DryRun ? "yes" : "no"),
        });

        if (options.DryRun)
        {
            // 只输出计划：不建目录、不写目标目录里的任何文件（日志放 %TEMP%）。
            Out(plan);
            log.Path = TempLogPath("dry-run");
            log.Append("dry-run: 只输出计划，未改动任何文件");
            foreach (string line in plan.Split('\n'))
            {
                log.Append("  " + line);
            }
            log.Flush();
            Out("dry_run_log=" + log.Path);
            Out("UPGRADE-RESULT status=dry-run exit=" + ExitOk);
            return ExitOk;
        }

        if (alreadyLatest)
        {
            log.Path = TempLogPath("already-latest");
            log.Append("目标 app.asar 已是最新，未做任何修改");
            log.Append("old_sha256=" + oldSha);
            log.Append("new_sha256=" + newSha);
            log.Flush();
            Out("UPGRADE-RESULT status=already-latest exit="
                + (options.Silent ? ExitAlreadyLatest : ExitOk));
            ShowDialog(
                quiet,
                "已经是最新版本，无需升级。\n\n当前 app.asar 与新版本完全一致：\n" + oldSha
                + "\n\n本次没有覆盖任何文件，也没有重启 1CT。",
                MessageBoxIcon.Information);
            return options.Silent ? ExitAlreadyLatest : ExitOk;
        }

        // ---- 真正的升级：从这里开始会在目标目录里写东西 ----
        log.Path = Path.Combine(backupDir, LogFileName);
        log.Append("== 升级开始 ==");
        log.Append("目标目录: " + targetDir);
        log.Append("旧 asar sha256: " + oldSha);
        log.Append("新 asar sha256: " + newSha);
        log.Append("新 asar 字节数: " + payload.AsarBytes.Length.ToString(CultureInfo.InvariantCulture));
        log.Append("版本: " + OneLine(payload.VersionLine));

        // 1) 关掉 1CT（含托盘）。只按镜像名，不动 启动1CT.exe，也不会杀到自己。
        if (options.NoKill)
        {
            log.Append("跳过关闭 1CT（--no-kill）");
        }
        else
        {
            log.Append(CloseTarget());
        }

        // 2) 备份旧 asar（先备份，才有回滚的底气）。
        try
        {
            Directory.CreateDirectory(backupDir);
            File.Copy(targetAsar, backupAsar, true);
            string backupSha = Sha256File(backupAsar);
            if (!string.Equals(backupSha, oldSha, StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException("备份校验失败：备份 sha256=" + backupSha + "，期望 " + oldSha);
            }
            log.Append("备份完成: " + backupAsar);
            log.Append("备份 sha256: " + backupSha);
        }
        catch (Exception ex)
        {
            log.Append("备份失败: " + ex.GetType().Name + ": " + ex.Message);
            return Finish(
                options, log, ExitWriteFailed, "write-failed", "备份失败，没有改动任何文件",
                "无法把旧 app.asar 复制到：\n" + backupAsar + "\n\n原因：" + ex.Message
                + "\n\n请先完全退出 1CT（含托盘图标）再重试。");
        }

        // 3) 写临时文件 → 原子替换 → 校验 sha256。
        try
        {
            AtomicWrite(targetAsar, payload.AsarBytes, log.Append);
            log.Append("替换完成: " + targetAsar);
        }
        catch (Exception ex)
        {
            log.Append("写入失败: " + ex.GetType().Name + ": " + ex.Message);
            return FailWithRollback(
                options, log, backupAsar, targetAsar, oldSha,
                "覆盖 app.asar 失败", ex.Message);
        }

        string afterSha = Sha256File(targetAsar);
        if (!string.Equals(afterSha, newSha, StringComparison.OrdinalIgnoreCase))
        {
            log.Append("校验失败: 替换后 sha256=" + afterSha + "，期望 " + newSha);
            return FailWithRollback(
                options, log, backupAsar, targetAsar, oldSha,
                "替换后校验失败", "写入后的 app.asar 与新版本不一致（sha256 " + afterSha + "）。");
        }
        log.Append("校验通过: " + afterSha);

        // 4) 顺带更新版本说明与构建标记（fail-soft：失败只记日志，不影响升级结果）。
        WriteVersionFile(targetDir, payload.VersionLine, newSha, backupDir, log);
        UpdateInstallMarker(targetDir, newSha, log);

        // 5) 重启 1CT。
        string launchNote;
        if (options.NoLaunch)
        {
            launchNote = "已跳过自动启动（--no-launch）。";
            log.Append("跳过启动 1CT（--no-launch）");
        }
        else
        {
            try
            {
                StartTarget(targetExe, targetDir);
                launchNote = "1CT 已重新启动。";
                log.Append("已重新启动 1CT: " + targetExe);
            }
            catch (Exception ex)
            {
                launchNote = "自动启动失败，请手动双击 1CT.exe 启动。";
                log.Append("启动失败: " + ex.GetType().Name + ": " + ex.Message);
            }
        }

        log.Append("== 升级成功 ==");
        return Finish(
            options, log, ExitOk, "success", "升级完成",
            "目标目录: " + targetDir
            + "\n新版本: " + OneLine(payload.VersionLine)
            + "\n新 asar sha256: " + newSha
            + "\n\n旧版本已备份到:\n" + backupAsar
            + "\n（出问题就把这份 app.asar 复制回 resources\\app.asar）"
            + "\n\n用户数据 %APPDATA%\\1CT 未被改动。\n" + launchNote);
    }

    /// <summary>写失败/校验失败时的统一出口：目标仍是旧字节就不动它，否则复制备份回去。</summary>
    private static int FailWithRollback(
        Options options,
        UpgradeLog log,
        string backupAsar,
        string targetAsar,
        string oldSha,
        string headline,
        string detail)
    {
        string currentSha = null;
        try
        {
            currentSha = File.Exists(targetAsar) ? Sha256File(targetAsar) : null;
        }
        catch (Exception ex)
        {
            log.Append("读取目标状态失败: " + ex.Message);
        }

        string rollbackNote;
        if (currentSha != null && string.Equals(currentSha, oldSha, StringComparison.OrdinalIgnoreCase))
        {
            rollbackNote = "目标 app.asar 仍是旧版本（未被改动），无需回滚。";
            log.Append("目标未被改动（sha256=" + currentSha + "），跳过回滚写入");
        }
        else
        {
            bool restored = Rollback(backupAsar, targetAsar, log.Append);
            rollbackNote = restored
                ? "已自动回滚：旧版本已复制回 resources\\app.asar。"
                : "回滚写入失败，请手动把 " + backupAsar + " 复制回 resources\\app.asar。";
        }

        return Finish(
            options, log, ExitWriteFailed, "write-failed", headline,
            detail + "\n\n" + rollbackNote + "\n\n备份: " + backupAsar);
    }

    // ================= 定位 / 关进程 / 写文件 =================

    // ================= 定位（S0–S6） =================

    /// <summary>定位结果：选定的目录 + 命中的是链条哪一步（写进 locate= 与日志）。</summary>
    private sealed class LocateResult
    {
        public string Dir;
        public string Step;
        public bool Cancelled;
        public bool NeedsSelection;
        public List<string> Candidates = new List<string>();
    }

    /// <summary>
    /// 定位 1CT 安装根：--target → S1 自身目录 → S2 自身目录\1CT →
    /// S3 日志线索 → S4 有界扫描 → S5 候选列表 / S6 文件夹选择框。
    /// </summary>
    private static LocateResult ResolveTarget(Options options, bool quiet, UpgradeLog log)
    {
        var result = new LocateResult();

        // ---- S0: --target 最高优先级（指定了就不走 S1–S6）----
        if (!string.IsNullOrEmpty(options.Target))
        {
            string explicitDir;
            try
            {
                explicitDir = Path.GetFullPath(options.Target);
            }
            catch (Exception ex)
            {
                throw new ArgumentException("--target 路径不合法: " + ex.Message);
            }
            result.Dir = explicitDir;
            result.Step = "arg";
            log.Append("定位 S0: 使用 --target 指定的目录 → " + explicitDir);
            return result;
        }

        string baseDir = SafeFullPath(AppDomain.CurrentDomain.BaseDirectory);

        // ---- S1: 升级器自身所在目录 ----
        if (IsInstallRoot(baseDir))
        {
            result.Dir = baseDir;
            result.Step = "self";
            log.Append("定位 S1: 升级器自身目录就是 1CT 安装根 → " + baseDir);
            return result;
        }
        log.Append("定位 S1: 自身目录不是安装根（缺 1CT.exe 或 resources\\app.asar）: "
            + (baseDir ?? "(未知)"));

        // ---- S2: 自身目录下的 1CT\ ----
        string sibling = baseDir == null ? null : Path.Combine(baseDir, "1CT");
        if (IsInstallRoot(sibling))
        {
            result.Dir = sibling;
            result.Step = "sibling";
            log.Append("定位 S2: 自身目录下的 1CT\\ 是安装根 → " + sibling);
            return result;
        }
        log.Append("定位 S2: 自身目录下没有合法的 1CT\\: " + (sibling ?? "(未知)"));

        if (options.NoScan)
        {
            log.Append("定位 S3/S4: 已用 --no-scan 跳过日志线索与有界扫描");
            return FallbackToManualPick(result, quiet, log);
        }

        // ---- S3: 日志线索 ----
        List<string> candidates = CollectLogCandidates(options, log);
        if (candidates.Count == 1)
        {
            result.Dir = candidates[0];
            result.Step = "logs";
            log.Append("定位 S3: 日志线索唯一命中 → " + candidates[0]);
            return result;
        }
        if (candidates.Count > 1)
        {
            return ChooseAmongCandidates(candidates, result, quiet, log, "S3 日志线索");
        }

        // ---- S4: 有界扫描 ----
        candidates = ScanForInstalls(options, log);
        if (candidates.Count == 1)
        {
            result.Dir = candidates[0];
            result.Step = "scan";
            log.Append("定位 S4: 有界扫描唯一命中 → " + candidates[0]);
            return result;
        }
        if (candidates.Count > 1)
        {
            return ChooseAmongCandidates(candidates, result, quiet, log, "S4 有界扫描");
        }

        // ---- S6: 一个都没有 ----
        return FallbackToManualPick(result, quiet, log);
    }

    /// <summary>S5：多候选 → 候选列表对话框（无交互能力时用退出码 6 明确报错）。</summary>
    private static LocateResult ChooseAmongCandidates(
        List<string> candidates, LocateResult result, bool quiet, UpgradeLog log, string origin)
    {
        result.Candidates = candidates;
        log.Append("定位 S5: " + origin + " 找到 " + candidates.Count
            + " 个合法候选，需要人工选择（不静默挑）:");
        for (int i = 0; i < candidates.Count; i++)
        {
            log.Append("  候选 " + (i + 1) + ": " + candidates[i]);
        }

        if (quiet)
        {
            result.NeedsSelection = true;
            log.Append("定位 S5: --silent/--dry-run 无法交互 → 退出码 " + ExitNeedSelection);
            return result;
        }

        string picked = ShowCandidateDialog(candidates, log);
        if (string.IsNullOrEmpty(picked))
        {
            result.Cancelled = true;
            log.Append("定位 S5: 用户在候选列表里取消");
            return result;
        }
        result.Dir = picked;
        // 候选列表里点的是合法安装根 → list；用「自己选文件夹」选的 → dialog（后面统一校验）。
        result.Step = IsInstallRoot(picked) ? "list" : "dialog";
        log.Append("定位 S5: 用户选定 → " + picked + "（locate=" + result.Step + "）");
        return result;
    }

    /// <summary>S6：一个候选都没有 → 文件夹选择框；无交互能力就直接交给调用方报 3。</summary>
    private static LocateResult FallbackToManualPick(LocateResult result, bool quiet, UpgradeLog log)
    {
        if (quiet)
        {
            log.Append("定位 S6: 没有找到 1CT（--silent/--dry-run 不弹选择框）");
            return result;
        }
        log.Append("定位 S6: 一个候选都没有，弹文件夹选择框让用户指定");
        string picked = AskForFolder(log);
        if (string.IsNullOrEmpty(picked))
        {
            result.Cancelled = true;
            log.Append("定位 S6: 用户在文件夹选择框里取消");
            return result;
        }
        result.Dir = picked;
        result.Step = "dialog";
        log.Append("定位 S6: 用户选定 → " + picked);
        return result;
    }

    /// <summary>S6 的文件夹选择框；无桌面会话时返回 null（按「找不到目标」处理，不崩）。</summary>
    private static string AskForFolder(UpgradeLog log)
    {
        try
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = FolderPrompt();
                dialog.ShowNewFolderButton = false;
                if (dialog.ShowDialog() != DialogResult.OK) return null;
                return SafeFullPath(dialog.SelectedPath);
            }
        }
        catch (Exception ex)
        {
            Out("dialog_error=" + OneLine(ex.Message));
            log.Append("定位 S6: 弹不出文件夹选择框（可能没有桌面会话）: "
                + ex.GetType().Name + ": " + ex.Message);
            return null;
        }
    }

    private static string FolderPrompt()
    {
        string home = SafeFolder(Environment.SpecialFolder.UserProfile);
        string example = string.IsNullOrEmpty(home)
            ? "…\\1CT"
            : Path.Combine(home, "Desktop", "1CT");
        var builder = new StringBuilder();
        builder.Append("找不到 1CT：请选择 1CT 文件夹（里面有 1CT.exe 和 resources），例如 ")
            .Append(example);
        if (UserDataDirExists())
        {
            builder.Append("  看起来你以前运行过 1CT（%APPDATA%\\1CT 存在），选它所在的文件夹即可。");
        }
        return builder.ToString();
    }

    private static bool UserDataDirExists()
    {
        try
        {
            string appData = SafeFolder(Environment.SpecialFolder.ApplicationData);
            return !string.IsNullOrEmpty(appData) && Directory.Exists(Path.Combine(appData, "1CT"));
        }
        catch
        {
            return false;
        }
    }

    /// <summary>S5 的候选列表：每项一个「立即升级这个」按钮 + 「自己选文件夹」+「取消」。</summary>
    private static string ShowCandidateDialog(List<string> candidates, UpgradeLog log)
    {
        try
        {
            using (var form = new Form())
            {
                form.Text = Title + "：找到多个 1CT，请选择要升级的那个";
                form.StartPosition = FormStartPosition.CenterScreen;
                form.ClientSize = new Size(760, 400);
                form.MinimizeBox = false;
                form.MaximizeBox = false;

                string picked = null;

                var list = new Panel();
                list.Dock = DockStyle.Fill;
                list.AutoScroll = true;
                list.Padding = new Padding(8);

                var footer = new FlowLayoutPanel();
                footer.Dock = DockStyle.Bottom;
                footer.FlowDirection = FlowDirection.RightToLeft;
                footer.Height = 48;
                footer.Padding = new Padding(8);

                var cancel = new Button();
                cancel.Text = "取消";
                cancel.Width = 96;
                cancel.Height = 30;
                cancel.Click += delegate { form.Close(); };

                var manual = new Button();
                manual.Text = "自己选文件夹…";
                manual.Width = 150;
                manual.Height = 30;
                manual.Click += delegate
                {
                    using (var dialog = new FolderBrowserDialog())
                    {
                        dialog.Description = FolderPrompt();
                        dialog.ShowNewFolderButton = false;
                        if (dialog.ShowDialog(form) == DialogResult.OK)
                        {
                            picked = SafeFullPath(dialog.SelectedPath);
                            form.Close();
                        }
                    }
                };

                footer.Controls.Add(cancel);
                footer.Controls.Add(manual);

                int top = 4;
                foreach (string candidate in candidates)
                {
                    string captured = candidate;

                    var label = new Label();
                    label.Text = captured;
                    label.Left = 4;
                    label.Top = top + 7;
                    label.Width = 560;
                    label.Height = 20;
                    label.AutoEllipsis = true;

                    var button = new Button();
                    button.Text = "立即升级这个";
                    button.Left = 570;
                    button.Top = top;
                    button.Width = 150;
                    button.Height = 30;
                    button.Click += delegate { picked = captured; form.Close(); };

                    list.Controls.Add(label);
                    list.Controls.Add(button);
                    top += 38;
                }

                // 先加 Fill，再加 Bottom：后加的 Bottom 先占位，Fill 拿剩下的空间。
                form.Controls.Add(list);
                form.Controls.Add(footer);
                form.CancelButton = cancel;
                form.ShowDialog();
                return picked;
            }
        }
        catch (Exception ex)
        {
            Out("dialog_error=" + OneLine(ex.Message));
            log.Append("定位 S5: 候选列表对话框弹不出来（可能没有桌面会话）: "
                + ex.GetType().Name + ": " + ex.Message);
            return null;
        }
    }

    /// <summary>合法安装根 = 有 1CT.exe + resources\app.asar，且不在 %APPDATA%\1CT 里。</summary>
    private static bool IsInstallRoot(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return false;
        try
        {
            if (!Directory.Exists(dir)) return false;
            if (!File.Exists(Path.Combine(dir, TargetExeName))) return false;
            if (!File.Exists(Path.Combine(dir, ResourcesDirName, AsarName))) return false;
            return !IsInsideUserData(dir);
        }
        catch
        {
            return false;
        }
    }

    // ---- S3: 日志线索 ----

    /// <summary>Electron 栈帧里的安装根：…\1CT\resources\app.asar\dist\main\…（正反斜杠都认）。</summary>
    private static readonly Regex LogPathPattern = new Regex(
        @"([A-Za-z]:[\\/][^""\r\n]*?)[\\/]resources[\\/]app\.asar",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static List<string> CollectLogCandidates(Options options, UpgradeLog log)
    {
        var found = new List<string>();

        string logDir = null;
        if (!string.IsNullOrEmpty(options.LogDir))
        {
            logDir = SafeFullPath(options.LogDir);
            log.Append("定位 S3: 使用 --log-dir 指定的日志目录 → " + (logDir ?? options.LogDir));
        }
        else
        {
            string appData = SafeFolder(Environment.SpecialFolder.ApplicationData);
            if (string.IsNullOrEmpty(appData))
            {
                log.Append("定位 S3: 拿不到 %APPDATA%，跳过日志线索");
                return found;
            }
            logDir = Path.Combine(appData, "1CT", "logs");
        }

        string[] files;
        try
        {
            files = Directory.GetFiles(logDir, "*.log");
        }
        catch (Exception ex)
        {
            log.Append("定位 S3: 读日志目录失败（跳过）: " + logDir
                + " / " + ex.GetType().Name);
            return found;
        }
        Array.Sort(files, StringComparer.OrdinalIgnoreCase);
        log.Append("定位 S3: 扫 " + logDir + " 下的 *.log（" + files.Length
            + " 个，每个只读最后 " + (LogTailBytes / 1024) + "KB）");

        foreach (string file in files)
        {
            string text = ReadLogTail(file, log);
            if (text == null) continue;

            int hits = 0;
            foreach (Match match in LogPathPattern.Matches(text))
            {
                string root = NormalizeDir(match.Groups[1].Value);
                if (root == null) continue;
                if (!IsInstallRoot(root))
                {
                    log.Append("定位 S3: 日志线索不是合法安装根（忽略）: " + root);
                    continue;
                }
                AddUnique(found, root);
                hits++;
            }
            log.Append("定位 S3: " + Path.GetFileName(file) + " 命中 " + hits + " 个合法线索");
        }

        if (found.Count == 0)
        {
            log.Append("定位 S3: 日志里没有可用的安装根线索");
        }
        return found;
    }

    /// <summary>只读日志尾部 LogTailBytes 字节（大日志不拖慢启动）。</summary>
    private static string ReadLogTail(string path, UpgradeLog log)
    {
        try
        {
            using (var stream = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                long length = stream.Length;
                long start = length > LogTailBytes ? length - LogTailBytes : 0;
                int count = (int)(length - start);
                if (count <= 0) return string.Empty;
                stream.Seek(start, SeekOrigin.Begin);
                var buffer = new byte[count];
                int offset = 0;
                while (offset < count)
                {
                    int read = stream.Read(buffer, offset, count - offset);
                    if (read <= 0) break;
                    offset += read;
                }
                string text = Encoding.UTF8.GetString(buffer, 0, offset);
                if (text.IndexOf('\uFFFD') >= 0)
                {
                    // 老日志可能是 GBK：出现替换字符就按系统 ANSI 再解一次。
                    try { text = Encoding.Default.GetString(buffer, 0, offset); }
                    catch { }
                }
                return text;
            }
        }
        catch (Exception ex)
        {
            log.Append("定位 S3: 读日志失败（忽略）: " + path + " / " + ex.GetType().Name);
            return null;
        }
    }

    // ---- S4: 有界扫描 ----

    /// <summary>扫描时整棵跳过的目录名（小写比较）：系统目录、回收站、用户数据、缓存。</summary>
    private static readonly string[] ScanSkipNames = new string[]
    {
        "$recycle.bin", "system volume information", "windows", "winsxs", "system32",
        "syswow64", "driverstore", "installer", "appdata", "node_modules", ".git",
        ".cache", "cache", "temp", "tmp", "recovery", "perflogs", "msocache",
        "programdata", "config.msi", "windows.old", "onedrivetemp",
    };

    private static List<string> ScanForInstalls(Options options, UpgradeLog log)
    {
        var found = new List<string>();
        var roots = new List<string>();
        int maxDepth;

        if (options.ScanRoots.Count > 0)
        {
            maxDepth = ScanExplicitDepth;
            foreach (string root in options.ScanRoots)
            {
                string full = SafeFullPath(root);
                if (full == null)
                {
                    log.Append("定位 S4: --scan-root 路径不合法（忽略）: " + root);
                    continue;
                }
                AddUnique(roots, full);
            }
            log.Append("定位 S4: 用 --scan-root 指定的 " + roots.Count
                + " 个扫描根，深度<=" + maxDepth);
        }
        else
        {
            maxDepth = ScanDefaultDepth;
            foreach (string root in DefaultScanRoots())
            {
                AddUnique(roots, root);
            }
            log.Append("定位 S4: 默认扫描根 " + roots.Count
                + " 个（桌面/下载/文档/OneDrive/Programs/Program Files/用户目录/固定盘根），深度<="
                + maxDepth + "，限时 " + ScanBudgetMs + "ms");
        }

        if (roots.Count == 0)
        {
            log.Append("定位 S4: 没有可扫描的根目录");
            return found;
        }

        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var current = roots;
        int depth = 0;
        int scanned = 0;
        bool stopped = false;
        var stopwatch = Stopwatch.StartNew();

        while (current.Count > 0)
        {
            var next = new List<string>();
            foreach (string dir in current)
            {
                if (stopwatch.ElapsedMilliseconds > ScanBudgetMs || scanned > ScanMaxDirs)
                {
                    stopped = true;
                    break;
                }
                if (!visited.Add(dir)) continue;
                scanned++;

                if (IsInstallRoot(dir)) AddUnique(found, dir);
                if (depth >= maxDepth) continue;

                string[] children;
                try
                {
                    children = Directory.GetDirectories(dir);
                }
                catch
                {
                    continue;
                }
                foreach (string child in children)
                {
                    if (ShouldSkipDir(child)) continue;
                    next.Add(child);
                }
            }
            if (stopped) break;
            current = next;
            depth++;
        }

        log.Append("定位 S4: 扫描" + (stopped ? "到时间/数量上限提前结束" : "完成")
            + "，访问 " + scanned + " 个目录，耗时 " + stopwatch.ElapsedMilliseconds
            + "ms，合法候选 " + found.Count + " 个");
        return found;
    }

    private static List<string> DefaultScanRoots()
    {
        var roots = new List<string>();
        string userProfile = SafeFolder(Environment.SpecialFolder.UserProfile);
        string localAppData = SafeFolder(Environment.SpecialFolder.LocalApplicationData);

        if (userProfile != null)
        {
            AddIfDir(roots, Path.Combine(userProfile, "Desktop"));
            AddIfDir(roots, Path.Combine(userProfile, "Downloads"));
            AddIfDir(roots, Path.Combine(userProfile, "Documents"));
        }
        foreach (string variable in new string[] { "OneDrive", "OneDriveCommercial", "OneDriveConsumer" })
        {
            string oneDrive = Environment.GetEnvironmentVariable(variable);
            if (string.IsNullOrEmpty(oneDrive)) continue;
            AddIfDir(roots, Path.Combine(oneDrive, "Desktop"));
            AddIfDir(roots, Path.Combine(oneDrive, "Documents"));
        }
        if (localAppData != null) AddIfDir(roots, Path.Combine(localAppData, "Programs"));
        AddIfDir(roots, Environment.GetEnvironmentVariable("ProgramFiles"));
        AddIfDir(roots, Environment.GetEnvironmentVariable("ProgramFiles(x86)"));
        if (userProfile != null) AddIfDir(roots, userProfile);

        try
        {
            foreach (DriveInfo drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
                    AddIfDir(roots, drive.RootDirectory.FullName);
                }
                catch
                {
                    // 单个盘读不到不影响别的盘。
                }
            }
        }
        catch
        {
            // 枚举盘符失败就只扫前面那些目录。
        }
        return roots;
    }

    private static bool ShouldSkipDir(string dir)
    {
        string name = Path.GetFileName(dir);
        if (string.IsNullOrEmpty(name)) return false;
        string lower = name.ToLowerInvariant();
        foreach (string skip in ScanSkipNames)
        {
            if (string.Equals(lower, skip, StringComparison.Ordinal)) return true;
        }
        try
        {
            // 符号链接/junction 不跟（防环、防跑到别的盘）。
            FileAttributes attributes = File.GetAttributes(dir);
            if ((attributes & FileAttributes.ReparsePoint) != 0) return true;
        }
        catch
        {
            return true;
        }
        return false;
    }

    // ---- 定位用的小工具 ----

    private static string SafeFolder(Environment.SpecialFolder folder)
    {
        try
        {
            string path = Environment.GetFolderPath(folder);
            return string.IsNullOrEmpty(path) ? null : path;
        }
        catch
        {
            return null;
        }
    }

    private static string SafeFullPath(string path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        try
        {
            return Path.GetFullPath(path);
        }
        catch
        {
            return null;
        }
    }

    private static void AddIfDir(List<string> roots, string path)
    {
        if (string.IsNullOrEmpty(path)) return;
        try
        {
            if (!Directory.Exists(path)) return;
            AddUnique(roots, Path.GetFullPath(path));
        }
        catch
        {
            // 不存在的常见目录直接跳过。
        }
    }

    private static void AddUnique(List<string> list, string value)
    {
        if (string.IsNullOrEmpty(value)) return;
        foreach (string existing in list)
        {
            if (string.Equals(existing, value, StringComparison.OrdinalIgnoreCase)) return;
        }
        list.Add(value);
    }

    private static string NormalizeDir(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        string text = raw.Trim().Trim('"').Replace('/', '\\').TrimEnd('\\');
        if (text.Length == 0) return null;
        return SafeFullPath(text);
    }

    /// <summary>关掉所有 1CT.exe（含托盘）：taskkill /IM /T → 轮询 → /F 兜底。</summary>
    private static string CloseTarget()
    {
        var steps = new StringBuilder();
        if (!AnyProcessRunning())
        {
            return "1CT 当前没有运行，无需关闭";
        }

        int code = Taskkill("/IM " + TargetExeName + " /T");
        steps.Append("taskkill /IM " + TargetExeName + " /T -> ").Append(code).Append("; ");
        // taskkill 已经明确失败（例如进程不响应 WM_CLOSE）时不必干等满 15 秒，
        // 短暂确认后直接上 /F；只有它报了成功才值得等应用优雅退出。
        int gracefulWait = code == 0 ? KillTimeoutMs : 2000;
        if (WaitUntilGone(gracefulWait))
        {
            steps.Append("已自动关闭 1CT（含托盘）");
            return steps.ToString();
        }

        code = Taskkill("/F /IM " + TargetExeName + " /T");
        steps.Append("taskkill /F /IM " + TargetExeName + " /T -> ").Append(code).Append("; ");
        if (WaitUntilGone(KillForceTimeoutMs))
        {
            steps.Append("已强制关闭 1CT（含托盘）");
            return steps.ToString();
        }

        steps.Append("1CT 仍在运行，继续尝试覆盖（失败会回滚）");
        return steps.ToString();
    }

    private static bool AnyProcessRunning()
    {
        EnsureSelfIdentity();
        Process[] processes = null;
        try
        {
            processes = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(TargetExeName));
        }
        catch
        {
            return false;
        }
        try
        {
            foreach (Process process in processes)
            {
                // 双保险：绝不把自己算进“要关掉的 1CT”里。
                if (process.Id == _selfPid) continue;
                if (_selfPath != null && IsSamePath(SafeMainModulePath(process), _selfPath)) continue;
                return true;
            }
            return false;
        }
        finally
        {
            foreach (Process process in processes) process.Dispose();
        }
    }

    private static int _selfPid = -1;
    private static string _selfPath;

    /// <summary>缓存自身 PID/路径（AnyProcessRunning 会被轮询调用几十次，别每次都开句柄）。</summary>
    private static void EnsureSelfIdentity()
    {
        if (_selfPid >= 0) return;
        try
        {
            using (Process self = Process.GetCurrentProcess())
            {
                _selfPid = self.Id;
                try
                {
                    _selfPath = self.MainModule == null ? null : self.MainModule.FileName;
                }
                catch
                {
                    _selfPath = null;
                }
            }
        }
        catch
        {
            _selfPid = 0;
            _selfPath = null;
        }
    }

    private static bool WaitUntilGone(int timeoutMs)
    {
        int waited = 0;
        while (waited < timeoutMs)
        {
            if (!AnyProcessRunning()) return true;
            Thread.Sleep(300);
            waited += 300;
        }
        return !AnyProcessRunning();
    }

    private static int Taskkill(string arguments)
    {
        try
        {
            var info = new ProcessStartInfo
            {
                FileName = "taskkill",
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (Process process = Process.Start(info))
            {
                if (process == null) return -1;
                try
                {
                    process.StandardOutput.ReadToEnd();
                    process.StandardError.ReadToEnd();
                }
                catch
                {
                    // 输出读不到不影响退出码判断。
                }
                if (!process.WaitForExit(10000))
                {
                    try { process.Kill(); } catch { }
                    return -2;
                }
                return process.ExitCode;
            }
        }
        catch (Exception)
        {
            return -1;
        }
    }

    /// <summary>写临时文件再原子替换；只读/被占用等失败向上抛，由调用方回滚。</summary>
    private static void AtomicWrite(string path, byte[] bytes, Action<string> log)
    {
        string dir = Path.GetDirectoryName(path);
        string temp = Path.Combine(
            dir,
            Path.GetFileName(path) + ".new-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        File.WriteAllBytes(temp, bytes);
        try
        {
            File.Replace(temp, path, null);
            return;
        }
        catch (Exception ex)
        {
            if (!(ex is IOException) && !(ex is UnauthorizedAccessException))
            {
                TryDelete(temp);
                throw;
            }
            if (log != null)
            {
                log("File.Replace 不可用（" + ex.GetType().Name + "），改用删除+改名: " + ex.Message);
            }
        }
        // 兜底：删除旧文件再改名（非原子，但此时已有备份可回滚）。
        File.Delete(path);
        File.Move(temp, path);
    }

    private static bool Rollback(string backupAsar, string targetAsar, Action<string> log)
    {
        try
        {
            if (File.Exists(targetAsar))
            {
                FileAttributes attributes = File.GetAttributes(targetAsar);
                if ((attributes & FileAttributes.ReadOnly) != 0)
                {
                    File.SetAttributes(targetAsar, attributes & ~FileAttributes.ReadOnly);
                    log("回滚前清除只读属性: " + targetAsar);
                }
            }
            File.Copy(backupAsar, targetAsar, true);
            string restored = Sha256File(targetAsar);
            string expected = Sha256File(backupAsar);
            if (!string.Equals(restored, expected, StringComparison.OrdinalIgnoreCase))
            {
                log("回滚后校验不一致: " + restored + " != " + expected);
                return false;
            }
            log("已回滚: " + targetAsar + " (sha256 " + restored + ")");
            return true;
        }
        catch (Exception ex)
        {
            log("回滚失败: " + ex.GetType().Name + ": " + ex.Message);
            return false;
        }
    }

    private static void WriteVersionFile(
        string targetDir, string versionLine, string newSha, string backupDir, UpgradeLog log)
    {
        string path = Path.Combine(targetDir, VersionFileName);
        var builder = new StringBuilder();
        builder.Append(versionLine).Append("\r\n");
        builder.Append("asar sha256: ").Append(newSha).Append("\r\n");
        builder.Append("升级时间   : ")
            .Append(DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture))
            .Append("\r\n");
        builder.Append("升级方式   : 双击 ").Append(UpdaterName).Append("（自动关闭 1CT / 备份 / 覆盖 / 重启）\r\n");
        builder.Append("回滚方法   : 把 ").Append(backupDir).Append("\\").Append(AsarName)
            .Append(" 复制回 ").Append(ResourcesDirName).Append("\\").Append(AsarName).Append("\r\n");
        builder.Append("用户数据   : %APPDATA%\\1CT（升级不碰）\r\n");
        try
        {
            AtomicWrite(path, new UTF8Encoding(false).GetBytes(builder.ToString()), log.Append);
            log.Append("已写入 " + VersionFileName);
        }
        catch (Exception ex)
        {
            log.Append("写 " + VersionFileName + " 失败（忽略）: " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    /// <summary>
    /// 只改 .1ct-install.json 里的 patched_asar_sha256 一个字段，并在根对象末尾追加
    /// patched_by / patched_at。任何一步不像预期（找不到字段、结构校验不过）就跳过，
    /// 绝不让 marker 变成坏 JSON。
    /// </summary>
    private static void UpdateInstallMarker(string targetDir, string newSha, UpgradeLog log)
    {
        string path = Path.Combine(targetDir, InstallMarkerName);
        if (!File.Exists(path))
        {
            log.Append("没有 " + InstallMarkerName + "，跳过标记更新");
            return;
        }

        string original;
        try
        {
            original = File.ReadAllText(path, Encoding.UTF8);
        }
        catch (Exception ex)
        {
            log.Append("读 " + InstallMarkerName + " 失败（跳过）: " + ex.Message);
            return;
        }

        var pattern = new Regex("\"patched_asar_sha256\"\\s*:\\s*\"[0-9a-fA-F]{64}\"");
        if (!pattern.IsMatch(original))
        {
            log.Append("标记文件形状不匹配（没有 patched_asar_sha256 字段），跳过，未改动原文件");
            return;
        }

        string updated = pattern.Replace(
            original, "\"patched_asar_sha256\": \"" + newSha + "\"", 1);

        string stamp = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
        int closeIndex = updated.LastIndexOf('}');
        if (closeIndex > 0)
        {
            int probe = closeIndex - 1;
            while (probe >= 0 && char.IsWhiteSpace(updated[probe])) probe--;
            bool emptyObject = probe >= 0 && updated[probe] == '{';
            string insertion = (emptyObject ? string.Empty : ",")
                + "\r\n  \"patched_by\": \"" + MarkerOwner + "\","
                + "\r\n  \"patched_at\": \"" + stamp + "\"\r\n";
            updated = updated.Substring(0, closeIndex) + insertion + updated.Substring(closeIndex);
        }

        if (!LooksLikeJsonObject(updated))
        {
            log.Append("标记文件编辑后结构校验失败，跳过，未改动原文件");
            return;
        }

        try
        {
            AtomicWrite(path, new UTF8Encoding(false).GetBytes(updated), log.Append);
            log.Append("已更新 " + InstallMarkerName + ": patched_asar_sha256=" + newSha
                + "，并记录 patched_by=" + MarkerOwner);
        }
        catch (Exception ex)
        {
            log.Append("写 " + InstallMarkerName + " 失败（跳过）: " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    /// <summary>轻量 JSON 结构校验：括号配平、首尾是对象（不引第三方解析器）。</summary>
    private static bool LooksLikeJsonObject(string text)
    {
        if (text == null) return false;
        int index = 0;
        while (index < text.Length && char.IsWhiteSpace(text[index])) index++;
        if (index >= text.Length || text[index] != '{') return false;

        int depth = 0;
        bool inString = false;
        bool escaped = false;
        for (int i = index; i < text.Length; i++)
        {
            char c = text[i];
            if (inString)
            {
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            if (c == '"') inString = true;
            else if (c == '{') depth++;
            else if (c == '}')
            {
                depth--;
                if (depth < 0) return false;
            }
        }
        return !inString && depth == 0;
    }

    private static void StartTarget(string targetExe, string workDir)
    {
        var info = new ProcessStartInfo
        {
            FileName = targetExe,
            WorkingDirectory = workDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        // 只清这几个 Electron 开关，避免把当前进程的调试环境带进新实例。
        info.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        info.EnvironmentVariables.Remove("NODE_OPTIONS");
        info.EnvironmentVariables.Remove("NODE_PATH");
        Process.Start(info);
    }

    private static bool IsInsideUserData(string targetDir)
    {
        string appData = null;
        try
        {
            appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        }
        catch
        {
            return false;
        }
        if (string.IsNullOrEmpty(appData)) return false;
        string userData = Path.GetFullPath(Path.Combine(appData, "1CT"));
        string normalized = Path.GetFullPath(targetDir).TrimEnd('\\');
        string root = userData.TrimEnd('\\');
        return string.Equals(normalized, root, StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
    }

    // ================= 结果输出 =================

    private static int Finish(
        Options options,
        UpgradeLog log,
        int exitCode,
        string status,
        string headline,
        string detail)
    {
        log.Append("结果: " + status + " (" + headline + ")");
        log.Flush();
        Out("UPGRADE-RESULT status=" + status + " exit=" + exitCode);
        MessageBoxIcon icon = exitCode == ExitOk ? MessageBoxIcon.Information : MessageBoxIcon.Warning;
        ShowDialog(options.Silent || options.DryRun, headline + "\n\n" + detail + LogNote(log), icon);
        return exitCode;
    }

    private static string LogNote(UpgradeLog log)
    {
        return string.IsNullOrEmpty(log.Path) ? string.Empty : "\n\n日志: " + log.Path;
    }

    private static void ShowDialog(bool quiet, string message, MessageBoxIcon icon)
    {
        if (quiet) return;
        try
        {
            MessageBox.Show(message, Title, MessageBoxButtons.OK, icon);
        }
        catch
        {
            // 无桌面会话时弹不出来也不能因此失败。
        }
    }

    private static string TempLogPath(string suffix)
    {
        return Path.Combine(
            Path.GetTempPath(), "1CT-upgrade-" + suffix + ".log");
    }

    private static void Out(string line)
    {
        try
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
        catch
        {
            // 双击启动时没有控制台，stdout 写不出去属于正常情况。
        }
    }

    private static string OneLine(string value)
    {
        if (value == null) return string.Empty;
        return value.Replace("\r", " ").Replace("\n", " ").Trim();
    }

    private static string UsageText()
    {
        return "用法: " + UpdaterName
            + " [--target <目录>] [--silent] [--no-launch] [--no-kill] [--dry-run]"
            + " [--no-scan] [--log-dir <目录>] [--scan-root <目录>]...";
    }

    // ================= 哈希 / 文件小工具 =================

    private static string Sha256File(string path)
    {
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (var sha = SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(stream);
            return Hex(hash);
        }
    }

    private static string Sha256Bytes(byte[] bytes)
    {
        using (var sha = SHA256.Create())
        {
            return Hex(sha.ComputeHash(bytes));
        }
    }

    private static string Hex(byte[] bytes)
    {
        var builder = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes)
        {
            builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        }
        return builder.ToString();
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // 临时文件删不掉不影响结果。
        }
    }

    private static string SafeMainModulePath(Process process)
    {
        try
        {
            return process.MainModule == null ? null : process.MainModule.FileName;
        }
        catch
        {
            return null;
        }
    }

    private static bool IsSamePath(string left, string right)
    {
        if (left == null || right == null) return false;
        try
        {
            return string.Equals(
                Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    // ================= 内嵌 payload =================

    private sealed class Payload
    {
        public byte[] AsarBytes;
        public string AsarSha256;
        public string DeclaredSha256;
        public string VersionLine;

        public static Payload Load()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            string asarResource = null;
            string jsonResource = null;
            foreach (string name in assembly.GetManifestResourceNames())
            {
                if (asarResource == null && name.EndsWith(".asar", StringComparison.OrdinalIgnoreCase))
                {
                    asarResource = name;
                }
                else if (jsonResource == null && name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                {
                    jsonResource = name;
                }
            }
            if (asarResource == null)
            {
                throw new InvalidOperationException(
                    "这个 exe 里没有内嵌 app.asar（构建脚本必须用 /resource: 嵌入）");
            }

            var payload = new Payload();
            payload.AsarBytes = ReadResource(assembly, asarResource);
            if (payload.AsarBytes.Length == 0)
            {
                throw new InvalidOperationException("内嵌 app.asar 是空文件，拒绝升级");
            }
            payload.AsarSha256 = Sha256Bytes(payload.AsarBytes);
            payload.VersionLine = "1CT 升级包（构建信息缺失）";

            if (jsonResource != null)
            {
                string json = Encoding.UTF8.GetString(ReadResource(assembly, jsonResource));
                string versionLine = JsonStringField(json, "versionLine");
                if (!string.IsNullOrEmpty(versionLine)) payload.VersionLine = versionLine;
                string declared = JsonStringField(json, "asarSha256");
                if (!string.IsNullOrEmpty(declared)) payload.DeclaredSha256 = declared;
            }
            return payload;
        }

        private static byte[] ReadResource(Assembly assembly, string name)
        {
            using (Stream stream = assembly.GetManifestResourceStream(name))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("读不到内嵌资源: " + name);
                }
                using (var memory = new MemoryStream())
                {
                    var buffer = new byte[81920];
                    int read;
                    while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        memory.Write(buffer, 0, read);
                    }
                    return memory.ToArray();
                }
            }
        }

        /// <summary>只取一个顶层字符串字段（不值得为两三个字段引入 JSON 解析器）。</summary>
        private static string JsonStringField(string json, string field)
        {
            if (string.IsNullOrEmpty(json)) return null;
            Match match = Regex.Match(
                json,
                "\"" + Regex.Escape(field) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!match.Success) return null;
            return JsonUnescape(match.Groups[1].Value);
        }

        private static string JsonUnescape(string value)
        {
            var builder = new StringBuilder(value.Length);
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c != '\\' || i + 1 >= value.Length)
                {
                    builder.Append(c);
                    continue;
                }
                char next = value[++i];
                switch (next)
                {
                    case 'n': builder.Append('\n'); break;
                    case 'r': builder.Append('\r'); break;
                    case 't': builder.Append('\t'); break;
                    case '"': builder.Append('"'); break;
                    case '\\': builder.Append('\\'); break;
                    case '/': builder.Append('/'); break;
                    case 'u':
                        if (i + 4 < value.Length)
                        {
                            int code;
                            if (int.TryParse(
                                value.Substring(i + 1, 4),
                                NumberStyles.HexNumber,
                                CultureInfo.InvariantCulture,
                                out code))
                            {
                                builder.Append((char)code);
                                i += 4;
                                break;
                            }
                        }
                        builder.Append("\\u");
                        break;
                    default: builder.Append(next); break;
                }
            }
            return builder.ToString();
        }
    }

    // ================= 日志 =================

    private sealed class UpgradeLog
    {
        private readonly List<string> _lines = new List<string>();

        public string Path;

        public void Append(string message)
        {
            _lines.Add(
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                + "  " + (message == null ? string.Empty : message));
        }

        public void Flush()
        {
            if (string.IsNullOrEmpty(Path)) return;
            try
            {
                string dir = System.IO.Path.GetDirectoryName(Path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(
                    Path,
                    string.Join("\r\n", _lines.ToArray()) + "\r\n",
                    new UTF8Encoding(false));
            }
            catch
            {
                // 日志写不进去不能影响升级本身。
            }
        }
    }

    // ================= 命令行 =================

    private sealed class Options
    {
        public string Target;
        public string LogDir;
        public readonly List<string> ScanRoots = new List<string>();
        public bool Silent;
        public bool NoLaunch;
        public bool NoKill;
        public bool DryRun;
        public bool NoScan;

        public static Options Parse(string[] args)
        {
            var options = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string argument = args[i];
                if (string.Equals(argument, "--silent", StringComparison.OrdinalIgnoreCase))
                {
                    options.Silent = true;
                }
                else if (string.Equals(argument, "--no-launch", StringComparison.OrdinalIgnoreCase))
                {
                    options.NoLaunch = true;
                }
                else if (string.Equals(argument, "--no-kill", StringComparison.OrdinalIgnoreCase))
                {
                    options.NoKill = true;
                }
                else if (string.Equals(argument, "--dry-run", StringComparison.OrdinalIgnoreCase))
                {
                    options.DryRun = true;
                }
                else if (string.Equals(argument, "--no-scan", StringComparison.OrdinalIgnoreCase))
                {
                    options.NoScan = true;
                }
                else if (string.Equals(argument, "--target", StringComparison.OrdinalIgnoreCase))
                {
                    if (i + 1 >= args.Length)
                    {
                        throw new ArgumentException("--target 需要一个目录参数");
                    }
                    options.Target = args[++i];
                }
                else if (argument.StartsWith("--target=", StringComparison.OrdinalIgnoreCase))
                {
                    options.Target = argument.Substring("--target=".Length);
                }
                else if (string.Equals(argument, "--log-dir", StringComparison.OrdinalIgnoreCase))
                {
                    if (i + 1 >= args.Length)
                    {
                        throw new ArgumentException("--log-dir 需要一个目录参数");
                    }
                    options.LogDir = args[++i];
                }
                else if (argument.StartsWith("--log-dir=", StringComparison.OrdinalIgnoreCase))
                {
                    options.LogDir = argument.Substring("--log-dir=".Length);
                }
                else if (string.Equals(argument, "--scan-root", StringComparison.OrdinalIgnoreCase))
                {
                    if (i + 1 >= args.Length)
                    {
                        throw new ArgumentException("--scan-root 需要一个目录参数");
                    }
                    options.ScanRoots.Add(args[++i]);
                }
                else if (argument.StartsWith("--scan-root=", StringComparison.OrdinalIgnoreCase))
                {
                    options.ScanRoots.Add(argument.Substring("--scan-root=".Length));
                }
                else
                {
                    throw new ArgumentException("未知参数: " + argument);
                }
            }
            if (options.Target != null && options.Target.Trim().Length == 0)
            {
                throw new ArgumentException("--target 的目录不能是空字符串");
            }
            if (options.LogDir != null && options.LogDir.Trim().Length == 0)
            {
                throw new ArgumentException("--log-dir 的目录不能是空字符串");
            }
            foreach (string root in options.ScanRoots)
            {
                if (root.Trim().Length == 0)
                {
                    throw new ArgumentException("--scan-root 的目录不能是空字符串");
                }
            }
            return options;
        }
    }
}
