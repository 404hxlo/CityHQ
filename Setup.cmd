@echo off
title CityHQ setup
rem Sets up a QBCore FiveM server and the CityHQ app in one folder on this PC.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Install-Server.ps1" %*
echo.
pause
