$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

python -m pip install --user pyinstaller soxr numpy PySide6
$extra = @(
  "--exclude-module", "tkinter",
  "--exclude-module", "PySide6.QtQml",
  "--exclude-module", "PySide6.QtQuick",
  "--exclude-module", "PySide6.QtQuickWidgets",
  "--exclude-module", "PySide6.QtNetwork",
  "--exclude-module", "PySide6.QtSql",
  "--exclude-module", "PySide6.QtSvg",
  "--exclude-module", "PySide6.QtPdf",
  "--exclude-module", "PySide6.QtOpenGL",
  "--exclude-module", "PySide6.QtDBus",
  "--exclude-module", "PySide6.QtTest"
)
if (Test-Path "ffmpeg\LICENSE.txt") {
  $extra += "--add-data"
  $extra += "ffmpeg\LICENSE.txt;."
}
python -m PyInstaller --noconfirm --onefile --windowed --name SpartanLive --icon "..\assets\Spartan-Live.ico" --add-data "..\assets\Spartan-Live.ico;." --add-data "..\assets\Spartan-Live-ON.ico;." --add-data "..\assets\aguardando-nova-tela.jpg;." --add-binary "ffmpeg\ffmpeg.exe;." --add-data "publish.json;." @extra --collect-all pyaudiowpatch --collect-all soxr --distpath dist --workpath build spartan_live.py
python stamp_icon.py "dist\SpartanLive.exe" "..\assets\Spartan-Live.ico"

Write-Host "Pronto: dist\SpartanLive.exe"
