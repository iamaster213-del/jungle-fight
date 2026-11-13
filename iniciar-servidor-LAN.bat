@echo off
chcp 65001 >nul
title Jungle Fight - servidor LAN
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   No se encontro Node.js.
  echo   Instalalo desde https://nodejs.org ^(version LTS^) y vuelve a abrir este archivo.
  echo.
  pause
  exit /b
)
node server.js
pause
