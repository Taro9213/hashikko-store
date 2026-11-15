@echo off
rem Stops the Hashikko Store demo and opens Hashikko normally again.
cd /d "%~dp0"
taskkill /F /IM HashikkoPlayer.exe >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Hashikko Store demo*" >nul 2>&1
timeout /t 1 /nobreak >nul
start "" "%~dp0..\hashikko-win\build\HashikkoPlayer.exe"
echo The demo has stopped. Hashikko is back to normal.
timeout /t 4 >nul
