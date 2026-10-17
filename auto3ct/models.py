"""auto3ct 调度核心的数据模型（纯本地、无网络）。

本模块只包含不可变数据结构与输入校验。真正的第三方业务操作由调用方传入的
``handler`` 完成，调度核心不接触账号、网络或任何第三方接口。
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Mapping, Sequence

ALL_WEEKDAYS: tuple[int, ...] = (1, 2, 3, 4, 5, 6, 7)
"""ISO 星期编号：1=周一 … 7=周日。"""

#: ``ActionResult.status`` 允许的取值（handler 的业务结果类型）。
ACTION_SUCCESS = "success"
ACTION_RETRY = "retry"
ACTION_BLOCKED = "blocked"
ACTION_UNKNOWN = "unknown"
ACTION_STATUSES = frozenset({ACTION_SUCCESS, ACTION_RETRY, ACTION_BLOCKED, ACTION_UNKNOWN})

#: ``runs`` 表中记录的状态。
RUN_IN_FLIGHT = "in_flight"
RUN_SUCCESS = "success"
RUN_RETRY = "retry"
RUN_BLOCKED = "blocked"
RUN_UNKNOWN = "unknown"
RUN_FAILED = "failed"
RUN_WAITING_DEPENDENCY = "waiting_dependency"
RUN_WINDOW_EXPIRED = "window_expired"

#: 终态：命中后当天不再对同一任务自动提交。
TERMINAL_RUN_STATUSES = frozenset(
    {RUN_SUCCESS, RUN_BLOCKED, RUN_UNKNOWN, RUN_FAILED, RUN_WINDOW_EXPIRED}
)

#: ``run_due`` 返回的 ``RunResult.status`` 中表示“本次没有真实执行”的原因。
RESULT_ALREADY_DONE = "already_done"
RESULT_NOT_DUE = "not_due"
RESULT_IN_FLIGHT = "in_flight"
RESULT_RETRY_WAITING = "retry_waiting"
RESULT_WAITING_DEPENDENCY = "waiting_dependency"
RESULT_WINDOW_EXPIRED = "window_expired"
RESULT_DRY_RUN = "dry_run"

_HHMM_PATTERN = re.compile(r"\A(?:[01]\d|2[0-3]):[0-5]\d\Z")


def parse_hhmm(value: str) -> int:
    """把 ``"HH:MM"`` 解析为当日分钟数；格式非法时抛 ``ValueError``。"""

    if not isinstance(value, str):
        raise ValueError(f"时间必须为 'HH:MM' 字符串，收到 {value!r}")
    if _HHMM_PATTERN.match(value) is None:
        raise ValueError(f"时间格式必须为 'HH:MM'（00:00-23:59），收到 {value!r}")
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


@dataclass(frozen=True)
class ActionResult:
    """一次 handler 调用的业务结果。

    ``status``:
    - ``success``：确认成功；
    - ``retry``：可重试，``retry_after`` 为距下次尝试的秒数（``None`` 用调度默认值）；
    - ``blocked``：明确阻断（前置条件/账号问题），不自动重试；
    - ``unknown``：结果未知（可能已提交），不自动重复业务提交。
    """

    status: str
    message: str = ""
    retry_after: float | None = None

    def __post_init__(self) -> None:
        if self.status not in ACTION_STATUSES:
            raise ValueError(
                f"ActionResult.status 非法: {self.status!r}，允许 {sorted(ACTION_STATUSES)}"
            )
        if not isinstance(self.message, str):
            raise ValueError("ActionResult.message 必须为字符串")
        if self.retry_after is not None:
            if isinstance(self.retry_after, bool) or not isinstance(
                self.retry_after, (int, float)
            ):
                raise ValueError("ActionResult.retry_after 必须为秒数或 None")
            if not math.isfinite(self.retry_after):
                raise ValueError("ActionResult.retry_after 必须为有限数值（不允许 NaN/Inf）")
            if self.retry_after < 0:
                raise ValueError("ActionResult.retry_after 不能为负数")
            object.__setattr__(self, "retry_after", float(self.retry_after))

    @classmethod
    def success(cls, message: str = "") -> ActionResult:
        return cls(ACTION_SUCCESS, message)

    @classmethod
    def retry(cls, message: str = "", retry_after: float | None = None) -> ActionResult:
        return cls(ACTION_RETRY, message, retry_after)

    @classmethod
    def blocked(cls, message: str = "") -> ActionResult:
        return cls(ACTION_BLOCKED, message)

    @classmethod
    def unknown(cls, message: str = "") -> ActionResult:
        return cls(ACTION_UNKNOWN, message)


@dataclass(frozen=True)
class Task:
    """一个每日调度的任务定义。

    ``start``/``end`` 为本地时区的 ``"HH:MM"``，只支持当天窗口（``start <= end``）。
    ``weekdays`` 为 ISO 星期编号（1=周一 … 7=周日）。
    ``depends_on`` 中的任务必须在同一个本地日期成功后才执行本任务。
    ``max_attempts=None`` 时使用 :class:`~auto3ct.scheduler.Scheduler` 的默认值。
    """

    id: str
    action: str
    start: str = "00:00"
    end: str = "23:59"
    payload: Mapping[str, Any] = field(default_factory=dict)
    weekdays: Sequence[int] = ALL_WEEKDAYS
    enabled: bool = True
    depends_on: Sequence[str] = ()
    max_attempts: int | None = None

    def __post_init__(self) -> None:
        for name in ("id", "action"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"Task.{name} 必须为非空字符串")
            object.__setattr__(self, name, value.strip())

        if parse_hhmm(self.start) > parse_hhmm(self.end):
            raise ValueError(
                f"Task.start ({self.start}) 不能晚于 Task.end ({self.end})；不支持跨午夜窗口"
            )

        weekdays = self.weekdays
        if weekdays is None:
            weekdays = ALL_WEEKDAYS
        if isinstance(weekdays, (str, bytes)) or not isinstance(weekdays, Sequence):
            raise ValueError("Task.weekdays 必须为 1..7 的整数序列")
        normalized_days: set[int] = set()
        for day in weekdays:
            if isinstance(day, bool) or not isinstance(day, int):
                raise ValueError(
                    "Task.weekdays 只能包含整数（1=周一 … 7=周日），"
                    f"不接受 bool/float/str: {day!r}"
                )
            if day not in ALL_WEEKDAYS:
                raise ValueError("Task.weekdays 必须为 1..7 的非空集合（1=周一）")
            normalized_days.add(day)
        if not normalized_days:
            raise ValueError("Task.weekdays 必须为 1..7 的非空集合（1=周一）")
        object.__setattr__(self, "weekdays", tuple(sorted(normalized_days)))

        if not isinstance(self.enabled, bool):
            raise ValueError("Task.enabled 必须为 bool")

        payload = self.payload
        if payload is None:
            payload = {}
        if not isinstance(payload, Mapping):
            raise ValueError("Task.payload 必须为 Mapping（dict）")
        object.__setattr__(self, "payload", dict(payload))

        depends_on = self.depends_on
        if depends_on is None:
            depends_on = ()
        if isinstance(depends_on, (str, bytes)) or not isinstance(depends_on, Sequence):
            raise ValueError("Task.depends_on 必须为任务 id 序列")
        cleaned_dependencies: list[str] = []
        for dependency in depends_on:
            if not isinstance(dependency, str) or not dependency.strip():
                raise ValueError("Task.depends_on 中的任务 id 必须为非空字符串")
            cleaned_dependencies.append(dependency.strip())
        object.__setattr__(self, "depends_on", tuple(dict.fromkeys(cleaned_dependencies)))

        if self.max_attempts is not None:
            if (
                isinstance(self.max_attempts, bool)
                or not isinstance(self.max_attempts, int)
                or self.max_attempts < 1
            ):
                raise ValueError("Task.max_attempts 必须为 >=1 的整数或 None")

    @property
    def task_id(self) -> str:
        """``id`` 的只读别名（兼容两种字段命名）。"""

        return self.id

    @property
    def start_minute(self) -> int:
        return parse_hhmm(self.start)

    @property
    def end_minute(self) -> int:
        return parse_hhmm(self.end)

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> Task:
        """从 dict 构造 Task；同时接受 ``task_id`` 作为 ``id`` 的输入别名。"""

        if not isinstance(data, Mapping):
            raise ValueError(f"Task 需要 Mapping，收到 {type(data).__name__}")
        values = dict(data)
        if "id" not in values and "task_id" in values:
            values["id"] = values.pop("task_id")
        allowed = {
            "id",
            "action",
            "start",
            "end",
            "payload",
            "weekdays",
            "enabled",
            "depends_on",
            "max_attempts",
        }
        unknown = set(values) - allowed
        if unknown:
            raise ValueError(f"Task 不支持字段: {sorted(unknown)}")
        return cls(**values)


@dataclass(frozen=True)
class RunResult:
    """``run_due`` 对单个任务返回的本次处理结果。"""

    task_id: str
    action: str
    run_key: str
    local_date: date
    status: str
    message: str = ""
    attempt: int = 0
    next_attempt: datetime | None = None
    would_run: bool = False
    dry_run: bool = False

    @property
    def id(self) -> str:
        """``task_id`` 的只读别名。"""

        return self.task_id

    @property
    def succeeded(self) -> bool:
        return self.status == ACTION_SUCCESS


@dataclass(frozen=True)
class RunRecord:
    """``runs`` 表中的一条历史记录。"""

    run_key: str
    task_id: str
    action: str
    local_date: date
    status: str
    message: str = ""
    attempt: int = 0
    next_attempt: datetime | None = None
    updated_at: datetime | None = None

    @property
    def id(self) -> str:
        """``task_id`` 的只读别名。"""

        return self.task_id
