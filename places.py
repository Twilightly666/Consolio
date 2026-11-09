import json
import os
import platform
import re
import shutil
import subprocess
import threading
import time

IS_WIN = platform.system() == "Windows"
HOME = os.path.expanduser("~")
LIMIT = 5000

KNOWN_FOLDERS = {
    "desktop": ("B4BFCC3A-DB2C-424C-B029-7FE99A87C641", "Desktop"),
    "downloads": ("374DE290-123F-4565-9164-39C4925E467B", "Downloads"),
    "documents": ("FDD39AD0-238F-46AF-ADB4-6C85480369C7", "Documents"),
    "images": ("33E28130-4E1E-4676-835A-98395C3BC3BB", "Pictures"),
    "music": ("4BD8D571-6D19-48D3-BE97-422220080E43", "Music"),
    "videos": ("18989B1D-99B5-455B-841C-AB7C74E4DDFC", "Videos"),
}

VIRTUAL_TITLES = {
    "quick": "Швидкий доступ",
    "pc": "Цей пк",
    "removable": "Змінні носії",
    "trash": "Смітник",
}

DRIVE_NAMES = {
    2: "Знімний диск",
    3: "Локальний диск",
    4: "Мережевий диск",
    5: "Оптичний диск",
}

TRASH_SCRIPT = (
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
    "$ns=(New-Object -ComObject Shell.Application).Namespace(10);"
    "$items=@($ns.Items()|ForEach-Object{[PSCustomObject]@{name=$_.Name;"
    "origin=$ns.GetDetailsOf($_,1);deleted=$ns.GetDetailsOf($_,2);type=$_.Type;"
    "folder=[bool]$_.IsFolder;size=[int64]$_.Size;path=$_.Path;"
    "modified=([DateTimeOffset]$_.ModifyDate).ToUnixTimeSeconds()}});"
    "ConvertTo-Json -InputObject $items -Compress"
)

DEVICES_SCRIPT = (
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
    "$ns=(New-Object -ComObject Shell.Application).Namespace(17);"
    "$items=@($ns.Items()|Where-Object{-not $_.IsFileSystem -and $_.Path -notmatch '^[A-Za-z]:'}"
    "|ForEach-Object{$c=0;try{$c=@($_.GetFolder.Items()).Count}catch{};"
    "[PSCustomObject]@{name=$_.Name;path=$_.Path;active=($c -gt 0)}});"
    "ConvertTo-Json -InputObject $items -Compress"
)
PORTABLE_TTL = 3
_portable_lock = threading.Lock()
_portable_cache = {"t": -1e9, "items": []}

MTP_SEP = "\x01"
MTP_SCRIPT = (
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
    "$step='start';"
    "try{"
    "$sh=New-Object -ComObject Shell.Application;"
    "$dev=$env:CONSOLIO_DEV;"
    "$names=@(($env:CONSOLIO_NAMES -split [string][char]1)|Where-Object{$_});"
    "$step='find';"
    "$item=$null;$cand=@();"
    "foreach($i in $sh.Namespace(17).Items()){"
    "if($i.Path -eq $dev){$item=$i;break};"
    "if((-not $i.IsFileSystem) -and ($i.Path -notmatch '^[A-Za-z]:')){$cand+=$i}};"
    "if($null -eq $item -and $cand.Count -eq 1){$item=$cand[0]};"
    "if($null -eq $item){throw 'device not found'};"
    "$devname=$item.Name;"
    "$step='open';"
    "$folder=$item.GetFolder;"
    "if($null -eq $folder){throw 'GetFolder returned null'};"
    "foreach($n in $names){"
    "$step='cd '+$n;$next=$null;"
    "foreach($c in $folder.Items()){if($c.IsFolder){$cn=$null;try{$cn=$c.ExtendedProperty('System.FileName')}catch{};if(($c.Name -eq $n) -or ($cn -eq $n)){$next=$c;break}}};"
    "if($null -eq $next){throw 'folder not found'};$folder=$next.GetFolder};"
    "$step='list';"
    "$items=@();"
    "foreach($f in $folder.Items()){$m=$null;"
    "try{$m=([DateTimeOffset]$f.ModifyDate).ToUnixTimeSeconds()}catch{};"
    "if(($null -eq $m) -or ($m -le 0)){try{$m=([DateTimeOffset][DateTime]$f.ExtendedProperty('System.DateModified')).ToUnixTimeSeconds()}catch{}};"
    "$sz=[int64]0;"
    "if(-not $f.IsFolder){$sz=[int64]-1;try{$v=$f.ExtendedProperty('System.Size');if($null -ne $v){$sz=[int64]$v}}catch{};"
    "if($sz -lt 0){try{$sz=[int64]$f.Size}catch{$sz=0}}};"
    "$nm=$null;try{$nm=$f.ExtendedProperty('System.FileName')}catch{};if(-not $nm){$nm=$f.Name};"
    "$items+=[PSCustomObject]@{name=[string]$nm;folder=[bool]$f.IsFolder;size=$sz;modified=$m}};"
    "ConvertTo-Json -InputObject ([PSCustomObject]@{device=$devname;items=$items}) -Compress -Depth 4"
    "}catch{ConvertTo-Json -InputObject ([PSCustomObject]@{error=($step+': '+$_.Exception.Message)}) -Compress}"
)

INVISIBLE = re.compile("[\u200e\u200f\u202a-\u202e]")

if IS_WIN:
    import ctypes
    import uuid
    from ctypes import wintypes

    shell32 = ctypes.WinDLL("shell32")
    ole32 = ctypes.WinDLL("ole32")
    kernel32 = ctypes.WinDLL("kernel32")

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    shell32.SHGetKnownFolderPath.argtypes = [
        ctypes.POINTER(GUID), wintypes.DWORD, wintypes.HANDLE,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    shell32.SHGetKnownFolderPath.restype = ctypes.c_long
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    kernel32.GetLogicalDrives.restype = wintypes.DWORD
    kernel32.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetDriveTypeW.restype = wintypes.UINT
    kernel32.GetVolumeInformationW.argtypes = [
        wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        wintypes.LPWSTR, wintypes.DWORD,
    ]
    kernel32.GetVolumeInformationW.restype = wintypes.BOOL
    kernel32.SetErrorMode(1)


def _known_folder(guid_text):
    try:
        u = uuid.UUID(guid_text)
        g = GUID()
        g.Data1 = u.time_low
        g.Data2 = u.time_mid
        g.Data3 = u.time_hi_version
        g.Data4 = (ctypes.c_ubyte * 8)(
            u.clock_seq_hi_variant, u.clock_seq_low, *u.node.to_bytes(6, "big")
        )
        ptr = ctypes.c_void_p()
        hr = shell32.SHGetKnownFolderPath(ctypes.byref(g), 0, None, ctypes.byref(ptr))
        path = ctypes.wstring_at(ptr.value) if hr == 0 and ptr.value else None
        if ptr.value:
            ole32.CoTaskMemFree(ptr)
        return path
    except Exception:
        return None


def folder_path(key):
    guid_text, name = KNOWN_FOLDERS[key]
    path = _known_folder(guid_text) if IS_WIN else None
    if path and os.path.isdir(path):
        return path
    path = os.path.join(HOME, name)
    return path if os.path.isdir(path) else HOME


def _is_hidden(entry):
    if entry.name.startswith("."):
        return True
    if IS_WIN:
        try:
            return bool(entry.stat().st_file_attributes & 0x6)
        except (OSError, AttributeError):
            return False
    return False


def _scan(path):
    items = []
    with os.scandir(path) as it:
        for entry in it:
            try:
                if _is_hidden(entry):
                    continue
                is_dir = entry.is_dir()
                st = entry.stat()
            except OSError:
                continue
            items.append({
                "name": entry.name,
                "path": entry.path,
                "kind": "folder" if is_dir else "file",
                "ext": "" if is_dir else os.path.splitext(entry.name)[1][1:].lower(),
                "size": None if is_dir else st.st_size,
                "modified": st.st_mtime,
            })
    items.sort(key=lambda i: (i["kind"] != "folder", i["name"].casefold()))
    return items[:LIMIT], len(items)


def _count_dir(path):
    folders = files = 0
    with os.scandir(path) as it:
        for entry in it:
            try:
                if _is_hidden(entry):
                    continue
                if entry.is_dir():
                    folders += 1
                else:
                    files += 1
            except OSError:
                continue
    return {"folders": folders, "files": files}


def _drive_item(name, dtype, root, removable):
    try:
        usage = shutil.disk_usage(root)
        total, free = usage.total, usage.free
    except OSError:
        total = free = None
    return {
        "name": name,
        "path": root,
        "kind": "drive",
        "dtype": dtype,
        "removable": removable,
        "active": True,
        "size": total,
        "free": free,
        "modified": None,
    }


def _drives(removable_only):
    result = []
    if IS_WIN:
        mask = kernel32.GetLogicalDrives()
        for i in range(26):
            if not (mask >> i) & 1:
                continue
            letter = chr(65 + i)
            root = f"{letter}:\\"
            kind = kernel32.GetDriveTypeW(root)
            if kind not in DRIVE_NAMES:
                continue
            if removable_only and kind != 2:
                continue
            if not removable_only and kind == 2:
                continue
            label = ctypes.create_unicode_buffer(261)
            kernel32.GetVolumeInformationW(root, label, 261, None, None, None, None, 0)
            default = DRIVE_NAMES[kind]
            result.append(_drive_item(
                f"{label.value or default} ({letter}:)", default, root, kind == 2
            ))
        return result

    if not removable_only:
        return [_drive_item("/", DRIVE_NAMES[3], "/", False)]
    user = os.environ.get("USER", "")
    for base in (f"/media/{user}", f"/run/media/{user}", "/Volumes"):
        if os.path.isdir(base):
            for name in sorted(os.listdir(base)):
                full = os.path.join(base, name)
                if os.path.ismount(full):
                    result.append(_drive_item(name, DRIVE_NAMES[2], full, True))
    return result


def _portable():
    if not IS_WIN:
        return []
    with _portable_lock:
        if time.monotonic() - _portable_cache["t"] < PORTABLE_TTL:
            return _portable_cache["items"]
        items = _portable_cache["items"]
        try:
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", DEVICES_SCRIPT],
                capture_output=True,
                timeout=15,
                creationflags=0x08000000,
            )
            text = proc.stdout.decode("utf-8", "replace").lstrip("\ufeff").strip()
            raw = json.loads(text) if text else []
            if isinstance(raw, dict):
                raw = [raw]
            items = [{
                "name": INVISIBLE.sub("", r.get("name") or "").strip(),
                "path": r.get("path") or "",
                "kind": "device",
                "dtype": "Телефон",
                "active": bool(r.get("active")),
                "removable": True,
                "size": None,
                "free": None,
                "modified": None,
            } for r in raw if r.get("path")]
        except Exception:
            pass
        _portable_cache["items"] = items
        _portable_cache["t"] = time.monotonic()
        return items


def invalidate_portable():
    _portable_cache["t"] = -1e9


def is_portable(path):
    return any(d["path"] == path for d in _portable())


def _removable_all():
    return _drives(True) + _portable()


def _trash():
    if IS_WIN:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", TRASH_SCRIPT],
            capture_output=True,
            timeout=25,
            creationflags=0x08000000,
        )
        text = proc.stdout.decode("utf-8", "replace").lstrip("\ufeff").strip()
        raw = json.loads(text) if text else []
        items = [{
            "name": r["name"],
            "kind": "folder" if r["folder"] else "file",
            "ext": "" if r["folder"] else os.path.splitext(r["name"])[1][1:].lower(),
            "size": r["size"],
            "modified": r["modified"],
            "origin": INVISIBLE.sub("", r.get("origin") or "").strip(),
            "deleted": INVISIBLE.sub("", r.get("deleted") or "").strip(),
            "ttype": (r.get("type") or "").strip(),
            "tpath": r.get("path") or "",
        } for r in raw]
        items.sort(key=lambda i: (i["kind"] != "folder", i["name"].casefold()))
        return items[:LIMIT], len(items)
    for path in (
        os.path.join(HOME, ".local", "share", "Trash", "files"),
        os.path.join(HOME, ".Trash"),
    ):
        if os.path.isdir(path):
            return _scan(path)
    return [], 0


def _result(address, path, items, total):
    return {
        "address": address,
        "path": path,
        "items": items,
        "total": total,
        "truncated": total > LIMIT,
    }


def listing(key):
    path = None
    try:
        if key in KNOWN_FOLDERS:
            path = folder_path(key)
            items, total = _scan(path)
            return _result(path, path, items, total)
        if key == "quick":
            return _result(VIRTUAL_TITLES[key], None, [], 0)
        if key == "pc":
            items = _drives(False)
            return _result(VIRTUAL_TITLES[key], None, items, len(items))
        if key == "removable":
            items = _removable_all()
            return _result(VIRTUAL_TITLES[key], None, items, len(items))
        if key == "trash":
            items, total = _trash()
            return _result(VIRTUAL_TITLES[key], None, items, total)
    except Exception as e:
        result = _result(VIRTUAL_TITLES.get(key, path or ""), path, [], 0)
        result["error"] = str(e)
        return result
    result = _result("", None, [], 0)
    result["error"] = "Невідоме місце"
    return result


def is_mtp(path):
    return isinstance(path, str) and path.startswith("::")


def mtp_listing(path):
    parts = path.split(MTP_SEP)
    dev, names = parts[0], [n for n in parts[1:] if n]
    fail = lambda msg, addr="": dict(_result(addr, path, [], 0), error=msg)
    if not IS_WIN:
        return fail("Підтримується лише у Windows")
    try:
        env = dict(os.environ, CONSOLIO_DEV=dev, CONSOLIO_NAMES=MTP_SEP.join(names))
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", MTP_SCRIPT],
            capture_output=True, timeout=60, creationflags=0x08000000, env=env,
        )
        text = proc.stdout.decode("utf-8", "replace").lstrip("\ufeff").strip()
        data = json.loads(text) if text else {}
    except Exception as e:
        return fail(str(e))
    if data.get("error"):
        return fail(
            "Пристрій недоступний. Увімкніть передачу даних і розблокуйте телефон"
            f" [{data['error']}]"
        )
    devname = INVISIBLE.sub("", data.get("device") or "").strip()
    address = "\\".join([devname] + names)
    raw = data.get("items") or []
    if isinstance(raw, dict):
        raw = [raw]
    items = []
    for r in raw:
        name = INVISIBLE.sub("", r.get("name") or "").strip()
        if not name or name.startswith("."):
            continue
        is_dir = bool(r.get("folder"))
        modified = r.get("modified")
        items.append({
            "name": name,
            "path": path + MTP_SEP + name,
            "kind": "folder" if is_dir else "file",
            "ext": "" if is_dir else os.path.splitext(name)[1][1:].lower(),
            "size": None if is_dir or not isinstance(r.get("size"), (int, float)) or r.get("size") < 0 else r.get("size"),
            "modified": modified if isinstance(modified, (int, float)) and modified > 0 else None,
        })
    items.sort(key=lambda i: (i["kind"] != "folder", i["name"].casefold()))
    return _result(address, path, items[:LIMIT], len(items))


def listing_path(path):
    if is_mtp(path):
        return mtp_listing(path)
    path = os.path.abspath(path)
    try:
        items, total = _scan(path)
        return _result(path, path, items, total)
    except Exception as e:
        result = _result(path, path, [], 0)
        result["error"] = str(e)
        return result


def quick_listing(paths):
    items = []
    for path in paths:
        try:
            st = os.stat(path)
        except OSError:
            continue
        is_dir = os.path.isdir(path)
        name = os.path.basename(path.rstrip("\\/")) or path
        items.append({
            "name": name,
            "path": path,
            "kind": "folder" if is_dir else "file",
            "ext": "" if is_dir else os.path.splitext(name)[1][1:].lower(),
            "size": None if is_dir else st.st_size,
            "modified": st.st_mtime,
        })
    return _result(VIRTUAL_TITLES["quick"], None, items, len(items))


def removable_devices():
    try:
        return [
            {"name": d["name"], "path": d["path"], "active": d.get("active", True)}
            for d in _removable_all()
        ]
    except Exception:
        return []


def folder_size(path, cancelled=None):
    if is_mtp(path):
        return None
    total = 0
    stack = [path]
    while stack:
        if cancelled and cancelled():
            return None
        try:
            with os.scandir(stack.pop()) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            continue
                        st = entry.stat(follow_symlinks=False)
                        if IS_WIN and st.st_file_attributes & 0x400:
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        else:
                            total += st.st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def parent_of(path):
    if is_mtp(path):
        return path.rsplit(MTP_SEP, 1)[0] if MTP_SEP in path else None
    current = os.path.abspath(path)
    up = os.path.dirname(current)
    return None if up == current else up


def count(key):
    try:
        if key in KNOWN_FOLDERS:
            return _count_dir(folder_path(key))
        if key == "pc":
            return {"drives": len(_drives(False))}
        if key == "removable":
            return {"devices": len(_removable_all())}
        if key == "trash":
            items, _ = _trash()
            folders = sum(1 for i in items if i["kind"] == "folder")
            return {"folders": folders, "files": len(items) - folders}
    except Exception:
        return {}
    return {}
