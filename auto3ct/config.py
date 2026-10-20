"""用户配置的加载与严格校验。

本模块完全离线：只读取 JSON 配置文件、只做结构/语义校验，
不访问网络、不加载业务适配器、不创建数据库。

设计约束：
- 时区固定为 Asia/Shanghai（本机可能没有 tzdata，china_tz() 会回退到 +08:00）。
- 配置中的相对路径（数据库）一律相对「配置文件所在目录」解析。
- 校验尽量一次收集全部错误，每条错误都是简短中文。
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, field
from datetime import timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any

try:  # pragma: no cover - 只在有 tzdata 的机器上走真实 IANA 时区
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - Python < 3.9，本项目要求 >= 3.11
    ZoneInfo = None  # type: ignore[assignment]
    ZoneInfoNotFoundError = Exception  # type: ignore[assignment]

TIMEZONE_NAME = "Asia/Shanghai"
DEFAULT_CONFIG_NAME = "config.local.json"
EXAMPLE_CONFIG_NAME = "config.example.json"
DEFAULT_DB_RELATIVE = "runtime/auto3ct.db"
DEFAULT_INTERVAL_SECONDS = 30.0
DEFAULT_MAX_ATTEMPTS = 3
SUPPORTED_VERSION = 1
MIN_INTERVAL_SECONDS = 1.0
MAX_INTERVAL_SECONDS = 3600.0
MIN_ATTEMPTS = 1
MAX_ATTEMPTS = 10

_TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_ACTION_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_FACTORY_RE = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$"
)
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

_TOP_LEVEL_KEYS = {"version", "timezone", "database", "adapter", "defaults", "tasks"}
_TASK_KEYS = {
    "id",
    "action",
    "start",
    "end",
    "weekdays",
    "enabled",
    "depends_on",
    "max_attempts",
    "payload",
}
_ADAPTER_KEYS = {"factory", "options"}
_DEFAULTS_KEYS = {"interval_seconds", "max_attempts"}

# 只用于提示"任务已启用但 payload 还是占位符"。
PLACEHOLDER_KEYS = frozenset({"placeholder", "todo", "tbd", "fixme"})


class ConfigError(Exception):
    """配置不合法。``errors`` 为简短中文错误列表。"""

    def __init__(self, errors: str | list[str]) -> None:
        self.errors: list[str] = [errors] if isinstance(errors, str) else list(errors)
        super().__init__("\n".join(self.errors))


@dataclass(frozen=True)
class AdapterConfig:
    """业务适配器声明：``factory`` 形如 ``module:attribute``。"""

    factory: str
    options: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "options", dict(self.options))


@dataclass(frozen=True)
class TaskConfig:
    """单个任务的配置（尚未转换成 scheduler 的 Task）。"""

    id: str
    action: str
    start: str
    end: str
    weekdays: tuple[int, ...] = (1, 2, 3, 4, 5, 6, 7)
    enabled: bool = False
    depends_on: tuple[str, ...] = ()
    max_attempts: int | None = None
    payload: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "weekdays", tuple(self.weekdays))
        object.__setattr__(self, "depends_on", tuple(self.depends_on))
        object.__setattr__(self, "payload", dict(self.payload))


@dataclass(frozen=True)
class Config:
    """校验通过的完整配置。"""

    path: Path
    version: int
    timezone: str
    database_path: Path
    adapter: AdapterConfig | None
    interval_seconds: float
    default_max_attempts: int
    tasks: tuple[TaskConfig, ...]

    @property
    def task_count(self) -> int:
        return len(self.tasks)

    @property
    def enabled_tasks(self) -> tuple[TaskConfig, ...]:
        return tuple(task for task in self.tasks if task.enabled)

    @property
    def enabled_count(self) -> int:
        return len(self.enabled_tasks)


def china_tz() -> tzinfo:
    """返回 Asia/Shanghai 时区；没有 tzdata 时回退到固定 +08:00。"""

    if ZoneInfo is not None:
        try:
            return ZoneInfo(TIMEZONE_NAME)
        except (ZoneInfoNotFoundError, KeyError, OSError):  # pragma: no cover - 无 tzdata 的机器
            pass
    return timezone(timedelta(hours=8))


def default_config_path(cwd: str | Path | None = None) -> Path:
    """默认配置路径：环境变量 AUTO3CT_CONFIG，否则 <cwd>/config.local.json。"""

    env = os.environ.get("AUTO3CT_CONFIG")
    if env:
        return Path(env)
    return Path(cwd) / DEFAULT_CONFIG_NAME if cwd is not None else Path.cwd() / DEFAULT_CONFIG_NAME


def load_config(path: str | Path) -> Config:
    """加载并校验配置；不合法时抛出 :class:`ConfigError`。"""

    config_path = Path(path).expanduser().resolve()
    errors: list[str] = []
    raw = _read_json(config_path, errors)
    if raw is None:
        raise ConfigError(errors)
    if not isinstance(raw, dict):
        raise ConfigError("配置文件顶层必须是 JSON 对象")

    unknown = set(raw) - _TOP_LEVEL_KEYS
    if unknown:
        errors.append(f"未知配置项: {', '.join(sorted(unknown))}")

    version = _parse_version(raw, errors)
    tz_name = raw.get("timezone", TIMEZONE_NAME)
    if tz_name != TIMEZONE_NAME:
        errors.append(f"仅支持时区 {TIMEZONE_NAME}: {tz_name!r}")
        tz_name = TIMEZONE_NAME

    database_path = _parse_database(raw, config_path, errors)
    adapter = _parse_adapter(raw, errors)
    interval_seconds, default_max_attempts = _parse_defaults(raw, errors)
    tasks = _parse_tasks(raw, errors, config_path)

    if errors:
        raise ConfigError(errors)
    return Config(
        path=config_path,
        version=version,
        timezone=tz_name,
        database_path=database_path,
        adapter=adapter,
        interval_seconds=interval_seconds,
        default_max_attempts=default_max_attempts,
        tasks=tuple(tasks),
    )


def validate_config(path: str | Path) -> list[str]:
    """校验配置并返回错误列表；空列表表示配置有效。"""

    try:
        load_config(path)
    except ConfigError as exc:
        return list(exc.errors)
    return []


def _read_json(path: Path, errors: list[str]) -> Any | None:
    if not path.is_file():
        errors.append(f"配置文件不存在: {path}")
        return None
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        errors.append(f"无法读取配置文件: {exc}")
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        errors.append(f"配置文件不是合法 JSON（第 {exc.lineno} 行第 {exc.colno} 列）: {exc.msg}")
        return None


def _parse_version(raw: dict[str, Any], errors: list[str]) -> int:
    version = raw.get("version", SUPPORTED_VERSION)
    if isinstance(version, bool) or not isinstance(version, int) or version != SUPPORTED_VERSION:
        errors.append(f"不支持的配置版本: {version!r}（仅支持 {SUPPORTED_VERSION}）")
        return SUPPORTED_VERSION
    return version


def _parse_database(
    raw: dict[str, Any], config_path: Path, errors: list[str]
) -> Path:
    value = raw.get("database", DEFAULT_DB_RELATIVE)
    if not isinstance(value, str) or not value.strip():
        errors.append("database 必须是非空字符串")
        value = DEFAULT_DB_RELATIVE
    elif value.strip() == ":memory:":
        errors.append("不支持 :memory: 数据库，请配置真实的数据库文件路径")
        value = DEFAULT_DB_RELATIVE
    db = Path(value.strip()).expanduser()
    if not db.is_absolute():
        db = config_path.parent / db
    return db.resolve()


def _parse_adapter(raw: dict[str, Any], errors: list[str]) -> AdapterConfig | None:
    if "adapter" not in raw:
        return None
    value = raw["adapter"]
    if value is None:
        return None
    if not isinstance(value, dict):
        errors.append("adapter 必须是对象（或 null）")
        return None

    unknown = set(value) - _ADAPTER_KEYS
    if unknown:
        errors.append(f"adapter 未知字段: {', '.join(sorted(unknown))}")

    factory = value.get("factory")
    if not isinstance(factory, str) or not _FACTORY_RE.match(factory):
        errors.append("adapter.factory 格式应为 module:factory")

    options = value.get("options", {})
    if not isinstance(options, dict):
        errors.append("adapter.options 必须是 JSON 对象")
        options = {}
    else:
        problem = _json_problem(options)
        if problem:
            errors.append(f"adapter.options 含非法 JSON 值: {problem}")

    if errors:
        return None
    return AdapterConfig(factory=factory, options=options)


def _parse_defaults(
    raw: dict[str, Any], errors: list[str]
) -> tuple[float, int]:
    interval = DEFAULT_INTERVAL_SECONDS
    max_attempts = DEFAULT_MAX_ATTEMPTS
    if "defaults" not in raw:
        return interval, max_attempts
    value = raw["defaults"]
    if not isinstance(value, dict):
        errors.append("defaults 必须是对象")
        return interval, max_attempts

    unknown = set(value) - _DEFAULTS_KEYS
    if unknown:
        errors.append(f"defaults 未知字段: {', '.join(sorted(unknown))}")

    if "interval_seconds" in value:
        interval = _parse_interval(value["interval_seconds"], errors)
    if "max_attempts" in value:
        max_attempts = _parse_max_attempts(
            value["max_attempts"], errors, label="defaults.max_attempts"
        )
    return interval, max_attempts


def _parse_interval(value: Any, errors: list[str]) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        errors.append("defaults.interval_seconds 必须是 ≥1 的秒数")
        return DEFAULT_INTERVAL_SECONDS
    number = float(value)
    if not math.isfinite(number) or not MIN_INTERVAL_SECONDS <= number <= MAX_INTERVAL_SECONDS:
        errors.append(
            f"defaults.interval_seconds 必须在 {MIN_INTERVAL_SECONDS}-{MAX_INTERVAL_SECONDS} 秒之间"
        )
        return DEFAULT_INTERVAL_SECONDS
    return number


def _parse_attempts(value: Any, errors: list[str], label: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not MIN_ATTEMPTS <= value <= MAX_ATTEMPTS:
        errors.append(f"{label} 必须是 {MIN_ATTEMPTS}-{MAX_ATTEMPTS} 的整数")
        return None
    return value


def _parse_max_attempts(value: Any, errors: list[str], label: str) -> int:
    parsed = _parse_attempts(value, errors, label)
    return DEFAULT_MAX_ATTEMPTS if parsed is None else parsed


def _parse_tasks(raw: dict[str, Any], errors: list[str], config_path: Path) -> list[TaskConfig]:
    if "tasks" not in raw:
        errors.append("缺少 tasks 配置")
        return []
    value = raw["tasks"]
    if not isinstance(value, list):
        errors.append("tasks 必须是数组")
        return []

    tasks: list[TaskConfig] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(value, start=1):
        task = _parse_task(index, item, errors, seen_ids)
        if task is not None:
            tasks.append(task)

    _check_dependencies(tasks, errors)
    return tasks


def _parse_task(
    index: int,
    raw: Any,
    errors: list[str],
    seen_ids: set[str],
) -> TaskConfig | None:
    before = len(errors)
    if not isinstance(raw, dict):
        errors.append(f"任务 #{index} 必须是对象")
        return None

    task_id = raw.get("id")
    if isinstance(task_id, str) and _TASK_ID_RE.match(task_id):
        label = task_id
        if task_id in seen_ids:
            errors.append(f"任务 id 重复: {task_id}")
        seen_ids.add(task_id)
    else:
        label = f"#{index}"
        errors.append(f"任务 id 不合法（1-64 位字母/数字/下划线/点/连字符）: {task_id!r}")
        task_id = None

    unknown = set(raw) - _TASK_KEYS
    if unknown:
        errors.append(f"任务 {label} 未知字段: {', '.join(sorted(unknown))}")

    action = raw.get("action")
    if not isinstance(action, str) or not _ACTION_RE.match(action):
        errors.append(f"action 必须是合法动作名（小写字母、数字、下划线）: {action!r}")

    start = _require_time(raw, "start", label, errors)
    end = _require_time(raw, "end", label, errors)
    if start and end:
        if start == end:
            errors.append(f"任务 {label} 时窗不能为空（start 必须早于 end）: {start}-{end}")
        elif start > end:
            errors.append(f"任务 {label} 时窗非法（不支持跨夜）: {start}-{end}")

    weekdays = _parse_weekdays(raw, label, errors)

    enabled = raw.get("enabled", False)
    if not isinstance(enabled, bool):
        errors.append(f"任务 {label} enabled 必须是布尔值: {enabled!r}")
        enabled = False

    depends_on = _parse_depends_on(raw, label, errors)

    max_attempts = _parse_attempts(
        raw.get("max_attempts"), errors, label=f"任务 {label} max_attempts"
    )

    payload = raw.get("payload", {})
    if not isinstance(payload, dict):
        errors.append(f"任务 {label} payload 必须是 JSON 对象")
        payload = {}
    else:
        problem = _json_problem(payload)
        if problem:
            errors.append(f"任务 {label} payload 含非法 JSON 值: {problem}")
        elif enabled and _payload_is_placeholder(payload):
            errors.append(f"任务 {label} 已启用但 payload 仍为占位（请填写真实参数）")

    if len(errors) != before:
        return None
    assert isinstance(task_id, str) and isinstance(action, str)
    return TaskConfig(
        id=task_id,
        action=action,
        start=start,
        end=end,
        weekdays=weekdays,
        enabled=enabled,
        depends_on=depends_on,
        max_attempts=max_attempts,
        payload=payload,
    )


def _require_time(raw: dict[str, Any], key: str, label: str, errors: list[str]) -> str | None:
    if key not in raw:
        errors.append(f"任务 {label} 缺少 {key}")
        return None
    value = raw[key]
    if not isinstance(value, str) or not _TIME_RE.match(value):
        errors.append(f"任务 {label} {key} 时窗格式必须是 HH:MM: {value!r}")
        return None
    return value


def _parse_weekdays(raw: dict[str, Any], label: str, errors: list[str]) -> tuple[int, ...]:
    value = raw.get("weekdays", (1, 2, 3, 4, 5, 6, 7))
    if not isinstance(value, (list, tuple)) or len(value) == 0:
        errors.append(f"任务 {label} 工作日不能为空")
        return (1, 2, 3, 4, 5, 6, 7)
    days: set[int] = set()
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int) or not 1 <= item <= 7:
            errors.append(f"任务 {label} 工作日必须是 1-7 的整数（1=周一，7=周日）: {item!r}")
            return (1, 2, 3, 4, 5, 6, 7)
        days.add(item)
    return tuple(sorted(days))


def _parse_depends_on(raw: dict[str, Any], label: str, errors: list[str]) -> tuple[str, ...]:
    value = raw.get("depends_on", ())
    if not isinstance(value, (list, tuple)):
        errors.append(f"任务 {label} depends_on 必须是数组")
        return ()
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not _TASK_ID_RE.match(item):
            errors.append(f"任务 {label} depends_on 含非法任务 id: {item!r}")
            continue
        if item not in result:
            result.append(item)
    return tuple(result)


def _payload_is_placeholder(payload: dict[str, Any]) -> bool:
    if not payload:
        return True
    return any(
        key.strip().lower() in PLACEHOLDER_KEYS and bool(value)
        for key, value in payload.items()
        if isinstance(key, str)
    )


def _json_problem(value: Any, depth: int = 0) -> str | None:
    """检查 payload/options 是否为可安全序列化的 JSON 值。"""

    if depth > 8:
        return "嵌套层级过深"
    if value is None or isinstance(value, (str, bool)):
        return None
    if isinstance(value, int):
        return None
    if isinstance(value, float):
        return None if math.isfinite(value) else "非有限数字"
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or not key:
                return "对象键必须是非空字符串"
            problem = _json_problem(item, depth + 1)
            if problem:
                return problem
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            problem = _json_problem(item, depth + 1)
            if problem:
                return problem
        return None
    return f"不支持的 JSON 类型: {type(value).__name__}"


def _check_dependencies(tasks: list[TaskConfig], errors: list[str]) -> None:
    known = {task.id for task in tasks}
    graph: dict[str, list[str]] = {}
    for task in tasks:
        edges: list[str] = []
        for dep in task.depends_on:
            if dep not in known:
                errors.append(f"任务 {task.id} 依赖未知任务: {dep}")
            else:
                edges.append(dep)
        graph[task.id] = edges

    for cycle in _find_cycles(graph):
        errors.append(f"任务依赖存在循环: {' -> '.join(cycle)}")


def _find_cycles(graph: dict[str, list[str]]) -> list[list[str]]:
    """返回依赖图中的所有循环路径（每个环一次）。"""

    WHITE, GRAY, BLACK = 0, 1, 2
    color = {node: WHITE for node in graph}
    cycles: list[list[str]] = []
    stack: list[str] = []
    positions: dict[str, int] = {}

    def visit(node: str) -> None:
        color[node] = GRAY
        positions[node] = len(stack)
        stack.append(node)
        for neighbor in graph.get(node, ()):
            if color.get(neighbor) == GRAY:
                cycle = stack[positions[neighbor]:] + [neighbor]
                cycles.append(cycle)
            elif color.get(neighbor) == WHITE:
                visit(neighbor)
        stack.pop()
        positions.pop(node, None)
        color[node] = BLACK

    for node in graph:
        if color[node] == WHITE:
            visit(node)
    return cycles
