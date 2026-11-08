"""A sample dApp with a planted bug gets a report that surfaces the bug (SPEC §14 Phase 6), and the parts it is made of."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from hyvo.cli import app
from hyvo.config import load_settings
from hyvo.dryrun.abi import action_space, coerce_args, is_admin_name
from hyvo.dryrun.crowd import PERSONAS, make_crowd
from hyvo.dryrun.document import FILENAME, dry_run_meta, dry_run_problems, hash_dry_run
from hyvo.dryrun.findings import analyze
from hyvo.dryrun.play import play_dry_run
from hyvo.dryrun.spec import DryRunError, DryRunSpec, from_mapping
from hyvo.report.guard import find_violations

ARTIFACT = Path(__file__).resolve().parents[3] / "chain" / "artifacts" / "SampleVault.json"
SAMPLE = json.loads(ARTIFACT.read_text(encoding="utf-8"))
ABI = tuple(SAMPLE["abi"])
BYTECODE = SAMPLE["bytecode"]
DESCRIPTION = "A savings vault. People deposit ETH and can withdraw it whenever they want."


def spec(**changes: Any) -> DryRunSpec:
    return DryRunSpec(**{"description": DESCRIPTION, "abi": ABI, "bytecode": BYTECODE, "invariants": ("isSolvent",), "agents": 12, "rounds": 8, "seed": 7, **changes})


@pytest.fixture(scope="module")
def report(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    outcome = play_dry_run(spec(), load_settings(environ={}, dotenv_path=None), runs_dir=tmp_path_factory.mktemp("dry"), offline=True)
    return json.loads(outcome.path.read_text(encoding="utf-8"))


def kinds(report: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    found: dict[str, list[dict[str, Any]]] = {}
    for finding in report["findings"]:
        found.setdefault(finding["kind"], []).append(finding)
    return found


# --- the definition of done ---------------------------------------------------------------------


@pytest.mark.anvil
@pytest.mark.slow
def test_the_planted_overpayment_is_surfaced_by_the_invariant_and_by_the_money(report: dict[str, Any]) -> None:
    found = kinds(report)
    [broken] = found["invariant_violation"]
    assert broken["severity"] == "high" and "isSolvent" in broken["title"]
    assert "withdraw" in broken["detail"]
    assert found["unusual_balance"], "a user took out more than it put in"
    assert all(finding["severity"] == "high" for finding in found["unusual_balance"])
    invariant = next(item for item in report["invariants"] if item["name"] == "isSolvent")
    assert not invariant["held"] and invariant["firstBroken"] is not None
    assert report["calls"][invariant["firstBroken"]]["function"] == "withdraw(uint256)"


@pytest.mark.anvil
@pytest.mark.slow
def test_the_planted_open_admin_function_is_surfaced_and_the_guarded_one_is_not(report: dict[str, Any]) -> None:
    [open_admin] = kinds(report)["access_control"]
    assert open_admin["severity"] == "high" and "rescueFunds" in open_admin["title"]
    guarded = next(probe for probe in report["probes"] if probe["function"] == "setFee(uint256)")
    assert guarded["status"] == "reverted" and "NotOwner" in guarded["reason"]
    assert "setFee(uint256)" not in {finding["title"] for finding in kinds(report)["access_control"]}


@pytest.mark.anvil
@pytest.mark.slow
def test_every_finding_says_how_to_reproduce_it(report: dict[str, Any]) -> None:
    found = kinds(report)
    assert report["findings"], "the planted bugs were not found at all"
    for kind in ("invariant_violation", "unusual_balance", "access_control"):
        for finding in found[kind]:
            assert finding["reproduce"], finding
            for step in finding["reproduce"]:
                assert {"round", "agentId", "function", "args", "valueWei"} <= set(step)
    last = found["invariant_violation"][0]["reproduce"][-1]
    assert last["function"] == "withdraw(uint256)"
    assert report["findings"][0]["severity"] == "high", "the worst comes first"


# --- what is recorded -----------------------------------------------------------------------------


@pytest.mark.anvil
@pytest.mark.slow
def test_every_call_is_recorded_with_its_gas_its_reason_and_what_it_changed(report: dict[str, Any]) -> None:
    calls = report["calls"]
    assert len(calls) > 40
    made = [call for call in calls if call["status"] == "ok"]
    assert made and all(call["gasUsed"] and call["txHash"] for call in made)
    deposit = next(call for call in made if call["function"] == "deposit()")
    assert int(deposit["ethDeltaWei"]) < 0 and int(deposit["contractDeltaWei"]) > 0
    assert "Deposited" in deposit["events"]
    assert "totalDeposits" in deposit["changes"]
    failed = [call for call in calls if call["status"] == "reverted"]
    assert failed and all(call["reason"] for call in failed)
    assert any("not enough deposited" in call["reason"] for call in failed)


@pytest.mark.anvil
@pytest.mark.slow
def test_the_report_holds_together_and_says_what_it_is_not(report: dict[str, Any]) -> None:
    assert dry_run_problems(report) == []
    assert hash_dry_run(report) == report["hash"]
    assert "Synthetic crowd reaction. Not a trading signal." in report["disclaimer"]
    assert "not an audit" in report["disclaimer"]
    assert report["status"] == "complete" and report["crowd"]["size"] == 12
    assert set(report["crowd"]["personas"]) == {persona.id for persona in PERSONAS}
    assert sorted(report["actionSpace"]["functions"]) == ["checkpoint()", "deposit()", "withdraw(uint256)"]
    assert sorted(report["actionSpace"]["keptForTheOwner"]) == ["rescueFunds(address)", "setFee(uint256)"]
    assert "isSolvent" in report["actionSpace"]["reads"]
    meta = dry_run_meta(report, b"x")
    assert meta["hash"] == report["hash"] and meta["summary"]["findings"]["high"] >= 2
    tampered = json.loads(json.dumps(report))
    tampered["findings"] = []
    assert dry_run_problems(tampered) == ["its hash does not match its content"]


@pytest.mark.anvil
@pytest.mark.slow
def test_what_users_said_is_kept_and_never_breaks_the_copy_rules(report: dict[str, Any]) -> None:
    assert report["feedback"]
    for line in report["feedback"]:
        assert line["text"] and find_violations(line["text"]) == []


@pytest.mark.anvil
@pytest.mark.slow
def test_the_same_seed_gives_the_same_report(tmp_path: Path, report: dict[str, Any]) -> None:
    outcome = play_dry_run(spec(), load_settings(environ={}, dotenv_path=None), runs_dir=tmp_path, offline=True)
    again = json.loads(outcome.path.read_text(encoding="utf-8"))
    def strip(doc: dict[str, Any]) -> list[Any]:
        return [(call["agentId"], call["function"], call["args"], call["status"]) for call in doc["calls"]]
    assert strip(again) == strip(report)
    assert [finding["title"] for finding in again["findings"]] == [finding["title"] for finding in report["findings"]]


@pytest.mark.anvil
@pytest.mark.slow
def test_a_budget_too_small_ends_it_early_and_says_so(tmp_path: Path) -> None:
    outcome = play_dry_run(spec(max_llm_calls=3), load_settings(environ={}, dotenv_path=None), runs_dir=tmp_path, offline=True)
    assert outcome.status == "partial" and outcome.stop_reason == "budget"
    assert dry_run_problems(json.loads(outcome.path.read_text(encoding="utf-8"))) == []


@pytest.mark.anvil
@pytest.mark.slow
def test_bytecode_that_does_not_deploy_is_a_clear_failure(tmp_path: Path) -> None:
    with pytest.raises(DryRunError, match="constructor reverted|could not be deployed"):
        play_dry_run(spec(bytecode="0xfe"), load_settings(environ={}, dotenv_path=None), runs_dir=tmp_path, offline=True)


@pytest.mark.anvil
@pytest.mark.slow
def test_the_command_plays_a_spec_file(tmp_path: Path) -> None:
    file = tmp_path / "spec.json"
    file.write_text(json.dumps({"description": DESCRIPTION, "abi": list(ABI), "bytecode": BYTECODE, "invariants": ["isSolvent"], "agents": 8, "rounds": 3, "seed": 2}), encoding="utf-8")
    result = CliRunner().invoke(app, ["dryrun", str(file), "--offline", "--out", str(tmp_path / "out")])
    assert result.exit_code == 0, result.output
    assert "findings" in result.output
    assert list((tmp_path / "out").glob(f"*/{FILENAME}"))


def test_the_command_says_what_is_wrong_with_a_spec(tmp_path: Path) -> None:
    file = tmp_path / "spec.json"
    file.write_text(json.dumps({"description": "x"}), encoding="utf-8")
    result = CliRunner().invoke(app, ["dryrun", str(file), "--offline"])
    assert result.exit_code == 2 and "address or bytecode" in result.output


# --- the action space -----------------------------------------------------------------------------


def test_the_action_space_is_what_users_can_call() -> None:
    space = action_space(ABI)
    assert sorted(function.signature for function in space.actions) == ["checkpoint()", "deposit()", "withdraw(uint256)"]
    assert space.find("deposit()").payable and not space.find("withdraw").payable
    assert sorted(function.signature for function in space.admin) == ["rescueFunds(address)", "setFee(uint256)"]
    assert {function.name for function in space.reads} >= {"owner", "totalDeposits", "isSolvent"}
    assert "balanceOf" not in {function.name for function in space.reads}, "a read that takes arguments is not state to show"
    assert set(space.events) == {"Deposited", "Withdrawn"}


@pytest.mark.parametrize("name", ["setFee", "transferOwnership", "pause", "unpause", "upgradeTo", "grantRole", "rescueFunds", "withdrawFees", "emergencyStop", "adminMint", "ownerWithdraw", "initialize"])
def test_these_are_kept_for_the_owner(name: str) -> None:
    assert is_admin_name(name)


@pytest.mark.parametrize("name", ["deposit", "withdraw", "swap", "mint", "settle", "setup", "pauseless", "claim", "stake", "transfer", "approve"])
def test_these_are_for_users(name: str) -> None:
    assert not is_admin_name(name)


def test_an_abi_with_nothing_to_call_is_refused() -> None:
    with pytest.raises(DryRunError, match="no function a user could call"):
        action_space([{"type": "function", "name": "owner", "inputs": [], "stateMutability": "view"}])


ALL_TYPES = {
    "type": "function",
    "name": "f",
    "stateMutability": "nonpayable",
    "inputs": [
        {"name": "a", "type": "uint8"},
        {"name": "b", "type": "int16"},
        {"name": "c", "type": "address"},
        {"name": "d", "type": "bool"},
        {"name": "e", "type": "bytes4"},
        {"name": "f", "type": "string"},
        {"name": "g", "type": "uint256[]"},
        {"name": "h", "type": "tuple", "components": [{"name": "x", "type": "uint256"}, {"name": "y", "type": "bool"}]},
    ],
}


def function() -> Any:
    return action_space([ALL_TYPES]).actions[0]


GOOD = ["255", -3, "0x" + "ab" * 20, "true", "0x01020304", "hi", ["1", 2], {"x": "5", "y": False}]


def test_what_an_agent_sends_becomes_what_the_abi_wants() -> None:
    assert function().signature == "f(uint8,int16,address,bool,bytes4,string,uint256[],(uint256,bool))"
    values = coerce_args(function(), GOOD)
    assert values[0] == 255 and values[1] == -3 and values[3] is True and values[4] == b"\x01\x02\x03\x04"
    assert values[6] == [1, 2] and values[7] == (5, False)


@pytest.mark.parametrize(
    "index, bad, why",
    [
        (0, "256", "does not fit"),
        (0, "-1", "does not fit"),
        (0, "abc", "not a whole number"),
        (0, 1.5, "not a whole number"),
        (0, True, "must be a number"),
        (2, "0x12", "not an address"),
        (3, "maybe", "not true or false"),
        (4, "0x01", "must be 4 bytes"),
        (4, "nope", "must be 0x"),
        (6, "1", "must be a list"),
        (6, ["1"] * 17, "at most"),
        (7, ["1"], "a tuple of 2"),
    ],
)
def test_what_an_agent_cannot_send_is_named(index: int, bad: Any, why: str) -> None:
    args = list(GOOD)
    args[index] = bad
    with pytest.raises(DryRunError, match=why):
        coerce_args(function(), args)


def test_the_wrong_number_of_arguments_is_named() -> None:
    with pytest.raises(DryRunError, match="takes 8 arguments, got 1"):
        coerce_args(function(), ["1"])
    with pytest.raises(DryRunError, match="must be a list"):
        coerce_args(function(), "1")


# --- the submission -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "changes, why",
    [
        ({"bytecode": None}, "either a contract address or bytecode"),
        ({"address": "0x" + "1" * 40}, "either a contract address or bytecode"),
        ({"bytecode": None, "address": "0x12"}, "40 hex digits"),
        ({"bytecode": "0xabc"}, "even number"),
        ({"bytecode": "0x" + "00" * 49_153}, "longer than"),
        ({"abi": None}, "needs its ABI"),
        ({"description": "  "}, "plain language"),
        ({"invariants": ("not a name",)}, "name of a view function"),
        ({"invariants": tuple(f"f{i}" for i in range(11))}, "at most 10"),
        ({"agents": 3}, "from 4 to 40"),
        ({"agents": 41}, "from 4 to 40"),
        ({"rounds": 0}, "1 to 30"),
        ({"rounds": 31}, "1 to 30"),
    ],
)
def test_a_bad_submission_says_what_to_change(changes: dict[str, Any], why: str) -> None:
    with pytest.raises(DryRunError, match=why):
        spec(**changes)


def test_a_submission_from_json_keeps_its_fields_and_refuses_others() -> None:
    parsed = from_mapping({"description": DESCRIPTION, "abi": list(ABI), "bytecode": BYTECODE, "constructorArgs": [1], "invariants": ["isSolvent"], "agents": 5, "rounds": 2})
    assert parsed.constructor_args == (1,) and parsed.agents == 5
    with pytest.raises(DryRunError, match="unknown field"):
        from_mapping({"description": DESCRIPTION, "bytecode": BYTECODE, "abi": list(ABI), "evil": 1})
    with pytest.raises(DryRunError, match="whole number"):
        from_mapping({"description": DESCRIPTION, "bytecode": BYTECODE, "abi": list(ABI), "agents": "12"})
    with pytest.raises(DryRunError, match="JSON list"):
        from_mapping({"description": DESCRIPTION, "bytecode": BYTECODE, "abi": "[]"})


# --- the crowd and the findings -------------------------------------------------------------------


def test_every_crowd_has_every_kind_of_user() -> None:
    crowd = make_crowd(5, seed=1)
    assert {user.persona.id for user in crowd} == {persona.id for persona in PERSONAS}
    assert [user.agent_id for user in crowd] == ["u01", "u02", "u03", "u04", "u05"]
    assert crowd == make_crowd(5, seed=1)


def call(**changes: Any) -> dict[str, Any]:
    return {"round": 1, "agentId": "u01", "persona": "newcomer", "function": "f()", "args": [], "valueWei": "0", "status": "ok", "reason": None, "gasUsed": 50_000, "ethDeltaWei": "0", **changes}


def test_repeated_failures_from_several_users_are_a_confusing_flow() -> None:
    failed = [call(status="reverted", reason="nope", agentId=f"u0{i}") for i in range(1, 4)]
    [finding, *_] = analyze(failed, [], [])
    assert finding["kind"] == "confusing_flow" and finding["severity"] == "medium" and "nope" in finding["title"]


def test_one_user_failing_over_and_over_is_not_a_flow_problem() -> None:
    assert [finding for finding in analyze([call(status="reverted", reason="nope")] * 3, [], []) if finding["kind"] == "confusing_flow"] == []


def test_a_function_that_never_worked_is_mentioned() -> None:
    failed = [call(status="reverted", reason=f"r{i}", agentId=f"u0{i}") for i in range(3)]
    assert any(finding["kind"] == "never_worked" for finding in analyze(failed, [], []))


def test_gas_that_stands_out_is_mentioned_and_small_numbers_are_not() -> None:
    calls = [call(gasUsed=50_000), call(gasUsed=50_000), call(gasUsed=50_000), call(gasUsed=400_000, round=5)]
    [finding] = [item for item in analyze(calls, [], []) if item["kind"] == "gas_outlier"]
    assert finding["severity"] == "low" and "400,000" in finding["title"] and finding["reproduce"][0]["round"] == 5
    small = [call(gasUsed=1_000), call(gasUsed=1_000), call(gasUsed=1_000), call(gasUsed=90_000)]
    assert [item for item in analyze(small, [], []) if item["kind"] == "gas_outlier"] == []


def test_a_first_call_that_writes_new_storage_is_not_a_gas_problem() -> None:
    first = [call(agentId="u01", gasUsed=133_000), call(agentId="u02", gasUsed=99_000)]
    again = [call(agentId=agent, gasUsed=35_000) for agent in ("u01", "u02", "u01", "u02")]
    assert [item for item in analyze([*first, *again], [], []) if item["kind"] == "gas_outlier"] == []


ETH = 10**18


def test_money_out_of_nowhere_is_one_finding_however_many_users_ran_into_it() -> None:
    calls = [
        call(agentId="u01", ethDeltaWei=str(-ETH)),
        call(agentId="u01", ethDeltaWei=str(ETH + ETH // 10), function="withdraw(uint256)", round=2),
        call(agentId="u02", persona="power_user", ethDeltaWei=str(-ETH)),
        call(agentId="u02", persona="power_user", ethDeltaWei=str(ETH + ETH // 2), function="withdraw(uint256)", round=3),
    ]
    [finding] = [item for item in analyze(calls, [], []) if item["kind"] == "unusual_balance"]
    assert finding["title"] == "2 users took out more than they put in"
    assert finding["detail"].startswith("u02 (power user) got 0.5000 ETH ahead, starting with withdraw(uint256) in round 3. Also: u01.")
    assert [step["agentId"] for step in finding["reproduce"]] == ["u01", "u01", "u02", "u02"]


def test_it_reports_how_far_ahead_a_user_got_even_if_it_put_more_in_later() -> None:
    calls = [call(ethDeltaWei=str(-ETH)), call(ethDeltaWei=str(ETH + ETH // 10), round=2), call(ethDeltaWei=str(-5 * ETH), round=3)]
    [finding] = [item for item in analyze(calls, [], []) if item["kind"] == "unusual_balance"]
    assert finding["title"] == "u01 took out more than it put in"
    assert "got 0.1000 ETH ahead" in finding["detail"] and "-" not in finding["detail"]


def test_putting_money_in_and_taking_it_out_is_not_suspicious() -> None:
    calls = [call(ethDeltaWei="-100"), call(ethDeltaWei="100"), call(ethDeltaWei="-5")]
    assert [item for item in analyze(calls, [], []) if item["kind"] == "unusual_balance"] == []


def test_an_invariant_false_from_the_start_or_unreadable_is_said_plainly() -> None:
    found = analyze([], [{"name": "a", "falseFromStart": True, "firstBroken": None, "error": None}, {"name": "b", "falseFromStart": False, "firstBroken": None, "error": "no such function"}], [])
    assert {finding["kind"] for finding in found} == {"invariant_violation", "invariant_unreadable"}
    assert found[0]["severity"] == "high"


def test_a_clean_contract_has_nothing_to_report() -> None:
    assert analyze([call(), call(ethDeltaWei="-5")], [{"name": "ok", "falseFromStart": False, "firstBroken": None, "error": None}], [{"status": "reverted", "function": "setFee(uint256)", "agentId": "x", "args": []}]) == []


def test_the_example_submission_is_the_sample_vault() -> None:
    example = Path(__file__).resolve().parents[2] / "examples" / "dryrun" / "sample-vault.json"
    parsed = json.loads(example.read_text(encoding="utf-8"))
    assert parsed["bytecode"] == BYTECODE and parsed["abi"] == list(ABI)
    assert from_mapping(parsed).invariants == ("isSolvent",)
