"""Parsing and normalisation of kirk JSON reports.

kirk (https://github.com/linux-test-project/kirk) is the test executor of the
Linux Test Project. Its JSON report looks roughly like::

    {
      "results": [
        {"test_fqn": "abort01", "status": "pass",
         "test": {"command": "abort01", "arguments": [], "log": "...",
                  "retval": ["0"], "duration": 0.15,
                  "passed": 2, "failed": 0, "broken": 0,
                  "skipped": 0, "warnings": 0, "result": "pass"}},
        ...
      ],
      "stats": {"runtime": 5014.1, "passed": 13558, ...},
      "environment": {"distribution": "debian", "kernel": "...", ...}
    }

Everything here is defensive: older kirk / runltp-ng versions omit fields, and
the viewer should still show whatever is there.
"""

from __future__ import annotations

import errno as _errno
import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Order matters: most severe first. Used for sorting and "worst status" logic.
STATUS_ORDER = ["fail", "brok", "warn", "conf", "pass"]

# Which LTP message levels explain a given final status, in priority order.
_REASON_LEVELS = {
    "fail": ("TFAIL", "TBROK", "TWARN"),
    "brok": ("TBROK", "TFAIL", "TWARN"),
    "warn": ("TWARN", "TBROK", "TFAIL"),
    "conf": ("TCONF",),
    "pass": (),
}
_DEFAULT_REASON_LEVELS = ("TFAIL", "TBROK", "TWARN", "TCONF")

# Matches all three LTP log dialects:
#   new C API:   "foo01.c:42: TFAIL: message"
#   shell API:   "foo01 1 TBROK: message"
#   legacy API:  "foo01    1  TPASS  :  message"
_MSG_RE = re.compile(
    r"^(?:(?P<loc>[\w.+-]+:\d+):\s+)?.*?\b(?P<lvl>TPASS|TFAIL|TBROK|TCONF|TWARN|TINFO|TDEBUG)\b\s*:\s*(?P<msg>.*)$"
)
_LTP_VERSION_RE = re.compile(r"LTP version:\s*(\S+)")
_ERRNO_NAMES = frozenset(n for n in dir(_errno) if n.startswith("E")) | {"ENOTSUPP"}
_ERRNO_WITH_CODE_RE = re.compile(r"\b(E[A-Z0-9]{2,})\s*\(\d+\)")
_ERRNO_BARE_RE = re.compile(r"\b(E[A-Z0-9]{2,})\b")
_KCONFIG_RE = re.compile(r"Constraint '([^']+)' not satisfied")
_INNER_LOC_RE = re.compile(r"^[\w.+-]+\.[ch]:\d+:\s*")
_FAMILY_SUFFIX_RE = re.compile(r"(?:_?\d+)?(?:_(?:16|64))?$")

# Normalisation for grouping by reason: volatile bits (pids, addresses,
# temporary paths, timestamps) are masked so identical failures group together.
_REASON_NORMALISERS = [
    (re.compile(r"0x[0-9a-fA-F]+"), "0x…"),
    (re.compile(r"/proc/\d+"), "/proc/<pid>"),
    (re.compile(r"/tmp/LTP_[\w.]+"), "/tmp/LTP_…"),
    (re.compile(r"\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?"), "<time>"),
    (re.compile(r"\bpid[ =:]+\d+", re.I), "pid <n>"),
]


class ReportError(ValueError):
    """Raised when a file is not a usable kirk report."""


@dataclass
class Report:
    id: str
    name: str
    source: str
    loaded_at: float
    stats: dict[str, Any]
    environment: dict[str, Any]
    ltp_version: str | None
    tests: list[dict[str, Any]]
    logs: list[str] = field(repr=False)

    def summary(self) -> dict[str, Any]:
        counts = {s: 0 for s in STATUS_ORDER}
        for t in self.tests:
            counts[t["status"]] = counts.get(t["status"], 0) + 1
        return {
            "id": self.id,
            "name": self.name,
            "source": self.source,
            "loaded_at": self.loaded_at,
            "total": len(self.tests),
            "counts": counts,
            "kernel": self.environment.get("kernel"),
            "runtime": self.stats.get("runtime"),
        }

    def to_dict(self, with_logs: bool = False) -> dict[str, Any]:
        data = {
            **self.summary(),
            "stats": self.stats,
            "environment": self.environment,
            "ltp_version": self.ltp_version,
            "tests": self.tests,
        }
        if with_logs:
            data["logs"] = self.logs
        return data

    def search_logs(self, query: str, regex: bool = False, case: bool = False) -> list[int]:
        """Return indexes of tests whose log matches ``query``."""
        if not query:
            return []
        flags = 0 if case else re.IGNORECASE
        pattern = re.compile(query if regex else re.escape(query), flags)
        return [i for i, log in enumerate(self.logs) if pattern.search(log)]


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "report"


def _to_int(value: Any) -> int | None:
    if isinstance(value, list):
        value = value[0] if value else None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def family_of(name: str) -> str:
    """``accept01`` → ``accept``, ``fcntl17_64`` → ``fcntl``, ``cve-2017-1000`` → ``cve``."""
    if name.lower().startswith("cve-"):
        return "cve"
    base = _FAMILY_SUFFIX_RE.sub("", name).rstrip("_-")
    return base or name


def subsystem_of(family: str) -> str:
    """Coarse bucket: first ``_``-separated token of the family name."""
    return re.split(r"[_-]", family, maxsplit=1)[0] or family


def normalise_reason(reason: str) -> str:
    for rx, repl in _REASON_NORMALISERS:
        reason = rx.sub(repl, reason)
    return reason


def find_errno(text: str) -> str | None:
    """Return the errno the message ends up with ("... expected ENOENT: EPERM (1)" → EPERM)."""
    if not text:
        return None
    for m in _ERRNO_WITH_CODE_RE.finditer(text):
        if m.group(1) in _ERRNO_NAMES:
            return m.group(1)
    hits = [m.group(1) for m in _ERRNO_BARE_RE.finditer(text) if m.group(1) in _ERRNO_NAMES]
    return hits[-1] if hits else None


def analyse_log(log: str, status: str) -> dict[str, Any]:
    """Extract level counters and the most relevant problem message from a log."""
    levels: dict[str, int] = {}
    first: dict[str, tuple[int, str, str | None]] = {}
    kconfig: list[str] = []
    lines = log.splitlines()
    for lineno, line in enumerate(lines, 1):
        m = _MSG_RE.match(line)
        if not m:
            continue
        lvl, msg = m.group("lvl"), _INNER_LOC_RE.sub("", m.group("msg").strip())
        levels[lvl] = levels.get(lvl, 0) + 1
        if lvl == "TINFO":
            k = _KCONFIG_RE.search(msg)
            if k and k.group(1) not in kconfig:
                kconfig.append(k.group(1))
        # "Hint: ..." lines precede the real message; prefer what follows.
        if lvl not in first or first[lvl][1].startswith("Hint:"):
            first[lvl] = (lineno, msg, m.group("loc"))

    reason = reason_level = reason_loc = None
    reason_line = None
    for lvl in _REASON_LEVELS.get(status, _DEFAULT_REASON_LEVELS):
        if lvl in first:
            reason_line, reason, reason_loc = first[lvl]
            reason_level = lvl
            break
    if kconfig and reason and "kernel config" in reason.lower():
        reason = "Kernel config not satisfied: " + ", ".join(kconfig)
    return {
        "levels": levels,
        "lines": len(lines),
        "reason": reason,
        "reason_level": reason_level,
        "reason_loc": reason_loc,
        "reason_line": reason_line,
        "kconfig": kconfig,
    }


def _normalise_test(idx: int, raw: dict[str, Any], seen: dict[str, int]) -> tuple[dict[str, Any], str]:
    test = raw.get("test") or {}
    name = str(raw.get("test_fqn") or test.get("command") or f"test-{idx}")
    status = str(raw.get("status") or test.get("result") or "unknown").lower()
    log = test.get("log") or ""
    command = str(test.get("command") or name)
    args = [str(a) for a in (test.get("arguments") or [])]
    retval = _to_int(test.get("retval"))

    info = analyse_log(log, status)
    reason = info["reason"]
    if reason is None and status not in ("pass",):
        reason = f"Exited with code {retval}" if retval not in (None, 0) else None

    occurrence = seen.get(name, 0)
    seen[name] = occurrence + 1
    family = family_of(name)

    return {
        "idx": idx,
        "key": f"{name}#{occurrence}",
        "name": name,
        "occurrence": occurrence,
        "status": status,
        "command": command,
        "args": args,
        "cmdline": " ".join([command, *args]),
        "retval": retval,
        "duration": _to_float(test.get("duration")),
        "passed": _to_int(test.get("passed")) or 0,
        "failed": _to_int(test.get("failed")) or 0,
        "broken": _to_int(test.get("broken")) or 0,
        "skipped": _to_int(test.get("skipped")) or 0,
        "warnings": _to_int(test.get("warnings")) or 0,
        "family": family,
        "subsystem": subsystem_of(family),
        "reason": reason,
        "reason_key": normalise_reason(reason) if reason else None,
        "reason_level": info["reason_level"],
        "reason_loc": info["reason_loc"],
        "reason_line": info["reason_line"],
        "errno": find_errno(reason or ""),
        "kconfig": info["kconfig"],
        "levels": info["levels"],
        "log_lines": info["lines"],
        "log_size": len(log),
    }, log


def parse_report(data: Any, name: str = "report", source: str = "") -> Report:
    """Build a :class:`Report` from already-decoded kirk JSON."""
    if isinstance(data, list):  # bare list of results
        data = {"results": data}
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        raise ReportError("not a kirk report: expected an object with a 'results' list")

    seen: dict[str, int] = {}
    tests, logs = [], []
    for idx, raw in enumerate(data["results"]):
        if not isinstance(raw, dict):
            continue
        test, log = _normalise_test(len(tests), raw, seen)
        tests.append(test)
        logs.append(log)

    ltp_version = None
    for log in logs[:50]:
        m = _LTP_VERSION_RE.search(log)
        if m:
            ltp_version = m.group(1)
            break

    stats = data.get("stats") if isinstance(data.get("stats"), dict) else {}
    env = data.get("environment") if isinstance(data.get("environment"), dict) else {}
    digest = hashlib.sha1(
        json.dumps([[t["key"], t["status"], t["duration"]] for t in tests]).encode()
        + json.dumps(env, sort_keys=True).encode()
    ).hexdigest()[:8]

    return Report(
        id=f"{_slug(name)}-{digest}",
        name=name,
        source=source,
        loaded_at=time.time(),
        stats=stats,
        environment=env,
        ltp_version=ltp_version,
        tests=tests,
        logs=logs,
    )


def load_report(path: str | Path) -> Report:
    path = Path(path)
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        raise ReportError(f"{path}: invalid JSON ({exc})") from exc
    return parse_report(data, name=path.stem, source=str(path.resolve()))


def load_report_bytes(blob: bytes, name: str) -> Report:
    try:
        data = json.loads(blob.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        raise ReportError(f"{name}: invalid JSON ({exc})") from exc
    return parse_report(data, name=Path(name).stem or "upload", source=f"upload:{name}")
