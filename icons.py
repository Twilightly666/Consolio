import base64
import ctypes
import io
import os
import platform
import threading
import uuid
from ctypes import wintypes

try:
    from PIL import Image
except ImportError:
    Image = None

IS_WIN = platform.system() == "Windows"
EXTS = {"exe", "lnk"}
CACHE_LIMIT = 800
MAX_SIDE = 64

_cache = {}
_lock = threading.Lock()

if IS_WIN:
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    ole32 = ctypes.WinDLL("ole32", use_last_error=True)

    SHGFI_ICON = 0x00000100
    SHGFI_LARGEICON = 0x00000000
    SHGFI_SYSICONINDEX = 0x00004000
    SHIL_EXTRALARGE = 2
    COINIT_APARTMENTTHREADED = 2
    IMAGELIST_GETICON = 10
    IUNKNOWN_RELEASE = 2

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_uint32),
            ("Data2", ctypes.c_uint16),
            ("Data3", ctypes.c_uint16),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    class SHFILEINFOW(ctypes.Structure):
        _fields_ = [
            ("hIcon", wintypes.HICON),
            ("iIcon", ctypes.c_int),
            ("dwAttributes", wintypes.DWORD),
            ("szDisplayName", wintypes.WCHAR * 260),
            ("szTypeName", wintypes.WCHAR * 80),
        ]

    class ICONINFO(ctypes.Structure):
        _fields_ = [
            ("fIcon", wintypes.BOOL),
            ("xHotspot", wintypes.DWORD),
            ("yHotspot", wintypes.DWORD),
            ("hbmMask", wintypes.HBITMAP),
            ("hbmColor", wintypes.HBITMAP),
        ]

    class BITMAP(ctypes.Structure):
        _fields_ = [
            ("bmType", wintypes.LONG),
            ("bmWidth", wintypes.LONG),
            ("bmHeight", wintypes.LONG),
            ("bmWidthBytes", wintypes.LONG),
            ("bmPlanes", wintypes.WORD),
            ("bmBitsPixel", wintypes.WORD),
            ("bmBits", ctypes.c_void_p),
        ]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    def _guid(text):
        u = uuid.UUID(text)
        return GUID(u.time_low, u.time_mid, u.time_hi_version, (ctypes.c_ubyte * 8)(*u.bytes[8:]))

    IID_IIMAGELIST = _guid("46EB5926-582E-4017-9FDF-E8998DAA0950")

    shell32.SHGetFileInfoW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(SHFILEINFOW), wintypes.UINT, wintypes.UINT,
    ]
    shell32.SHGetFileInfoW.restype = ctypes.c_size_t
    shell32.SHGetImageList.argtypes = [ctypes.c_int, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
    shell32.SHGetImageList.restype = ctypes.c_long
    user32.GetIconInfo.argtypes = [wintypes.HICON, ctypes.POINTER(ICONINFO)]
    user32.GetIconInfo.restype = wintypes.BOOL
    user32.DestroyIcon.argtypes = [wintypes.HICON]
    user32.DestroyIcon.restype = wintypes.BOOL
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.GetDC.restype = wintypes.HDC
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    user32.ReleaseDC.restype = ctypes.c_int
    gdi32.GetObjectW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p]
    gdi32.GetObjectW.restype = ctypes.c_int
    gdi32.GetDIBits.argtypes = [
        wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT,
    ]
    gdi32.GetDIBits.restype = ctypes.c_int
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteObject.restype = wintypes.BOOL
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoInitializeEx.restype = ctypes.c_long
    ole32.CoUninitialize.argtypes = []
    ole32.CoUninitialize.restype = None

    class _Com:
        def __enter__(self):
            self.ok = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED) >= 0
            return self

        def __exit__(self, *exc):
            if self.ok:
                ole32.CoUninitialize()
            return False

    def _list_icon(index, shil):
        ptr = ctypes.c_void_p()
        if shell32.SHGetImageList(shil, ctypes.byref(IID_IIMAGELIST), ctypes.byref(ptr)) < 0 or not ptr.value:
            return None
        vtbl = ctypes.cast(ptr.value, ctypes.POINTER(ctypes.c_void_p))[0]
        funcs = ctypes.cast(vtbl, ctypes.POINTER(ctypes.c_void_p))
        try:
            get_icon = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)
            )(funcs[IMAGELIST_GETICON])
            hicon = ctypes.c_void_p()
            if get_icon(ptr, index, 0, ctypes.byref(hicon)) < 0 or not hicon.value:
                return None
            return hicon.value
        finally:
            ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(funcs[IUNKNOWN_RELEASE])(ptr)

    def _icon_handle(path):
        info = SHFILEINFOW()
        if shell32.SHGetFileInfoW(path, 0, ctypes.byref(info), ctypes.sizeof(info), SHGFI_SYSICONINDEX):
            try:
                handle = _list_icon(info.iIcon, SHIL_EXTRALARGE)
            except Exception:
                handle = None
            if handle:
                return handle
        info = SHFILEINFOW()
        if shell32.SHGetFileInfoW(
            path, 0, ctypes.byref(info), ctypes.sizeof(info), SHGFI_ICON | SHGFI_LARGEICON
        ) and info.hIcon:
            return info.hIcon
        return None

    def _bits(hbm, w, h):
        header = BITMAPINFOHEADER()
        header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        header.biWidth = w
        header.biHeight = -h
        header.biPlanes = 1
        header.biBitCount = 32
        header.biCompression = 0
        buf = ctypes.create_string_buffer(w * h * 4)
        hdc = user32.GetDC(None)
        try:
            got = gdi32.GetDIBits(hdc, hbm, 0, h, buf, ctypes.byref(header), 0)
        finally:
            user32.ReleaseDC(None, hdc)
        if not got:
            raise OSError("GetDIBits failed")
        return buf.raw

    def _to_image(hicon):
        info = ICONINFO()
        if not user32.GetIconInfo(hicon, ctypes.byref(info)):
            return None
        try:
            if not info.hbmColor:
                return None
            bm = BITMAP()
            gdi32.GetObjectW(info.hbmColor, ctypes.sizeof(BITMAP), ctypes.byref(bm))
            w, h = bm.bmWidth, bm.bmHeight
            if w <= 0 or h <= 0 or w > 512 or h > 512:
                return None
            img = Image.frombuffer("RGBA", (w, h), _bits(info.hbmColor, w, h), "raw", "BGRA", 0, 1)
            if img.getchannel("A").getextrema()[1] == 0:
                if info.hbmMask:
                    mask = Image.frombuffer("RGBA", (w, h), _bits(info.hbmMask, w, h), "raw", "BGRA", 0, 1)
                    img.putalpha(mask.getchannel("R").point(lambda v: 255 - v))
                else:
                    img.putalpha(255)
            return img
        finally:
            if info.hbmColor:
                gdi32.DeleteObject(info.hbmColor)
            if info.hbmMask:
                gdi32.DeleteObject(info.hbmMask)


def app_icon(path):
    if not IS_WIN or Image is None:
        return {"error": "Іконка недоступна"}
    if os.path.splitext(path)[1][1:].lower() not in EXTS:
        return {"error": "Іконка недоступна"}
    try:
        mtime = os.stat(path).st_mtime
    except OSError as e:
        return {"error": str(e)}
    key = os.path.normcase(os.path.abspath(path))
    with _lock:
        hit = _cache.get(key)
    if hit and hit[0] == mtime:
        return {"url": hit[1]}
    try:
        with _Com():
            hicon = _icon_handle(path)
            if not hicon:
                return {"error": "Іконка недоступна"}
            try:
                img = _to_image(hicon)
            finally:
                user32.DestroyIcon(hicon)
        if img is None:
            return {"error": "Іконка недоступна"}
        if max(img.size) > MAX_SIDE:
            img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "PNG")
    except Exception as e:
        return {"error": str(e)}
    url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    with _lock:
        _cache[key] = (mtime, url)
        while len(_cache) > CACHE_LIMIT:
            _cache.pop(next(iter(_cache)))
    return {"url": url}
