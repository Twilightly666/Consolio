import os
import platform
import shutil
import stat
import threading
import zipfile
import itertools
import time
from urllib.parse import quote

IS_WIN = platform.system() == "Windows"

PROGRESS = {"active": False, "done": 0, "total": 0, "name": ""}
CHUNK = 1 << 20
_cid = itertools.count(1)
_conflict = {"state": None, "sticky": None}


def ask_conflict(name, is_dir):
    if _conflict["sticky"]:
        return _conflict["sticky"]
    ev = threading.Event()
    st = {"id": "p%d" % next(_cid), "name": name, "dir": bool(is_dir), "event": ev, "answer": "cancel"}
    _conflict["state"] = st
    try:
        ev.wait(600)
    finally:
        _conflict["state"] = None
    return st["answer"]


def pending_conflict():
    st = _conflict["state"]
    if not st:
        return None
    return {"id": st["id"], "name": st["name"], "dir": st["dir"]}


def resolve(answer, apply_all=False):
    st = _conflict["state"]
    if st and answer in ("replace", "skip", "cancel"):
        st["answer"] = answer
        if apply_all and answer != "cancel":
            _conflict["sticky"] = answer
        st["event"].set()
        return True
    return False


def bad_name(name):
    if not name or not name.strip():
        return "Назва не може бути порожньою"
    if name in (".", ".."):
        return "Недопустима назва"
    if any(c in name for c in '<>:"/\\|?*') or any(ord(c) < 32 for c in name):
        return "Назва містить недопустимі символи"
    if name.endswith(".") or name.endswith(" "):
        return "Назва не може закінчуватися крапкою чи пропуском"
    return None


def rename(path, new_name):
    err = bad_name(new_name)
    if err:
        return None, err
    if not os.path.lexists(path):
        return None, "Елемент не знайдено"
    parent = os.path.dirname(path.rstrip("\\/"))
    target = os.path.join(parent, new_name)
    if _norm(target) != _norm(path) and os.path.lexists(target):
        return None, "Елемент з такою назвою вже існує"
    try:
        os.rename(path, target)
    except OSError as e:
        return None, str(e)
    return target, None

if IS_WIN:
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _pack_ = 8 if ctypes.sizeof(ctypes.c_void_p) == 8 else 1
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", ctypes.c_void_p),
            ("pTo", ctypes.c_void_p),
            ("fFlags", ctypes.c_ushort),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    _shell32 = ctypes.WinDLL("shell32")
    _shell32.SHFileOperationW.argtypes = [ctypes.POINTER(SHFILEOPSTRUCTW)]
    _shell32.SHFileOperationW.restype = ctypes.c_int

FO_DELETE = 0x3
FOF_SILENT = 0x4
FOF_NOCONFIRMATION = 0x10
FOF_ALLOWUNDO = 0x40
FOF_NOERRORUI = 0x400


def _name(path):
    return os.path.basename(path.rstrip("\\/")) or path


def _norm(path):
    return os.path.normcase(os.path.abspath(path))


def _unique(dest_dir, name, is_dir):
    target = os.path.join(dest_dir, name)
    if not os.path.exists(target):
        return target
    stem, ext = (name, "") if is_dir else os.path.splitext(name)
    n = 1
    while True:
        tag = " - копія" if n == 1 else f" - копія ({n})"
        target = os.path.join(dest_dir, f"{stem}{tag}{ext}")
        if not os.path.exists(target):
            return target
        n += 1


def _inside(folder, dest_dir):
    a = _norm(folder).rstrip("\\/")
    b = _norm(dest_dir)
    return b == a or b.startswith(a + os.sep)


def _size_of(path):
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            total = 0
            for root, _dirs, files in os.walk(path):
                for f in files:
                    try:
                        total += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass
            return total
        return os.path.getsize(path)
    except OSError:
        return 0


def _copy_file(src, dst, **_kw):
    with open(src, "rb") as fi, open(dst, "wb") as fo:
        while True:
            buf = fi.read(CHUNK)
            if not buf:
                break
            fo.write(buf)
            PROGRESS["done"] += len(buf)
    shutil.copystat(src, dst)
    return dst


def _copy(src, dst, is_dir):
    if is_dir:
        shutil.copytree(src, dst, copy_function=_copy_file)
    else:
        _copy_file(src, dst)


def _move(src, dst, is_dir):
    try:
        os.rename(src, dst)
        return
    except OSError:
        pass
    _copy(src, dst, is_dir)
    _remove(src)


def paste(paths, dest_dir, mode):
    if not os.path.isdir(dest_dir):
        return [], ["Папка призначення недоступна"], [], False
    PROGRESS.update(active=True, done=0, total=0, name="")
    _conflict["sticky"] = None
    try:
        PROGRESS["total"] = sum(_size_of(p) for p in paths if os.path.exists(p))
        return _paste(paths, dest_dir, mode)
    finally:
        PROGRESS["active"] = False
        _conflict["sticky"] = None


def _replace(src, dst, is_dir, mode):
    if os.path.lexists(dst):
        dst_is_dir = os.path.isdir(dst) and not os.path.islink(dst)
        if is_dir and dst_is_dir:
            shutil.copytree(src, dst, copy_function=_copy_file, dirs_exist_ok=True)
            if mode == "cut":
                _remove(src)
            return
        _remove(dst)
    if mode == "cut":
        _move(src, dst, is_dir)
    else:
        _copy(src, dst, is_dir)


def _paste(paths, dest_dir, mode):
    pairs, errors, replaced = [], [], []
    cancelled = False
    for src in paths:
        PROGRESS["name"] = _name(src)
        name = _name(src)
        try:
            if not os.path.exists(src):
                errors.append(f"{name}: не знайдено")
                continue
            is_dir = os.path.isdir(src)
            if is_dir and _inside(src, dest_dir):
                errors.append(f"{name}: не можна вставити в саму себе")
                continue
            same = _norm(os.path.dirname(src)) == _norm(dest_dir)
            if mode == "cut" and same:
                continue
            target = os.path.join(dest_dir, name)
            if not same and os.path.lexists(target):
                answer = ask_conflict(name, is_dir)
                if answer == "cancel":
                    cancelled = True
                    break
                if answer == "skip":
                    continue
                _replace(src, target, is_dir, mode)
                replaced.append(target)
                continue
            if mode == "cut":
                dst = _unique(dest_dir, name, is_dir)
                _move(src, dst, is_dir)
            else:
                dst = _unique(dest_dir, name, is_dir)
                _copy(src, dst, is_dir)
            pairs.append((src, dst))
        except (OSError, shutil.Error) as e:
            errors.append(f"{name}: {e}")
    return pairs, errors, replaced, cancelled


def _zip_file(zf, src, arc):
    info = zipfile.ZipInfo.from_file(src, arc)
    info.compress_type = zipfile.ZIP_DEFLATED
    with open(src, "rb") as fi, zf.open(info, "w", force_zip64=info.file_size >= (1 << 31)) as fo:
        while True:
            buf = fi.read(CHUNK)
            if not buf:
                break
            fo.write(buf)
            PROGRESS["done"] += len(buf)


def _zip_dir_entry(zf, src, arc):
    info = zipfile.ZipInfo.from_file(src, arc)
    zf.writestr(info, b"")


def _zip_tree(zf, root, skip):
    base = _name(root)
    _zip_dir_entry(zf, root, base)
    for cur, dirs, files in os.walk(root):
        rel = os.path.relpath(cur, root)
        prefix = base if rel == "." else base + "/" + rel.replace(os.sep, "/")
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(cur, d))]
        for d in dirs:
            _zip_dir_entry(zf, os.path.join(cur, d), prefix + "/" + d)
        for f in files:
            full = os.path.join(cur, f)
            if _norm(full) == skip or os.path.islink(full):
                continue
            PROGRESS["name"] = f
            _zip_file(zf, full, prefix + "/" + f)


def zip_items(paths, name=None):
    paths = [p for p in paths if os.path.lexists(p)]
    if not paths:
        return None, ["Елемент не знайдено"]
    first = paths[0]
    dest_dir = os.path.dirname(first.rstrip("\\/"))
    if not os.path.isdir(dest_dir):
        return None, ["Папка призначення недоступна"]
    if name:
        if not name.lower().endswith(".zip"):
            name += ".zip"
        err = bad_name(name)
        if err:
            return None, [err]
        target = os.path.join(dest_dir, name)
        if os.path.lexists(target):
            return None, ["Елемент з такою назвою вже існує"]
    else:
        base = _name(first)
        if not os.path.isdir(first):
            base = os.path.splitext(base)[0] or base
        target = _unique(dest_dir, base + ".zip", False)
    tmp = target + ".part"
    PROGRESS.update(active=True, done=0, total=sum(_size_of(p) for p in paths), name="")
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for src in paths:
                if os.path.isdir(src) and not os.path.islink(src):
                    _zip_tree(zf, src, _norm(tmp))
                else:
                    PROGRESS["name"] = _name(src)
                    _zip_file(zf, src, _name(src))
        os.replace(tmp, target)
        return target, []
    except (OSError, zipfile.BadZipFile, ValueError) as e:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return None, [f"{_name(first)}: {e}"]
    finally:
        PROGRESS["active"] = False


def _extract(zf, dest):
    root = os.path.realpath(dest)
    for info in zf.infolist():
        parts = [p for p in info.filename.replace("\\", "/").split("/") if p not in ("", ".")]
        if ".." in parts:
            raise ValueError("небезпечний шлях в архіві")
        target = os.path.realpath(os.path.join(dest, *parts)) if parts else root
        if target != root and not target.startswith(root + os.sep):
            raise ValueError("небезпечний шлях в архіві")
        if info.is_dir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        PROGRESS["name"] = os.path.basename(target)
        with zf.open(info) as fi, open(target, "wb") as fo:
            while True:
                buf = fi.read(CHUNK)
                if not buf:
                    break
                fo.write(buf)
                PROGRESS["done"] += len(buf)


def unzip_items(paths):
    created, errors = [], []
    archives = []
    for p in paths:
        name = _name(p)
        if not os.path.isfile(p):
            errors.append(f"{name}: не знайдено")
        elif not zipfile.is_zipfile(p):
            errors.append(f"{name}: не є ZIP-архівом")
        else:
            archives.append(p)
    total = 0
    for p in archives:
        try:
            with zipfile.ZipFile(p) as zf:
                total += sum(i.file_size for i in zf.infolist())
        except (OSError, zipfile.BadZipFile):
            pass
    PROGRESS.update(active=True, done=0, total=total, name="")
    try:
        for p in archives:
            name = _name(p)
            dest_dir = os.path.dirname(p.rstrip("\\/"))
            stem = os.path.splitext(name)[0] or name
            dest = _unique(dest_dir, stem, True)
            try:
                os.makedirs(dest)
                with zipfile.ZipFile(p) as zf:
                    _extract(zf, dest)
                created.append((p, dest))
            except (OSError, zipfile.BadZipFile, ValueError, RuntimeError, NotImplementedError) as e:
                errors.append(f"{name}: {e}")
                shutil.rmtree(dest, ignore_errors=True)
    finally:
        PROGRESS["active"] = False
    return created, errors


def undo(entry):
    restored, errors, count = [], [], 0
    for src, dst in entry["pairs"]:
        name = _name(dst)
        try:
            if not os.path.exists(dst):
                continue
            if entry["mode"] == "copy":
                if os.path.isdir(dst) and not os.path.islink(dst):
                    shutil.rmtree(dst)
                else:
                    os.remove(dst)
                count += 1
            else:
                if os.path.exists(src):
                    errors.append(f"{name}: початкове місце зайняте")
                    continue
                shutil.move(dst, src)
                restored.append(src)
                count += 1
        except (OSError, shutil.Error) as e:
            errors.append(f"{name}: {e}")
    return restored, errors, count


def _trash_win(paths):
    buf = ctypes.create_unicode_buffer("\0".join(os.path.abspath(p) for p in paths) + "\0\0")
    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = ctypes.addressof(buf)
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    code = _shell32.SHFileOperationW(ctypes.byref(op))
    if code != 0:
        return f"Не вдалося перемістити в смітник (код {code})"
    if op.fAnyOperationsAborted:
        return "Операцію перервано"
    return None


def _trash_posix(path):
    home = os.path.expanduser("~")
    name = _name(path)
    if platform.system() == "Darwin":
        folder = os.path.join(home, ".Trash")
        os.makedirs(folder, exist_ok=True)
        shutil.move(path, _unique(folder, name, os.path.isdir(path)))
        return
    base = os.path.join(home, ".local", "share", "Trash")
    files = os.path.join(base, "files")
    info = os.path.join(base, "info")
    os.makedirs(files, exist_ok=True)
    os.makedirs(info, exist_ok=True)
    target = _unique(files, name, os.path.isdir(path))
    with open(os.path.join(info, os.path.basename(target) + ".trashinfo"), "w", encoding="utf-8") as f:
        f.write(
            "[Trash Info]\n"
            f"Path={quote(os.path.abspath(path))}\n"
            f"DeletionDate={time.strftime('%Y-%m-%dT%H:%M:%S')}\n"
        )
    shutil.move(path, target)


def _rm_readonly(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _remove(path):
    if os.path.islink(path):
        try:
            os.unlink(path)
        except OSError:
            os.rmdir(path)
    elif os.path.isdir(path):
        shutil.rmtree(path, onerror=_rm_readonly)
    else:
        try:
            os.remove(path)
        except PermissionError:
            os.chmod(path, stat.S_IWRITE)
            os.remove(path)


def _purge_trash_meta(path):
    parent, base = os.path.split(path.rstrip("\\/"))
    try:
        if IS_WIN:
            if "$recycle.bin" in parent.lower() and base[:2].upper() == "$R":
                meta = os.path.join(parent, "$I" + base[2:])
                if os.path.lexists(meta):
                    _remove(meta)
        else:
            if parent.endswith(os.path.join("Trash", "files")):
                meta = os.path.join(os.path.dirname(parent), "info", base + ".trashinfo")
                if os.path.lexists(meta):
                    _remove(meta)
    except OSError:
        pass


def delete(paths, permanent):
    errors = []
    existing = []
    for p in paths:
        if os.path.lexists(p):
            existing.append(p)
        else:
            errors.append(f"{_name(p)}: не знайдено")
    if existing:
        if permanent:
            for p in existing:
                try:
                    _remove(p)
                    _purge_trash_meta(p)
                except (OSError, shutil.Error) as e:
                    errors.append(f"{_name(p)}: {e}")
        elif IS_WIN:
            err = _trash_win(existing)
            if err:
                errors.append(err)
        else:
            for p in existing:
                try:
                    _trash_posix(p)
                except (OSError, shutil.Error) as e:
                    errors.append(f"{_name(p)}: {e}")
    count = sum(1 for p in existing if not os.path.lexists(p))
    if count < len(existing) and not errors:
        errors.append("Не всі елементи вдалося видалити")
    return count, errors
