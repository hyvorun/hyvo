"""``run.json`` v1: pydantic models, canonical hashing and file IO (docs/RUN_FORMAT.md)."""

from hyvo.runfile.canonical import (
    CanonicalizationError,
    bytes32_to_run_id,
    canonical_json,
    hash_run,
    keccak256_hex,
    new_run_id,
    run_id_to_bytes32,
    scenario_hash,
    utc_timestamp,
)
from hyvo.runfile.io import (
    RunValidationError,
    VerifyResult,
    load_run,
    model_errors,
    schema_path,
    validate_json_schema,
    verify_run,
    write_run,
)
from hyvo.runfile.models import DISCLAIMER, Report, RunV1
from hyvo.runfile.summary import run_meta, summarize_run

__all__ = [
    "DISCLAIMER",
    "CanonicalizationError",
    "Report",
    "RunV1",
    "RunValidationError",
    "VerifyResult",
    "bytes32_to_run_id",
    "canonical_json",
    "hash_run",
    "keccak256_hex",
    "load_run",
    "model_errors",
    "new_run_id",
    "run_id_to_bytes32",
    "run_meta",
    "scenario_hash",
    "schema_path",
    "summarize_run",
    "utc_timestamp",
    "validate_json_schema",
    "verify_run",
    "write_run",
]
