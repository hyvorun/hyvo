"""Write, load and verify ``run.json`` files (docs/RUN_FORMAT.md)."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from hyvo.runfile.canonical import CanonicalizationError, hash_run
from hyvo.runfile.models import RUN_RULES_ERROR, RunV1

RUN_FILENAME = "run.json"
SCHEMA_ENV_VAR = "HYVO_RUN_SCHEMA"
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SCHEMA_PATH = REPO_ROOT / "packages" / "schema" / "run.schema.json"
_MAX_MESSAGE_CHARS = 300

PathLike = str | os.PathLike[str]


class RunValidationError(ValueError):
    """A run document failed validation; ``errors`` holds one message per problem."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("invalid run.json:\n" + "\n".join(f"  {e}" for e in errors))
        self.errors = errors


@dataclass(frozen=True)
class VerifyResult:
    """Outcome of ``verify_run``, with the field meanings of ``verifyRunHash`` in packages/schema.

    ``expected`` is the hash recomputed from the content, the value ``hash`` must have (``None``
    when the content cannot be canonicalized); ``actual`` is the recorded ``hash`` member (``None``
    when it is missing or not a string). ``ok`` means both are equal and the document passed the
    pydantic models and the JSON Schema.
    """

    ok: bool
    expected: str | None
    actual: str | None
    schema_errors: list[str]
    model_errors: list[str]


def write_run(out_dir: PathLike, run: Mapping[str, Any], *, validate: bool = True) -> Path:
    """Set ``hash`` and write ``<out_dir>/run.json`` (UTF-8, ``indent=2``, ``ensure_ascii=False``).

    The caller's mapping is not modified; the written document is ``run`` with ``hash`` set (as the
    last member). With ``validate`` (the default) the document must pass ``RunV1`` first, otherwise
    ``RunValidationError`` is raised and nothing is written. Returns the path of the file.
    """
    doc = {key: value for key, value in run.items() if key != "hash"}
    doc["hash"] = hash_run(doc)
    if validate:
        problems = model_errors(doc)
        if problems:
            raise RunValidationError(problems)
    text = json.dumps(doc, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / RUN_FILENAME
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(text.encode("utf-8"))  # bytes: no CRLF translation on Windows
    os.replace(tmp, path)
    return path


def load_run(path: PathLike) -> dict[str, Any]:
    """Parse a ``run.json`` file strictly.

    Rejects a UTF-8 BOM, duplicate member names and the non-JSON constants NaN/Infinity, which
    Python's ``json`` module would otherwise accept, and a top level that is not an object.
    """
    text = Path(path).read_bytes().decode("utf-8")
    doc = json.loads(text, object_pairs_hook=_unique_members, parse_constant=_reject_constant)
    if not isinstance(doc, dict):
        raise ValueError(f"{path}: run.json must contain a JSON object")
    return doc


def model_errors(run: Mapping[str, Any]) -> list[str]:
    """Validate against ``RunV1``; return one message per problem (empty when valid)."""
    try:
        RunV1.model_validate(run)
    except ValidationError as exc:
        messages: list[str] = []
        for error in exc.errors():
            if error["type"] == RUN_RULES_ERROR:
                messages += [f"/: {problem}" for problem in error["ctx"]["problems"]]
            else:
                messages.append(f"{_pointer(error['loc'])}: {_clip(error['msg'])}")
        return messages
    return []


def schema_path() -> Path:
    """The JSON Schema location: ``$HYVO_RUN_SCHEMA`` or ``<repo>/packages/schema/run.schema.json``."""
    override = os.environ.get(SCHEMA_ENV_VAR)
    return Path(override) if override else DEFAULT_SCHEMA_PATH


def validate_json_schema(run: Mapping[str, Any]) -> list[str]:
    """Validate against ``run.schema.json`` (Draft 2020-12 unless the schema declares another).

    Returns one message per error, sorted by location; raises ``FileNotFoundError`` when the
    schema file does not exist.
    """
    path = schema_path().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"run.json schema not found at {path} (set {SCHEMA_ENV_VAR})")
    validator = _schema_validator(str(path), path.stat().st_mtime_ns)
    errors = [
        (_pointer(error.absolute_path), _clip(error.message))
        for error in validator.iter_errors(run)
    ]
    return [f"{where}: {message}" for where, message in sorted(errors)]


def verify_run(source: PathLike | Mapping[str, Any], *, check_schema: bool = True) -> VerifyResult:
    """Recompute the hash of a run (a path or an already parsed mapping) and validate it."""
    run = source if isinstance(source, Mapping) else load_run(source)
    recorded = run.get("hash")
    actual = recorded if isinstance(recorded, str) else None
    problems = model_errors(run)
    try:
        expected: str | None = hash_run(run)
    except CanonicalizationError as exc:
        expected = None
        problems.append(f"/: cannot be canonicalized (RFC 8785): {exc}")
    schema_problems = validate_json_schema(run) if check_schema else []
    ok = expected is not None and expected == actual and not problems and not schema_problems
    return VerifyResult(ok, expected, actual, schema_problems, problems)


@lru_cache(maxsize=4)
def _schema_validator(path: str, mtime_ns: int) -> Any:
    # mtime_ns is only part of the cache key, so an edited schema file is reloaded.
    # jsonschema is imported lazily: it is only needed when a schema check is requested.
    from jsonschema import Draft202012Validator
    from jsonschema.validators import validator_for

    schema = json.loads(Path(path).read_text(encoding="utf-8"))
    cls = validator_for(schema, default=Draft202012Validator)
    cls.check_schema(schema)
    return cls(schema)


def _unique_members(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    doc: dict[str, Any] = {}
    for key, value in pairs:
        if key in doc:
            raise ValueError(f"duplicate JSON member name {key!r}")
        doc[key] = value
    return doc


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


def _pointer(location: Any) -> str:
    return "/" + "/".join(str(part) for part in location)


def _clip(message: str) -> str:
    return message if len(message) <= _MAX_MESSAGE_CHARS else message[: _MAX_MESSAGE_CHARS - 3] + "..."
