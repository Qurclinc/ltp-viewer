"""Command line entry point: ``ltp-viewer [serve] FILES…`` / ``ltp-viewer export …``."""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from pathlib import Path

from . import __version__

_COMMANDS = {"serve", "export"}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ltp-viewer",
        description="Browse Linux Test Project (kirk) JSON reports in your browser.",
        epilog="Running without a sub-command is the same as 'serve'.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="start the web UI (default)")
    serve.add_argument("paths", nargs="*", metavar="FILE|DIR", help="kirk JSON report(s) or directories with them")
    serve.add_argument("-H", "--host", default="127.0.0.1", help="interface to bind (default: %(default)s)")
    serve.add_argument("-p", "--port", type=int, default=8080, help="port to listen on (default: %(default)s)")
    serve.add_argument("-o", "--open", action="store_true", help="open the UI in a web browser")
    serve.add_argument("--no-upload", action="store_true", help="disable uploading reports from the browser")
    serve.add_argument("--debug", action="store_true", help="run Flask in debug mode (auto-reload)")

    export = sub.add_parser("export", help="write a self-contained, offline HTML file")
    export.add_argument("paths", nargs="+", metavar="FILE|DIR", help="kirk JSON report(s) or directories with them")
    export.add_argument("-b", "--baseline", metavar="FILE", help="also embed FILE and open it as the comparison baseline")
    export.add_argument("-o", "--output", default="ltp-report.html", help="output file (default: %(default)s)")
    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or (argv[0] not in _COMMANDS and argv[0] not in ("-h", "--help", "--version")):
        argv.insert(0, "serve")
    args = _build_parser().parse_args(argv)

    from .app import create_app  # imported late so --help stays fast

    if args.command == "export":
        from .export import render_static_html
        from .report import ReportError, load_report

        app = create_app(args.paths, allow_upload=False)
        reports = app.extensions["ltp_store"].all()
        if not reports:
            print("error: no reports could be loaded", file=sys.stderr)
            return 1
        baseline_id = None
        if args.baseline:
            try:
                baseline = load_report(args.baseline)
            except (OSError, ReportError) as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 1
            reports = [r for r in reports if r.id != baseline.id] + [baseline]
            baseline_id = baseline.id

        out = Path(args.output)
        out.write_text(render_static_html(app, reports, baseline_id), encoding="utf-8")
        print(f"wrote {out} ({out.stat().st_size / 1024 / 1024:.1f} MiB, {len(reports)} report(s))")
        return 0

    app = create_app(args.paths, allow_upload=not args.no_upload)
    store = app.extensions["ltp_store"]
    if args.paths and not store.all():
        print("warning: none of the given paths contained a loadable report", file=sys.stderr)
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0', '::') else args.host}:{args.port}/"
    print(f"LTP Viewer {__version__} — {len(store.all())} report(s) loaded — {url}")
    if args.open:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    app.run(host=args.host, port=args.port, debug=args.debug)
    return 0
