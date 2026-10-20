"""auto3ct 命令行：validate / preview / run-once / watch / status。

安全默认：
- 所有命令默认 dry-run，只做本地计算；
- 只有显式 ``--execute`` 且配置了可用 adapter（工厂可加载、``init()`` 成功）时
  才会调用业务适配器，否则以非零退出码报错，绝不把未执行当成成功；
- preview 不创建数据库、不加载 adapter；任何命令都不打印 payload 值，避免凭证进日志。

业务适配器协议（由用户在配置的 ``adapter.factory`` 中提供）：
    factory(options: dict) -> adapter
    adapter.init() -> None                      # 可选，用于建立登录态
    adapter.execute(task, run_key) -> ActionResult
    adapter.close() -> None                     # 可选
"""

from __future__ import annotations

import argparse
import importlib
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import config as config_module
from .config import AdapterConfig, Config, TaskConfig, china_tz

EXAMPLE_CONFIG_NAME = config_module.EXAMPLE_CONFIG_NAME
REPO_ROOT = Path(__file__).resolve().parent.parent

#: RunResult / RunRecord 状态的中文短名。
STATUS_TEXT = {
    "success": "成功",
    "dry_run": "将执行",
    "not_due": "未到时窗",
    "window_expired": "时窗已过",
    "already_done": "今日已完成",
    "retry": "等待重试",
    "retry_waiting": "重试未到时间",
    "in_flight": "执行中",
    "waiting_dependency": "等待依赖",
    "blocked": "已阻断",
    "unknown": "结果未知",
    "failed": "失败",
}
#: 真实执行后视为“未成功”的终态。
FAILED_STATUSES = frozenset({"failed", "blocked", "unknown"})
#: run-once / watch 需要逐条打印的状态。
SHOW_STATUSES = frozenset(
    {
        "dry_run",
        "success",
        "retry",
        "blocked",
        "unknown",
        "failed",
        "waiting_dependency",
        "window_expired",
        "retry_waiting",
        "in_flight",
        "already_done",
    }
)
_WEEKDAY_NAMES = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")


class AdapterError(Exception):
    """业务适配器无法加载或初始化。"""


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--config",
        metavar="PATH",
        default=argparse.SUPPRESS,
        help="配置文件路径（默认 config.local.json，可由 AUTO3CT_CONFIG 指定）",
    )

    parser = argparse.ArgumentParser(
        prog="auto3ct",
        description="3CT 本地每日调度工具：默认 dry-run，不访问任何服务。",
        parents=[common],
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("validate", parents=[common], help="校验配置文件（完全离线）")

    preview = sub.add_parser("preview", parents=[common], help="预览今日计划与下次时窗（不写库、不执行）")
    preview.add_argument("--now", metavar="ISO8601", help="指定当前时间（默认此刻）")

    run_once = sub.add_parser("run-once", parents=[common], help="执行一轮到点任务（默认 dry-run）")
    run_once.add_argument("--now", metavar="ISO8601", help="指定当前时间（默认此刻）")
    _add_mode_flags(run_once)

    watch = sub.add_parser("watch", parents=[common], help="常驻轮询（默认 dry-run，Ctrl+C 停止）")
    watch.add_argument("--interval", type=float, metavar="SECONDS", help="轮询间隔（默认取配置）")
    watch.add_argument(
        "--max-iterations",
        type=int,
        metavar="N",
        help="仅扫描 N 次后退出（用于自检/演示，默认无限）",
    )
    _add_mode_flags(watch)

    status = sub.add_parser("status", parents=[common], help="查看任务与最近运行记录")
    status.add_argument("--limit", type=int, default=10, metavar="N", help="最多显示 N 条运行记录")
    return parser


def _add_mode_flags(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--execute", action="store_true", help="真实执行（需要可用 adapter）")
    group.add_argument("--dry-run", action="store_true", help="仅预览（默认行为）")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    commands = {
        "validate": cmd_validate,
        "preview": cmd_preview,
        "run-once": cmd_run_once,
        "watch": cmd_watch,
        "status": cmd_status,
    }
    return commands[args.command](args)


def _info(message: str = "") -> None:
    print(message)


def _error(message: str) -> None:
    print(f"错误: {message}", file=sys.stderr)


def _load_config(args: argparse.Namespace) -> Config | None:
    raw = getattr(args, "config", None)
    path = Path(raw) if raw is not None else config_module.default_config_path()
    if not path.is_file():
        hint = ""
        if raw is None:
            example = REPO_ROOT / EXAMPLE_CONFIG_NAME
            if example.is_file():
                hint = f"；可从 {example.name} 复制一份并填写"
        _error(f"配置文件不存在: {path}{hint}")
        return None
    try:
        return config_module.load_config(path)
    except config_module.ConfigError as exc:
        for message in exc.errors:
            _error(message)
        return None


def _resolve_now(value: str | None) -> datetime:
    tz = china_tz()
    if not value:
        return datetime.now(tz)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"--now 时间格式无效: {value}（示例 2025-01-06T07:00:00+08:00）") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)


def _config_header(config: Config) -> None:
    _info(f"配置文件: {config.path}")
    _info(f"时区: {config.timezone}")
    _info(f"数据库: {config.database_path}")


def _adapter_status(config: Config) -> str:
    if config.adapter is None:
        return "未配置（仅支持 preview / dry-run）"
    return f"已配置: {config.adapter.factory}"


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------


def cmd_validate(args: argparse.Namespace) -> int:
    config = _load_config(args)
    if config is None:
        return 1
    _info(f"配置有效: {config.path}")
    _info(f"时区: {config.timezone}")
    _info(f"数据库: {config.database_path}")
    _info(f"任务: {config.task_count} 个（启用 {config.enabled_count} 个）")
    _info(f"适配器: {_adapter_status(config)}")
    return 0


# ---------------------------------------------------------------------------
# preview
# ---------------------------------------------------------------------------


def cmd_preview(args: argparse.Namespace) -> int:
    config = _load_config(args)
    if config is None:
        return 1
    try:
        now = _resolve_now(getattr(args, "now", None))
    except ValueError as exc:
        _error(str(exc))
        return 1

    _info("预览: 仅本地计算，不执行、不访问任何服务")
    _config_header(config)
    _info(f"适配器: {_adapter_status(config)}")
    _info(f"当前时间: {_format_time(now)}（{_WEEKDAY_NAMES[now.isoweekday() - 1]}）")
    _info(f"任务（{config.task_count} 个，启用 {config.enabled_count} 个）:")
    for task in config.tasks:
        _preview_task(task, now)
    _info(f"共 {config.task_count} 个任务，启用 {config.enabled_count} 个；以上仅为预览，未执行任何操作。")
    return 0


def _preview_task(task: TaskConfig, now: datetime) -> None:
    flag = "[启用]" if task.enabled else "[禁用]"
    _info(
        f"  {flag} {task.id}  {task.action}  {task.start}-{task.end}  {_weekday_text(task.weekdays)}"
    )
    if task.depends_on:
        _info(f"         依赖: {', '.join(task.depends_on)}")
    if task.payload:
        _info(f"         payload 键: {', '.join(sorted(str(key) for key in task.payload))}（值已隐藏）")
    else:
        _info("         payload: 空（启用前需填写）")
    if not task.enabled:
        return
    _info(f"         今日: {_today_state(task, now)}")
    next_start = _next_window_start(task, now)
    if next_start is not None:
        _info(f"         下次: {_format_time(next_start)}")


def _weekday_text(weekdays: tuple[int, ...]) -> str:
    if weekdays == (1, 2, 3, 4, 5, 6, 7):
        return "每天"
    if weekdays == (1, 2, 3, 4, 5):
        return "周一至周五"
    return "、".join(_WEEKDAY_NAMES[day - 1] for day in weekdays)


def _today_state(task: TaskConfig, now: datetime) -> str:
    if now.isoweekday() not in task.weekdays:
        return "今日不调度"
    start = _combine(now.date(), task.start)
    end = _combine(now.date(), task.end)
    if now < start:
        return "未到时窗"
    if now <= end:
        return "在时窗内"
    return "时窗已过"


def _next_window_start(task: TaskConfig, now: datetime):
    for offset in range(0, 8):
        day = (now + timedelta(days=offset)).date()
        if day.isoweekday() not in task.weekdays:
            continue
        start = _combine(day, task.start)
        end = _combine(day, task.end)
        if start <= now <= end:
            return start
        if now < start:
            return start
    return None


def _combine(day, hhmm: str) -> datetime:
    hours, minutes = hhmm.split(":")
    return datetime(day.year, day.month, day.day, int(hours), int(minutes), tzinfo=china_tz())


def _format_time(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------------------
# run-once
# ---------------------------------------------------------------------------


def cmd_run_once(args: argparse.Namespace) -> int:
    config = _load_config(args)
    if config is None:
        return 1
    try:
        now = _resolve_now(getattr(args, "now", None))
    except ValueError as exc:
        _error(str(exc))
        return 1
    execute = bool(getattr(args, "execute", False))

    adapter = None
    if execute:
        adapter = _prepare_adapter(config)
        if adapter is None:
            return 1
    try:
        return _run_once(config, execute=execute, now=now, adapter=adapter)
    finally:
        _close_adapter(adapter)


def _make_scheduler(config: Config, *, sync: bool = True):
    from .scheduler import Scheduler

    scheduler = Scheduler(
        str(config.database_path),
        tz=china_tz(),
        max_attempts=config.default_max_attempts,
    )
    if sync:
        scheduler.replace_tasks([to_task(task) for task in config.tasks])
    return scheduler


def _run_once(config: Config, *, execute: bool, now: datetime, adapter) -> int:
    scheduler = _make_scheduler(config)
    results = scheduler.run_due(
        _make_handler(adapter) if execute else None, now=now, dry_run=not execute
    )

    _print_mode(config, execute, now)
    if not results:
        _info("没有可扫描的任务（所有任务已禁用或今日不调度）。")
        return 0
    _print_results(results)
    if not execute:
        would_run = sum(1 for result in results if result.would_run)
        _info(f"dry-run 完成：考虑 {len(results)} 个任务，将会执行 {would_run} 个。")
        return 0

    successes = sum(1 for result in results if result.status == "success")
    failures = sum(1 for result in results if result.status in FAILED_STATUSES)
    retries = sum(1 for result in results if result.status == "retry")
    _info(f"执行完成：成功 {successes}，失败/阻断/未知 {failures}，等待重试 {retries}。")
    if failures:
        _error("有任务未成功（失败/阻断/未知），请对照上面的状态人工确认。")
        return 1
    return 0


def _print_mode(config: Config, execute: bool, now: datetime) -> None:
    mode = "--execute（真实执行）" if execute else "dry-run（不访问任何服务）"
    _info(f"执行模式: {mode}")
    _config_header(config)
    _info(f"扫描时间: {_format_time(now)}（{_WEEKDAY_NAMES[now.isoweekday() - 1]}）")


def _print_results(results) -> None:
    for result in results:
        if result.status not in SHOW_STATUSES:
            continue
        line = f"  [{STATUS_TEXT.get(result.status, result.status)}] {result.task_id}  {result.action}"
        if result.message:
            line += f"：{result.message}"
        if result.status == "retry" and result.next_attempt is not None:
            line += f"（下次尝试 {_format_time(result.next_attempt)}）"
        _info(line)


# ---------------------------------------------------------------------------
# watch
# ---------------------------------------------------------------------------


def cmd_watch(args: argparse.Namespace) -> int:
    config = _load_config(args)
    if config is None:
        return 1
    execute = bool(getattr(args, "execute", False))
    interval = getattr(args, "interval", None)
    if interval is None:
        interval = config.interval_seconds
    if not config_module.MIN_INTERVAL_SECONDS <= interval <= config_module.MAX_INTERVAL_SECONDS:
        _error(
            f"--interval 必须在 {config_module.MIN_INTERVAL_SECONDS:.0f}-"
            f"{config_module.MAX_INTERVAL_SECONDS:.0f} 秒之间: {interval}"
        )
        return 1
    iterations = getattr(args, "max_iterations", None)
    if iterations is not None and iterations < 1:
        _error(f"--max-iterations 必须 ≥1: {iterations}")
        return 1

    adapter = None
    if execute:
        adapter = _prepare_adapter(config)
        if adapter is None:
            return 1
    _info(
        f"[watch] 启动：{('真实执行' if execute else 'dry-run')}，间隔 {interval:g} 秒；"
        "Ctrl+C 停止。"
    )
    return run_watch(
        config,
        execute=execute,
        interval=float(interval),
        adapter=adapter,
        iterations=iterations,
    )


def run_watch(
    config: Config,
    *,
    execute: bool,
    interval: float,
    adapter=None,
    iterations: int | None = None,
    clock=None,
    sleep=None,
) -> int:
    """常驻轮询；Ctrl+C 时优雅退出并返回 0。"""

    scheduler = _make_scheduler(config)
    handler = _make_handler(adapter) if execute else None
    clock = clock or (lambda: datetime.now(china_tz()))
    sleep = sleep or time.sleep
    count = 0
    try:
        while iterations is None or count < iterations:
            now = clock()
            results = scheduler.run_due(handler, now=now, dry_run=not execute)
            _info(f"[watch] 扫描完成 {now:%H:%M:%S}：{_summarize(results, execute)}")
            count += 1
            if iterations is not None and count >= iterations:
                break
            sleep(interval)
    except KeyboardInterrupt:
        _info("\n已停止（Ctrl+C）。本地运行记录已保留。")
        return 0
    finally:
        _close_adapter(adapter)
    return 0


def _summarize(results, execute: bool) -> str:
    if not results:
        return "没有到点任务"
    if not execute:
        would_run = sum(1 for result in results if result.would_run)
        return f"考虑 {len(results)} 个任务，将会执行 {would_run} 个（dry-run）"
    successes = sum(1 for result in results if result.status == "success")
    failures = sum(1 for result in results if result.status in FAILED_STATUSES)
    retries = sum(1 for result in results if result.status == "retry")
    return f"成功 {successes}，失败/阻断/未知 {failures}，等待重试 {retries}"


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def cmd_status(args: argparse.Namespace) -> int:
    config = _load_config(args)
    if config is None:
        return 1
    _info("状态")
    _config_header(config)
    _info(f"任务: {config.task_count} 个（启用 {config.enabled_count} 个）")
    _info(f"适配器: {_adapter_status(config)}")

    if not config.database_path.exists():
        _info("运行记录: 无（数据库尚未创建）")
        return 0

    limit = getattr(args, "limit", 10) or 10
    records = _make_scheduler(config, sync=False).list_runs(limit=limit)
    if not records:
        _info("运行记录: 无")
        return 0
    _info(f"最近运行（最多 {limit} 条）:")
    for record in records:
        message = f"：{record.message}" if record.message else ""
        updated = record.updated_at.strftime("%H:%M") if record.updated_at else "--:--"
        _info(
            f"  {record.local_date:%Y-%m-%d} {updated}  {record.task_id}  "
            f"{STATUS_TEXT.get(record.status, record.status)}  尝试 {record.attempt}{message}"
        )
    return 0


# ---------------------------------------------------------------------------
# 适配器与调度器适配
# ---------------------------------------------------------------------------


def _prepare_adapter(config: Config):
    if config.adapter is None:
        _error(
            "未配置 adapter，不能 --execute；请在配置中设置 adapter.factory，"
            "或使用 dry-run（默认）"
        )
        return None
    try:
        return load_adapter(config.adapter)
    except AdapterError as exc:
        _error(f"适配器不可用: {exc}")
        return None


def load_adapter(adapter_config: AdapterConfig):
    """按 ``module:factory`` 加载并初始化适配器；失败抛 :class:`AdapterError`。"""

    module_name, _, attribute = adapter_config.factory.partition(":")
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:  # noqa: BLE001 - 任何导入失败都按适配器不可用处理
        raise AdapterError(f"无法加载模块 {module_name}: {exc}") from exc
    factory = getattr(module, attribute, None)
    if not callable(factory):
        raise AdapterError(f"模块 {module_name} 中没有可调用的工厂 {attribute}")
    try:
        adapter = factory(dict(adapter_config.options))
    except Exception as exc:  # noqa: BLE001
        raise AdapterError(f"适配器工厂调用失败: {exc}") from exc
    if not callable(getattr(adapter, "execute", None)):
        raise AdapterError("适配器缺少 execute(task, run_key) 接口")
    init = getattr(adapter, "init", None)
    if callable(init):
        try:
            init()
        except Exception as exc:  # noqa: BLE001
            raise AdapterError(f"适配器初始化失败: {exc}") from exc
    return adapter


def _close_adapter(adapter) -> None:
    if adapter is None:
        return
    close = getattr(adapter, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - 关闭失败不应影响结果
            pass


def _make_handler(adapter):
    def handler(task, run_key):
        return adapter.execute(task, run_key)

    return handler


def to_task(task: TaskConfig):
    """把配置任务转换为调度核心的 :class:`auto3ct.models.Task`。"""

    from .models import Task

    return Task(
        id=task.id,
        action=task.action,
        start=task.start,
        end=task.end,
        payload=dict(task.payload),
        weekdays=task.weekdays,
        enabled=task.enabled,
        depends_on=task.depends_on,
        max_attempts=task.max_attempts,
    )


if __name__ == "__main__":  # pragma: no cover - 便于直接 python -m auto3ct.cli
    raise SystemExit(main())
