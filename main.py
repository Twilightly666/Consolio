import base64
import http.server
import io
import json
import mimetypes
import atexit
import os
import platform
import subprocess
import sys
import threading
import uuid
import webview

try:
    from PIL import Image, ImageOps
except ImportError:
    Image = None

import finder
import icons
import mtp
import ops
import places

BASE = os.path.dirname(os.path.abspath(__file__))
IS_WIN = platform.system() == "Windows"
IMAGE_MIME = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "svg": "image/svg+xml",
    "ico": "image/x-icon",
    "avif": "image/avif",
}
IMAGE_LIMIT = 60 * 1024 * 1024
TEXT_LIMIT = 8 * 1024 * 1024
BLOCK_AUTOPLAY = True
AUTOPLAY_KEY = r"Software\Microsoft\Windows\CurrentVersion\Explorer\AutoplayHandlers"
AUTOPLAY_VALUE = "DisableAutoplay"
if getattr(sys, "frozen", False):
    DATA_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "Consolio")
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except OSError:
        DATA_DIR = BASE
else:
    DATA_DIR = BASE
SESSION_FILE = os.path.join(DATA_DIR, "session.json")
INDEX_FILE = os.path.join(DATA_DIR, "search_index.bin")

if IS_WIN:
    import ctypes
    import winreg
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromWindow.restype = wintypes.HANDLE
    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MONITORINFO)]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.SetWindowPos.argtypes = [
        wintypes.HWND, wintypes.HWND,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT,
    ]

    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    MONITOR_DEFAULTTONEAREST = 2

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetModuleHandleW.restype = ctypes.c_void_p

    HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

    class KBDLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [
            ("vkCode", wintypes.DWORD),
            ("scanCode", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.c_size_t),
        ]

    user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, ctypes.c_void_p, wintypes.DWORD]
    user32.SetWindowsHookExW.restype = ctypes.c_void_p
    user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
    user32.CallNextHookEx.restype = ctypes.c_ssize_t
    user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    user32.GetMessageW.restype = ctypes.c_int
    user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
    user32.GetAsyncKeyState.restype = ctypes.c_short
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_size_t]

    WH_KEYBOARD_LL = 13
    WM_KEYDOWN = 0x0100
    WM_SYSKEYDOWN = 0x0104
    LLKHF_INJECTED = 0x10
    VK_ARROWS = {0x25: "left", 0x26: "up", 0x27: "right", 0x28: "down"}


def _target_path(path, new, is_m):
    if is_m:
        d, names = mtp.split(path)
        return mtp.SEP.join([d] + names[:-1] + [new])
    return os.path.join(os.path.dirname(path.rstrip("\\/")), new)


def _key(path, is_m):
    return path.lower() if is_m else os.path.normcase(os.path.abspath(path))


def _plan_rename(pairs, is_m):
    sources = {_key(p, is_m) for p, _ in pairs}
    finals = [_target_path(p, n, is_m) for p, n in pairs]
    clash = any(
        _key(f, is_m) in sources and _key(f, is_m) != _key(p, is_m)
        for (p, _), f in zip(pairs, finals)
    )
    if not clash:
        return list(pairs), finals
    first, second = [], []
    for i, ((p, n), f) in enumerate(zip(pairs, finals)):
        tmp = ".consolio-%s-%d" % (uuid.uuid4().hex[:8], i)
        first.append((p, tmp))
        second.append((_target_path(p, tmp, is_m), n))
    return first + second, finals


def load_session():
    try:
        with open(SESSION_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


VIDEO_EXTS = {"mp4", "m4v", "webm", "mkv", "avi", "mov", "wmv", "flv", "ogv", "mpg", "mpeg", "3gp"}
VIDEO_MIME = {
    "mp4": "video/mp4",
    "m4v": "video/mp4",
    "webm": "video/webm",
    "mkv": "video/webm",
    "avi": "video/x-msvideo",
    "mov": "video/quicktime",
    "wmv": "video/x-ms-wmv",
    "flv": "video/x-flv",
    "ogv": "video/ogg",
    "mpg": "video/mpeg",
    "mpeg": "video/mpeg",
    "3gp": "video/3gpp",
}
AUDIO_EXTS = {"mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "wma", "weba"}
AUDIO_MIME = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "opus": "audio/ogg",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "wma": "audio/x-ms-wma",
    "weba": "audio/webm",
}
_MEDIA_LOCK = threading.Lock()
_MEDIA_TOKENS = {}
_MEDIA_BY_PATH = {}
_MEDIA_SERVER = None


class _MediaHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionError, OSError):
            pass

    def _file(self):
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) == 2 and parts[0] == "v":
            return _MEDIA_TOKENS.get(parts[1])
        return None

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self._serve(False)

    def do_GET(self):
        self._serve(True)

    def _serve(self, body):
        try:
            path = self._file()
            if not path or not os.path.isfile(path):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            size = os.path.getsize(path)
            ext = os.path.splitext(path)[1][1:].lower()
            ctype = VIDEO_MIME.get(ext) or AUDIO_MIME.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
            start, end, status = 0, size - 1, 200
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                a, _, b = rng[6:].split(",")[0].strip().partition("-")
                try:
                    if a == "":
                        start = max(0, size - int(b))
                    else:
                        start = int(a)
                        end = int(b) if b else size - 1
                except ValueError:
                    start, end = 0, size - 1
                end = min(end, size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            if status == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not body:
                return
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(256 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (OSError, ConnectionError):
            pass


class _MediaServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, OSError)):
            return
        super().handle_error(request, client_address)


def _media_server():
    global _MEDIA_SERVER
    with _MEDIA_LOCK:
        if _MEDIA_SERVER is None:
            srv = _MediaServer(("127.0.0.1", 0), _MediaHandler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            _MEDIA_SERVER = srv
        return _MEDIA_SERVER


class Api:
    def __init__(self, ephemeral=False, start_paths=None):
        self._ephemeral = ephemeral
        self._start_paths = start_paths or []
        self._hook_proc = None
        self._window = None
        self._maximized = False
        self._saved = None
        self._session = load_session()
        self._undo = []
        self._size_token = 0
        self._search_token = 0
        finder.engine.start(INDEX_FILE, build=not ephemeral)

    def _write_session(self):
        if self._ephemeral:
            return
        tmp = SESSION_FILE + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._session, f, ensure_ascii=False, indent=2)
            os.replace(tmp, SESSION_FILE)
        except OSError:
            pass

    def block_autoplay(self):
        if not (IS_WIN and BLOCK_AUTOPLAY):
            return
        try:
            if not isinstance(self._session.get("autoplay_original"), dict):
                try:
                    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOPLAY_KEY) as k:
                        value = int(winreg.QueryValueEx(k, AUTOPLAY_VALUE)[0])
                        existed = True
                except OSError:
                    value, existed = 0, False
                self._session["autoplay_original"] = {"existed": existed, "value": value}
                self._write_session()
            with winreg.CreateKeyEx(
                winreg.HKEY_CURRENT_USER, AUTOPLAY_KEY, 0, winreg.KEY_SET_VALUE
            ) as k:
                winreg.SetValueEx(k, AUTOPLAY_VALUE, 0, winreg.REG_DWORD, 1)
        except OSError:
            pass

    def restore_autoplay(self):
        if not IS_WIN:
            return
        saved = self._session.get("autoplay_original")
        if not isinstance(saved, dict):
            return
        try:
            with winreg.CreateKeyEx(
                winreg.HKEY_CURRENT_USER, AUTOPLAY_KEY, 0, winreg.KEY_SET_VALUE
            ) as k:
                if saved.get("existed"):
                    winreg.SetValueEx(
                        k, AUTOPLAY_VALUE, 0, winreg.REG_DWORD, int(saved.get("value", 0))
                    )
                else:
                    try:
                        winreg.DeleteValue(k, AUTOPLAY_VALUE)
                    except FileNotFoundError:
                        pass
        except OSError:
            return
        self._session.pop("autoplay_original", None)
        self._write_session()

    def removable_devices(self, force=False):
        if force:
            places.invalidate_portable()
        return places.removable_devices()

    def list_place(self, key):
        if key == "quick":
            quick = self._session.get("quick")
            return places.quick_listing(quick if isinstance(quick, list) else [])
        return places.listing(key)

    def add_quick(self, items):
        quick = self._session.get("quick")
        if not isinstance(quick, list):
            quick = []
        seen = {os.path.normcase(os.path.abspath(p)) for p in quick}
        added = 0
        for it in items or []:
            path = it.get("path") if isinstance(it, dict) else None
            if not isinstance(path, str) or not os.path.exists(path):
                continue
            key = os.path.normcase(os.path.abspath(path))
            if key in seen:
                continue
            seen.add(key)
            quick.append(path)
            added += 1
        if added:
            self._session["quick"] = quick
            self._write_session()
        return {"added": added, "total": len(quick)}

    def remove_quick(self, paths):
        quick = self._session.get("quick")
        if not isinstance(quick, list):
            return {"removed": 0}
        drop = {
            os.path.normcase(os.path.abspath(p))
            for p in (paths or [])
            if isinstance(p, str)
        }
        kept = [p for p in quick if os.path.normcase(os.path.abspath(p)) not in drop]
        removed = len(quick) - len(kept)
        if removed:
            self._session["quick"] = kept
            self._write_session()
        return {"removed": removed}

    def open_device(self, path):
        if not IS_WIN or not isinstance(path, str) or not places.is_portable(path):
            return False
        try:
            subprocess.Popen(["explorer.exe", path])
            return True
        except OSError:
            return False

    def new_window(self, paths=None):
        if isinstance(paths, str):
            paths = [paths]
        paths = paths or []
        if not isinstance(paths, list) or not all(
            isinstance(p, str) and (os.path.isdir(p) or mtp.is_mtp(p)) for p in paths
        ):
            return False
        try:
            if getattr(sys, "frozen", False):
                cmd = [sys.executable]
            else:
                exe = sys.executable
                if IS_WIN and exe.lower().endswith("python.exe"):
                    alt = exe[:-10] + "pythonw.exe"
                    if os.path.exists(alt):
                        exe = alt
                cmd = [exe, os.path.abspath(__file__)]
            cmd.append("--new")
            cmd.extend(paths)
            subprocess.Popen(cmd, cwd=BASE)
            return True
        except OSError:
            return False

    def copy_text(self, text):
        if not isinstance(text, str) or not text:
            return False
        try:
            if IS_WIN:
                subprocess.run(
                    ["clip"],
                    input=b"\xff\xfe" + text.encode("utf-16le"),
                    creationflags=0x08000000,
                    timeout=5,
                    check=True,
                )
            elif platform.system() == "Darwin":
                subprocess.run(["pbcopy"], input=text.encode("utf-8"), timeout=5, check=True)
            else:
                try:
                    subprocess.run(["wl-copy"], input=text.encode("utf-8"), timeout=5, check=True)
                except (OSError, subprocess.SubprocessError):
                    subprocess.run(
                        ["xclip", "-selection", "clipboard"],
                        input=text.encode("utf-8"),
                        timeout=5,
                        check=True,
                    )
            return True
        except (OSError, subprocess.SubprocessError):
            return False

    def unzip_items(self, paths):
        if not isinstance(paths, list):
            return {"created": [], "errors": ["Некоректний запит"]}
        paths = [p for p in paths if isinstance(p, str)]
        if not paths:
            return {"created": [], "errors": ["Нічого розпаковувати"]}
        if any(mtp.is_mtp(p) for p in paths):
            return {"created": [], "errors": ["Розпакування недоступне для цього розташування"]}
        pairs, errors = ops.unzip_items(paths)
        finder.engine.touch([d for _, d in pairs])
        if pairs:
            self._undo.append({"mode": "copy", "pairs": pairs})
            del self._undo[:-50]
        return {"created": [d for _, d in pairs], "errors": errors}

    def zip_items(self, paths, name=None):
        if not isinstance(paths, list):
            return {"created": [], "errors": ["Некоректний запит"]}
        paths = [p for p in paths if isinstance(p, str)]
        if not paths:
            return {"created": [], "errors": ["Нічого архівувати"]}
        if any(mtp.is_mtp(p) for p in paths):
            return {"created": [], "errors": ["Архівування недоступне для цього розташування"]}
        if name is not None and not isinstance(name, str):
            name = None
        target, errors = ops.zip_items(paths, name)
        if target:
            finder.engine.touch([target])
            self._undo.append({"mode": "copy", "pairs": [(paths[0], target)]})
            del self._undo[:-50]
        return {"created": [target] if target else [], "errors": errors}

    def read_image(self, path):
        if not isinstance(path, str) or mtp.is_mtp(path):
            return {"error": "Перегляд недоступний"}
        mime = IMAGE_MIME.get(os.path.splitext(path)[1][1:].lower())
        if not mime or not os.path.isfile(path):
            return {"error": "Перегляд недоступний"}
        try:
            if os.path.getsize(path) > IMAGE_LIMIT:
                return {"error": "Файл завеликий для перегляду"}
            with open(path, "rb") as f:
                data = f.read()
        except OSError as e:
            return {"error": str(e)}
        return {"url": "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))}

    @staticmethod
    def _decode_text(data):
        if data.startswith(b"\xef\xbb\xbf"):
            return data[3:].decode("utf-8", "replace"), "utf-8-sig"
        if data.startswith((b"\xff\xfe", b"\xfe\xff")):
            try:
                return data.decode("utf-16"), "utf-16"
            except UnicodeDecodeError:
                return None, None
        if b"\x00" in data[:8192]:
            return None, None
        try:
            return data.decode("utf-8"), "utf-8"
        except UnicodeDecodeError:
            pass
        try:
            return data.decode("cp1251"), "cp1251"
        except UnicodeDecodeError:
            return data.decode("latin-1"), "latin-1"

    def read_text(self, path):
        if not isinstance(path, str) or mtp.is_mtp(path):
            return {"error": "Редагування недоступне для цього розташування"}
        if not os.path.isfile(path):
            return {"error": "Файл не знайдено"}
        try:
            size = os.path.getsize(path)
            if size > TEXT_LIMIT:
                return {"error": "Файл завеликий для редактора (понад 8 МБ)"}
            mtime = os.path.getmtime(path)
            with open(path, "rb") as f:
                data = f.read()
        except OSError as e:
            return {"error": str(e)}
        text, enc = self._decode_text(data)
        if text is None:
            return {"error": "Це не текстовий файл"}
        crlf = text.count("\r\n")
        lf = text.count("\n") - crlf
        if crlf == 0 and lf == 0:
            eol = os.linesep
        else:
            eol = "\r\n" if crlf > lf else "\n"
        return {"text": text, "enc": enc, "eol": eol, "mtime": mtime, "size": size}

    def write_text(self, path, text, enc="utf-8", eol="\n", expected_mtime=None):
        if not isinstance(path, str) or not isinstance(text, str) or mtp.is_mtp(path):
            return {"error": "Збереження недоступне для цього розташування"}
        if enc not in ("utf-8", "utf-8-sig", "utf-16", "cp1251", "latin-1"):
            enc = "utf-8"
        if eol not in ("\n", "\r\n"):
            eol = "\n"
        try:
            if expected_mtime is not None and os.path.exists(path):
                if abs(os.path.getmtime(path) - float(expected_mtime)) > 0.01:
                    return {"conflict": True}
        except (OSError, TypeError, ValueError):
            pass
        body = text.replace("\r\n", "\n").replace("\r", "\n")
        if eol != "\n":
            body = body.replace("\n", eol)
        try:
            raw = body.encode(enc)
        except UnicodeEncodeError:
            enc = "utf-8"
            raw = body.encode(enc)
        if enc == "utf-16":
            raw = b"\xff\xfe" + body.encode("utf-16-le")
        try:
            with open(path, "wb") as f:
                f.write(raw)
            mtime = os.path.getmtime(path)
        except OSError as e:
            return {"error": str(e)}
        return {"ok": True, "mtime": mtime, "enc": enc}

    def video_url(self, path):
        return self._media_url(path, VIDEO_EXTS)

    def audio_url(self, path):
        return self._media_url(path, AUDIO_EXTS)

    @staticmethod
    def _media_url(path, exts):
        if not isinstance(path, str) or mtp.is_mtp(path):
            return {"error": "Відтворення недоступне"}
        if os.path.splitext(path)[1][1:].lower() not in exts or not os.path.isfile(path):
            return {"error": "Відтворення недоступне"}
        try:
            srv = _media_server()
        except OSError as e:
            return {"error": str(e)}
        with _MEDIA_LOCK:
            token = _MEDIA_BY_PATH.get(path)
            if not token:
                token = uuid.uuid4().hex
                _MEDIA_BY_PATH[path] = token
                _MEDIA_TOKENS[token] = path
        return {"url": "http://127.0.0.1:%d/v/%s" % (srv.server_address[1], token)}

    def read_thumb(self, path, size=128):
        if not isinstance(path, str) or mtp.is_mtp(path):
            return {"error": "Перегляд недоступний"}
        ext = os.path.splitext(path)[1][1:].lower()
        if Image is not None and ext in ("jpg", "jpeg", "png", "gif", "webp", "bmp"):
            try:
                size = max(32, min(int(size), 512))
                with Image.open(path) as im:
                    im = ImageOps.exif_transpose(im)
                    im.thumbnail((size * 2, size * 2))
                    alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
                    im = im.convert("RGBA" if alpha else "RGB")
                    buf = io.BytesIO()
                    if alpha:
                        im.save(buf, "PNG")
                        mime = "image/png"
                    else:
                        im.save(buf, "JPEG", quality=80)
                        mime = "image/jpeg"
                return {"url": "data:%s;base64,%s" % (mime, base64.b64encode(buf.getvalue()).decode("ascii"))}
            except Exception:
                pass
        try:
            if os.path.getsize(path) > 8 * 1024 * 1024:
                return {"error": "Файл завеликий для мініатюри"}
        except OSError as e:
            return {"error": str(e)}
        return self.read_image(path)

    def read_app_icon(self, path):
        if not isinstance(path, str) or mtp.is_mtp(path):
            return {"error": "Іконка недоступна"}
        return icons.app_icon(path)

    def open_path(self, path):
        if not isinstance(path, str) or not os.path.exists(path):
            return False
        try:
            if IS_WIN:
                folder = os.path.dirname(path)
                if folder and os.path.isfile(path) and not path.lower().endswith(".lnk"):
                    try:
                        os.startfile(path, cwd=folder)
                    except TypeError:
                        os.startfile(path)
                else:
                    os.startfile(path)
            elif platform.system() == "Darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])
            return True
        except OSError:
            return False

    def paste_items(self, paths, dest, mode):
        if not isinstance(paths, list) or not isinstance(dest, str) or mode not in ("copy", "cut"):
            return {"created": [], "errors": ["Некоректний запит"]}
        paths = [p for p in paths if isinstance(p, str)]
        if mtp.is_mtp(dest) or any(mtp.is_mtp(p) for p in paths):
            created, errors, cancelled = mtp.paste(paths, dest, mode)
            return {"created": created, "errors": errors, "cancelled": cancelled}
        pairs, errors, replaced, cancelled = ops.paste(paths, dest, mode)
        finder.engine.touch([d for _, d in pairs] + replaced)
        if pairs:
            self._undo.append({"mode": mode, "pairs": pairs})
            del self._undo[:-50]
        return {
            "created": [d for _, d in pairs] + replaced,
            "errors": errors,
            "cancelled": cancelled,
        }

    def get_progress(self):
        conflict = ops.pending_conflict() or mtp.read_conflict()
        p = mtp.read_progress()
        if p is None and ops.PROGRESS.get("active"):
            p = {
                "done": ops.PROGRESS["done"],
                "total": ops.PROGRESS["total"],
                "name": ops.PROGRESS["name"],
            }
        if conflict:
            p = dict(p or {"done": 0, "total": 0, "name": ""})
            p["conflict"] = conflict
        return p

    def resolve_conflict(self, answer, apply_all=False):
        if answer not in ("replace", "skip", "cancel"):
            return False
        first = ops.resolve(answer, bool(apply_all))
        second = mtp.resolve(answer, bool(apply_all))
        return bool(first or second)

    def rename_many(self, pairs):
        if not isinstance(pairs, list) or not pairs:
            return {"paths": [], "errors": ["Некоректний запит"]}
        clean = []
        for p in pairs:
            path = p.get("path") if isinstance(p, dict) else None
            name = p.get("name") if isinstance(p, dict) else None
            if not isinstance(path, str) or not isinstance(name, str):
                return {"paths": [], "errors": ["Некоректний запит"]}
            name = name.strip()
            err = ops.bad_name(name)
            if err:
                return {"paths": [], "errors": [err]}
            clean.append((path, name))
        is_m = mtp.is_mtp(clean[0][0])
        if any(mtp.is_mtp(p) != is_m for p, _ in clean):
            return {"paths": [], "errors": ["Некоректний запит"]}
        steps, finals = _plan_rename(clean, is_m)
        errors = []
        if is_m:
            errors = mtp.rename_many(steps)
        else:
            for path, new in steps:
                _, err = ops.rename(path, new)
                if err:
                    errors.append("%s: %s" % (os.path.basename(path.rstrip("\\/")), err))
                    break
        if not is_m:
            finder.engine.touch(finals)
        return {"paths": finals, "errors": errors}

    def rename_item(self, path, new_name):
        if not isinstance(path, str) or not isinstance(new_name, str):
            return {"error": "Некоректний запит"}
        new_name = new_name.strip()
        if mtp.is_mtp(path):
            new_path, err = mtp.rename(path, new_name)
        else:
            new_path, err = ops.rename(path, new_name)
        if err:
            return {"error": err}
        finder.engine.touch([new_path])
        return {"path": new_path}

    def create_item(self, directory, name, kind):
        if not isinstance(directory, str) or not isinstance(name, str) or kind not in ("file", "folder"):
            return {"error": "Некоректний запит"}
        if mtp.is_mtp(directory) or not os.path.isdir(directory):
            return {"error": "Тут не можна створювати"}
        name = name.strip()
        err = ops.bad_name(name)
        if err:
            return {"error": err}
        path = os.path.join(directory, name)
        try:
            if os.path.lexists(path):
                return {"error": "Елемент з такою назвою вже існує"}
            if kind == "folder":
                os.mkdir(path)
            else:
                with open(path, "x"):
                    pass
        except OSError as e:
            return {"error": str(e)}
        finder.engine.touch([path])
        self._undo.append({"mode": "copy", "pairs": [(path, path)]})
        del self._undo[:-50]
        return {"path": path}

    def delete_items(self, paths, permanent):
        if not isinstance(paths, list):
            return {"deleted": 0, "errors": ["Некоректний запит"]}
        paths = [p for p in paths if isinstance(p, str)]
        if paths and all(mtp.is_mtp(p) for p in paths):
            count, errors = mtp.delete(paths)
            return {"deleted": count, "errors": errors}
        count, errors = ops.delete(paths, bool(permanent))
        return {"deleted": count, "errors": errors}

    def undo(self):
        if not self._undo:
            return {"ok": False, "paths": [], "errors": []}
        entry = self._undo.pop()
        restored, errors, count = ops.undo(entry)
        return {
            "ok": True,
            "mode": entry["mode"],
            "count": count,
            "paths": restored,
            "errors": errors,
        }

    def list_path(self, path):
        return places.listing_path(path)

    def search_files(self, query, scope, token):
        if not isinstance(query, str) or not isinstance(token, int):
            return {"items": [], "total": 0}
        if not isinstance(scope, str) or not scope or mtp.is_mtp(scope):
            scope = None
        self._search_token = max(self._search_token, token)
        try:
            return finder.engine.search(query, scope, lambda: token < self._search_token)
        except Exception as e:
            return {"items": [], "total": 0, "error": str(e)}

    def search_status(self):
        return finder.engine.status()

    def reindex(self):
        finder.engine.reindex()
        return True

    def folder_size(self, path, token):
        if not isinstance(path, str) or not isinstance(token, int):
            return None
        self._size_token = max(self._size_token, token)
        return places.folder_size(path, lambda: token < self._size_token)

    def parent_of(self, path):
        return places.parent_of(path)

    def count_place(self, key):
        return places.count(key)

    def get_session(self):
        if self._ephemeral:
            tabs = []
            for i, p in enumerate(self._start_paths, 1):
                title = os.path.basename(p.rstrip("\\/").rsplit(places.MTP_SEP, 1)[-1]) or p
                tabs.append({
                    "id": i,
                    "title": title,
                    "loc": {"path": p},
                    "history": [{"path": p}],
                    "index": 0,
                })
            return {
                "maximized": False,
                "view": self._session.get("view", "details"),
                "volume": self._session.get("volume", 1.0),
                "tabs": tabs,
                "active": 1 if tabs else None,
                "counter": len(tabs),
            }
        return {
            "maximized": bool(self._session.get("maximized", False)),
            "view": self._session.get("view", "details"),
            "volume": self._session.get("volume", 1.0),
            "tabs": self._session.get("tabs", []),
            "active": self._session.get("active"),
            "counter": self._session.get("counter", 0),
        }

    @staticmethod
    def _clean_loc(loc):
        if not isinstance(loc, dict):
            return None
        if isinstance(loc.get("place"), str):
            return {"place": loc["place"]}
        if isinstance(loc.get("path"), str):
            return {"path": loc["path"]}
        return None

    def _clean_tab(self, tab):
        try:
            history = [
                h for h in map(self._clean_loc, tab.get("history") or []) if h
            ]
            return {
                "id": int(tab["id"]),
                "title": str(tab["title"]),
                "loc": self._clean_loc(tab.get("loc")),
                "history": history,
                "index": int(tab.get("index", 0)),
            }
        except (KeyError, TypeError, ValueError, AttributeError):
            return None

    def save_view(self, view):
        if view in ("details", "list", "grid"):
            self._session["view"] = view
            self._write_session()

    def save_volume(self, volume):
        try:
            v = float(volume)
        except (TypeError, ValueError):
            return
        if 0.0 <= v <= 1.0:
            self._session["volume"] = round(v, 2)
            self._write_session()

    def save_tabs(self, tabs, active, counter):
        cleaned = [self._clean_tab(t) for t in tabs]
        self._session["tabs"] = [t for t in cleaned if t]
        self._session["active"] = active
        self._session["counter"] = counter
        self._write_session()

    def minimize(self):
        self._window.minimize()

    def toggle_maximize(self):
        result = self._toggle_maximize()
        self._session["maximized"] = result
        self._write_session()
        return result

    def _hwnd(self):
        try:
            return int(self._window.native.Handle.ToInt64())
        except Exception:
            return None

    @staticmethod
    def _work_area(hwnd):
        mon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        user32.GetMonitorInfoW(mon, ctypes.byref(info))
        wa = info.rcWork
        return wa.left, wa.top, wa.right, wa.bottom

    @staticmethod
    def _snap_rects(wa):
        l, t, r, b = wa
        mid = l + (r - l) // 2
        return {"max": wa, "left": (l, t, mid, b), "right": (mid, t, r, b)}

    def _sync_state(self, hwnd):
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        cur = (rect.left, rect.top, rect.right, rect.bottom)
        state = None
        for name, target in self._snap_rects(self._work_area(hwnd)).items():
            if all(abs(a - b) <= 2 for a, b in zip(cur, target)):
                state = name
                break
        if state is None:
            self._saved = (cur[0], cur[1], cur[2] - cur[0], cur[3] - cur[1])
        self._maximized = state == "max"
        return state

    @staticmethod
    def _place(hwnd, rect):
        l, t, r, b = rect
        user32.SetWindowPos(hwnd, None, l, t, r - l, b - t, SWP_NOZORDER | SWP_NOACTIVATE)

    def _toggle_maximize(self):
        if not IS_WIN:
            if self._maximized:
                self._window.restore()
            else:
                self._window.maximize()
            self._maximized = not self._maximized
            return self._maximized

        hwnd = self._hwnd()
        state = self._sync_state(hwnd)
        if state == "max" and self._saved:
            l, t, w, h = self._saved
            self._place(hwnd, (l, t, l + w, t + h))
            self._maximized = False
        else:
            self._place(hwnd, self._snap_rects(self._work_area(hwnd))["max"])
            self._maximized = True
        return self._maximized

    def _restore_saved(self, hwnd):
        if self._saved:
            l, t, w, h = self._saved
        else:
            wa = self._work_area(hwnd)
            w, h = 1100, 680
            l = wa[0] + (wa[2] - wa[0] - w) // 2
            t = wa[1] + (wa[3] - wa[1] - h) // 2
        self._place(hwnd, (l, t, l + w, t + h))

    def _snap(self, key):
        hwnd = self._hwnd()
        if not hwnd:
            return
        user32.keybd_event(0xE8, 0, 0, 0)
        user32.keybd_event(0xE8, 0, 2, 0)
        state = self._sync_state(hwnd)
        rects = self._snap_rects(self._work_area(hwnd))
        if key == "left":
            if state == "right":
                self._restore_saved(hwnd)
            else:
                self._place(hwnd, rects["left"])
        elif key == "right":
            if state == "left":
                self._restore_saved(hwnd)
            else:
                self._place(hwnd, rects["right"])
        elif key == "up":
            self._place(hwnd, rects["max"])
        elif key == "down":
            if state is None:
                self._window.minimize()
                return
            self._restore_saved(hwnd)
        is_max = self._sync_state(hwnd) == "max"
        self._session["maximized"] = is_max
        self._write_session()
        try:
            self._window.evaluate_js("setMaxIcon(%s)" % ("true" if is_max else "false"))
        except Exception:
            pass

    def start_snap(self):
        if not IS_WIN:
            return
        threading.Thread(target=self._hook_loop, daemon=True).start()

    def _hook_loop(self):
        def proc(code, wparam, lparam):
            if code == 0 and wparam in (WM_KEYDOWN, WM_SYSKEYDOWN):
                kb = ctypes.cast(lparam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                key = VK_ARROWS.get(kb.vkCode)
                if key and not (kb.flags & LLKHF_INJECTED):
                    win = (user32.GetAsyncKeyState(0x5B) | user32.GetAsyncKeyState(0x5C)) & 0x8000
                    other = (
                        user32.GetAsyncKeyState(0x10)
                        | user32.GetAsyncKeyState(0x11)
                        | user32.GetAsyncKeyState(0x12)
                    ) & 0x8000
                    if win and not other:
                        hwnd = self._hwnd()
                        if hwnd and user32.GetForegroundWindow() == hwnd:
                            threading.Thread(target=self._snap, args=(key,), daemon=True).start()
                            return 1
            return user32.CallNextHookEx(None, code, wparam, lparam)

        self._hook_proc = HOOKPROC(proc)
        hook = user32.SetWindowsHookExW(
            WH_KEYBOARD_LL, self._hook_proc, kernel32.GetModuleHandleW(None), 0
        )
        if not hook:
            return
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            pass

    def close(self):
        self._window.destroy()


if __name__ == "__main__":
    args = sys.argv[1:]
    extra = bool(args) and args[0] == "--new"
    api = Api(extra, args[1:] if extra else None)
    window = webview.create_window(
        "Consolio",
        os.path.join(BASE, "index.html"),
        width=1100,
        height=680,
        min_size=(600, 400),
        frameless=True,
        easy_drag=False,
        background_color="#0b0c0d",
        js_api=api,
    )
    api._window = window
    api.start_snap()
    if not extra:
        api.block_autoplay()
        atexit.register(api.restore_autoplay)
    try:
        webview.start()
    finally:
        if not extra:
            api.restore_autoplay()
