"""auto3ct 配置加载与严格校验的离线测试。

全部测试只使用 tempfile + 纯 JSON，不访问网络、不读写第三方系统。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from auto3ct import config as cfg

REPO_ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = REPO_ROOT / "config.example.json"


def ts(*args: int) -> datetime:
    return datetime(*args, tzinfo=timezone(timedelta(hours=8)))


class ConfigTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def write(self, data, name: str = "config.json") -> Path:
        path = self.dir / name
        path.write_text(
            data if isinstance(data, str) else json.dumps(data, ensure_ascii=False),
            encoding="utf-8",
        )
        return path

    def base_config(self, **overrides):
        data = {
            "version": 1,
            "tasks": [
                {
                    "id": "check_in",
                    "action": "check_in",
                    "start": "06:00",
                    "end": "12:00",
                    "enabled": False,
                    "payload": {"placeholder": "待填写"},
                }
            ],
        }
        data.update(overrides)
        return data

    def task(self, **overrides):
        data = {
            "id": "check_in",
            "action": "check_in",
            "start": "06:00",
            "end": "12:00",
            "enabled": False,
            "payload": {"placeholder": "待填写"},
        }
        data.update(overrides)
        return data

    def assert_error(self, path: Path, *fragments: str) -> cfg.ConfigError:
        with self.assertRaises(cfg.ConfigError) as ctx:
            cfg.load_config(path)
        text = str(ctx.exception)
        for fragment in fragments:
            self.assertIn(fragment, text)
        return ctx.exception

    def errors(self, path: Path) -> list[str]:
        with self.assertRaises(cfg.ConfigError) as ctx:
            cfg.load_config(path)
        return list(ctx.exception.errors)


class ExampleConfigTests(ConfigTestBase):
    def test_example_config_is_valid(self):
        config = cfg.load_config(EXAMPLE)

        self.assertEqual(config.timezone, "Asia/Shanghai")
        self.assertEqual(len(config.tasks), 5)
        self.assertTrue(all(task.enabled is False for task in config.tasks))
        self.assertIsNone(config.adapter)
        self.assertEqual(
            {task.id for task in config.tasks},
            {"campus_run", "club_activity", "event_signup", "event_checkin", "event_checkout"},
        )

    def test_example_database_path_is_relative_to_config_file(self):
        config = cfg.load_config(EXAMPLE)

        self.assertTrue(config.database_path.is_absolute())
        self.assertEqual(
            config.database_path,
            (EXAMPLE.parent / "runtime" / "auto3ct.db").resolve(),
        )

    def test_example_dependencies_form_a_chain(self):
        config = cfg.load_config(EXAMPLE)
        by_id = {task.id: task for task in config.tasks}

        self.assertEqual(by_id["event_checkin"].depends_on, ("event_signup",))
        self.assertEqual(by_id["event_checkout"].depends_on, ("event_checkin",))

    def test_validate_config_returns_no_errors_for_example(self):
        self.assertEqual(cfg.validate_config(EXAMPLE), [])


class FileLevelTests(ConfigTestBase):
    def test_missing_file_is_reported(self):
        self.assert_error(self.dir / "missing.json", "配置文件不存在")

    def test_invalid_json_is_reported_with_position(self):
        path = self.write("{ not json")
        self.assert_error(path, "不是合法 JSON", "第 1 行")

    def test_non_object_root_is_rejected(self):
        path = self.write([1, 2, 3])
        self.assert_error(path, "配置文件顶层必须是 JSON 对象")

    def test_unknown_top_level_key_is_rejected(self):
        path = self.write(self.base_config(extra_setting=1))
        self.assert_error(path, "未知配置项: extra_setting")

    def test_unsupported_version_is_rejected(self):
        path = self.write(self.base_config(version=2))
        self.assert_error(path, "不支持的配置版本: 2")

    def test_missing_tasks_is_rejected(self):
        data = {"version": 1}
        self.assert_error(self.write(data), "缺少 tasks")

    def test_tasks_must_be_list(self):
        self.assert_error(self.write(self.base_config(tasks={})), "tasks 必须是数组")

    def test_tasks_must_be_objects(self):
        self.assert_error(self.write(self.base_config(tasks=[1])), "任务 #1 必须是对象")


class TaskValidationTests(ConfigTestBase):
    def test_duplicate_task_id_is_rejected(self):
        path = self.write(
            self.base_config(tasks=[self.task(), self.task(action="check_out")])
        )
        self.assert_error(path, "任务 id 重复: check_in")

    def test_unknown_dependency_is_rejected(self):
        path = self.write(
            self.base_config(tasks=[self.task(depends_on=["not_defined"])])
        )
        self.assert_error(path, "任务 check_in 依赖未知任务: not_defined")

    def test_dependency_cycle_is_rejected(self):
        path = self.write(
            self.base_config(
                tasks=[
                    self.task(id="a", action="a", depends_on=["b"]),
                    self.task(id="b", action="b", depends_on=["a"]),
                ]
            )
        )
        self.assert_error(path, "任务依赖存在循环")

    def test_self_dependency_is_rejected(self):
        path = self.write(
            self.base_config(tasks=[self.task(depends_on=["check_in"])])
        )
        self.assert_error(path, "任务依赖存在循环: check_in")

    def test_cross_midnight_window_is_rejected_explicitly(self):
        path = self.write(
            self.base_config(tasks=[self.task(start="22:00", end="06:00")])
        )
        self.assert_error(path, "不支持跨夜")

    def test_invalid_time_format_is_rejected(self):
        for start, end in (("6:00", "12:00"), ("06:00", "24:00"), ("06:00", "12:60")):
            with self.subTest(start=start, end=end):
                path = self.write(
                    self.base_config(
                        tasks=[self.task(start=start, end=end)], name="bad.json"
                    )
                )
                self.assert_error(path, "时窗格式必须是 HH:MM")

    def test_equal_start_and_end_is_rejected(self):
        path = self.write(
            self.base_config(tasks=[self.task(start="06:00", end="06:00")])
        )
        self.assert_error(path, "时窗不能为空")

    def test_missing_time_window_is_rejected(self):
        task = self.task()
        del task["start"]
        self.assert_error(self.write(self.base_config(tasks=[task])), "缺少 start")

    def test_empty_weekdays_is_rejected(self):
        path = self.write(self.base_config(tasks=[self.task(weekdays=[])]))
        self.assert_error(path, "工作日不能为空")

    def test_invalid_weekday_values_are_rejected(self):
        for weekdays in ([0], [8], ["1"], [True]):
            with self.subTest(weekdays=weekdays):
                path = self.write(
                    self.base_config(
                        tasks=[self.task(weekdays=weekdays)], name="bad.json"
                    )
                )
                self.assert_error(path, "工作日必须是 1-7 的整数")

    def test_weekdays_are_normalized(self):
        config = cfg.load_config(
            self.write(self.base_config(tasks=[self.task(weekdays=[5, 1, 3, 3])]))
        )
        self.assertEqual(config.tasks[0].weekdays, (1, 3, 5))

    def test_enabled_must_be_boolean(self):
        path = self.write(self.base_config(tasks=[self.task(enabled="yes")]))
        self.assert_error(path, "enabled 必须是布尔值")

    def test_enabled_defaults_to_false(self):
        task = self.task()
        del task["enabled"]
        config = cfg.load_config(self.write(self.base_config(tasks=[task])))
        self.assertFalse(config.tasks[0].enabled)

    def test_enabled_task_requires_real_payload(self):
        path = self.write(
            self.base_config(tasks=[self.task(enabled=True, payload={})])
        )
        self.assert_error(path, "payload 仍为占位")

    def test_enabled_task_rejects_placeholder_payload(self):
        path = self.write(
            self.base_config(
                tasks=[self.task(enabled=True, payload={"placeholder": "待填写"})]
            )
        )
        self.assert_error(path, "payload 仍为占位")

    def test_enabled_task_with_real_payload_is_accepted(self):
        config = cfg.load_config(
            self.write(
                self.base_config(
                    tasks=[self.task(enabled=True, payload={"activity_id": "act-1"})]
                )
            )
        )
        self.assertTrue(config.tasks[0].enabled)

    def test_payload_must_be_object(self):
        path = self.write(self.base_config(tasks=[self.task(payload=[1])]))
        self.assert_error(path, "payload 必须是 JSON 对象")

    def test_payload_must_be_json_safe(self):
        raw = json.dumps(self.base_config(), ensure_ascii=False).replace(
            '"placeholder": "待填写"', '"n": NaN'
        )
        self.assert_error(self.write(raw), "payload 含非法 JSON 值")

    def test_task_id_format_is_validated(self):
        for task_id in ("", "has space", "中文"):
            with self.subTest(task_id=task_id):
                path = self.write(
                    self.base_config(
                        tasks=[self.task(id=task_id)], name="bad.json"
                    )
                )
                self.assert_error(path, "任务 id")

    def test_action_format_is_validated(self):
        for action in ("", "Check In", "校园跑"):
            with self.subTest(action=action):
                path = self.write(
                    self.base_config(
                        tasks=[self.task(action=action)], name="bad.json"
                    )
                )
                self.assert_error(path, "action 必须是")

    def test_unknown_task_key_is_rejected(self):
        path = self.write(self.base_config(tasks=[self.task(cron="* * * * *")]))
        self.assert_error(path, "任务 check_in 未知字段: cron")

    def test_per_task_max_attempts_is_validated(self):
        for value in (0, 11, "2", True):
            with self.subTest(value=value):
                path = self.write(
                    self.base_config(
                        tasks=[self.task(max_attempts=value)], name="bad.json"
                    )
                )
                self.assert_error(path, "max_attempts")


class PathAndGlobalOptionTests(ConfigTestBase):
    def test_relative_database_path_is_resolved_against_config_dir(self):
        path = self.write(self.base_config(database="state/my.db"))
        config = cfg.load_config(path)
        self.assertEqual(config.database_path, (self.dir / "state" / "my.db").resolve())

    def test_absolute_database_path_is_kept(self):
        absolute = (self.dir / "elsewhere" / "x.db").resolve()
        config = cfg.load_config(self.write(self.base_config(database=str(absolute))))
        self.assertEqual(config.database_path, absolute)

    def test_default_database_path(self):
        config = cfg.load_config(self.write(self.base_config()))
        self.assertEqual(config.database_path, (self.dir / "runtime" / "auto3ct.db").resolve())

    def test_memory_database_is_rejected(self):
        self.assert_error(
            self.write(self.base_config(database=":memory:")), "不支持 :memory:"
        )

    def test_timezone_must_be_asia_shanghai(self):
        self.assert_error(
            self.write(self.base_config(timezone="UTC")), "仅支持时区 Asia/Shanghai"
        )

    def test_timezone_defaults_to_asia_shanghai(self):
        self.assertEqual(cfg.load_config(self.write(self.base_config())).timezone, cfg.TIMEZONE_NAME)

    def test_adapter_must_be_object(self):
        self.assert_error(
            self.write(self.base_config(adapter="auto3ct.adapters:create")),
            "adapter 必须是对象",
        )

    def test_adapter_factory_format_is_validated(self):
        self.assert_error(
            self.write(self.base_config(adapter={"factory": "bad"})),
            "adapter.factory 格式应为 module:factory",
        )

    def test_adapter_unknown_key_is_rejected(self):
        self.assert_error(
            self.write(
                self.base_config(adapter={"factory": "m:f", "token": "x"})
            ),
            "adapter 未知字段: token",
        )

    def test_adapter_options_must_be_object(self):
        self.assert_error(
            self.write(self.base_config(adapter={"factory": "m:f", "options": []})),
            "adapter.options 必须是 JSON 对象",
        )

    def test_adapter_is_loaded_from_config(self):
        config = cfg.load_config(
            self.write(
                self.base_config(
                    adapter={"factory": "my_mod:create", "options": {"a": 1}}
                )
            )
        )
        self.assertIsNotNone(config.adapter)
        self.assertEqual(config.adapter.factory, "my_mod:create")
        self.assertEqual(config.adapter.options, {"a": 1})

    def test_interval_seconds_is_validated(self):
        for value in (0, -1, "30"):
            with self.subTest(value=value):
                path = self.write(
                    self.base_config(defaults={"interval_seconds": value})
                )
                self.assert_error(path, "interval_seconds")

    def test_default_max_attempts_is_validated(self):
        for value in (0, 100):
            with self.subTest(value=value):
                path = self.write(self.base_config(defaults={"max_attempts": value}))
                self.assert_error(path, "defaults.max_attempts")

    def test_defaults_unknown_key_is_rejected(self):
        self.assert_error(
            self.write(self.base_config(defaults={"retry": 1})),
            "defaults 未知字段: retry",
        )

    def test_default_interval_is_30_seconds(self):
        self.assertEqual(cfg.load_config(self.write(self.base_config())).interval_seconds, 30.0)


class ErrorCollectionTests(ConfigTestBase):
    def test_multiple_errors_are_collected_at_once(self):
        path = self.write(
            self.base_config(
                timezone="UTC",
                tasks=[
                    self.task(id="a", action="a", start="22:00", end="06:00"),
                    self.task(id="a", action="b"),
                    self.task(id="c", action="c", depends_on=["missing"]),
                ],
            )
        )
        errors = self.errors(path)
        text = "\n".join(errors)
        self.assertGreaterEqual(len(errors), 3)
        for fragment in ("时窗", "任务 id 重复", "依赖未知任务"):
            self.assertIn(fragment, text)

    def test_error_message_is_short_and_chinese(self):
        path = self.write(self.base_config(tasks=[]))
        config = cfg.load_config(path)
        self.assertEqual(config.tasks, ())

    def test_str_of_config_error_joins_errors(self):
        path = self.write(self.base_config(version=9))
        with self.assertRaises(cfg.ConfigError) as ctx:
            cfg.load_config(path)
        self.assertEqual(str(ctx.exception), "\n".join(ctx.exception.errors))


class TimezoneAndPathHelperTests(unittest.TestCase):
    def test_china_tz_has_utc_offset_of_eight_hours(self):
        tz = cfg.china_tz()
        self.assertEqual(ts(2025, 1, 6, 7).utcoffset(), timedelta(hours=8))
        self.assertEqual(tz.utcoffset(datetime(2025, 1, 6)), timedelta(hours=8))

    def test_default_config_path_uses_environment(self):
        old = os.environ.get("AUTO3CT_CONFIG")
        try:
            os.environ["AUTO3CT_CONFIG"] = str(self_config := Path("elsewhere/local.json"))
            self.assertEqual(cfg.default_config_path(), self_config)
        finally:
            if old is None:
                os.environ.pop("AUTO3CT_CONFIG", None)
            else:
                os.environ["AUTO3CT_CONFIG"] = old

    def test_default_config_path_falls_back_to_cwd(self):
        old = os.environ.pop("AUTO3CT_CONFIG", None)
        try:
            self.assertEqual(cfg.default_config_path(Path("D:/repo")), Path("D:/repo") / "config.local.json")
        finally:
            if old is not None:
                os.environ["AUTO3CT_CONFIG"] = old


if __name__ == "__main__":
    unittest.main()
