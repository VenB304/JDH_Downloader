@echo off
set /p CODENAME="Enter codename: "
if "%CODENAME%"=="" (
    echo No codename entered. Exiting.
    pause
    exit /b 1
)
node "%~dp0fetch.mjs" %CODENAME%
TIMEOUT 5
