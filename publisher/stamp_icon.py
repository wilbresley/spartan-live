"""Grava o ícone do projeto no .exe, em todo tamanho e em todo idioma que o Windows consulta."""

import ctypes
import shutil
import struct
import sys
from ctypes import wintypes
from pathlib import Path

from PIL import Image
from PyInstaller.utils.win32.icon import RT_GROUP_ICON, RT_ICON, IconFile

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

kernel32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
kernel32.LoadLibraryExW.restype = wintypes.HMODULE
kernel32.FreeLibrary.argtypes = [wintypes.HMODULE]
kernel32.FreeLibrary.restype = wintypes.BOOL
kernel32.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
kernel32.BeginUpdateResourceW.restype = wintypes.HANDLE
kernel32.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
kernel32.EndUpdateResourceW.restype = wintypes.BOOL
kernel32.UpdateResourceW.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.c_void_p,
    wintypes.WORD,
    ctypes.c_void_p,
    wintypes.DWORD,
]
kernel32.UpdateResourceW.restype = wintypes.BOOL

NAMEPROC = ctypes.WINFUNCTYPE(
    wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ssize_t
)
LANGPROC = ctypes.WINFUNCTYPE(
    wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, ctypes.c_ssize_t
)
kernel32.EnumResourceNamesW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, NAMEPROC, ctypes.c_ssize_t]
kernel32.EnumResourceNamesW.restype = wintypes.BOOL
kernel32.EnumResourceLanguagesW.argtypes = [
    wintypes.HMODULE,
    ctypes.c_void_p,
    ctypes.c_void_p,
    LANGPROC,
    ctypes.c_ssize_t,
]
kernel32.EnumResourceLanguagesW.restype = wintypes.BOOL

# Neutro, inglês (EUA) e português (Brasil). O Explorer pede um desses conforme o tamanho da vista.
LANGS = (0, 0x0409, 0x0416)
LOAD_AS_DATAFILE = 0x00000002
ERROR_RESOURCE_TYPE_NOT_FOUND = 1813
COOKIE_MAGIC = b"MEI\014\013\012\013\016"
COOKIE_FORMAT = "!8sIIII64s"
COOKIE_LENGTH = struct.calcsize(COOKIE_FORMAT)


def win_error(action):
    code = ctypes.get_last_error()
    return OSError(code, f"{action} falhou (erro {code})")


def resource_ids(path, restype):
    module = kernel32.LoadLibraryExW(str(path), None, LOAD_AS_DATAFILE)
    if not module:
        raise win_error("LoadLibraryEx")
    found = []

    def on_lang(_module, _restype, name, lang, _param):
        found.append((restype, ctypes.cast(name, ctypes.c_void_p).value, lang))
        return True

    def on_name(_module, _restype, name, _param):
        kernel32.EnumResourceLanguagesW(
            module, restype, ctypes.cast(name, ctypes.c_void_p).value, lang_cb, 0
        )
        return True

    name_cb = NAMEPROC(on_name)
    lang_cb = LANGPROC(on_lang)
    ok = kernel32.EnumResourceNamesW(module, restype, name_cb, 0)
    err = ctypes.get_last_error()
    kernel32.FreeLibrary(module)
    if not ok and err not in (0, ERROR_RESOURCE_TYPE_NOT_FOUND):
        raise OSError(err, f"EnumResourceNames falhou (erro {err})")
    return found


def update_resource(handle, restype, name, lang, data):
    if data is None:
        ok = kernel32.UpdateResourceW(handle, restype, name, lang, None, 0)
    else:
        buf = ctypes.create_string_buffer(data)
        ok = kernel32.UpdateResourceW(handle, restype, name, lang, buf, len(data))
    if not ok:
        raise win_error(f"UpdateResource type={restype} id={name} lang={lang}")


def pe_data_end(data):
    if len(data) < 64 or data[:2] != b"MZ":
        raise RuntimeError("O arquivo não é um executável.")
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew : e_lfanew + 4] != b"PE\0\0":
        raise RuntimeError("O arquivo não é um executável.")
    coff = e_lfanew + 4
    sections = struct.unpack_from("<H", data, coff + 2)[0]
    optional = struct.unpack_from("<H", data, coff + 16)[0]
    offset = coff + 20 + optional
    end = 0
    for index in range(sections):
        entry = offset + index * 40
        raw_size, raw_ptr = struct.unpack_from("<II", data, entry + 16)
        end = max(end, raw_ptr + raw_size)
    if end <= 0 or end > len(data):
        raise RuntimeError("Não consegui achar o fim do executável.")
    return end


def read_overlay(path):
    """O programa inteiro fica colado depois do executável. O Windows apaga isso ao trocar o ícone."""
    data = Path(path).read_bytes()
    overlay = data[pe_data_end(data) :]
    if len(overlay) < COOKIE_LENGTH or overlay[-COOKIE_LENGTH : -COOKIE_LENGTH + 8] != COOKIE_MAGIC:
        raise RuntimeError("O executável está sem o pacote do programa.")
    archive_length = struct.unpack_from("!I", overlay, len(overlay) - COOKIE_LENGTH + 8)[0]
    if archive_length != len(overlay):
        raise RuntimeError("O pacote embutido no executável está incompleto.")
    return overlay


def write_checksum(path):
    from PyInstaller.utils.win32.winutils import compute_exe_pe_checksum

    checksum = compute_exe_pe_checksum(str(path)) & 0xFFFFFFFF
    blob = bytearray(Path(path).read_bytes())
    e_lfanew = struct.unpack_from("<I", blob, 0x3C)[0]
    field = e_lfanew + 24 + 64
    blob[field : field + 4] = struct.pack("<I", checksum)
    Path(path).write_bytes(blob)


def stamp(exe, ico):
    overlay = read_overlay(exe)
    icon = IconFile(str(ico))
    group = icon.grp_icon_dir() + icon.grp_icondir_entries(1)
    existing = resource_ids(exe, RT_ICON) + resource_ids(exe, RT_GROUP_ICON)
    handle = kernel32.BeginUpdateResourceW(str(exe), False)
    if not handle:
        raise win_error("BeginUpdateResource")
    try:
        for restype, name, lang in existing:
            update_resource(handle, restype, name, lang, None)
        for lang in LANGS:
            icon_id = 1
            for image in icon.images:
                update_resource(handle, RT_ICON, icon_id, lang, image)
                icon_id += 1
            update_resource(handle, RT_GROUP_ICON, 1, lang, group)
    except Exception:
        kernel32.EndUpdateResourceW(handle, True)
        raise
    if not kernel32.EndUpdateResourceW(handle, False):
        raise win_error("EndUpdateResource")
    with open(exe, "ab") as handle:
        handle.write(overlay)
    write_checksum(exe)


class ICONINFO(ctypes.Structure):
    _fields_ = [
        ("fIcon", wintypes.BOOL),
        ("xHotspot", wintypes.DWORD),
        ("yHotspot", wintypes.DWORD),
        ("hbmMask", ctypes.c_void_p),
        ("hbmColor", ctypes.c_void_p),
    ]


class BITMAP(ctypes.Structure):
    _fields_ = [
        ("bmType", ctypes.c_long),
        ("bmWidth", ctypes.c_long),
        ("bmHeight", ctypes.c_long),
        ("bmWidthBytes", ctypes.c_long),
        ("bmPlanes", ctypes.c_ushort),
        ("bmBitsPixel", ctypes.c_ushort),
        ("bmBits", ctypes.c_void_p),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


user32.PrivateExtractIconsW.argtypes = [
    wintypes.LPCWSTR,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.POINTER(wintypes.HICON),
    ctypes.POINTER(wintypes.UINT),
    ctypes.c_uint,
    ctypes.c_uint,
]
user32.PrivateExtractIconsW.restype = ctypes.c_uint
user32.GetIconInfo.argtypes = [wintypes.HICON, ctypes.POINTER(ICONINFO)]
user32.DestroyIcon.argtypes = [wintypes.HICON]
user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
gdi32.GetObjectW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
gdi32.GetDIBits.argtypes = [
    wintypes.HDC,
    ctypes.c_void_p,
    wintypes.UINT,
    wintypes.UINT,
    ctypes.c_void_p,
    ctypes.c_void_p,
    wintypes.UINT,
]
gdi32.DeleteObject.argtypes = [ctypes.c_void_p]


def extract(path, size):
    icon = wintypes.HICON()
    count = user32.PrivateExtractIconsW(str(path), 0, size, size, ctypes.byref(icon), None, 1, 0)
    if count != 1 or not icon:
        raise win_error(f"PrivateExtractIcons {size}")
    info = ICONINFO()
    user32.GetIconInfo(icon, ctypes.byref(info))
    bmp = BITMAP()
    gdi32.GetObjectW(info.hbmColor, ctypes.sizeof(bmp), ctypes.byref(bmp))
    width, height = bmp.bmWidth, abs(bmp.bmHeight)
    header = BITMAPINFOHEADER()
    header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    header.biWidth = width
    header.biHeight = -height
    header.biPlanes = 1
    header.biBitCount = 32
    raw = ctypes.create_string_buffer(width * height * 4)
    dc = user32.GetDC(None)
    gdi32.GetDIBits(dc, info.hbmColor, 0, height, raw, ctypes.byref(header), 0)
    user32.ReleaseDC(None, dc)
    user32.DestroyIcon(icon)
    gdi32.DeleteObject(info.hbmMask)
    gdi32.DeleteObject(info.hbmColor)
    pixels = bytearray()
    blob = raw.raw
    for i in range(0, width * height * 4, 4):
        blue, green, red, alpha = blob[i : i + 4]
        pixels += bytes((red, green, blue, alpha or 255))
    return Image.frombytes("RGBA", (width, height), bytes(pixels))


def distance(left, right):
    a = left.convert("RGB")
    b = right.convert("RGB").resize(a.size)
    total = 0
    n = a.size[0] * a.size[1] * 3
    for p, q in zip(a.tobytes(), b.tobytes()):
        total += abs(p - q)
    return total / n


def notify_shell(exe):
    path = ctypes.create_unicode_buffer(str(exe))
    shell32.SHChangeNotify.argtypes = [wintypes.LONG, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p]
    shell32.SHChangeNotify(0x00002000, 0x0005 | 0x1000, ctypes.cast(path, ctypes.c_void_p), None)
    shell32.SHChangeNotify(0x08000000, 0x1000, None, None)


def main():
    if len(sys.argv) != 3:
        print("uso: stamp_icon.py SpartanLive.exe Spartan-Live.ico", file=sys.stderr)
        return 2
    exe = Path(sys.argv[1]).resolve()
    ico = Path(sys.argv[2]).resolve()
    if not exe.is_file() or not ico.is_file():
        print("Não achei o executável ou o ícone.", file=sys.stderr)
        return 1
    stamped = exe.with_suffix(".exe.stamp")
    if stamped.exists():
        stamped.unlink()
    shutil.copy2(exe, stamped)
    try:
        stamp(stamped, ico)
        from PyInstaller.archive.readers import CArchiveReader

        archive = CArchiveReader(str(stamped))
        if not archive.toc or stamped.stat().st_size < 20_000_000:
            raise RuntimeError("O executável ficou sem o programa.")
        print(f"pacote {stamped.stat().st_size} bytes, {len(archive.toc)} arquivos")
        import PyInstaller

        boot = Path(PyInstaller.__file__).parent / "bootloader" / "images" / "icon-windowed.ico"
        for size in (16, 24, 32, 48, 256):
            got = extract(stamped, size)
            want = extract(ico, size)
            gap = distance(got, want)
            other = distance(got, extract(boot, size)) if boot and boot.is_file() else 999
            print(f"{size}px projeto={gap:.1f} python={other:.1f}")
            if gap > 12 or gap >= other:
                raise RuntimeError(f"O tamanho {size}px não ficou com o ícone do projeto.")
        stamped.replace(exe)
    except Exception:
        if stamped.exists():
            stamped.unlink()
        raise
    notify_shell(exe)
    print(f"Ícone do projeto gravado em {exe.name}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(error, file=sys.stderr)
        if getattr(error, "winerror", None) == 32 or getattr(error, "errno", None) == 32:
            print("Feche o Spartan Live e rode o build de novo.", file=sys.stderr)
        raise SystemExit(1)
