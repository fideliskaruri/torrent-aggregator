@echo off
rem Double-click to build and install TorrentFlow. Same as running .\install.ps1 (arguments are passed through).
rem install.ps1 keeps the window open at the end when it was started from Explorer.
setlocal
set TORRENTFLOW_INSTALL_CMD=1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
