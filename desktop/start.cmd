@echo off
cd /d "%~dp0.."
node scripts\start-desktop.mjs
if errorlevel 1 pause
