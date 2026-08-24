@echo off
setlocal
cd /d "%~dp0"

echo Fermeture d'une eventuelle ancienne instance sur le port 5177...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5177" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
)

echo Demarrage de Chess Coach sur http://localhost:5177 ...
echo.
echo Pour l'ouvrir depuis ton iPhone (sur le meme Wi-Fi que ce PC) :
for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match 'Wi-Fi' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress)"') do (
  echo   http://%%a:5177
)
echo.
start "" http://localhost:5177
npx --yes serve -l 5177 .
