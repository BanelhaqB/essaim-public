@echo off
rem Lance le runner d'Essaim sur ce PC, à la demande. Double-clique pour l'activer ;
rem Ctrl+C ou ferme la fenêtre pour l'arrêter (les tâches en cours reprendront au prochain lancement).
title Essaim - runner
set "ENV_FILE=%USERPROFILE%\.essaim\runner.env"
if not exist "%ENV_FILE%" (
  echo Fichier introuvable : %ENV_FILE%
  pause
  exit /b 1
)
echo Runner Essaim actif. Ctrl+C pour l'arreter.
echo.
node --env-file="%ENV_FILE%" "%~dp0..\src\runner.mjs"
echo.
echo Runner arrete.
pause
