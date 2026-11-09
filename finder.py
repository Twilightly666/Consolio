import array
import bisect
import fnmatch
import gzip
import heapq
import os
import pickle
import platform
import re
import threading
import time

IS_WIN = platform.system() == "Windows"
SEP = os.sep

MAX_RESULTS = 1000
HARD_CAP = 300000
STALE_AFTER = 30 * 60
LIVE_BUDGET = 4.0
CACHE_VERSION = 1

SKIP_WIN = {"$recycle.bin", "system volume information"}
SKIP_POSIX = {"/proc", "/sys", "/dev", "/run", "/snap"}


def _roots():
    if IS_WIN:
        import ctypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
        k.GetDriveTypeW.restype = ctypes.c_uint
        mask = k.GetLogicalDrives()
        out = []
        for i in range(26):
            if (mask >> i) & 1:
                root = f"{chr(65 + i)}:\\"
                if k.GetDriveTypeW(root) == 3:
                    out.append(root)
        return out
    return ["/"]


def _lower_priority():
    if not IS_WIN:
        try:
            os.nice(10)
        except Exception:
            pass
        return
    try:
        import ctypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetCurrentThread.restype = ctypes.c_void_p
        k.SetThreadPriority.argtypes = [ctypes.c_void_p, ctypes.c_int]
        k.SetThreadPriority(k.GetCurrentThread(), 0x00010000)
    except Exception:
        pass


def _entry_info(e):
    try:
        nofollow = e.is_dir(follow_symlinks=False)
        is_dir = nofollow or e.is_dir()
        descend = nofollow
        if nofollow and IS_WIN:
            if e.stat(follow_symlinks=False).st_file_attributes & 0x400:
                descend = False
        return is_dir, descend
    except OSError:
        return False, False


def _crawl(roots, cancelled, progress):
    dirs, names = [], []
    dids = array.array("I")
    flags = bytearray()
    stack = list(reversed(roots))
    n = 0
    while stack:
        if cancelled():
            return None
        path = stack.pop()
        did = len(dirs)
        dirs.append(path)
        try:
            it = os.scandir(path)
        except OSError:
            continue
        with it:
            for e in it:
                name = e.name
                if "\n" in name:
                    continue
                is_dir, descend = _entry_info(e)
                if descend:
                    if IS_WIN and name.lower() in SKIP_WIN:
                        continue
                    if not IS_WIN and e.path in SKIP_POSIX:
                        descend = False
                    elif descend:
                        stack.append(e.path)
                names.append(name)
                dids.append(did)
                flags.append(1 if is_dir else 0)
                n += 1
                if n % 4000 == 0:
                    progress(n)
                    time.sleep(0.001)
    return dirs, names, dids, flags


def _blobs(names):
    offs = array.array("I")
    lower = []
    pos = 0
    for n in names:
        low = n.lower()
        if len(low) != len(n):
            low = n
        lower.append(low)
        offs.append(pos)
        pos += len(n) + 1
    offs.append(pos)
    return offs, "\n".join(lower) + "\n", "\n".join(names) + "\n"


_OP = re.compile(r"^(ext|type|in):(.*)$", re.I)
_TOKEN = re.compile(r'"([^"]*)"|(\S+)')


class Query:
    def __init__(self, text):
        self.plain = []
        self.wild = []
        self.paths = []
        self.exts = None
        self.kind = None
        for m in _TOKEN.finditer(text):
            quoted = m.group(1) is not None
            tok = (m.group(1) if quoted else m.group(2)).strip()
            if not tok:
                continue
            low = tok.lower()
            op = None if quoted else _OP.match(low)
            if op:
                key, val = op.group(1), op.group(2).strip()
                if key == "ext":
                    exts = {x.strip().lstrip(".") for x in val.split(",") if x.strip().lstrip(".")}
                    if exts:
                        self.exts = (self.exts or set()) | exts
                elif key == "type":
                    if val in ("folder", "dir", "папка", "d"):
                        self.kind = "dir"
                    elif val in ("file", "файл", "f"):
                        self.kind = "file"
                elif key == "in" and val:
                    self.paths.append(val.replace("/", SEP).replace("\\", SEP))
                continue
            if "\\" in low or "/" in low:
                self.paths.append(low.replace("/", SEP).replace("\\", SEP))
            elif not quoted and ("*" in low or "?" in low):
                self.wild.append(re.compile(fnmatch.translate(low)))
            else:
                self.plain.append(low)

    @property
    def empty(self):
        return not (self.plain or self.wild or self.paths or self.exts or self.kind)

    def test(self, lname, is_dir):
        for t in self.plain:
            if t not in lname:
                return False
        for rx in self.wild:
            if not rx.match(lname):
                return False
        if self.kind is not None and is_dir != (self.kind == "dir"):
            return False
        if self.exts is not None:
            if is_dir:
                return False
            dot = lname.rfind(".")
            if dot < 0 or lname[dot + 1:] not in self.exts:
                return False
        return True

    def test_path(self, dir_lower, lname):
        if not self.paths:
            return True
        full = (dir_lower if dir_lower.endswith(SEP) else dir_lower + SEP) + lname
        return all(p in full for p in self.paths)

    def tier(self, lname):
        if not self.plain:
            return 3
        p = self.plain[0]
        if lname == p:
            return 0
        dot = lname.rfind(".")
        if (lname[:dot] if dot > 0 else lname) == p:
            return 0
        if lname.startswith(p):
            return 1
        i = lname.find(p)
        if i > 0 and not lname[i - 1].isalnum():
            return 2
        return 3


class Index:
    def __init__(self, roots, dirs, offs, dids, flags, lblob, nblob, built):
        self.roots = roots
        self.dirs = dirs
        self.offs = offs
        self.dids = dids
        self.flags = flags
        self.lblob = lblob
        self.nblob = nblob
        self.built = built
        self.count = len(dids)
        self._dl = None
        self._depth = None

    def _prepare(self):
        if self._dl is None:
            dl = [d.lower() for d in self.dirs]
            self._depth = [d.count(SEP) for d in dl]
            self._dl = dl
        return self._dl

    def covers(self, path):
        p = path.lower()
        return any(p.startswith(r.lower().rstrip(SEP)) for r in self.roots)

    def _find(self, tok):
        lb, offs = self.lblob, self.offs
        pos = lb.find(tok)
        last = -1
        while pos != -1:
            i = bisect.bisect_right(offs, pos) - 1
            if i != last:
                last = i
                yield i
            pos = lb.find(tok, offs[i + 1])

    def search(self, q, scope, cancelled, limit):
        dl = self._prepare()
        ok = None
        if scope:
            s = scope.lower().rstrip(SEP)
            pre = s + SEP
            ok = bytearray(len(dl))
            for i, d in enumerate(dl):
                if d.rstrip(SEP) == s or d.startswith(pre):
                    ok[i] = 1
        if q.plain:
            cands = self._find(max(q.plain, key=len))
        else:
            cands = range(self.count)
        offs, lblob, dids, flags = self.offs, self.lblob, self.dids, self.flags
        found = []
        for n, i in enumerate(cands):
            if n & 0x3FFF == 0 and cancelled():
                return None
            did = dids[i]
            if ok is not None and not ok[did]:
                continue
            lname = lblob[offs[i]:offs[i + 1] - 1]
            if not q.test(lname, flags[i]):
                continue
            if q.paths and not q.test_path(dl[did], lname):
                continue
            found.append(i)
            if len(found) >= HARD_CAP:
                break
        depth = self._depth

        def key(i):
            lname = lblob[offs[i]:offs[i + 1] - 1]
            return (q.tier(lname), 0 if flags[i] else 1, len(lname), depth[dids[i]])

        top = heapq.nsmallest(limit, found, key=key)
        return top, len(found)

    def name_of(self, i):
        return self.nblob[self.offs[i]:self.offs[i + 1] - 1]

    def dir_of(self, i):
        return self.dirs[self.dids[i]]


def _make_item(name, directory, is_dir, st):
    return {
        "name": name,
        "path": os.path.join(directory, name),
        "kind": "folder" if is_dir else "file",
        "ext": "" if is_dir else os.path.splitext(name)[1][1:].lower(),
        "size": None if is_dir else st.st_size,
        "modified": st.st_mtime,
        "where": directory,
    }


class Engine:
    def __init__(self):
        self.index = None
        self.building = False
        self.scanned = 0
        self.cache_path = None
        self.overlay = {}
        self._gen = 0
        self._started = False
        self._lock = threading.Lock()

    def start(self, cache_path, build=True):
        if self._started:
            return
        self._started = True
        self.cache_path = cache_path
        threading.Thread(target=self._boot, args=(build,), daemon=True).start()

    def _boot(self, build):
        self._load_cache()
        if not build:
            return
        if self.index is None or time.time() - self.index.built > STALE_AFTER:
            self._rebuild()
        while True:
            time.sleep(120)
            if self.index is None or time.time() - self.index.built > STALE_AFTER:
                self._rebuild()

    def reindex(self):
        if not self.building:
            threading.Thread(target=self._rebuild, daemon=True).start()

    def _rebuild(self):
        with self._lock:
            if self.building:
                return
            self.building = True
        self._gen += 1
        gen = self._gen
        self.scanned = 0
        try:
            _lower_priority()
            roots = _roots()

            def progress(n):
                self.scanned = n

            res = _crawl(roots, lambda: gen != self._gen, progress)
            if res is None:
                return
            dirs, names, dids, flags = res
            offs, lblob, nblob = _blobs(names)
            idx = Index(roots, dirs, offs, dids, flags, lblob, nblob, time.time())
            self.index = idx
            self.overlay.clear()
            self._save_cache(idx)
        except Exception:
            pass
        finally:
            self.building = False

    def _save_cache(self, idx):
        if not self.cache_path:
            return
        tmp = self.cache_path + ".tmp"
        try:
            data = {
                "v": CACHE_VERSION, "roots": idx.roots, "built": idx.built,
                "dirs": idx.dirs, "offs": idx.offs, "dids": idx.dids,
                "flags": bytes(idx.flags), "lblob": idx.lblob, "nblob": idx.nblob,
            }
            with gzip.open(tmp, "wb", compresslevel=1) as f:
                pickle.dump(data, f, protocol=pickle.HIGHEST_PROTOCOL)
            os.replace(tmp, self.cache_path)
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass

    def _load_cache(self):
        if not self.cache_path or not os.path.isfile(self.cache_path):
            return
        try:
            with gzip.open(self.cache_path, "rb") as f:
                d = pickle.load(f)
            if d.get("v") != CACHE_VERSION:
                return
            self.index = Index(d["roots"], d["dirs"], d["offs"], d["dids"],
                               bytearray(d["flags"]), d["lblob"], d["nblob"], d["built"])
        except Exception:
            pass

    def touch(self, paths):
        for p in paths or []:
            if isinstance(p, str) and not p.startswith("::"):
                self.overlay[p] = True
        if len(self.overlay) > 5000:
            for k in list(self.overlay)[:1000]:
                self.overlay.pop(k, None)

    def status(self):
        idx = self.index
        return {
            "indexing": self.building,
            "scanned": self.scanned,
            "indexed": idx.count if idx else 0,
            "built": idx.built if idx else None,
        }

    def search(self, text, scope, cancelled, limit=MAX_RESULTS):
        t0 = time.time()
        q = Query(text or "")
        base = {"items": [], "total": 0, "truncated": False, "live": False, "partial": False}
        if q.empty:
            return dict(base, **self.status())
        idx = self.index
        use_index = idx is not None and (not scope or idx.covers(scope))
        if use_index:
            res = idx.search(q, scope, cancelled, limit)
            if res is None:
                return dict(base, cancelled=True)
            top, total = res
            items = []
            for i in top:
                name, directory = idx.name_of(i), idx.dir_of(i)
                try:
                    st = os.stat(os.path.join(directory, name))
                except OSError:
                    total -= 1
                    continue
                items.append(_make_item(name, directory, bool(idx.flags[i]), st))
            seen = {it["path"] for it in items}
            items.extend(self._from_overlay(q, scope, seen))
            out = dict(base, items=items, total=max(total, len(items)))
        else:
            items, partial = _live(q, scope, _roots_for(scope), cancelled, limit)
            if items is None:
                return dict(base, cancelled=True)
            out = dict(base, items=items, total=len(items), live=True, partial=partial)
        out["truncated"] = out["total"] > len(out["items"])
        out["ms"] = int((time.time() - t0) * 1000)
        out.update(self.status())
        return out

    def _from_overlay(self, q, scope, seen):
        res = []
        pre = scope.lower().rstrip(SEP) if scope else None
        for p in list(self.overlay):
            if p in seen:
                continue
            try:
                st = os.stat(p)
            except OSError:
                self.overlay.pop(p, None)
                continue
            directory, name = os.path.split(p)
            dl = directory.lower()
            if pre is not None and not (dl.rstrip(SEP) == pre or dl.startswith(pre + SEP)):
                continue
            is_dir = os.path.isdir(p)
            lname = name.lower()
            if q.test(lname, is_dir) and q.test_path(dl, lname):
                res.append(_make_item(name, directory, is_dir, st))
        return res


def _roots_for(scope):
    return [scope] if scope else _roots()


def _live(q, scope, roots, cancelled, limit):
    deadline = time.time() + LIVE_BUDGET
    stack = list(reversed(roots))
    found = []
    partial = False
    n = 0
    while stack:
        if cancelled():
            return None, False
        if time.time() > deadline or len(found) >= HARD_CAP // 10:
            partial = True
            break
        path = stack.pop()
        dl = path.lower()
        try:
            it = os.scandir(path)
        except OSError:
            continue
        with it:
            for e in it:
                n += 1
                lname = e.name.lower()
                is_dir, descend = _entry_info(e)
                if descend and not (IS_WIN and lname in SKIP_WIN):
                    stack.append(e.path)
                if q.test(lname, is_dir) and q.test_path(dl, lname):
                    try:
                        st = e.stat()
                    except OSError:
                        continue
                    found.append(_make_item(e.name, path, is_dir, st))
    found.sort(key=lambda it: (q.tier(it["name"].lower()), it["kind"] != "folder", len(it["name"])))
    return found[:limit], partial or len(found) > limit


engine = Engine()
