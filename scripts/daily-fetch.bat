@echo off
setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir logs
echo [%date% %time%] Running RapidAPI job fetch...
node fetch-jobs.mjs >> logs\fetch.log 2>&1
echo [%date% %time%] Done. Check logs\fetch.log for results.
