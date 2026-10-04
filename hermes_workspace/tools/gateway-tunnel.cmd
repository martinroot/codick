@echo off
REM Постоянный SSH-туннель Windows -> VPS для внешнего шлюза Hermes.
REM
REM Два порта, потому что приложение HermesWorkspace говорит с шлюзом ДВУМЯ
REM разными протоколами, и на сервере это два разных процесса:
REM   19122 -> VPS 127.0.0.1:9122  hermes serve      (WS /api/ws — разговор, исполнение, апрувы)
REM   18642 -> VPS 127.0.0.1:8642  api_server        (/v1/capabilities — проверка шлюза в UI)
REM
REM Loopback на сервере — наружу ничего не открываем, доступ только через туннель.
REM Путь к ключу и адрес — в переменных ниже, чтобы не искать их по файлам.

setlocal
set "VPS_HOST=169.58.162.156"
set "VPS_USER=radar"
set "SSH_KEY=%USERPROFILE%\.ssh\id_ed25519"
set "SERVE_LOCAL=19122"
set "API_LOCAL=18642"
REM Третья нога: api_server ПРОФИЛЯ radar (8643). Без него приложение читало сессии
REM у профиля main (18642) и не видело переписку, которая идёт в radar.
set "RADAR_API_LOCAL=18643"

:loop
echo [%date% %time%] tunnel: %VPS_USER%@%VPS_HOST% %SERVE_LOCAL%->9122, %API_LOCAL%->8642, %RADAR_API_LOCAL%->8643
ssh -N ^
    -i "%SSH_KEY%" ^
    -o BatchMode=yes ^
    -o ExitOnForwardFailure=yes ^
    -o ServerAliveInterval=30 ^
    -o ServerAliveCountMax=3 ^
    -L %SERVE_LOCAL%:127.0.0.1:9122 ^
    -L %API_LOCAL%:127.0.0.1:8642 ^
    -L %RADAR_API_LOCAL%:127.0.0.1:8643 ^
    %VPS_USER%@%VPS_HOST%
echo [%date% %time%] ssh вернул код %ERRORLEVEL%, перезапуск через 5 с
timeout /t 5 /nobreak >nul
goto loop
