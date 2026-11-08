"""write_run, load_run, JSON Schema plumbing and verify_run (including tamper detection)."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

import pytest

from hyvo.runfile import (
    RunValidationError,
    hash_run,
    load_run,
    validate_json_schema,
    verify_run,
    write_run,
)
from hyvo.runfile.io import DEFAULT_SCHEMA_PATH, SCHEMA_ENV_VAR, schema_path

Doc = dict[str, Any]

MINI_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["runId", "version", "hash"],
    "properties": {
        "runId": {"type": "string", "pattern": "^run_[0-9A-HJKMNP-TV-Z]{26}$"},
        "version": {"const": 1},
        "rounds": {"type": "array", "items": {"type": "object", "required": ["n"]}},
    },
}


@pytest.fixture
def mini_schema(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "mini.schema.json"
    path.write_text(json.dumps(MINI_SCHEMA), encoding="utf-8")
    monkeypatch.setenv(SCHEMA_ENV_VAR, str(path))
    return path


def _rewrite(path: Path, change: Any) -> None:
    doc = json.loads(path.read_text(encoding="utf-8"))
    change(doc)
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")


def test_write_run_sets_hash_and_formats_the_file(tmp_path: Path, run_doc: Doc) -> None:
    run_doc["hash"] = "0x" + "0" * 64  # stale hash: replaced
    original = copy.deepcopy(run_doc)
    path = write_run(tmp_path / "runs" / run_doc["runId"], run_doc)

    assert path.name == "run.json" and path.parent.name == run_doc["runId"]
    assert run_doc == original, "the caller's mapping must not be modified"
    raw = path.read_bytes()
    assert b"\r" not in raw and raw.endswith(b"}\n")
    text = raw.decode("utf-8")
    assert "café, 🚀" in text, "non-ASCII is written as UTF-8, not \\u escapes"
    assert text.startswith('{\n  "runId": ')
    written = json.loads(text)
    assert list(written)[-1] == "hash"
    assert written["hash"] == hash_run(original) != original["hash"]
    assert not list(path.parent.glob("*.tmp"))


def test_write_run_overwrites_and_loads_back(tmp_path: Path, run_doc: Doc) -> None:
    write_run(tmp_path, run_doc)
    run_doc["report"]["summary"] = "A different summary."
    path = write_run(tmp_path, run_doc)
    loaded = load_run(path)
    assert loaded["report"]["summary"] == "A different summary."
    assert loaded["hash"] == hash_run(run_doc)


def test_write_run_refuses_an_invalid_run(tmp_path: Path, run_doc: Doc) -> None:
    run_doc["report"]["sentimentByRound"] = [0.0]
    with pytest.raises(RunValidationError) as info:
        write_run(tmp_path, run_doc)
    assert any("sentimentByRound" in e for e in info.value.errors)
    assert not (tmp_path / "run.json").exists()
    assert write_run(tmp_path, run_doc, validate=False).is_file()


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b'{"a": 1, "a": 2}', "duplicate JSON member"),
        (b'{"a": NaN}', "NaN is not valid JSON"),
        (b'{"a": -Infinity}', "-Infinity is not valid JSON"),
        (b"\xef\xbb\xbf{}", "BOM"),
        (b"[1, 2]", "must contain a JSON object"),
    ],
)
def test_load_run_is_strict(tmp_path: Path, content: bytes, message: str) -> None:
    path = tmp_path / "run.json"
    path.write_bytes(content)
    with pytest.raises(ValueError, match=message):
        load_run(path)


def test_verify_run_accepts_a_written_run(tmp_path: Path, run_doc: Doc, mini_schema: Path) -> None:
    path = write_run(tmp_path, run_doc)
    result = verify_run(path)
    assert result.ok, result
    assert result.expected == result.actual == hash_run(run_doc)
    assert result.schema_errors == [] and result.model_errors == []
    assert verify_run(load_run(path)).ok


def test_tampered_content_is_detected(tmp_path: Path, run_doc: Doc, mini_schema: Path) -> None:
    path = write_run(tmp_path, run_doc)
    _rewrite(path, lambda d: d["rounds"][0]["posts"][0].update(text="Edited after the fact."))
    result = verify_run(path)
    assert not result.ok
    assert result.actual == hash_run(run_doc), "actual is the recorded hash"
    assert result.expected == hash_run(load_run(path)) != result.actual, "expected is recomputed"
    assert result.model_errors == [] and result.schema_errors == []


def test_tampered_hash_is_detected(tmp_path: Path, run_doc: Doc, mini_schema: Path) -> None:
    path = write_run(tmp_path, run_doc)
    _rewrite(path, lambda d: d.update(hash="0x" + "1" * 64))
    result = verify_run(path)
    assert not result.ok
    assert result.expected == hash_run(run_doc) and result.actual == "0x" + "1" * 64


def test_tampered_numbers_are_detected(tmp_path: Path, run_doc: Doc, mini_schema: Path) -> None:
    path = write_run(tmp_path, run_doc)
    _rewrite(path, lambda d: d["rounds"][1]["market"].update(price="0.0000012"))
    assert not verify_run(path).ok
    _rewrite(path, lambda d: d["rounds"][1]["market"].update(price="0.0000011"))
    assert verify_run(path).ok, "restoring the value restores the hash"


def test_missing_hash_and_invalid_content(run_doc: Doc, mini_schema: Path) -> None:
    del run_doc["hash"]
    result = verify_run(run_doc)
    assert not result.ok and result.actual is None and result.expected == hash_run(run_doc)
    assert any(e.startswith("/hash") for e in result.model_errors)
    assert any("hash" in e for e in result.schema_errors)


def test_uncanonicalizable_content_is_reported(run_doc: Doc) -> None:
    run_doc["usage"]["inputTokens"] = 2**60
    result = verify_run(run_doc, check_schema=False)
    assert not result.ok and result.expected is None and result.actual == run_doc["hash"]
    assert any("canonicalized" in e for e in result.model_errors)
    assert any(e.startswith("/usage/inputTokens") for e in result.model_errors)


def test_schema_errors_are_reported_with_locations(run_doc: Doc, mini_schema: Path) -> None:
    run_doc["version"] = 2
    del run_doc["rounds"][1]["n"]
    errors = validate_json_schema(run_doc)
    assert [e.split(":")[0] for e in errors] == ["/rounds/1", "/version"]


def test_schema_path_default_and_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv(SCHEMA_ENV_VAR, raising=False)
    assert schema_path() == DEFAULT_SCHEMA_PATH
    assert DEFAULT_SCHEMA_PATH.parts[-3:] == ("packages", "schema", "run.schema.json")
    monkeypatch.setenv(SCHEMA_ENV_VAR, str(tmp_path / "absent.json"))
    with pytest.raises(FileNotFoundError, match=SCHEMA_ENV_VAR):
        validate_json_schema({})


def test_edited_schema_is_reloaded(run_doc: Doc, mini_schema: Path) -> None:
    assert validate_json_schema(run_doc) == []
    stricter = MINI_SCHEMA | {"required": [*MINI_SCHEMA["required"], "notThere"]}
    mini_schema.write_text(json.dumps(stricter), encoding="utf-8")
    stat = mini_schema.stat()
    os.utime(mini_schema, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    assert any("notThere" in e for e in validate_json_schema(run_doc))
