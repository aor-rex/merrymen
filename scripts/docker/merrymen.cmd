@echo off
rem merrymen -- Docker-mode CLI shim (Windows launcher).
rem Routes to the PowerShell wrapper. ExecutionPolicy Bypass is scoped to this
rem single invocation, so a locked-down policy can never block it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0merrymen.ps1" %*
