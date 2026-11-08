from __future__ import annotations

import json
import re
import threading

from hyvo.llm.log import LLM_LOG_NAME, LLMLog

from .llm_fakes import messages, result

FIELDS = {
    "ts", "purpose", "model", "temperature", "max_tokens", "json_mode", "messages",
    "response_text", "input_tokens", "output_tokens", "estimated_tokens", "cost_usd",
    "latency_ms", "finish_reason", "error",
}  # fmt: skip


def read(log: LLMLog) -> list[dict]:
    return [json.loads(line) for line in log.path.read_text(encoding="utf-8").splitlines()]


def write(log: LLMLog, **extra) -> None:
    log.write(
        purpose="report",
        model="deepseek/deepseek-chat",
        messages=messages(user="Ünïcode stays readable: 🐝"),
        temperature=0.3,
        max_tokens=800,
        json_mode=True,
        **extra,
    )


def test_call_line_has_every_field(tmp_path):
    log = LLMLog(tmp_path / "nested" / LLM_LOG_NAME)
    write(log, result=result('{"summary": "x"}', cost=0.002, tokens=(900, 80)))
    [line] = read(log)
    assert set(line) == FIELDS
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", line["ts"])
    assert line["messages"][1] == {"role": "user", "content": "Ünïcode stays readable: 🐝"}
    assert line["response_text"] == '{"summary": "x"}'
    assert (line["input_tokens"], line["output_tokens"], line["cost_usd"]) == (900, 80, 0.002)
    assert (line["latency_ms"], line["finish_reason"], line["error"]) == (5, "stop", None)
    assert "🐝" in log.path.read_text(encoding="utf-8")


def test_lines_without_a_result_have_empty_usage(tmp_path):
    log = LLMLog(tmp_path / LLM_LOG_NAME)
    write(log, error="budget_exceeded: max_cost_usd")
    [line] = read(log)
    assert line["error"] == "budget_exceeded: max_cost_usd"
    assert line["response_text"] is None and line["latency_ms"] is None
    assert (line["input_tokens"], line["output_tokens"], line["cost_usd"]) == (0, 0, 0.0)
    assert line["estimated_tokens"] is False


def test_concurrent_writes_stay_one_json_object_per_line(tmp_path):
    log = LLMLog(tmp_path / LLM_LOG_NAME)
    threads = [threading.Thread(target=lambda: [write(log, result=result()) for _ in range(25)])
               for _ in range(8)]  # fmt: skip
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(read(log)) == 200


def test_log_appends(tmp_path):
    path = tmp_path / LLM_LOG_NAME
    write(LLMLog(path), result=result())
    write(LLMLog(path), result=result())
    assert len(read(LLMLog(path))) == 2
