import os

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = os.path.abspath(SPECPATH)
VENDOR = os.path.join(ROOT, "vendor")

if not os.path.isdir(os.path.join(VENDOR, "codemirror")):
    raise SystemExit(
        "Не знайдено vendor/codemirror поруч зі spec-файлом. "
        "Скопіюй теку vendor з проєкту (її підключає index.html)."
    )

datas = [
    (os.path.join(ROOT, "index.html"), "."),
    (os.path.join(ROOT, "style.css"), "."),
    (os.path.join(ROOT, "script.js"), "."),
    (VENDOR, "vendor"),
]
datas += collect_data_files("webview")

hiddenimports = [
    "webview.platforms.edgechromium",
    "webview.platforms.winforms",
]
hiddenimports += collect_submodules("clr_loader")

a = Analysis(
    [os.path.join(ROOT, "main.py")],
    pathex=[ROOT],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=[
        "tkinter", "matplotlib", "numpy", "scipy", "pandas",
        "PyQt5", "PyQt6", "PySide2", "PySide6", "qtpy", "gi", "cefpython3",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Consolio",
    console=False,
    icon=os.path.join(ROOT, "icon.ico"),
    upx=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    upx=False,
    name="Consolio",
)
