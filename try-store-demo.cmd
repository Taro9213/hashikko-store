@echo off
rem Try the whole Hashikko Store flow on this computer (share -> review -> in the store).
rem Double-click this file. To stop, double-click end-store-demo.cmd.
cd /d "%~dp0"
echo Starting the Hashikko Store demo...
taskkill /F /IM HashikkoPlayer.exe >nul 2>&1
timeout /t 1 /nobreak >nul
start "Hashikko Store demo" node tools\review-demo.mjs
timeout /t 3 /nobreak >nul
set HASHIKKO_DEBUG=1
set HASHIKKO_STORE_URL=http://127.0.0.1:4322/
set HASHIKKO_STORE_REPO=demo/hashikko-store
set HASHIKKO_SUBMIT_URL=http://127.0.0.1:4330/
start "" "%~dp0..\hashikko-win\build\HashikkoPlayer.exe"
start "" http://127.0.0.1:4330/desk
start "" http://127.0.0.1:4322/web/
echo.
echo Hashikko is now connected to the demo store.
echo Review desk:   http://127.0.0.1:4330/desk
echo Store website: http://127.0.0.1:4322/web/
timeout /t 8 >nul
