"""auto3ct 持久化每日调度核心（纯本地、SQLite、无网络）。

设计要点
--------
- 所有状态落在 SQLite：``tasks`` 保存任务定义，``runs`` 保存每日执行记录；
- 每日按**本地日期**去重：``run_key = f"{local_date}::{task_id}"`` 且为唯一主键，
  因此重启恢复、多进程并发都不会对同一任务同一天重复提交；
- 任务只在 ``[start, end]`` 时间窗内执行，窗口过期不补；
- ``depends_on`` 依赖必须在同一本地日期 ``success`` 后才执行；
- 有限重试：``runs.attempt`` 计数 + ``runs.next_attempt`` 到点再试，超过
  ``max_attempts`` 记 ``failed`` 终态；
- ``blocked`` / ``unknown`` / ``failed`` / ``window_expired`` / ``success`` 都是终态：
  当天不再自动提交（``unknown`` 表示可能已提交，绝不盲目重复）；
- ``in_flight`` 记录带 lease：lease 内视为其它进程正在执行（跳过），lease 过期视为
  进程崩溃，标记 ``unknown`` 且不自动重提；
- ``dry_run`` 只读：不调用 handler、不写 ``runs``（构造时的建表/建目录除外）。

中国市场无夏令时，默认使用固定 ``+08:00`` 的 ``Asia/Shanghai``，避免依赖 tzdata。
"""

from __future__ import annotations

import json
import math
import sqlite3
import uuid
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from .models import (
    ACTION_BLOCKED,
    ACTION_RETRY,
    ACTION_SUCCESS,
    ACTION_UNKNOWN,
    ALL_WEEKDAYS,
    RESULT_ALREADY_DONE,
    RESULT_DRY_RUN,
    RESULT_IN_FLIGHT,
    RESULT_NOT_DUE,
    RESULT_RETRY_WAITING,
    RESULT_WAITING_DEPENDENCY,
    RESULT_WINDOW_EXPIRED,
    RUN_BLOCKED,
    RUN_FAILED,
    RUN_IN_FLIGHT,
    RUN_RETRY,
    RUN_SUCCESS,
    RUN_UNKNOWN,
    RUN_WAITING_DEPENDENCY,
    RUN_WINDOW_EXPIRED,
    TERMINAL_RUN_STATUSES,
    ActionResult,
    RunRecord,
    RunResult,
    Task,
)

__all__ = ["SHANGHAI_TZ", "Handler", "Scheduler"]

#: handler 签名：接收任务定义与当次 run_key，返回业务结果。
Handler = Callable[[Task, str], ActionResult]

#: 默认时区：中国无夏令时，固定 +08:00 即为 Asia/Shanghai。
SHANGHAI_TZ = timezone(timedelta(hours=8), "Asia/Shanghai")

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    weekdays TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL DEFAULT '{}',
    depends_on TEXT NOT NULL DEFAULT '[]',
    max_attempts INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
    run_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    action TEXT NOT NULL,
    local_date TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    attempt INTEGER NOT NULL DEFAULT 0,
    next_attempt TEXT,
    lease_expires_at TEXT,
    claim_token TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_task_date ON runs (task_id, local_date);
CREATE INDEX IF NOT EXISTS idx_runs_local_date ON runs (local_date);
"""

_TASK_FIELDS = (
    "task_id, action, start, end, weekdays, enabled, payload, depends_on, max_attempts"
)

_RUN_FIELDS = (
    "run_key, task_id, action, local_date, status, message, attempt, "
    "next_attempt, lease_expires_at, claim_token, created_at, updated_at"
)

_INSERT_RUN_SQL = f"INSERT OR IGNORE INTO runs ({_RUN_FIELDS}) VALUES ({', '.join(['?'] * 12)})"


class Scheduler:
    """SQLite 持久化的每日调度器。

    :param db_path: SQLite 文件路径（父目录不存在会自动创建；不支持 ``:memory:``）。
    :param tz: 时区，默认固定 ``+08:00`` 的 ``Asia/Shanghai``。
    :param lease_seconds: ``in_flight`` 记录的 lease 时长；超过即视为进程崩溃。
    :param max_attempts: 默认最多尝试次数（``Task.max_attempts`` 可覆盖）。
    :param retry_delay: ``ActionResult.retry`` 未给出 ``retry_after`` 时的默认秒数。
    """

    def __init__(
        self,
        db_path: str | Path,
        tz: tzinfo | None = None,
        lease_seconds: float = 300.0,
        max_attempts: int = 3,
        retry_delay: float = 60.0,
    ) -> None:
        if isinstance(db_path, Path):
            raw_path = str(db_path)
        elif isinstance(db_path, str) and db_path.strip():
            raw_path = db_path
        else:
            raise ValueError("db_path 必须为非空字符串或 pathlib.Path")
        if raw_path == ":memory:":
            raise ValueError("Scheduler 需要持久化文件路径，不支持 ':memory:'")

        if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, (int, float)):
            raise ValueError("lease_seconds 必须为秒数")
        if not math.isfinite(lease_seconds):
            raise ValueError("lease_seconds 必须为有限数值（不允许 NaN/Inf）")
        if lease_seconds < 0:
            raise ValueError("lease_seconds 不能为负数")
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int):
            raise ValueError("max_attempts 必须为整数")
        if max_attempts < 1:
            raise ValueError("max_attempts 必须 >= 1")
        if isinstance(retry_delay, bool) or not isinstance(retry_delay, (int, float)):
            raise ValueError("retry_delay 必须为秒数")
        if not math.isfinite(retry_delay):
            raise ValueError("retry_delay 必须为有限数值（不允许 NaN/Inf）")
        if retry_delay < 0:
            raise ValueError("retry_delay 不能为负数")
        if tz is not None and not isinstance(tz, tzinfo):
            raise ValueError("tz 必须为 datetime.tzinfo 或 None")

        self.db_path = raw_path
        self.tz: tzinfo = tz if tz is not None else SHANGHAI_TZ
        self.lease_seconds = float(lease_seconds)
        self.max_attempts = int(max_attempts)
        self.retry_delay = float(retry_delay)

        Path(self.db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    # ------------------------------------------------------------------ 任务定义

    def add_task(self, task: Task | Mapping[str, Any]) -> None:
        """新增或更新单个任务定义（按 task id upsert）。"""

        normalized = self._coerce_task(task)
        conn = self._connect()
        try:
            self._upsert_task_row(conn, normalized)
        finally:
            conn.close()

    def replace_tasks(self, tasks: Iterable[Task | Mapping[str, Any]]) -> None:
        """全量替换任务定义（幂等）：不在列表中的任务定义会被删除，``runs`` 历史保留。"""

        normalized: list[Task] = []
        seen: set[str] = set()
        for item in tasks:
            task = self._coerce_task(item)
            if task.id in seen:
                raise ValueError(f"replace_tasks 中出现重复任务 id: {task.id!r}")
            seen.add(task.id)
            normalized.append(task)

        conn = self._connect()
        self._begin(conn)
        try:
            for task in normalized:
                self._upsert_task_row(conn, task)
            if normalized:
                placeholders = ", ".join(["?"] * len(normalized))
                conn.execute(
                    f"DELETE FROM tasks WHERE task_id NOT IN ({placeholders})",
                    [task.id for task in normalized],
                )
            else:
                conn.execute("DELETE FROM tasks")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def list_tasks(self) -> list[Task]:
        """返回全部任务定义（含 disabled），按任务 id 排序，可作为任务候选查询。"""

        conn = self._connect()
        try:
            rows = conn.execute("SELECT * FROM tasks ORDER BY task_id").fetchall()
        finally:
            conn.close()
        return [self._task_from_row(row) for row in rows]

    # ------------------------------------------------------------------ 调度入口

    def run_due(
        self,
        handler: Handler | None,
        now: datetime | None = None,
        dry_run: bool = False,
    ) -> list[RunResult]:
        """处理当前到期的任务。

        :param handler: ``handler(task, run_key) -> ActionResult``；``dry_run=True`` 时可为 None。
        :param now: 参考时间；aware 会转成本地时区，naive 视为本地时间，None 取当前时间。
        :param dry_run: 只读模式：不调用 handler、不写 ``runs``、不推进任何状态。
        :return: 每个“被考虑的候选任务”一条 :class:`RunResult`（含未执行原因）。
        """

        if handler is not None and not callable(handler):
            raise ValueError("handler 必须可调用")
        if handler is None and not dry_run:
            raise ValueError("非 dry-run 模式必须提供 handler(task, run_key)")

        now_local = self._localize(now)
        local_date = now_local.date()
        tasks = self._load_tasks()
        tasks_by_id = {task.id: task for task in tasks}

        results: list[RunResult] = []
        for task in tasks:
            if not task.enabled:
                continue
            if local_date.isoweekday() not in task.weekdays:
                continue
            start_dt, end_dt = self._window(task, local_date)
            if now_local < start_dt:
                results.append(
                    self._make_result(
                        task,
                        local_date,
                        RESULT_NOT_DUE,
                        message=f"时间窗 {task.start}-{task.end} 尚未开始",
                        next_attempt=start_dt,
                    )
                )
                continue
            if dry_run:
                results.append(
                    self._plan_dry_run(task, local_date, now_local, end_dt, tasks_by_id)
                )
            else:
                assert handler is not None  # 已在入口校验
                results.append(
                    self._execute(task, local_date, now_local, end_dt, handler, tasks_by_id)
                )
        return results

    # ------------------------------------------------------------------ 执行流程

    def _execute(
        self,
        task: Task,
        local_date: date,
        now: datetime,
        end_dt: datetime,
        handler: Handler,
        tasks_by_id: Mapping[str, Task],
    ) -> RunResult:
        run_key = self._run_key(task.id, local_date)
        conn = self._connect()
        try:
            row = self._get_run(conn, run_key)
            blocked = self._pre_run_result(conn, task, run_key, local_date, now, row)
            if blocked is not None:
                return blocked

            if now > end_dt:
                return self._record_window_expired(conn, task, run_key, local_date, now, row)

            dependency_result = self._dependency_gate(
                conn, task, run_key, local_date, now, tasks_by_id, row, dry_run=False
            )
            if dependency_result is not None:
                return dependency_result

            claim_token = self._claim(conn, task, run_key, local_date, now, row)
            if claim_token is None:
                # 并发竞争失败：重新读取并给出当前状态，绝不重复提交。
                row = self._get_run(conn, run_key)
                current = self._pre_run_result(conn, task, run_key, local_date, now, row)
                if current is not None:
                    return current
                return self._make_result(
                    task,
                    local_date,
                    RESULT_IN_FLIGHT,
                    message="并发 claim 冲突，本次未提交",
                    attempt=int(row["attempt"] or 0) if row is not None else 0,
                )

            attempt = self._current_attempt(conn, run_key)
            try:
                outcome: Any = handler(task, run_key)
            except Exception:  # noqa: BLE001 - 异常一律视为结果未知，且不把异常原文落盘
                outcome = ActionResult.unknown("handler 异常（结果未知，请核查）")
            if outcome is None:
                outcome = ActionResult.unknown("handler 未返回 ActionResult")
            elif not isinstance(outcome, ActionResult):
                outcome = ActionResult.unknown(
                    f"handler 返回了非法类型: {type(outcome).__name__}"
                )

            return self._finalize(conn, task, run_key, local_date, now, claim_token, attempt, outcome)
        finally:
            conn.close()

    def _pre_run_result(
        self,
        conn: sqlite3.Connection,
        task: Task,
        run_key: str,
        local_date: date,
        now: datetime,
        row: sqlite3.Row | None,
        dry_run: bool = False,
    ) -> RunResult | None:
        """处理已存在的 run 记录。

        返回 ``RunResult`` 表示本次不执行；返回 ``None`` 表示可以继续尝试执行。
        """

        if row is None:
            return None
        status = row["status"]
        attempt = int(row["attempt"] or 0)

        if status in TERMINAL_RUN_STATUSES:
            return self._terminal_result(task, local_date, row)

        if status == RUN_IN_FLIGHT:
            lease = self._parse_dt(row["lease_expires_at"])
            if lease is not None and now < lease:
                return self._make_result(
                    task,
                    local_date,
                    RESULT_IN_FLIGHT,
                    message="其它进程正在执行（lease 未过期），本次跳过",
                    attempt=attempt,
                )
            message = "进程中断：in-flight lease 已过期，提交结果未知，不自动重复"
            if dry_run:
                return self._make_result(
                    task, local_date, RUN_UNKNOWN, message=message, attempt=attempt
                )
            # CAS：只有“仍是这条 in-flight 记录的持有者”才能把它标成 unknown，
            # 防止别的进程在读到 stale lease 后已 finalize success，被这里覆盖。
            updated = self._write_terminal(
                conn,
                run_key,
                RUN_UNKNOWN,
                message,
                now,
                expected_status=RUN_IN_FLIGHT,
                claim_token=row["claim_token"],
            )
            if updated:
                return self._make_result(
                    task, local_date, RUN_UNKNOWN, message=message, attempt=attempt
                )
            return self._result_from_row(conn, task, run_key, local_date, now)

        if status == RUN_RETRY:
            next_attempt = self._parse_dt(row["next_attempt"])
            if next_attempt is not None and now < next_attempt:
                return self._make_result(
                    task,
                    local_date,
                    RESULT_RETRY_WAITING,
                    message=f"未到重试时间（{next_attempt.isoformat()}）",
                    attempt=attempt,
                    next_attempt=next_attempt,
                )

        return None

    def _plan_dry_run(
        self,
        task: Task,
        local_date: date,
        now: datetime,
        end_dt: datetime,
        tasks_by_id: Mapping[str, Task],
    ) -> RunResult:
        """只读规划：只报告“本会怎么处理”，不调用 handler、不写库。"""

        run_key = self._run_key(task.id, local_date)
        conn = self._connect()
        try:
            row = self._get_run(conn, run_key)
            blocked = self._pre_run_result(
                conn, task, run_key, local_date, now, row, dry_run=True
            )
            if blocked is not None:
                return replace(blocked, dry_run=True)

            if now > end_dt:
                return self._make_result(
                    task,
                    local_date,
                    RESULT_WINDOW_EXPIRED,
                    message="时间窗已结束（dry-run，不写入）",
                    attempt=int(row["attempt"] or 0) if row is not None else 0,
                    dry_run=True,
                )

            dependency_result = self._dependency_gate(
                conn, task, run_key, local_date, now, tasks_by_id, row, dry_run=True
            )
            if dependency_result is not None:
                return dependency_result

            attempt = (int(row["attempt"]) + 1) if row is not None else 1
            return self._make_result(
                task,
                local_date,
                RESULT_DRY_RUN,
                message=f"dry-run：将执行 {task.action}",
                attempt=attempt,
                would_run=True,
                dry_run=True,
            )
        finally:
            conn.close()

    def _dependency_gate(
        self,
        conn: sqlite3.Connection,
        task: Task,
        run_key: str,
        local_date: date,
        now: datetime,
        tasks_by_id: Mapping[str, Task],
        row: sqlite3.Row | None,
        dry_run: bool,
    ) -> RunResult | None:
        """依赖未满足时返回结果；满足时返回 ``None``。"""

        if not task.depends_on:
            return None

        for dependency_id in task.depends_on:
            dependency_task = tasks_by_id.get(dependency_id)
            dependency_key = self._run_key(dependency_id, local_date)
            dependency_row = self._get_run(conn, dependency_key)
            if dependency_row is not None and dependency_row["status"] == RUN_SUCCESS:
                continue

            if dependency_task is None:
                return self._record_dependency_gate(
                    conn,
                    task,
                    run_key,
                    local_date,
                    now,
                    row,
                    RUN_BLOCKED,
                    f"依赖任务 {dependency_id} 未定义，无法执行",
                    dry_run,
                )
            if local_date.isoweekday() not in dependency_task.weekdays:
                return self._record_dependency_gate(
                    conn,
                    task,
                    run_key,
                    local_date,
                    now,
                    row,
                    RUN_BLOCKED,
                    f"依赖任务 {dependency_id} 今天不调度，无法执行",
                    dry_run,
                )

            dependency_status = dependency_row["status"] if dependency_row is not None else None
            dependency_failed = dependency_status in {
                RUN_WINDOW_EXPIRED,
                RUN_FAILED,
                RUN_BLOCKED,
                RUN_UNKNOWN,
            }
            _, dependency_end = self._window(dependency_task, local_date)
            if dependency_failed or now > dependency_end:
                reason = dependency_status or "未执行"
                return self._record_dependency_gate(
                    conn,
                    task,
                    run_key,
                    local_date,
                    now,
                    row,
                    RUN_BLOCKED,
                    f"依赖任务 {dependency_id} 未成功（{reason}），放弃执行",
                    dry_run,
                )
            return self._record_dependency_gate(
                conn,
                task,
                run_key,
                local_date,
                now,
                row,
                RUN_WAITING_DEPENDENCY,
                f"等待依赖任务 {dependency_id} 成功",
                dry_run,
            )
        return None

    # ------------------------------------------------------------------ 状态写入

    def _record_dependency_gate(
        self,
        conn: sqlite3.Connection,
        task: Task,
        run_key: str,
        local_date: date,
        now: datetime,
        row: sqlite3.Row | None,
        status: str,
        message: str,
        dry_run: bool,
    ) -> RunResult:
        result_status = (
            RESULT_WAITING_DEPENDENCY if status == RUN_WAITING_DEPENDENCY else RUN_BLOCKED
        )
        attempt = int(row["attempt"] or 0) if row is not None else 0
        if dry_run:
            return self._make_result(
                task, local_date, result_status, message=message, attempt=attempt, dry_run=True
            )

        timestamp = self._iso(now)
        self._begin(conn)
        try:
            if row is None:
                cursor = conn.execute(
                    _INSERT_RUN_SQL,
                    (
                        run_key,
                        task.id,
                        task.action,
                        local_date.isoformat(),
                        status,
                        message,
                        0,
                        None,
                        None,
                        None,
                        timestamp,
                        timestamp,
                    ),
                )
            else:
                cursor = conn.execute(
                    "UPDATE runs SET status = ?, message = ?, next_attempt = NULL, "
                    "lease_expires_at = NULL, claim_token = NULL, updated_at = ? "
                    "WHERE run_key = ? AND status IN (?, ?)",
                    (status, message, timestamp, run_key, RUN_RETRY, RUN_WAITING_DEPENDENCY),
                )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        if cursor.rowcount != 1:
            # 并发下记录已被抢占/终态化：回读最新状态，不覆盖对方
            return self._result_from_row(conn, task, run_key, local_date, now)
        return self._make_result(task, local_date, result_status, message=message, attempt=attempt)

    def _record_window_expired(
        self,
        conn: sqlite3.Connection,
        task: Task,
        run_key: str,
        local_date: date,
        now: datetime,
        row: sqlite3.Row | None,
    ) -> RunResult:
        attempt = int(row["attempt"] or 0) if row is not None else 0
        message = "时间窗已结束，过期不再补执行"
        timestamp = self._iso(now)
        self._begin(conn)
        try:
            if row is None:
                cursor = conn.execute(
                    _INSERT_RUN_SQL,
                    (
                        run_key,
                        task.id,
                        task.action,
                        local_date.isoformat(),
                        RUN_WINDOW_EXPIRED,
                        message,
                        0,
                        None,
                        None,
                        None,
                        timestamp,
                        timestamp,
                    ),
                )
            else:
                cursor = conn.execute(
                    "UPDATE runs SET status = ?, message = ?, next_attempt = NULL, "
                    "lease_expires_at = NULL, claim_token = NULL, updated_at = ? "
                    "WHERE run_key = ? AND status IN (?, ?)",
                    (
                        RUN_WINDOW_EXPIRED,
                        message,
                        timestamp,
                        run_key,
                        RUN_RETRY,
                        RUN_WAITING_DEPENDENCY,
                    ),
                )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        if cursor.rowcount != 1:
            # 并发下被抢占/终态化：回读最新状态，不覆盖对方
            return self._result_from_row(conn, task, run_key, local_date, now)
        return self._make_result(
            task, local_date, RESULT_WINDOW_EXPIRED, message=message, attempt=attempt
        )

    def _terminal_result(
        self, task: Task, local_date: date, row: sqlite3.Row
    ) -> RunResult:
        """把一条终态记录映射成对外结果（只读，不写库）。"""

        status = row["status"]
        if status == RUN_SUCCESS:
            message = "当天已成功，不重复执行"
        elif status == RUN_FAILED:
            message = "重试次数已耗尽，不再自动提交"
        elif status == RUN_UNKNOWN:
            message = "上次执行结果未知，不自动重复业务提交"
        elif status == RUN_BLOCKED:
            message = row["message"] or "当天已阻断，不再自动提交"
        else:
            message = "当天时间窗已结束，不补执行"
        result_status = (
            RESULT_WINDOW_EXPIRED if status == RUN_WINDOW_EXPIRED else RESULT_ALREADY_DONE
        )
        return self._make_result(
            task, local_date, result_status, message=message, attempt=int(row["attempt"] or 0)
        )

    def _result_from_row(
        self,
        conn: sqlite3.Connection,
        task: Task,
        run_key: str,
        local_date: date,
        now: datetime,
    ) -> RunResult:
        """CAS 失败后按最新库内状态给出只读结果，绝不覆盖其它进程的结果。"""

        row = self._get_run(conn, run_key)
        if row is None:
            return self._make_result(
                task,
                local_date,
                RESULT_ALREADY_DONE,
                message="记录已被其它进程清理，本次未写入，请人工核查",
            )
        status = row["status"]
        attempt = int(row["attempt"] or 0)
        if status in TERMINAL_RUN_STATUSES:
            return self._terminal_result(task, local_date, row)
        if status == RUN_IN_FLIGHT:
            lease = self._parse_dt(row["lease_expires_at"])
            if lease is not None and now < lease:
                return self._make_result(
                    task,
                    local_date,
                    RESULT_IN_FLIGHT,
                    message="其它进程正在执行（lease 未过期），本次跳过",
                    attempt=attempt,
                )
            return self._make_result(
                task,
                local_date,
                RUN_UNKNOWN,
                message="并发修改后仍为 in-flight，结果未知，请人工核查",
                attempt=attempt,
            )
        if status == RUN_RETRY:
            next_attempt = self._parse_dt(row["next_attempt"])
            return self._make_result(
                task,
                local_date,
                RESULT_RETRY_WAITING,
                message="并发修改：重试状态已变化，本次未执行",
                attempt=attempt,
                next_attempt=next_attempt,
            )
        if status == RUN_WAITING_DEPENDENCY:
            return self._make_result(
                task,
                local_date,
                RESULT_WAITING_DEPENDENCY,
                message="并发修改：仍在等待依赖",
                attempt=attempt,
            )
        return self._make_result(
            task,
            local_date,
            RESULT_ALREADY_DONE,
            message=f"并发修改：状态变为 {status}，本次未写入",
            attempt=attempt,
        )

    def _write_terminal(
        self,
        conn: sqlite3.Connection,
        run_key: str,
        status: str,
        message: str,
        now: datetime,
        expected_status: str | None = None,
        claim_token: str | None = None,
    ) -> bool:
        """CAS 写终态；返回是否命中（未命中说明被其它进程改过，调用方应回读）。"""

        clauses = ["run_key = ?"]
        params: list[Any] = [status, message, self._iso(now), run_key]
        if expected_status is not None:
            clauses.append("status = ?")
            params.append(expected_status)
        if claim_token is not None:
            clauses.append("claim_token = ?")
            params.append(claim_token)
        sql = (
            "UPDATE runs SET status = ?, message = ?, next_attempt = NULL, "
            "lease_expires_at = NULL, claim_token = NULL, updated_at = ? WHERE "
            + " AND ".join(clauses)
        )
        self._begin(conn)
        try:
            cursor = conn.execute(sql, params)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        return cursor.rowcount == 1

    def _claim(
        self,
        conn: sqlite3.Connection,
        task: Task,
        run_key: str,
        local_date: date,
        now: datetime,
        row: sqlite3.Row | None,
    ) -> str | None:
        """事务内抢占本次执行权；成功返回 claim token，失败返回 None。"""

        claim_token = uuid.uuid4().hex
        lease = now + timedelta(seconds=self.lease_seconds)
        timestamp = self._iso(now)
        self._begin(conn)
        try:
            if row is None:
                cursor = conn.execute(
                    _INSERT_RUN_SQL,
                    (
                        run_key,
                        task.id,
                        task.action,
                        local_date.isoformat(),
                        RUN_IN_FLIGHT,
                        "",
                        1,
                        None,
                        self._iso(lease),
                        claim_token,
                        timestamp,
                        timestamp,
                    ),
                )
            else:
                cursor = conn.execute(
                    "UPDATE runs SET status = ?, message = '', attempt = attempt + 1, "
                    "next_attempt = NULL, lease_expires_at = ?, claim_token = ?, updated_at = ? "
                    "WHERE run_key = ? AND status IN (?, ?)",
                    (
                        RUN_IN_FLIGHT,
                        self._iso(lease),
                        claim_token,
                        timestamp,
                        run_key,
                        RUN_RETRY,
                        RUN_WAITING_DEPENDENCY,
                    ),
                )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        return claim_token if cursor.rowcount == 1 else None

    def _finalize(
        self,
        conn: sqlite3.Connection,
        task: Task,
        run_key: str,
        local_date: date,
        now: datetime,
        claim_token: str,
        attempt: int,
        outcome: ActionResult,
    ) -> RunResult:
        status = outcome.status
        message = outcome.message
        next_attempt: datetime | None = None

        if status == ACTION_SUCCESS:
            final_status = RUN_SUCCESS
        elif status == ACTION_BLOCKED:
            final_status = RUN_BLOCKED
        elif status == ACTION_UNKNOWN:
            final_status = RUN_UNKNOWN
        else:  # ACTION_RETRY
            max_attempts = task.max_attempts if task.max_attempts is not None else self.max_attempts
            if attempt >= max_attempts:
                final_status = RUN_FAILED
                message = (f"{message}（重试 {attempt} 次后放弃）").strip()
            else:
                final_status = RUN_RETRY
                delay = (
                    outcome.retry_after
                    if outcome.retry_after is not None
                    else self.retry_delay
                )
                next_attempt = now + timedelta(seconds=delay)

        timestamp = self._iso(now)
        self._begin(conn)
        try:
            cursor = conn.execute(
                "UPDATE runs SET status = ?, message = ?, next_attempt = ?, "
                "lease_expires_at = NULL, claim_token = NULL, updated_at = ? "
                "WHERE run_key = ? AND claim_token = ? AND status = ?",
                (
                    final_status,
                    message,
                    self._iso(next_attempt),
                    timestamp,
                    run_key,
                    claim_token,
                    RUN_IN_FLIGHT,
                ),
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise

        if cursor.rowcount != 1:
            return self._make_result(
                task,
                local_date,
                RUN_UNKNOWN,
                message="claim 已被回收，本次结果未写入（结果未知）",
                attempt=attempt,
                would_run=True,
            )
        return self._make_result(
            task,
            local_date,
            final_status,
            message=message,
            attempt=attempt,
            next_attempt=next_attempt,
            would_run=True,
        )

    # ------------------------------------------------------------------ 历史查询

    def list_runs(
        self,
        task_id: str | None = None,
        local_date: date | datetime | str | None = None,
        status: str | None = None,
        limit: int | None = 50,
    ) -> list[RunRecord]:
        """查询执行历史（按本地日期、更新时间倒序）。"""

        if limit is not None:
            if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
                raise ValueError("limit 必须为 >=1 的整数或 None")

        clauses: list[str] = []
        params: list[Any] = []
        if task_id is not None:
            clauses.append("task_id = ?")
            params.append(task_id)
        if local_date is not None:
            if isinstance(local_date, datetime):
                local_date = local_date.date()
            if isinstance(local_date, date):
                local_date = local_date.isoformat()
            clauses.append("local_date = ?")
            params.append(str(local_date))
        if status is not None:
            clauses.append("status = ?")
            params.append(status)

        sql = "SELECT * FROM runs"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY local_date DESC, updated_at DESC, run_key"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)

        conn = self._connect()
        try:
            rows = conn.execute(sql, params).fetchall()
        finally:
            conn.close()
        return [self._run_record_from_row(row) for row in rows]

    # ------------------------------------------------------------------ 内部工具

    def _coerce_task(self, task: Task | Mapping[str, Any]) -> Task:
        if isinstance(task, Task):
            return task
        if isinstance(task, Mapping):
            return Task.from_mapping(task)
        raise ValueError(f"任务必须为 Task 或 Mapping，收到 {type(task).__name__}")

    def _load_tasks(self) -> list[Task]:
        conn = self._connect()
        try:
            rows = conn.execute("SELECT * FROM tasks ORDER BY task_id").fetchall()
        finally:
            conn.close()
        return [self._task_from_row(row) for row in rows]

    def _task_from_row(self, row: sqlite3.Row) -> Task:
        return Task(
            id=row["task_id"],
            action=row["action"],
            start=row["start"],
            end=row["end"],
            payload=json.loads(row["payload"] or "{}"),
            weekdays=tuple(json.loads(row["weekdays"] or "[]")) or ALL_WEEKDAYS,
            enabled=bool(row["enabled"]),
            depends_on=tuple(json.loads(row["depends_on"] or "[]")),
            max_attempts=row["max_attempts"],
        )

    @staticmethod
    def _run_record_from_row(row: sqlite3.Row) -> RunRecord:
        return RunRecord(
            run_key=row["run_key"],
            task_id=row["task_id"],
            action=row["action"],
            local_date=date.fromisoformat(row["local_date"]),
            status=row["status"],
            message=row["message"] or "",
            attempt=int(row["attempt"] or 0),
            next_attempt=Scheduler._parse_stored_datetime(row["next_attempt"]),
            updated_at=Scheduler._parse_stored_datetime(row["updated_at"]),
        )

    def _upsert_task_row(self, conn: sqlite3.Connection, task: Task) -> None:
        conn.execute(
            "INSERT INTO tasks (task_id, action, start, end, weekdays, enabled, payload, "
            "depends_on, max_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(task_id) DO UPDATE SET action = excluded.action, "
            "start = excluded.start, end = excluded.end, weekdays = excluded.weekdays, "
            "enabled = excluded.enabled, payload = excluded.payload, "
            "depends_on = excluded.depends_on, max_attempts = excluded.max_attempts",
            (
                task.id,
                task.action,
                task.start,
                task.end,
                json.dumps(list(task.weekdays)),
                1 if task.enabled else 0,
                json.dumps(dict(task.payload), ensure_ascii=False),
                json.dumps(list(task.depends_on)),
                task.max_attempts,
            ),
        )

    def _window(self, task: Task, local_date: date) -> tuple[datetime, datetime]:
        base = datetime(local_date.year, local_date.month, local_date.day, tzinfo=self.tz)
        return (
            base + timedelta(minutes=task.start_minute),
            base + timedelta(minutes=task.end_minute),
        )

    def _run_key(self, task_id: str, local_date: date) -> str:
        return f"{local_date.isoformat()}::{task_id}"

    def _current_attempt(self, conn: sqlite3.Connection, run_key: str) -> int:
        row = conn.execute("SELECT attempt FROM runs WHERE run_key = ?", (run_key,)).fetchone()
        return int(row["attempt"] or 0) if row is not None else 0

    def _get_run(self, conn: sqlite3.Connection, run_key: str) -> sqlite3.Row | None:
        return conn.execute("SELECT * FROM runs WHERE run_key = ?", (run_key,)).fetchone()

    def _localize(self, now: datetime | None) -> datetime:
        if now is None:
            return datetime.now(self.tz)
        if not isinstance(now, datetime):
            raise ValueError("now 必须为 datetime 或 None")
        if now.tzinfo is None:
            return now.replace(tzinfo=self.tz)
        return now.astimezone(self.tz)

    @staticmethod
    def _parse_stored_datetime(value: str | None) -> datetime | None:
        if value is None:
            return None
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=SHANGHAI_TZ)
        return parsed

    def _parse_dt(self, value: str | None) -> datetime | None:
        parsed = self._parse_stored_datetime(value)
        if parsed is None:
            return None
        return parsed.astimezone(self.tz)

    def _iso(self, value: datetime | None) -> str | None:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=self.tz)
        return value.isoformat()

    def _make_result(
        self,
        task: Task,
        local_date: date,
        status: str,
        message: str = "",
        attempt: int = 0,
        next_attempt: datetime | None = None,
        would_run: bool = False,
        dry_run: bool = False,
    ) -> RunResult:
        return RunResult(
            task_id=task.id,
            action=task.action,
            run_key=self._run_key(task.id, local_date),
            local_date=local_date,
            status=status,
            message=message,
            attempt=attempt,
            next_attempt=next_attempt,
            would_run=would_run,
            dry_run=dry_run,
        )

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        return conn

    @staticmethod
    def _begin(conn: sqlite3.Connection) -> None:
        conn.execute("BEGIN IMMEDIATE")

    def _ensure_schema(self) -> None:
        conn = self._connect()
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(_SCHEMA_SQL)
        finally:
            conn.close()
