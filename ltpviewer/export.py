"""Export one or more reports into a single self-contained HTML file."""

from __future__ import annotations

import json
from pathlib import Path

from flask import render_template

from . import __version__
from .report import Report

_STATIC = Path(__file__).parent / "static"


def _safe_json(data) -> str:
    # Prevent "</script>" and friends inside logs from closing the script tag.
    return (
        json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def render_static_html(app, reports: list[Report], baseline_id: str | None = None) -> str:
    """``reports[0]`` is opened first; ``baseline_id`` pre-selects a comparison."""
    payload = {"reports": [r.to_dict(with_logs=True) for r in reports], "baseline": baseline_id}
    with app.test_request_context("/"):
        return render_template(
            "index.html",
            version=__version__,
            static_data=_safe_json(payload),
            inline_css=(_STATIC / "css" / "app.css").read_text(encoding="utf-8"),
            inline_js=(_STATIC / "js" / "app.js").read_text(encoding="utf-8"),
            inline_icon=(_STATIC / "favicon.svg").read_text(encoding="utf-8"),
            allow_upload=False,
        )

