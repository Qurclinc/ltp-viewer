"""Thread-safe in-memory registry of loaded reports."""

from __future__ import annotations

import threading
from pathlib import Path

from .report import Report, ReportError, load_report


class ReportStore:
    def __init__(self) -> None:
        self._reports: dict[str, Report] = {}
        self._lock = threading.Lock()

    def add(self, report: Report) -> Report:
        with self._lock:
            # Re-loading identical content keeps the existing entry (same id).
            self._reports.setdefault(report.id, report)
            return self._reports[report.id]

    def get(self, report_id: str) -> Report | None:
        with self._lock:
            return self._reports.get(report_id)

    def remove(self, report_id: str) -> bool:
        with self._lock:
            return self._reports.pop(report_id, None) is not None

    def all(self) -> list[Report]:
        with self._lock:
            return list(self._reports.values())

    def load_paths(self, paths: list[str | Path]) -> list[str]:
        """Load files (or every ``*.json`` in directories). Returns error messages."""
        errors = []
        for raw in paths:
            path = Path(raw)
            files = sorted(path.glob("*.json")) if path.is_dir() else [path]
            for f in files:
                try:
                    self.add(load_report(f))
                except (OSError, ReportError) as exc:
                    errors.append(f"{f}: {exc}")
        return errors
