#!/usr/bin/env python3
"""
Range-capable static HTTP server for mxf.js HLS playlist testing.

Python's stdlib SimpleHTTPRequestHandler ignores the `Range:` header and always
replies 200 with the whole body. The MXF worker does HTTP Range reads, so we need
real 206 Partial Content support. This also sets the right MIME types for .wasm /
.m3u8 / .mxf and adds permissive CORS headers so the page can sit on any origin.

Usage (serve the repo root so /dist/* and /demo/* both resolve):

    python demo/hls-server.py --root . --port 8080

Then open:  http://localhost:8080/demo/playlist.html
m3u8 URL:   http://localhost:8080/demo/hls/playlist.m3u8
"""
import argparse
import os
import re
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn

EXTRA_MIME = {
    ".wasm": "application/wasm",
    ".m3u8": "application/vnd.apple.mpegurl",
    ".mxf": "application/mxf",
    ".mjs": "application/javascript",
    ".js": "application/javascript",
}

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class RangeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # CORS + range-friendly headers on every response.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_MIME:
            return EXTRA_MIME[ext]
        return super().guess_type(path)

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        rng = self.headers.get("Range")
        if rng is None:
            return super().do_GET()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()  # let the base class 404

        m = RANGE_RE.match(rng.strip())
        if not m:
            self.send_error(400, "Malformed Range header")
            return

        size = os.path.getsize(path)
        start_s, end_s = m.group(1), m.group(2)
        if start_s == "":
            # suffix range: bytes=-N  → last N bytes
            length = int(end_s)
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        end = min(end, size - 1)

        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return

        length = end - start + 1
        ctype = self.guess_type(path)
        self.send_response(206)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()

        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            chunk = 64 * 1024
            while remaining > 0:
                buf = f.read(min(chunk, remaining))
                if not buf:
                    break
                try:
                    self.wfile.write(buf)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(buf)

    def log_message(self, fmt, *args):
        sys.stderr.write("[hls-server] " + (fmt % args) + "\n")


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="directory to serve (default: cwd)")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    os.chdir(root)
    httpd = ThreadingHTTPServer((args.host, args.port), RangeHandler)
    print(f"[hls-server] serving {root} at http://{args.host}:{args.port}/ (Range + CORS enabled)")
    print(f"[hls-server] demo:  http://{args.host}:{args.port}/demo/playlist.html")
    print(f"[hls-server] m3u8:  http://{args.host}:{args.port}/demo/hls/playlist.m3u8")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[hls-server] stopped")


if __name__ == "__main__":
    main()
