$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

python -m pip install --user pyinstaller soxr numpy
$extra = @()
if (Test-Path "ffmpeg\LICENSE.txt") {
  $extra += "--add-data"
  $extra += "ffmpeg\LICENSE.txt;."
}
python -m PyInstaller --noconfirm --onefile --windowed --name SpartanLive --icon "..\assets\Spartan-Live.ico" --add-data "..\assets\Spartan-Live.ico;." --add-data "..\assets\Spartan-Live-ON.ico;." --add-binary "ffmpeg\ffmpeg.exe;." --add-data "publish.json;." @extra --collect-all pyaudiowpatch --collect-all soxr --distpath dist --workpath build spartan_live.py
python stamp_icon.py "dist\SpartanLive.exe" "..\assets\Spartan-Live.ico"

Write-Host "Pronto: dist\SpartanLive.exe"
