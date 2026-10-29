"""标准库正反例；临时输出全部位于系统临时目录并自动清理。"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import project_bundle as bundle


EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "stability-project.json"
SCRIPT = Path(__file__).with_name("project_bundle.py")


class ProjectBundleTests(unittest.TestCase):
    def setUp(self):
        self.data = bundle.load_project(EXAMPLE)

    def codes(self):
        return {x["code"] for x in bundle.validate(self.data)["issues"]}

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              capture_output=True, encoding="utf-8",
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"})

    def test_valid_example_and_no_mutation(self):
        before = copy.deepcopy(self.data)
        report = bundle.validate(self.data)
        self.assertEqual(report, {"structural_status": "valid", "semantic_status": "needs_review", "issues": []})
        self.assertEqual(before, self.data)
        self.assertEqual([s["duration"] for s in self.data["segments"]], [15, 15])

    def test_duplicate_shot_across_segments(self):
        self.data["segments"][1]["shots"][0]["id"] = "shot-001"
        self.assertIn("DUPLICATE_ID", self.codes())

    def test_duplicate_ids_all_entity_types(self):
        for field in ("characters", "assets", "segments"):
            with self.subTest(field=field):
                original = copy.deepcopy(self.data)
                self.data[field].append(copy.deepcopy(self.data[field][0]))
                self.assertIn("DUPLICATE_ID", self.codes())
                self.data = original

    def test_dangling_references(self):
        for target, key, value in (
            (self.data["assets"][0], "refs", ["missing"]),
            (self.data["segments"][0]["shots"][0], "asset_refs", ["char-lin"]),
            (self.data["segments"][0]["shots"][1]["dialogues"][0], "character_id", "asset-lin"),
        ):
            with self.subTest(key=key):
                old = target[key]
                target[key] = value
                self.assertIn("DANGLING_REF", self.codes())
                target[key] = old

    def test_visual_age_rejects_float_bool_string_negative(self):
        for age in (28.0, True, "28", -1, None):
            with self.subTest(age=age):
                self.data["characters"][0]["visual_age"] = age
                self.assertIn("VISUAL_AGE", self.codes())

    def test_assets_are_landscape_independent_of_video(self):
        self.assertEqual(self.data["project"]["video_aspect"], "9:16")
        self.data["assets"][0]["aspect"] = "9:16"
        self.assertIn("ASSET_ASPECT", self.codes())
        self.data["assets"][0]["aspect"] = "16:9"
        self.data["project"]["asset_aspect"] = "9:16"
        self.assertIn("ASSET_ASPECT", self.codes())

    def test_total_duration(self):
        self.data["project"]["total_duration"] = 29
        self.assertIn("TOTAL_DURATION", self.codes())

    def test_coverage_gap_overlap_outside_zero_and_tail(self):
        original = copy.deepcopy(self.data)
        for index, key, value in ((0, "start", 1), (1, "start", 2), (1, "start", 4),
                                  (3, "end", 16), (0, "end", 0), (3, "end", 14)):
            with self.subTest(index=index, key=key, value=value):
                self.data = copy.deepcopy(original)
                self.data["segments"][0]["shots"][index][key] = value
                self.assertIn("SHOT_COVERAGE", self.codes())

    def test_state_mismatch_requires_transition_but_not_semantic_pass(self):
        segment = self.data["segments"][1]
        segment["entry_state"] = "林站在门口。"
        self.assertIn("STATE_TRANSITION", self.codes())
        segment["transition"] = "空镜交代时间流逝，再切门口。"
        report = bundle.validate(self.data)
        self.assertEqual(report["structural_status"], "valid")
        self.assertEqual(report["semantic_status"], "needs_review")
        segment["transition"] = " "
        self.assertIn("SCHEMA", self.codes())

    def test_dialogue_budget_is_cumulative_warning(self):
        shot = self.data["segments"][0]["shots"][0]
        shot["dialogues"] = [{"character_id": "char-lin", "text": "一" * 9}] * 2
        report = bundle.validate(self.data)
        self.assertEqual(report["structural_status"], "valid")
        warnings = [x for x in report["issues"] if x["code"] == "DIALOGUE_BUDGET"]
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["level"], "WARN")
        self.assertEqual(report["semantic_status"], "needs_review")

    def test_invalid_schema_shapes_and_numbers(self):
        for data in (None, [], {}, {**self.data, "segments": []},
                     {**self.data, "assets": [None]}):
            with self.subTest(data=data):
                self.assertEqual(bundle.validate(data)["structural_status"], "error")
        for value in (True, float("nan"), float("inf"), "30", 0, -1):
            self.data["project"]["total_duration"] = value
            self.assertIn("SCHEMA", self.codes())

    def test_export_same_shots_deterministic_and_correct_stage(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "out"
            bundle.export_bundle(self.data, output)
            self.assertEqual({p.name for p in output.iterdir()}, {"assets-prompts.md", "P3CLEAN_GRID.md"})
            docs = {p.name: p.read_text(encoding="utf-8") for p in output.iterdir()}
            self.assertEqual(docs, bundle.render(self.data, bundle.validate(self.data)))
            for document in docs.values():
                self.assertIn("needs_review", document)
                for segment in self.data["segments"]:
                    for shot in segment["shots"]:
                        self.assertIn(f"### {shot['id']} [{shot['start']}-{shot['end']}s]", document)
                        self.assertIn(shot["action"], document)
                        self.assertIn(shot["camera"], document)
                        for dialogue in shot["dialogues"]:
                            self.assertIn(dialogue["text"], document)
            self.assertIn("# P3CLEAN_GRID", docs["P3CLEAN_GRID.md"])
            self.assertIn("布局：2 行 × 2 列", docs["P3CLEAN_GRID.md"])
            self.assertIn("无文字", docs["P3CLEAN_GRID.md"])

    def test_error_export_never_creates_output(self):
        self.data["segments"][0]["shots"][0]["asset_refs"] = ["missing"]
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "out"
            with self.assertRaises(bundle.BundleError):
                bundle.export_bundle(self.data, output)
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_existing_output_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "out"
            output.mkdir()
            sentinel = output / "assets-prompts.md"
            sentinel.write_bytes(b"original")
            with self.assertRaises(bundle.BundleError):
                bundle.export_bundle(self.data, output)
            self.assertEqual(sentinel.read_bytes(), b"original")
            self.assertEqual(list(output.iterdir()), [sentinel])

    def test_write_failure_leaves_no_partial_files(self):
        with tempfile.TemporaryDirectory() as temp:
            real_write = Path.write_text
            calls = 0

            def fail_second(path, *args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("模拟第二份文件写入失败")
                return real_write(path, *args, **kwargs)

            with patch.object(Path, "write_text", fail_second):
                with self.assertRaises(OSError):
                    bundle.export_bundle(self.data, Path(temp) / "out")
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_cli_validate_and_export(self):
        self.assertEqual(self.cli("validate", EXAMPLE).returncode, 0)
        with tempfile.TemporaryDirectory() as temp:
            result = self.cli("export", EXAMPLE, "-o", Path(temp) / "out")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["semantic_status"], "needs_review")
            self.assertTrue((Path(temp) / "out" / "P3CLEAN_GRID.md").is_file())

    def test_cli_bad_json_duplicate_keys_nan_and_missing_file(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "bad.json"
            output = Path(temp) / "out"
            for content in ("{", '{"project": 1, "project": 2}', '{"x": NaN}', '{"x": Infinity}'):
                source.write_text(content, encoding="utf-8")
                result = self.cli("export", source, "-o", output)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertFalse(output.exists())
                self.assertEqual({p.name for p in Path(temp).iterdir()}, {"bad.json"})
            self.assertEqual(self.cli("validate", Path(temp) / "missing.json").returncode, 1)

    def test_warning_does_not_block_export(self):
        self.data["segments"][0]["shots"][0]["dialogues"] = [{"character_id": "char-lin", "text": "长" * 100}]
        with tempfile.TemporaryDirectory() as temp:
            bundle.export_bundle(self.data, Path(temp) / "out")
            self.assertIn("DIALOGUE_BUDGET", (Path(temp) / "out" / "P3CLEAN_GRID.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
