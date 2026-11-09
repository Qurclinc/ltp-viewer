"""Flask application: serves the single-page UI and a small JSON API."""

from __future__ import annotations

import re
from pathlib import Path

from flask import Flask, Response, abort, jsonify, render_template, request

from . import __version__
from .report import ReportError, load_report_bytes
from .store import ReportStore


def create_app(paths: list[str | Path] | None = None, allow_upload: bool = True) -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 512 * 1024 * 1024
    app.json.sort_keys = False
    app.json.compact = True

    store = ReportStore()
    app.extensions["ltp_store"] = store
    load_errors = store.load_paths(list(paths or []))
    for err in load_errors:
        app.logger.warning("could not load %s", err)

    def get_report(report_id: str):
        report = store.get(report_id)
        if report is None:
            abort(404, description=f"unknown report '{report_id}'")
        return report

    @app.errorhandler(404)
    @app.errorhandler(400)
    @app.errorhandler(413)
    def json_error(exc):
        if request.path.startswith("/api/"):
            return jsonify(error=getattr(exc, "description", str(exc))), exc.code
        return exc

    @app.get("/")
    def index():
        return render_template(
            "index.html",
            version=__version__,
            static_data=None,
            inline_css=None,
            inline_js=None,
            allow_upload=allow_upload,
        )

    @app.get("/api/reports")
    def list_reports():
        return jsonify(
            reports=[r.summary() for r in store.all()],
            errors=load_errors,
            allow_upload=allow_upload,
        )

    @app.get("/api/reports/<report_id>")
    def report_detail(report_id: str):
        return jsonify(get_report(report_id).to_dict())

    @app.get("/api/reports/<report_id>/tests/<int:idx>/log")
    def test_log(report_id: str, idx: int):
        report = get_report(report_id)
        if not 0 <= idx < len(report.logs):
            abort(404, description="no such test")
        if request.args.get("download"):
            name = re.sub(r"[^\w.-]+", "_", report.tests[idx]["name"])
            return Response(
                report.logs[idx],
                mimetype="text/plain",
                headers={"Content-Disposition": f'attachment; filename="{name}.log"'},
            )
        return jsonify(log=report.logs[idx])

    @app.get("/api/reports/<report_id>/search")
    def search_logs(report_id: str):
        report = get_report(report_id)
        query = request.args.get("q", "")
        try:
            hits = report.search_logs(
                query,
                regex=request.args.get("regex") == "1",
                case=request.args.get("case") == "1",
            )
        except re.error as exc:
            abort(400, description=f"invalid regular expression: {exc}")
        return jsonify(hits=hits)

    @app.post("/api/reports")
    def upload_report():
        if not allow_upload:
            abort(400, description="uploads are disabled")
        files = request.files.getlist("file")
        if not files:
            abort(400, description="no file provided")
        loaded, errors = [], []
        for f in files:
            try:
                loaded.append(store.add(load_report_bytes(f.read(), f.filename or "upload.json")).summary())
            except ReportError as exc:
                errors.append(str(exc))
        if not loaded:
            abort(400, description="; ".join(errors) or "nothing loaded")
        return jsonify(reports=loaded, errors=errors)

    @app.get("/export/<report_id>.html")
    def export_html(report_id: str):
        from .export import render_static_html

        reports = [get_report(report_id)]
        baseline = request.args.get("b")
        if baseline and baseline != report_id:
            reports.append(get_report(baseline))
        else:
            baseline = None
        name = re.sub(r"[^\w.-]+", "_", reports[0].name)
        return Response(
            render_static_html(app, reports, baseline),
            mimetype="text/html",
            headers={"Content-Disposition": f'attachment; filename="ltp-report-{name}.html"'},
        )

    @app.delete("/api/reports/<report_id>")
    def delete_report(report_id: str):
        if not store.remove(report_id):
            abort(404, description=f"unknown report '{report_id}'")
        return jsonify(ok=True)

    return app
