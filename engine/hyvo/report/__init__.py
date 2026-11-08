"""Hyvo report agent: deterministic stats, one structured LLM call and a copy guard.

Importing this package registers the offline responders for ``report/v1`` and
``report_rewrite/v1`` (``hyvo.report.offline``), so the offline model can answer report calls.
"""

from hyvo.report import offline as _offline  # noqa: F401  (registers the offline responders)
from hyvo.report.builder import ReportResult, build_report
from hyvo.report.guard import BANNED_RULES, find_violations, guard_report
from hyvo.report.stats import ReportStats, compute_stats, sentiment_by_round
from hyvo.report.types import ReportInput, RoundTrace

__all__ = [
    "BANNED_RULES",
    "ReportInput",
    "ReportResult",
    "ReportStats",
    "RoundTrace",
    "build_report",
    "compute_stats",
    "find_violations",
    "guard_report",
    "sentiment_by_round",
]
