"""auto3ct 命令行（validate/preview/run-once/watch/status）的离线测试。

测试用临时配置 + 临时 SQLite；业务适配器通过 sys.modules 注入假模块，
不访问网络、不接触真实 3CT 接口。
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import runpy
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from auto3ct import cli, config as cfg
from auto3ct.models import ActionResult

REPO_ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = REPO_ROOT / "config.example.json"
TZ = timezone(timedelta(hours=8))


def new_module(name: str = "fake_auto3ct_adapter"):
    module = types.ModuleType(name)
    sys.modules[name] = module
    return module


class CliTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.config_path = self.dir / "config.json"

    # ---- 配置构造 ----
    def task(self, **overrides):
        data = {
            "id": "check_in",
            "action": "check_in",
            "start": "00:00",
            "end": "23:59",
            "weekdays": [1, 2, 3, 4, 5, 6, 7],
            "enabled": False,
            "depends_on": [],
            "payload": {"placeholder": "待填写"},
        }
        data.update(overrides)
        return data

    def enabled_task(self, **overrides):
        data = self.task(enabled=True, payload={"activity_id": "act-1"})
        data.update(overrides)
        return data

    def write_config(self, tasks=None, adapter=None, defaults=None, name="config.json") -> Path:
        data = {
            "version": 1,
            "database": "runtime/test.db",
            "tasks": tasks if tasks is not None else [self.enabled_task()],
        }
        if adapter is not None:
            data["adapter"] = adapter
        if defaults is not None:
            data["defaults"] = defaults
        path = self.dir / name
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def fake_adapter(
        self,
        *,
        name="fake_auto3ct_adapter",
        init_error: Exception | None = None,
        execute_error: Exception | None = None,
        result=None,
    ) -> list:
        """注册一个假适配器模块，返回 handler 调用记录。"""

        module = new_module(name)
        calls: list = []
        self.addCleanup(sys.modules.pop, name, None)

        class FakeAdapter:
            def __init__(self, options):
                self.options = dict(options or {})

            def init(self):
                if init_error is not None:
                    raise init_error

            def close(self):
                calls.append(("close",))

            def execute(self, task, run_key):
                calls.append((task.id, run_key))
                if execute_error is not None:
                    raise execute_error
                if result is not None:
                    return result(task, run_key)
                return ActionResult.success("假适配器成功")

        module.create = FakeAdapter
        return calls

    # ---- 运行 ----
    def run_cli(self, *args: str, config: Path | None = None) -> tuple[int, str, str]:
        argv = list(args)
        if config is not None:
            argv = ["--config", str(config), *argv]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(argv)
        return code, out.getvalue(), err.getvalue()

    def loaded_config(self, **kwargs):
        return cfg.load_config(self.write_config(**kwargs))

    def db_path(self) -> Path:
        return (self.dir / "runtime" / "test.db").resolve()


class ValidateCommandTests(CliTestBase):
    def test_validate_example_config(self):
        code, out, err = self.run_cli("validate", config=EXAMPLE)

        self.assertEqual(code, 0, err)
        self.assertIn("配置有效", out)
        self.assertIn("任务: 5", out)
        self.assertIn("Asia/Shanghai", out)

    def test_validate_reports_errors_for_broken_config(self):
        path = self.write_config(
            tasks=[
                self.task(id="a", depends_on=["missing"]),
                self.task(id="a", action="other"),
            ]
        )

        code, out, err = self.run_cli("validate", config=path)

        self.assertEqual(code, 1)
        self.assertIn("任务 id 重复", err)
        self.assertIn("依赖未知任务", err)

    def test_validate_missing_config_file(self):
        code, _out, err = self.run_cli("validate", config=self.dir / "nope.json")

        self.assertEqual(code, 1)
        self.assertIn("配置文件不存在", err)

    def test_config_option_can_precede_or_follow_subcommand(self):
        for argv in (
            ["--config", str(EXAMPLE), "validate"],
            ["validate", "--config", str(EXAMPLE)],
        ):
            with self.subTest(argv=argv):
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = cli.main(list(argv))
                self.assertEqual(code, 0, err.getvalue())
                self.assertIn("配置有效", out.getvalue())


class PreviewCommandTests(CliTestBase):
    def test_preview_example_config_lists_all_tasks(self):
        code, out, err = self.run_cli("preview", config=EXAMPLE)

        self.assertEqual(code, 0, err)
        for task_id in ("campus_run", "club_activity", "event_signup"):
            self.assertIn(task_id, out)
        self.assertIn("预览", out)
        self.assertIn("适配器: 未配置", out)
        self.assertIn("启用 0 个", out)

    def test_preview_does_not_create_database(self):
        code, _out, _err = self.run_cli("preview", config=self.write_config())

        self.assertEqual(code, 0)
        self.assertFalse(self.db_path().exists())

    def test_preview_does_not_print_payload_values(self):
        path = self.write_config(
            tasks=[
                self.task(
                    payload={"token": "SECRET-TOKEN-123", "placeholder": "待填写"}
                )
            ]
        )

        code, out, err = self.run_cli("preview", config=path, )

        self.assertEqual(code, 0)
        self.assertNotIn("SECRET-TOKEN-123", out)
        self.assertNotIn("SECRET-TOKEN-123", err)
        self.assertIn("值已隐藏", out)

    def test_preview_shows_today_status_and_next_window(self):
        path = self.write_config(tasks=[self.enabled_task(start="06:30", end="07:30")])

        code, out, _err = self.run_cli(
            "preview", "--now", "2025-01-06T05:00:00+08:00", config=path
        )

        self.assertEqual(code, 0)
        self.assertIn("未到时窗", out)
        self.assertIn("下次", out)

    def test_preview_does_not_load_adapter(self):
        path = self.write_config(adapter={"factory": "no_such_module_xyz:create"})

        code, out, _err = self.run_cli("preview", config=path)

        self.assertEqual(code, 0)
        self.assertIn("已配置", out)

    def test_preview_rejects_invalid_now(self):
        code, _out, err = self.run_cli("preview", "--now", "not-a-time", config=EXAMPLE)

        self.assertEqual(code, 1)
        self.assertIn("--now", err)


class RunOnceCommandTests(CliTestBase):
    def test_run_once_defaults_to_dry_run_and_writes_no_runs(self):
        path = self.write_config(tasks=[self.enabled_task()])

        code, out, err = self.run_cli(
            "run-once", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        self.assertEqual(code, 0, err)
        self.assertIn("dry-run", out)
        self.assertIn("将执行", out)
        from auto3ct.scheduler import Scheduler

        self.assertEqual(Scheduler(str(self.db_path())).list_runs(), [])

    def test_run_once_dry_run_does_not_load_adapter(self):
        path = self.write_config(adapter={"factory": "no_such_module_xyz:create"})

        code, out, err = self.run_cli(
            "run-once", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        self.assertEqual(code, 0, err)
        self.assertIn("dry-run", out)

    def test_run_once_execute_without_adapter_is_an_error(self):
        path = self.write_config()

        code, _out, err = self.run_cli(
            "run-once", "--execute", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        self.assertEqual(code, 1)
        self.assertIn("未配置 adapter", err)

    def test_run_once_execute_with_unloadable_adapter_is_an_error(self):
        path = self.write_config(adapter={"factory": "no_such_module_xyz:create"})

        code, _out, err = self.run_cli(
            "run-once", "--execute", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        self.assertEqual(code, 1)
        self.assertIn("适配器不可用", err)

    def test_run_once_execute_with_failing_init_is_an_error(self):
        self.fake_adapter(init_error=RuntimeError("登录态不可用"))
        path = self.write_config(adapter={"factory": "fake_auto3ct_adapter:create"})

        code, out, err = self.run_cli(
            "run-once", "--execute", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        self.assertEqual(code, 1)
        self.assertIn("适配器初始化失败", err)
        self.assertNotIn("成功", out)
        from auto3ct.scheduler import Scheduler

        self.assertEqual(Scheduler(str(self.db_path())).list_runs(), [])

    def test_run_once_execute_success_calls_adapter_once_and_records_run(self):
        calls = self.fake_adapter()
        path = self.write_config(adapter={"factory": "fake_auto3ct_adapter:create"})

        code, out, err = self.run_cli(
            "run-once", "--execute", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        self.assertEqual(code, 0, err)
        self.assertIn("成功", out)
        self.assertEqual([call for call in calls if call[0] != "close"], [("check_in", "2025-01-06::check_in")])

        from auto3ct.scheduler import Scheduler

        runs = Scheduler(str(self.db_path())).list_runs()
        self.assertEqual(len(runs), 1)
        self.assertEqual((runs[0].task_id, runs[0].status), ("check_in", "success"))

    def test_run_once_execute_second_time_is_already_done(self):
        calls = self.fake_adapter()
        path = self.write_config(adapter={"factory": "fake_auto3ct_adapter:create"})

        first, _out1, _err1 = self.run_cli(
            "run-once", "--execute", "--now", "2025-01-06T07:00:00+08:00", config=path
        )
        second, out2, err2 = self.run_cli(
            "run-once", "--execute", "--now", "2025-01-06T08:00:00+08:00", config=path
        )

        self.assertEqual((first, second), (0, 0), err2)
        self.assertIn("今日已完成", out2)
        self.assertEqual([call for call in calls if call[0] != "close"], [("check_in", "2025-01-06::check_in")])

    def test_run_once_execute_blocked_is_reported_as_failure(self):
        self.fake_adapter(result=lambda task, run_key: ActionResult.blocked("账号未绑定"))
        path = self.write_config(adapter={"factory": "fake_auto3ct_adapter:create"})

        code, out, err = self.run_cli(
            "run-once", "--execute", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        self.assertEqual(code, 1)
        self.assertIn("已阻断", out)
        self.assertIn("账号未绑定", out)
        self.assertIn("未成功", err)

    def test_run_once_execute_unknown_result_is_not_reported_as_success(self):
        self.fake_adapter(result=lambda task, run_key: ActionResult.unknown("未取到回执"))
        path = self.write_config(adapter={"factory": "fake_auto3ct_adapter:create"})

        code, out, err = self.run_cli(
            "run-once", "--execute", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        self.assertEqual(code, 1)
        self.assertIn("结果未知", out)
        self.assertNotIn("[成功]", out)

    def test_run_once_with_all_tasks_disabled(self):
        path = self.write_config(tasks=[self.task()])

        code, out, err = self.run_cli(
            "run-once", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        self.assertEqual(code, 0, err)
        self.assertIn("没有可扫描的任务", out)

    def test_run_once_outside_window_is_not_a_failure(self):
        path = self.write_config(tasks=[self.enabled_task(start="06:00", end="07:00")])

        code, out, err = self.run_cli(
            "run-once", "--now", "2025-01-06T09:00:00+08:00", config=path
        )

        self.assertEqual(code, 0, err)
        self.assertIn("时窗已过", out)


class WatchCommandTests(CliTestBase):
    def test_watch_dry_run_stops_after_max_iterations(self):
        config = self.loaded_config()

        code, out, err = self.run_cli(
            "watch",
            "--dry-run",
            "--interval",
            "1",
            "--max-iterations",
            "2",
            config=self.config_path,
        )

        self.assertEqual(code, 0, err)
        self.assertIn("watch", out)
        self.assertEqual(out.count("扫描完成"), 2)

    def test_watch_rejects_bad_interval(self):
        self.write_config()

        code, _out, err = self.run_cli(
            "watch", "--interval", "0", "--max-iterations", "1", config=self.config_path
        )

        self.assertEqual(code, 1)
        self.assertIn("interval", err)

    def test_watch_execute_without_adapter_is_an_error(self):
        self.write_config()

        code, _out, err = self.run_cli(
            "watch", "--execute", "--max-iterations", "1", config=self.config_path
        )

        self.assertEqual(code, 1)
        self.assertIn("未配置 adapter", err)

    def test_watch_handles_ctrl_c_gracefully(self):
        config = self.loaded_config(
            tasks=[self.enabled_task(payload={"activity_id": "act-1"})]
        )
        sleeps: list = []

        def fake_sleep(seconds):
            sleeps.append(seconds)
            raise KeyboardInterrupt

        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = cli.run_watch(
                config,
                execute=False,
                interval=1.0,
                clock=lambda: datetime(2025, 1, 6, 7, 0, tzinfo=TZ),
                sleep=fake_sleep,
            )

        self.assertEqual(code, 0)
        self.assertIn("已停止", out.getvalue())
        self.assertEqual(sleeps, [1.0])

    def test_run_watch_runs_fixed_number_of_iterations(self):
        config = self.loaded_config(
            tasks=[self.enabled_task(payload={"activity_id": "act-1"})]
        )
        sleeps: list = []
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = cli.run_watch(
                config,
                execute=False,
                interval=2.5,
                iterations=3,
                clock=lambda: datetime(2025, 1, 6, 7, 0, tzinfo=TZ),
                sleep=sleeps.append,
            )

        self.assertEqual(code, 0)
        self.assertEqual(len(sleeps), 2)
        self.assertEqual(out.getvalue().count("扫描完成"), 3)


class StatusCommandTests(CliTestBase):
    def test_status_without_database(self):
        code, out, err = self.run_cli("status", config=self.write_config())

        self.assertEqual(code, 0, err)
        self.assertIn("任务: 1", out)
        self.assertIn("尚未创建", out)

    def test_status_lists_recent_runs_after_execute(self):
        self.fake_adapter()
        path = self.write_config(adapter={"factory": "fake_auto3ct_adapter:create"})
        self.run_cli(
            "run-once", "--execute", "--now", "2025-01-06T07:00:00+08:00", config=path
        )

        code, out, err = self.run_cli("status", "--limit", "5", config=path)

        self.assertEqual(code, 0, err)
        self.assertIn("最近运行", out)
        self.assertIn("check_in", out)
        self.assertIn("成功", out)


class EntryPointTests(CliTestBase):
    def test_python_m_auto3ct_validate_exits_zero(self):
        out, err = io.StringIO(), io.StringIO()
        old_argv = sys.argv
        sys.argv = ["auto3ct", "validate", "--config", str(EXAMPLE)]
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    runpy.run_module("auto3ct", run_name="__main__")
        finally:
            sys.argv = old_argv

        self.assertEqual(ctx.exception.code, 0, err.getvalue())
        self.assertIn("配置有效", out.getvalue())

    def test_start_script_exists_and_uses_module_entry(self):
        script = REPO_ROOT / "start-auto3ct.cmd"
        text = script.read_text(encoding="utf-8")

        self.assertIn("-m auto3ct", text)
        self.assertIn("%*", text)
        self.assertNotIn("C:\\Users\\", text)


if __name__ == "__main__":
    unittest.main()
