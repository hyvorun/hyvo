from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import jsonschema
import pytest

from hyvo.scenarios import (
    InjectedEvent,
    MarketOverrides,
    Scenario,
    ScenarioError,
    SeedSource,
    from_text,
    load_scenario_file,
    parse_scenario_markdown,
)
from hyvo.scenarios.models import MAX_EVENTS, MAX_EVENTS_PER_ROUND
from hyvo.scenarios.sanitize import ELLIPSIS, MAX_SEED_CHARS

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "scenarios" / "pons-creator-tax.md"
SCHEMA_FILE = Path(__file__).resolve().parents[3] / "packages" / "schema" / "run.schema.json"


def doc(front: str = "title: A test scenario", body: str = "Seed text.") -> str:
    return f"---\n{front}\n---\n\n{body}\n"


def test_example_scenario_parses():
    scenario = load_scenario_file(EXAMPLE)
    assert scenario.title == "Fictional Pons token GLINT lists with a 5% creator tax"
    assert scenario.market == MarketOverrides(
        token_symbol="GLINT",
        token_name="Glint (fictional test token)",
        liquidity_eth=Decimal(5),
        liquidity_tokens=Decimal(100000000),
        fee_bps=500,
    )
    assert [e.round for e in scenario.injected_events] == [3, 5, 8]
    assert "pons.example/glint." in scenario.seed_text
    assert "https://" not in scenario.seed_text and "ref=launch" not in scenario.seed_text
    assert scenario.seed_sources == (SeedSource("user", "pons-creator-tax.md"),)
    scenario.check_rounds(10)


@pytest.mark.parametrize("path", sorted(EXAMPLE.parent.glob("*.md")), ids=lambda path: path.stem)
def test_every_example_is_fictional_and_fits_a_ten_round_run(path: Path):
    scenario = load_scenario_file(path)
    assert "fictional" in scenario.seed_text.lower()
    assert scenario.market is not None
    assert "fictional" in scenario.market.token_name.lower()
    assert scenario.injected_events
    scenario.check_rounds(10)


def test_example_scenario_matches_the_run_json_schema():
    if not SCHEMA_FILE.is_file():
        pytest.skip(f"{SCHEMA_FILE} is missing; it is produced by packages/schema")
    schema = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))["properties"]["scenario"]
    jsonschema.validate(load_scenario_file(EXAMPLE).to_run_dict(), schema)
    capped = from_text("t" * 999, "s" * 9999, [{"round": 1, "text": "e" * 999}])
    jsonschema.validate(capped.to_run_dict(), schema)


def test_run_dict_is_the_run_json_scenario_object():
    scenario = parse_scenario_markdown(
        doc(body="Seed.\n\n## Events\n\n- round 4: Rumor: dev wallet sold 20%"), ref="s.md"
    )
    assert scenario.to_run_dict() == {
        "title": "A test scenario",
        "seedText": "Seed.",
        "seedSources": [{"kind": "user", "ref": "s.md"}],
        "injectedEvents": [{"round": 4, "text": "Rumor: dev wallet sold 20%"}],
    }


def test_events_are_sorted_and_grouped_by_round():
    body = "x\n\n## Events\n- Round 5: late\n* round 2: early\n-round 5:   also late  \n"
    scenario = parse_scenario_markdown(doc(body=body))
    assert [(e.round, e.text) for e in scenario.injected_events] == [
        (2, "early"), (5, "late"), (5, "also late"),
    ]  # fmt: skip
    assert scenario.events_at(5) == (InjectedEvent(5, "late"), InjectedEvent(5, "also late"))
    assert scenario.events_at(1) == ()


def test_front_matter_features():
    front = (
        "# a comment\n"
        'title: "Quoted: title with # and colon"\n'
        "token_symbol: $glint\n"
        "liquidity_eth: 2.5\n"
        "fee_bps: 0\n"
    )
    scenario = parse_scenario_markdown(doc(front=front))
    assert scenario.title == "Quoted: title with # and colon"
    assert scenario.market == MarketOverrides(
        token_symbol="GLINT", liquidity_eth=Decimal("2.5"), fee_bps=0
    )


def test_no_market_overrides_means_none():
    assert parse_scenario_markdown(doc()).market is None


def test_crlf_bom_and_empty_body_are_fine():
    scenario = parse_scenario_markdown("\N{BYTE ORDER MARK}---\r\ntitle: T\r\n---\r\n")
    assert (scenario.title, scenario.seed_text, scenario.injected_events) == ("T", "", ())


def test_body_markdown_and_headings_before_events_are_kept():
    body = "# Background\n\nSome **bold** text.\n\n## Market\n\nThin.\n\n## Events\n- round 1: go"
    scenario = parse_scenario_markdown(doc(body=body))
    assert scenario.seed_text == "# Background\n\nSome **bold** text.\n\n## Market\n\nThin."


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("title: no fence\n", "line 1: a scenario starts with front matter"),
        ("---\ntitle: x\n", "never closed"),
        ("---\ntitle: x\nauthor: me\n---\n", "line 3: unknown front matter key 'author'"),
        ("---\ntitle: x\ntitle: y\n---\n", "line 3: duplicate front matter key 'title'"),
        ("---\ntitle: x\nmarket:\n  fee_bps: 30\n---\n", "line 3: unknown front matter key"),
        ("---\ntitle: x\n  fee_bps: 30\n---\n", "line 3: nested front matter"),
        ("---\njust words\n---\n", "line 2: expected 'key: value'"),
        ("---\ntoken_symbol: X\n---\n", "needs a 'title"),
        ("---\ntitle:   \n---\n", "line 2: title must not be empty"),
        ("---\ntitle: x\nfee_bps: 30.5\n---\n", "line 3: fee_bps must be a whole number"),
        ("---\ntitle: x\nfee_bps: 1001\n---\n", "line 3: fee_bps must be a whole number from 0"),
        ("---\ntitle: x\nliquidity_eth: 1e3\n---\n", "line 3: liquidity_eth must be a plain"),
        ("---\ntitle: x\nliquidity_eth: 0\n---\n", "line 3: liquidity_eth must be a number > 0"),
        ("---\ntitle: x\nliquidity_tokens: 1" + "0" * 16 + "\n---\n", "liquidity_tokens must be"),
        ("---\ntitle: x\nliquidity_eth: 1." + "1" * 19 + "\n---\n", "at most 18 decimals"),
        ("---\ntitle: x\ntoken_symbol: GL-INT\n---\n", "line 3: token_symbol must be"),
        ("---\ntitle: x\ntoken_symbol: ABCDEFGHIJKL\n---\n", "token_symbol must be"),
        ("---\ntitle: x\ntoken_name:\n---\n", "line 3: token_name must not be empty"),
    ],
)  # fmt: skip
def test_front_matter_errors_are_clear(text, message):
    with pytest.raises(ScenarioError, match=message.replace("(", r"\(")):
        parse_scenario_markdown(text)


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("## Events\n- round four: x", "line 6: event lines look like"),
        ("## Events\nsome prose", "line 6: event lines look like"),
        ("## Events\n- round 0: x", "line 6: event round must be 1 or more"),
        ("## Events\n- round 2:   ", "line 6: event text must not be empty"),
        ("## Events\n- round 2: a\n## Events\n- round 3: b", "line 7: only one '## Events'"),
        ("## Events\n- round 2: a\n## Notes\nmore", "line 7: the '## Events' section must be"),
        ("## Events\n- round 2: a\n# Title", "line 7: the '## Events' section must be"),
    ],
)
def test_event_errors_have_line_numbers(body, message):
    with pytest.raises(ScenarioError, match=message):
        parse_scenario_markdown(doc(body=body))


def test_text_is_sanitized_and_capped():
    title = "Launch\N{RIGHT-TO-LEFT OVERRIDE} at https://x.example/a?b=c " + "t" * 300
    event = "Rumor\x00 https://y.example/r#x " + "e" * 600
    seed = "Read https://z.example/p?q=1 " + "s " * 3000
    scenario = parse_scenario_markdown(
        doc(front=f"title: {title}", body=f"{seed}\n\n## Events\n- round 1: {event}")
    )
    assert scenario.title.startswith("Launch at x.example/a tt") and len(scenario.title) == 200
    assert scenario.injected_events[0].text.startswith("Rumor y.example/r ee")
    assert len(scenario.injected_events[0].text) == 500
    seed_text = scenario.seed_text
    assert seed_text.startswith("Read z.example/p s s") and seed_text.endswith("s" + ELLIPSIS)
    assert len(seed_text) <= MAX_SEED_CHARS  # the cut lands on a space, which is trimmed


def test_caps_count_code_points_so_emoji_titles_keep_their_length():
    bee = "\U0001f41d"
    assert parse_scenario_markdown(doc(front=f"title: {bee * 200}")).title == bee * 200


def test_from_text_builds_api_scenarios():
    scenario = from_text(
        "  API   job  ",
        "Seed with https://a.example/x?y=z",
        [{"round": 6, "text": "later"}, InjectedEvent(2, "sooner"), {"round": 2, "text": "too"}],
        ref="job_01",
    )
    assert scenario.title == "API job"
    assert scenario.seed_text == "Seed with a.example/x"
    assert [(e.round, e.text) for e in scenario.injected_events] == [
        (2, "sooner"), (2, "too"), (6, "later"),
    ]  # fmt: skip
    assert scenario.seed_sources == (SeedSource("user", "job_01"),)
    assert from_text("t", "").to_run_dict()["seedSources"] == [{"kind": "user", "ref": "api"}]


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (("", "seed"), "title must not be empty"),
        (("t", None), "must be strings"),
        (("t", "s", [{"round": "4", "text": "x"}]), "event 0: round must be"),
        (("t", "s", [{"round": True, "text": "x"}]), "event 0: round must be"),
        (("t", "s", [{"round": 0, "text": "x"}]), "event 0: round must be"),
        (("t", "s", [{"round": 1, "text": 5}]), "event 0: text must be a string"),
        (("t", "s", [{"round": 1, "text": "\x00 "}]), "event 0: text must not be empty"),
        (("t", "s", ["round 1: x"]), "event 0: expected an object"),
    ],
)
def test_from_text_validates_input(args, message):
    with pytest.raises(ScenarioError, match=message):
        from_text(*args)


def test_event_limits():
    many = [{"round": r % 20 + 1, "text": "e"} for r in range(MAX_EVENTS + 1)]
    with pytest.raises(ScenarioError, match=f"at most {MAX_EVENTS}"):
        from_text("t", "s", many)
    crowded = [{"round": 3, "text": "e"}] * (MAX_EVENTS_PER_ROUND + 1)
    with pytest.raises(ScenarioError, match="round 3 has more than"):
        from_text("t", "s", crowded)


def test_check_rounds_catches_events_after_the_last_round():
    scenario = from_text("t", "s", [{"round": 12, "text": "x"}, {"round": 11, "text": "y"}])
    scenario.check_rounds(12)
    with pytest.raises(ScenarioError, match=r"round\(s\) 11, 12 fall after the last round \(10\)"):
        scenario.check_rounds(10)


def test_model_validates_direct_construction():
    with pytest.raises(ScenarioError, match="title"):
        Scenario(title="", seed_text="", seed_sources=())
    with pytest.raises(ScenarioError, match="seed text"):
        Scenario(title="t", seed_text="x" * 4001, seed_sources=())
    with pytest.raises(ScenarioError, match="kind"):
        SeedSource("web", "x")  # type: ignore[arg-type]
    with pytest.raises(ScenarioError, match="event text"):
        InjectedEvent(1, "")
    with pytest.raises(ScenarioError, match="fee_bps"):
        MarketOverrides(fee_bps=True)  # type: ignore[arg-type]
    with pytest.raises(ScenarioError, match="liquidity_eth"):
        MarketOverrides(liquidity_eth=Decimal("NaN"))


def test_load_scenario_file_records_only_the_file_name(tmp_path):
    path = tmp_path / "private-folder" / "my scenario.md"
    path.parent.mkdir()
    path.write_text(doc(), encoding="utf-8")
    scenario = load_scenario_file(path)
    assert scenario.seed_sources == (SeedSource("user", "my scenario.md"),)
    assert "private-folder" not in str(scenario.to_run_dict())
