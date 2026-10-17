"""auto3ct 持久化每日调度核心的离线测试。

全部测试只使用 tempfile + SQLite，不访问网络、不读写第三方系统。
"""

from __future__ import annotations

import sqlite3
import tempfile
import threading
import time
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from auto3ct.models import ActionResult, Task
from auto3ct.scheduler import Scheduler

# 中国无夏令时，固定 +08:00 即可，避免依赖 tzdata。
TZ = timezone(timedelta(hours=8))

MONDAY = 6  # 2025-01-06 周一
TUESDAY = 7  # 2025-01-07 周二


def at(day: int = MONDAY, hour: int = 6, minute: int = 30) -> datetime:
    return datetime(2025, 1, day, hour, minute, tzinfo=TZ)


def day_key(day: int, task_id: str) -> str:
    return f"2025-01-{day:02d}::{task_id}"


class SchedulerTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = str(Path(self._tmp.name) / "scheduler.sqlite3")
        self.scheduler = Scheduler(self.db_path)
        self.calls: list[str] = []

    def handler(self, result_factory=None):
        def _handler(task, run_key):
            self.calls.append(task.task_id)
            if result_factory is not None:
                return result_factory(task, run_key)
            return ActionResult.success("ok")

        return _handler

    def basic_task(self, **overrides) -> Task:
        data = dict(
            id="check_in",
            action="check_in",
            start="06:00",
            end="12:00",
        )
        data.update(overrides)
        return Task(**data)

    def insert_run_row(
        self,
        *,
        run_key: str,
        task_id: str,
        local_date: str,
        status: str,
        attempt: int = 1,
        lease_expires_at: datetime | None = None,
        next_attempt: datetime | None = None,
        message: str = "",
    ) -> None:
        now = at()
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                "INSERT INTO runs ("
                "run_key, task_id, action, local_date, status, message, attempt,"
                " next_attempt, lease_expires_at, claim_token, created_at, updated_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_key,
                    task_id,
                    task_id,
                    local_date,
                    status,
                    message,
                    attempt,
                    next_attempt.isoformat() if next_attempt else None,
                    lease_expires_at.isoformat() if lease_expires_at else None,
                    "seed-token",
                    now.isoformat(),
                    now.isoformat(),
                ),
            )
            conn.commit()
        finally:
            conn.close()


class TaskPersistenceTests(SchedulerTestBase):
    def test_add_task_persists_definition(self):
        task = self.basic_task(payload={"user": "u-1"}, weekdays=(1, 3, 5))
        self.scheduler.add_task(task)

        tasks = self.scheduler.list_tasks()
        self.assertEqual([t.task_id for t in tasks], ["check_in"])
        stored = tasks[0]
        self.assertEqual(stored.action, "check_in")
        self.assertEqual((stored.start, stored.end), ("06:00", "12:00"))
        self.assertEqual(stored.weekdays, (1, 3, 5))
        self.assertTrue(stored.enabled)
        self.assertEqual(stored.payload, {"user": "u-1"})

    def test_add_task_upserts_same_id(self):
        self.scheduler.add_task(self.basic_task(start="06:00"))
        self.scheduler.add_task(self.basic_task(start="07:00"))

        tasks = self.scheduler.list_tasks()
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0].start, "07:00")

    def test_replace_tasks_replaces_definitions_but_keeps_run_history(self):
        self.scheduler.add_task(self.basic_task())
        self.scheduler.run_due(self.handler(), now=at(hour=7))

        self.scheduler.replace_tasks(
            [Task(id="check_out", action="check_out", start="06:00", end="12:00")]
        )

        self.assertEqual([t.task_id for t in self.scheduler.list_tasks()], ["check_out"])
        runs = self.scheduler.list_runs()
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0].status, "success")

    def test_list_runs_filters_by_task_date_and_status(self):
        self.scheduler.add_task(self.basic_task())
        self.scheduler.add_task(
            Task(id="check_out", action="check_out", start="06:00", end="12:00")
        )
        self.scheduler.run_due(self.handler(), now=at(hour=7))

        self.assertEqual(len(self.scheduler.list_runs()), 2)
        self.assertEqual(len(self.scheduler.list_runs(task_id="check_in")), 1)
        self.assertEqual(len(self.scheduler.list_runs(local_date="2025-01-06")), 2)
        self.assertEqual(len(self.scheduler.list_runs(local_date=date(2025, 1, 7))), 0)
        self.assertEqual(len(self.scheduler.list_runs(status="success")), 2)


class RunDueTests(SchedulerTestBase):
    def test_runs_task_inside_window_and_records_success(self):
        self.scheduler.add_task(self.basic_task())

        results = self.scheduler.run_due(self.handler(), now=at(hour=7))

        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertEqual(result.task_id, "check_in")
        self.assertEqual(result.run_key, day_key(MONDAY, "check_in"))
        self.assertEqual(result.status, "success")
        self.assertEqual(result.local_date, date(2025, 1, 6))
        self.assertTrue(result.would_run)
        self.assertFalse(result.dry_run)
        self.assertEqual(self.calls, ["check_in"])

        runs = self.scheduler.list_runs()
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0].status, "success")
        self.assertEqual(runs[0].attempt, 1)

    def test_naive_now_is_interpreted_as_local_time(self):
        self.scheduler.add_task(self.basic_task(start="06:00", end="12:00"))

        results = self.scheduler.run_due(
            self.handler(), now=datetime(2025, 1, MONDAY, 7, 0)
        )

        self.assertEqual(results[0].status, "success")
        self.assertEqual(results[0].local_date, date(2025, 1, 6))
        self.assertEqual(self.calls, ["check_in"])

    def test_same_local_day_runs_only_once(self):
        self.scheduler.add_task(self.basic_task())

        self.scheduler.run_due(self.handler(), now=at(hour=7))
        second = self.scheduler.run_due(self.handler(), now=at(hour=9))

        self.assertEqual(self.calls, ["check_in"])
        self.assertEqual(len(self.scheduler.list_runs()), 1)
        self.assertEqual(second[0].status, "already_done")
        self.assertFalse(second[0].would_run)

    def test_new_local_day_runs_again(self):
        self.scheduler.add_task(self.basic_task(start="00:00", end="23:59"))

        first = self.scheduler.run_due(
            self.handler(), now=datetime(2025, 1, MONDAY, 23, 50, tzinfo=TZ)
        )
        second = self.scheduler.run_due(
            self.handler(), now=datetime(2025, 1, TUESDAY, 0, 10, tzinfo=TZ)
        )

        self.assertEqual(first[0].status, "success")
        self.assertEqual(second[0].status, "success")
        self.assertEqual(self.calls, ["check_in", "check_in"])
        self.assertEqual(
            [r.local_date for r in self.scheduler.list_runs()],
            [date(2025, 1, 7), date(2025, 1, 6)],
        )

    def test_before_window_does_not_run(self):
        self.scheduler.add_task(self.basic_task(start="06:00", end="12:00"))

        results = self.scheduler.run_due(self.handler(), now=at(hour=5, minute=59))

        self.assertEqual(results[0].status, "not_due")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.scheduler.list_runs(), [])

    def test_expired_window_is_not_made_up_later(self):
        self.scheduler.add_task(self.basic_task(start="06:00", end="12:00"))

        first = self.scheduler.run_due(self.handler(), now=at(hour=12, minute=1))
        second = self.scheduler.run_due(self.handler(), now=at(hour=18, minute=0))

        self.assertEqual(first[0].status, "window_expired")
        self.assertEqual(second[0].status, "window_expired")
        self.assertEqual(self.calls, [])
        runs = self.scheduler.list_runs()
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0].status, "window_expired")

    def test_weekday_filter(self):
        self.scheduler.add_task(self.basic_task(weekdays=(1,)))  # 仅周一

        results = self.scheduler.run_due(self.handler(), now=at(TUESDAY, hour=7))

        self.assertEqual(results, [])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.scheduler.list_runs(), [])

    def test_disabled_task_is_skipped(self):
        self.scheduler.add_task(self.basic_task(enabled=False))

        results = self.scheduler.run_due(self.handler(), now=at(hour=7))

        self.assertEqual(results, [])
        self.assertEqual(self.calls, [])

    def test_payload_is_passed_to_handler(self):
        self.scheduler.add_task(self.basic_task(payload={"user": "u-9"}))
        seen = {}

        def handler(task, run_key):
            seen["payload"] = dict(task.payload)
            seen["run_key"] = run_key
            return ActionResult.success("done")

        self.scheduler.run_due(handler, now=at(hour=7))

        self.assertEqual(seen["payload"], {"user": "u-9"})
        self.assertEqual(seen["run_key"], day_key(MONDAY, "check_in"))

    def test_handler_exception_becomes_unknown_and_is_not_retried(self):
        self.scheduler.add_task(self.basic_task())

        def exploding_handler(task, run_key):
            self.calls.append(task.task_id)
            raise RuntimeError("boom")

        first = self.scheduler.run_due(exploding_handler, now=at(hour=7))
        second = self.scheduler.run_due(exploding_handler, now=at(hour=8))

        self.assertEqual(first[0].status, "unknown")
        self.assertEqual(first[0].message, "handler 异常（结果未知，请核查）")
        self.assertNotIn("boom", first[0].message)
        self.assertEqual(second[0].status, "already_done")
        self.assertEqual(self.calls, ["check_in"])
        self.assertEqual(self.scheduler.list_runs()[0].status, "unknown")


class DependencyTests(SchedulerTestBase):
    def test_dependent_task_waits_for_success_then_runs(self):
        self.scheduler.add_task(
            self.basic_task(id="check_in", action="check_in", start="06:00", end="12:00")
        )
        self.scheduler.add_task(
            self.basic_task(
                id="check_out",
                action="check_out",
                start="06:00",
                end="12:00",
                depends_on=("check_in",),
            )
        )
        attempts = {"check_in": 0}

        def handler(task, run_key):
            self.calls.append(task.task_id)
            if task.task_id == "check_in":
                attempts["check_in"] += 1
                if attempts["check_in"] == 1:
                    return ActionResult.retry("登录态未就绪", retry_after=60)
            return ActionResult.success("ok")

        t0 = at(hour=7)
        first = {r.task_id: r for r in self.scheduler.run_due(handler, now=t0)}

        self.assertEqual(first["check_in"].status, "retry")
        self.assertEqual(first["check_out"].status, "waiting_dependency")
        self.assertEqual(self.calls, ["check_in"])

        second = {
            r.task_id: r
            for r in self.scheduler.run_due(handler, now=t0 + timedelta(seconds=61))
        }

        self.assertEqual(second["check_in"].status, "success")
        self.assertEqual(second["check_out"].status, "success")
        self.assertEqual(self.calls, ["check_in", "check_in", "check_out"])

    def test_dependency_success_on_previous_day_does_not_satisfy_today(self):
        self.scheduler.add_task(
            self.basic_task(id="check_in", action="check_in", start="06:00", end="08:00")
        )
        self.scheduler.add_task(
            self.basic_task(
                id="check_out",
                action="check_out",
                start="06:00",
                end="12:00",
                depends_on=("check_in",),
            )
        )

        monday = {
            r.task_id: r for r in self.scheduler.run_due(self.handler(), now=at(MONDAY, hour=7))
        }
        self.assertEqual(monday["check_in"].status, "success")
        self.assertEqual(monday["check_out"].status, "success")

        self.calls.clear()
        tuesday = {
            r.task_id: r
            for r in self.scheduler.run_due(self.handler(), now=at(TUESDAY, hour=9))
        }

        self.assertEqual(tuesday["check_in"].status, "window_expired")
        self.assertEqual(tuesday["check_out"].status, "blocked")
        self.assertEqual(self.calls, [])

    def test_dependent_task_blocked_when_dependency_window_expired(self):
        self.scheduler.add_task(
            self.basic_task(id="check_in", action="check_in", start="06:00", end="08:00")
        )
        self.scheduler.add_task(
            self.basic_task(
                id="check_out",
                action="check_out",
                start="06:00",
                end="18:00",
                depends_on=("check_in",),
            )
        )

        results = {
            r.task_id: r for r in self.scheduler.run_due(self.handler(), now=at(hour=9))
        }

        self.assertEqual(results["check_in"].status, "window_expired")
        self.assertEqual(results["check_out"].status, "blocked")
        self.assertIn("check_in", results["check_out"].message)
        self.assertEqual(self.calls, [])
        self.assertEqual(
            {r.task_id: r.status for r in self.scheduler.list_runs()},
            {"check_in": "window_expired", "check_out": "blocked"},
        )


class RetryTests(SchedulerTestBase):
    def test_retry_sets_next_attempt_and_runs_later(self):
        self.scheduler.add_task(self.basic_task())
        attempts = {"n": 0}

        def handler(task, run_key):
            self.calls.append(task.task_id)
            attempts["n"] += 1
            if attempts["n"] == 1:
                return ActionResult.retry("稍后重试", retry_after=60)
            return ActionResult.success("ok")

        t0 = at(hour=7)
        first = self.scheduler.run_due(handler, now=t0)

        self.assertEqual(first[0].status, "retry")
        self.assertEqual(first[0].next_attempt, t0 + timedelta(seconds=60))
        self.assertEqual(self.scheduler.list_runs()[0].status, "retry")

        waiting = self.scheduler.run_due(handler, now=t0 + timedelta(seconds=30))
        self.assertEqual(waiting[0].status, "retry_waiting")
        self.assertEqual(len(self.calls), 1)

        done = self.scheduler.run_due(handler, now=t0 + timedelta(seconds=61))
        self.assertEqual(done[0].status, "success")
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.scheduler.list_runs()[0].attempt, 2)

    def test_retry_exhaustion_marks_failed_and_stops(self):
        self.scheduler.add_task(self.basic_task(max_attempts=2))

        def always_retry(task, run_key):
            self.calls.append(task.task_id)
            return ActionResult.retry("还没成功", retry_after=60)

        t0 = at(hour=7)
        first = self.scheduler.run_due(always_retry, now=t0)
        second = self.scheduler.run_due(always_retry, now=t0 + timedelta(seconds=61))
        third = self.scheduler.run_due(always_retry, now=t0 + timedelta(seconds=122))

        self.assertEqual(first[0].status, "retry")
        self.assertEqual(second[0].status, "failed")
        self.assertEqual(third[0].status, "already_done")
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.scheduler.list_runs()[0].status, "failed")

    def test_handler_unknown_is_not_resubmitted(self):
        self.scheduler.add_task(self.basic_task())

        def uncertain(task, run_key):
            self.calls.append(task.task_id)
            return ActionResult.unknown("提交后未取到回执")

        first = self.scheduler.run_due(uncertain, now=at(hour=7))
        second = self.scheduler.run_due(uncertain, now=at(hour=8))

        self.assertEqual(first[0].status, "unknown")
        self.assertEqual(second[0].status, "already_done")
        self.assertEqual(self.calls, ["check_in"])
        self.assertEqual(self.scheduler.list_runs()[0].status, "unknown")

    def test_handler_blocked_is_terminal(self):
        self.scheduler.add_task(self.basic_task())

        def blocked(task, run_key):
            self.calls.append(task.task_id)
            return ActionResult.blocked("账号未绑定")

        first = self.scheduler.run_due(blocked, now=at(hour=7))
        second = self.scheduler.run_due(blocked, now=at(hour=8))

        self.assertEqual(first[0].status, "blocked")
        self.assertEqual(second[0].status, "already_done")
        self.assertEqual(self.calls, ["check_in"])


class CrashRecoveryTests(SchedulerTestBase):
    def test_stale_in_flight_is_marked_unknown_without_resubmit(self):
        self.scheduler.add_task(self.basic_task())
        self.insert_run_row(
            run_key=day_key(MONDAY, "check_in"),
            task_id="check_in",
            local_date="2025-01-06",
            status="in_flight",
            attempt=1,
            lease_expires_at=at(hour=6, minute=0),  # lease 已过期
        )

        first = self.scheduler.run_due(self.handler(), now=at(hour=7))
        second = self.scheduler.run_due(self.handler(), now=at(hour=8))

        self.assertEqual(first[0].status, "unknown")
        self.assertIn("lease", first[0].message)
        self.assertEqual(second[0].status, "already_done")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.scheduler.list_runs()[0].status, "unknown")

    def test_live_lease_is_respected(self):
        self.scheduler.add_task(self.basic_task())
        self.insert_run_row(
            run_key=day_key(MONDAY, "check_in"),
            task_id="check_in",
            local_date="2025-01-06",
            status="in_flight",
            attempt=1,
            lease_expires_at=at(hour=8),  # lease 仍有效
        )

        results = self.scheduler.run_due(self.handler(), now=at(hour=7))

        self.assertEqual(results[0].status, "in_flight")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.scheduler.list_runs()[0].status, "in_flight")

    def test_restart_does_not_rerun_success(self):
        self.scheduler.add_task(self.basic_task())
        self.scheduler.run_due(self.handler(), now=at(hour=7))

        restarted = Scheduler(self.db_path)
        results = restarted.run_due(self.handler(), now=at(hour=9))

        self.assertEqual(results[0].status, "already_done")
        self.assertEqual(self.calls, ["check_in"])
        self.assertEqual(len(restarted.list_runs()), 1)

    def test_concurrent_run_due_submits_handler_only_once(self):
        self.scheduler.add_task(self.basic_task())
        calls: list[str] = []
        calls_lock = threading.Lock()
        barrier = threading.Barrier(2)

        def slow_handler(task, run_key):
            with calls_lock:
                calls.append(task.task_id)
            time.sleep(0.15)
            return ActionResult.success("ok")

        errors: list[BaseException] = []

        def worker():
            try:
                barrier.wait(timeout=5)
                self.scheduler.run_due(slow_handler, now=at(hour=7))
            except BaseException as exc:  # noqa: BLE001 - 测试里收集线程异常
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(errors, [])
        self.assertEqual(calls, ["check_in"])
        runs = self.scheduler.list_runs()
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0].status, "success")


class DryRunTests(SchedulerTestBase):
    def test_dry_run_does_not_call_handler_or_write_state(self):
        self.scheduler.add_task(self.basic_task())

        results = self.scheduler.run_due(self.handler(), now=at(hour=7), dry_run=True)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].status, "dry_run")
        self.assertTrue(results[0].would_run)
        self.assertTrue(results[0].dry_run)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.scheduler.list_runs(), [])

    def test_dry_run_never_overwrites_success(self):
        self.scheduler.add_task(self.basic_task())
        self.scheduler.run_due(self.handler(), now=at(hour=7))

        results = self.scheduler.run_due(self.handler(), now=at(hour=8), dry_run=True)

        self.assertEqual(results[0].status, "already_done")
        self.assertFalse(results[0].would_run)
        self.assertEqual(self.calls, ["check_in"])
        runs = self.scheduler.list_runs()
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0].status, "success")

    def test_dry_run_respects_expired_window(self):
        self.scheduler.add_task(self.basic_task(start="06:00", end="12:00"))

        results = self.scheduler.run_due(self.handler(), now=at(hour=13), dry_run=True)

        self.assertEqual(results[0].status, "window_expired")
        self.assertFalse(results[0].would_run)
        self.assertEqual(self.scheduler.list_runs(), [])

    def test_dry_run_without_handler_is_allowed(self):
        self.scheduler.add_task(self.basic_task())

        results = self.scheduler.run_due(None, now=at(hour=7), dry_run=True)

        self.assertEqual(results[0].status, "dry_run")
        self.assertEqual(self.calls, [])


class ModelValidationTests(unittest.TestCase):
    def test_task_rejects_inverted_window(self):
        with self.assertRaises(ValueError):
            Task(id="x", action="x", start="12:00", end="06:00")

    def test_task_rejects_bad_time_format(self):
        with self.assertRaises(ValueError):
            Task(id="x", action="x", start="6:00", end="07:00")

    def test_task_rejects_unknown_weekday(self):
        with self.assertRaises(ValueError):
            Task(id="x", action="x", weekdays=(0, 1))

    def test_task_rejects_non_int_weekdays_without_silent_conversion(self):
        for bad in ((1.0,), (True,), ("1",), (1, "2"), (None,)):
            with self.subTest(weekdays=bad):
                with self.assertRaises(ValueError):
                    Task(id="x", action="x", weekdays=bad)

    def test_task_rejects_float_max_attempts(self):
        with self.assertRaises(ValueError):
            Task(id="x", action="x", max_attempts=2.0)
        with self.assertRaises(ValueError):
            Task(id="x", action="x", max_attempts=True)

    def test_task_requires_id_and_action(self):
        with self.assertRaises(ValueError):
            Task(id="", action="check_in")
        with self.assertRaises(ValueError):
            Task(id="check_in", action="")

    def test_action_result_rejects_unknown_status(self):
        with self.assertRaises(ValueError):
            ActionResult(status="maybe")

    def test_action_result_rejects_negative_retry_after(self):
        with self.assertRaises(ValueError):
            ActionResult.retry("x", retry_after=-1)

    def test_action_result_rejects_non_finite_retry_after(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(retry_after=bad):
                with self.assertRaises(ValueError):
                    ActionResult.retry("x", retry_after=bad)

    def test_action_result_helpers(self):
        self.assertEqual(ActionResult.success("ok").status, "success")
        retry = ActionResult.retry("later", retry_after=30)
        self.assertEqual((retry.status, retry.retry_after), ("retry", 30))
        self.assertEqual(ActionResult.blocked("no").status, "blocked")
        self.assertEqual(ActionResult.unknown("hmm").status, "unknown")

    def test_run_due_requires_handler_unless_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            scheduler = Scheduler(str(Path(tmp) / "s.sqlite3"))
            scheduler.add_task(Task(id="check_in", action="check_in"))
            with self.assertRaises(ValueError):
                scheduler.run_due(None, now=at(hour=7))


class SchedulerConfigValidationTests(unittest.TestCase):
    def test_rejects_non_finite_or_negative_timing_parameters(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = str(Path(tmp) / "s.sqlite3")
            for bad in (float("nan"), float("inf"), float("-inf"), -1):
                with self.subTest(lease_seconds=bad):
                    with self.assertRaises(ValueError):
                        Scheduler(db, lease_seconds=bad)
                with self.subTest(retry_delay=bad):
                    with self.assertRaises(ValueError):
                        Scheduler(db, retry_delay=bad)

    def test_rejects_bad_max_attempts(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = str(Path(tmp) / "s.sqlite3")
            for bad in (0, -2, True, 2.0):
                with self.subTest(max_attempts=bad):
                    with self.assertRaises(ValueError):
                        Scheduler(db, max_attempts=bad)


class ConcurrentCasRaceTests(SchedulerTestBase):
    """模拟“读过 stale 记录后，别的进程已 finalize”的竞态，验证 CAS 不覆盖新结果。"""

    def test_stale_inflight_terminal_write_is_cas_protected(self):
        self.scheduler.add_task(self.basic_task())
        run_key = day_key(MONDAY, "check_in")
        self.insert_run_row(
            run_key=run_key,
            task_id="check_in",
            local_date="2025-01-06",
            status="in_flight",
            attempt=1,
            lease_expires_at=at(hour=6),  # lease 已过期
        )

        conn = self.scheduler._connect()
        try:
            stale_row = self.scheduler._get_run(conn, run_key)
            # 另一个进程在读到 stale in-flight 之后完成了 success
            conn.execute(
                "UPDATE runs SET status = ?, claim_token = NULL, lease_expires_at = NULL "
                "WHERE run_key = ?",
                ("success", run_key),
            )
            updated = self.scheduler._write_terminal(
                conn,
                run_key,
                "unknown",
                "stale-overwrite-attempt",
                at(hour=7),
                expected_status="in_flight",
                claim_token=stale_row["claim_token"],
            )
        finally:
            conn.close()

        self.assertFalse(updated, "过期 lease 的 in-flight 不得覆盖已成功记录")
        self.assertEqual(self.scheduler.list_runs()[0].status, "success")

    def test_dependency_gate_cas_does_not_overwrite_success(self):
        self.scheduler.add_task(
            self.basic_task(id="check_in", action="check_in", start="06:00", end="12:00")
        )
        self.scheduler.add_task(
            self.basic_task(
                id="check_out",
                action="check_out",
                start="06:00",
                end="12:00",
                depends_on=("check_in",),
            )
        )
        run_key = day_key(MONDAY, "check_out")
        self.insert_run_row(
            run_key=run_key,
            task_id="check_out",
            local_date="2025-01-06",
            status="waiting_dependency",
            attempt=0,
        )
        task = next(t for t in self.scheduler.list_tasks() if t.id == "check_out")

        conn = self.scheduler._connect()
        try:
            stale_row = self.scheduler._get_run(conn, run_key)
            conn.execute(
                "UPDATE runs SET status = ? WHERE run_key = ?", ("success", run_key)
            )
            result = self.scheduler._record_dependency_gate(
                conn,
                task,
                run_key,
                date(2025, 1, 6),
                at(hour=7),
                stale_row,
                "waiting_dependency",
                "等待依赖任务 check_in 成功",
                False,
            )
        finally:
            conn.close()

        self.assertEqual(result.status, "already_done")
        self.assertEqual(self.scheduler.list_runs()[0].status, "success")

    def test_window_expiry_cas_does_not_overwrite_success(self):
        self.scheduler.add_task(self.basic_task(start="06:00", end="12:00"))
        run_key = day_key(MONDAY, "check_in")
        self.insert_run_row(
            run_key=run_key,
            task_id="check_in",
            local_date="2025-01-06",
            status="retry",
            attempt=1,
            next_attempt=at(hour=13),
        )
        task = self.scheduler.list_tasks()[0]

        conn = self.scheduler._connect()
        try:
            stale_row = self.scheduler._get_run(conn, run_key)
            conn.execute(
                "UPDATE runs SET status = ? WHERE run_key = ?", ("success", run_key)
            )
            result = self.scheduler._record_window_expired(
                conn,
                task,
                run_key,
                date(2025, 1, 6),
                at(hour=13),
                stale_row,
            )
        finally:
            conn.close()

        self.assertEqual(result.status, "already_done")
        self.assertEqual(self.scheduler.list_runs()[0].status, "success")


if __name__ == "__main__":
    unittest.main()
