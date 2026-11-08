"""JSON parsing edge cases. Patterns ported from MiroFish backend/tests/test_llm_json_responses.py
(AGPL-3.0)."""

from __future__ import annotations

import pytest

from hyvo.llm.json_utils import (
    MAX_JSON_DEPTH,
    clean_chat_text,
    json_depth,
    parse_json_object,
)
from hyvo.llm.types import LLMResponseError


def test_strict_object_parses():
    assert parse_json_object('{"items": [1, 2]}') == {"items": [1, 2]}


def test_complete_object_before_trailing_prose_is_accepted():
    assert parse_json_object('{"ok": true}\nThis object is ready to use.') == {"ok": True}


@pytest.mark.parametrize(
    "content",
    [
        '{"status": "draft"}\n{"status": "complete"}',
        '{"status": "draft"}\n```json\n{"status": "complete"}\n```',
        '{"status": "draft"}\nExplanation first.\n{"status": "complete"}',
        '{"status": "draft"} and also [1, 2]',
    ],
)
def test_a_second_json_document_is_rejected(content):
    with pytest.raises(LLMResponseError, match="multiple JSON"):
        parse_json_object(content)


@pytest.mark.parametrize("content", ['[{"ok": true}]', '"text"', "42", "null"])
def test_top_level_must_be_an_object(content):
    with pytest.raises(LLMResponseError, match="JSON object"):
        parse_json_object(content)


@pytest.mark.parametrize(
    "content", [None, "", "   \n", "<think>only reasoning</think>", "```json\n```"]
)
def test_empty_content_is_rejected(content):
    with pytest.raises(LLMResponseError, match="empty"):
        parse_json_object(content)


def test_error_does_not_echo_partial_model_output():
    partial = '{"private_source_text": "SENTINEL-SHOULD-NOT-LEAK"'
    with pytest.raises(LLMResponseError) as captured:
        parse_json_object(partial)
    assert "SENTINEL-SHOULD-NOT-LEAK" not in str(captured.value)
    assert "line 1" in str(captured.value)
    assert captured.value.__cause__ is None


def test_prose_before_the_object_is_rejected():
    with pytest.raises(LLMResponseError, match="invalid JSON"):
        parse_json_object('Here you go: {"ok": true}')


def test_think_blocks_are_removed_even_if_they_contain_json():
    assert parse_json_object('<think>{"bad": 1} hmm</think>\n{"ok": true}') == {"ok": True}


def test_unclosed_think_block_is_not_guessed_at():
    with pytest.raises(LLMResponseError):
        parse_json_object('<think>still reasoning {"ok": true}')


@pytest.mark.parametrize(
    "content",
    [
        '```json\n{"ok": true}\n```',
        '```JSON\n{"ok": true}\n```',
        '```\n{"ok": true}\n```',
        '﻿{"ok": true}',
        '﻿  ```json\n{"ok": true}\n```  ',
    ],
)
def test_bom_and_code_fences_are_stripped(content):
    assert parse_json_object(content) == {"ok": True}


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_numbers_are_rejected(constant):
    with pytest.raises(LLMResponseError, match="non-finite"):
        parse_json_object(f'{{"sentiment": {constant}}}')


def test_non_finite_number_in_lenient_path_is_rejected():
    with pytest.raises(LLMResponseError, match="non-finite"):
        parse_json_object('{"sentiment": NaN}\nsome trailing prose')


def test_clean_chat_text_keeps_plain_prose():
    assert clean_chat_text("<think>x</think>  Hello there. ") == "Hello there."


def test_deeply_nested_answer_is_refused_without_crashing():
    import web3  # noqa: F401  (raises the recursion limit, as in the engine process)

    hostile = '{"a": ' + "[" * 100_000 + "]" * 100_000 + "}"
    with pytest.raises(LLMResponseError, match="nested deeper"):
        parse_json_object(hostile)


def test_nesting_limit_is_inclusive():
    at_limit = "[" * (MAX_JSON_DEPTH - 1) + "]" * (MAX_JSON_DEPTH - 1)
    assert parse_json_object('{"a": ' + at_limit + "}") == {"a": eval(at_limit)}
    too_deep = "[" * MAX_JSON_DEPTH + "]" * MAX_JSON_DEPTH
    with pytest.raises(LLMResponseError):
        parse_json_object('{"a": ' + too_deep + "}")


def test_brackets_inside_strings_do_not_count_as_nesting():
    text = '{"a": "' + "[{" * 500 + '\\" }"}'
    assert json_depth(text) == 1
    assert parse_json_object(text)["a"].startswith("[{")


def test_oversized_integer_is_a_response_error():
    with pytest.raises(LLMResponseError, match="cannot read"):
        parse_json_object('{"n": 1' + "0" * 5000 + "}")
