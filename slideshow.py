#!/usr/bin/env python3
"""Google Photos album slideshow (LXC).

Leest een publiek gedeeld Google Photos-album uit (geen OAuth nodig): de
album-pagina bevat de volledige fotolijst in een ingebedde RPC-payload
(AF_initDataCallback key 'ds:1'). De browser toont de foto's een voor een en
vraagt, zodra de lijst afgewerkt is, een verse lijst op -> nieuwe uploads van
gasten verschijnen automatisch in de volgende ronde.

Alleen de Python-standaardbibliotheek. Album + instellingen staan in
config.json (ook aanpasbaar via de web-UI op /config).
"""

import base64
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("PARTYPULSE_CONFIG") or os.path.join(BASE_DIR, "config.json")
AUTH_PATH = os.environ.get("PARTYPULSE_AUTH") or os.path.join(
    os.path.dirname(CONFIG_PATH), "auth.json"
)
STATIC_DIR = os.environ.get("PARTYPULSE_STATIC") or os.path.join(BASE_DIR, "static")

DEFAULTS = {
    "album_url": "",
    "port": 11111,
    "slide_seconds": 6,
    "order": "oldest",
    "image_width": 1600,
    "thumb_width": 480,
    "cache_seconds": 5,
    "poll_seconds": 5,
    "priority_new": True,
    "min_show_seconds": 1.5,
    "show_overlay": True,
    "title_text": "",
    "title_seconds": 8,
    "ken_burns": False,
    "end_loop_enabled": False,
    "end_film_enabled": False,
    "end_film_seconds": 1.0,
    "top_uploaders_enabled": True,
    "top_uploaders_count": 10,
    "qr_upload_enabled": False,
}

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

_cache = {"key": None, "at": 0.0, "photos": [], "title": "", "error": None}
_cache_lock = threading.Lock()


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    except (OSError, ValueError):
        pass
    return cfg


def save_config(updates):
    cfg = load_config()
    cfg.update(updates)
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return cfg


def load_users():
    """Gebruikers uit auth.json; leeg/ontbrekend bestand = geen auth."""
    try:
        with open(AUTH_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    users = data.get("users") if isinstance(data, dict) else None
    return users if isinstance(users, dict) else {}


def make_user_record(password, salt=None):
    import secrets

    salt = salt or secrets.token_hex(16)
    digest = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
    return {"salt": salt, "hash": digest}


def fetch_html(url, timeout=30):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _extract_array(seg, start):
    """Lees een gebalanceerde [...] array vanaf start (JS/JSON-compatibel)."""
    depth = 0
    in_str = False
    quote = ""
    esc = False
    for i in range(start, len(seg)):
        c = seg[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == quote:
                in_str = False
            continue
        if c in "\"'":
            in_str = True
            quote = c
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return seg[start:i + 1]
    return None


def parse_album(html):
    """Geef (title, [items]) terug uit de ingebedde ds:1-payload."""
    marker = "AF_initDataCallback({key: 'ds:1'"
    idx = html.find(marker)
    if idx < 0:
        raise ValueError("album-payload (ds:1) niet gevonden op de pagina")
    seg = html[idx:]
    dpos = seg.find("data:")
    apos = seg.find("[", dpos)
    raw = _extract_array(seg, apos)
    if not raw:
        raise ValueError("album-payload kon niet worden uitgelezen")
    data = json.loads(raw)
    items = data[1] if len(data) > 1 and isinstance(data[1], list) else []
    title = ""
    if len(data) > 3 and isinstance(data[3], list) and len(data[3]) > 1:
        title = data[3][1] or ""
    return title, items


def parse_people(html):
    """Map contributor-key -> {name, avatar} uit de personenlijst op de pagina."""
    people = {}
    for m in re.finditer(r'\["(AF1Qip[A-Za-z0-9_\-]+)","(\d{6,})"', html):
        key = m.group(1)
        if key in people:
            continue
        window = html[m.end():m.end() + 700]
        nm = re.search(r'\["([^"]{1,80})",\d+,(?:null|\d+),"[^"]*"\]', window)
        if not nm:
            continue
        avatar = ""
        av = re.search(r'\["(https://[^"]+)"\]', window[nm.end():])
        if av:
            avatar = av.group(1)
        people[key] = {"name": nm.group(1), "avatar": avatar}
    return people


def build_photos(items, cfg, people=None):
    people = people or {}
    w = int(cfg.get("image_width") or 1600)
    tw = int(cfg.get("thumb_width") or 480)
    photos = []
    for it in items:
        if not isinstance(it, list) or len(it) < 3:
            continue
        mid = it[0]
        base = None
        if isinstance(it[1], list) and it[1]:
            base = it[1][0]
        if not base:
            continue
        ts = it[2] if isinstance(it[2], int) else 0
        uploader_key = ""
        if len(it) > 6 and isinstance(it[6], list) and it[6]:
            uploader_key = it[6][0]
        person = people.get(uploader_key, {})
        photos.append(
            {
                "id": mid,
                "src": f"{base}=w{w}",
                "thumb": f"{base}=w{tw}",
                "ts": ts,
                "uploader": person.get("name", ""),
                "avatar": person.get("avatar", ""),
            }
        )
    order = cfg.get("order") or "oldest"
    if order == "newest":
        photos.sort(key=lambda p: p["ts"], reverse=True)
    elif order == "oldest":
        photos.sort(key=lambda p: p["ts"])
    return photos


def get_album(force=False):
    cfg = load_config()
    url = (cfg.get("album_url") or "").strip()
    if not url:
        return {"title": "", "photos": [], "error": "geen album ingesteld"}
    now = time.time()
    with _cache_lock:
        fresh = (
            _cache["key"] == url
            and _cache["photos"]
            and (now - _cache["at"]) < float(cfg.get("cache_seconds") or 20)
        )
        if fresh and not force:
            return {
                "title": _cache["title"],
                "photos": _cache["photos"],
                "error": _cache["error"],
            }
    try:
        html = fetch_html(url)
        title, items = parse_album(html)
        people = parse_people(html)
        photos = build_photos(items, cfg, people)
        if not photos:
            raise ValueError("geen foto's gevonden in het album")
        result = {"title": title, "photos": photos, "error": None}
    except Exception as exc:  # noqa: BLE001
        result = {
            "title": "",
            "photos": [],
            "error": f"{type(exc).__name__}: {exc}",
        }
    with _cache_lock:
        _cache.update(
            key=url, at=now, photos=result["photos"],
            title=result["title"], error=result["error"],
        )
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "gphotos-slideshow"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _require_auth(self):
        users = load_users()
        if not users:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            try:
                raw = base64.b64decode(header[6:]).decode("utf-8")
                user, _, password = raw.partition(":")
            except (ValueError, UnicodeDecodeError):
                user, password = "", ""
            record = users.get(user)
            if isinstance(record, dict):
                salt = str(record.get("salt", ""))
                expected = str(record.get("hash", ""))
                digest = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
                if hmac.compare_digest(digest, expected):
                    return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="PartyPulse"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path):
        if not os.path.isfile(path):
            self.send_error(404, "not found")
            return
        ext = os.path.splitext(path)[1].lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
        }.get(ext, "application/octet-stream")
        with open(path, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._require_auth():
            return
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if parsed.path == "/api/photos":
            force = qs.get("fresh", ["0"])[0] == "1"
            data = get_album(force=force)
            self._send_json(data)
        elif parsed.path == "/api/config":
            self._send_json(load_config())
        elif parsed.path in ("/", "/index.html"):
            self._send_file(os.path.join(STATIC_DIR, "index.html"))
        elif parsed.path == "/config":
            self._send_file(os.path.join(STATIC_DIR, "config.html"))
        else:
            safe = parsed.path.lstrip("/")
            candidate = os.path.normpath(os.path.join(STATIC_DIR, safe))
            if candidate.startswith(STATIC_DIR) and os.path.isfile(candidate):
                self._send_file(candidate)
            else:
                self.send_error(404, "not found")

    def do_POST(self):
        if not self._require_auth():
            return
        parsed = urlparse(self.path)
        if parsed.path != "/api/config":
            self.send_error(404, "not found")
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            self._send_json({"ok": False, "error": "ongeldige JSON"}, code=400)
            return
        allowed = {
            "album_url", "slide_seconds", "order", "image_width",
            "thumb_width", "cache_seconds", "poll_seconds",
            "priority_new", "min_show_seconds", "show_overlay",
            "title_text", "title_seconds", "ken_burns",
            "end_loop_enabled", "end_film_enabled", "end_film_seconds",
            "top_uploaders_enabled", "top_uploaders_count",
            "qr_upload_enabled",
        }
        updates = {k: v for k, v in payload.items() if k in allowed}
        if "slide_seconds" in updates:
            updates["slide_seconds"] = max(1, int(updates["slide_seconds"]))
        if "poll_seconds" in updates:
            updates["poll_seconds"] = max(2, int(updates["poll_seconds"]))
        if "cache_seconds" in updates:
            updates["cache_seconds"] = max(0, int(updates["cache_seconds"]))
        if "title_seconds" in updates:
            updates["title_seconds"] = max(1, int(updates["title_seconds"]))
        if "end_film_seconds" in updates:
            updates["end_film_seconds"] = max(0.2, float(updates["end_film_seconds"]))
        if "top_uploaders_count" in updates:
            updates["top_uploaders_count"] = max(1, int(updates["top_uploaders_count"]))
        save_config(updates)
        with _cache_lock:
            _cache["key"] = None
        self._send_json({"ok": True, "config": load_config()})


def main():
    cfg = load_config()
    port = int(os.environ.get("PORT") or cfg.get("port") or 11111)
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(
        f"gphotos-slideshow op http://0.0.0.0:{port}  (album: "
        f"{cfg.get('album_url') or '-'})\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
