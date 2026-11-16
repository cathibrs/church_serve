@echo off
rem Gera ..\EscalaIgreja.exe
rem 1) compila a interface (web\ -> static\) se o Node estiver instalado
rem 2) empacota o servidor Python + static\ com PyInstaller
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel%==0 (
  pushd web
  if not exist node_modules ( call npm install || goto :erro )
  node node_modules\typescript\bin\tsc --noEmit -p . || goto :erro
  node node_modules\vite\bin\vite.js build || goto :erro
  popd
) else (
  echo Node nao encontrado: usando a interface ja compilada em static\
)

set PY=py -3.12
%PY% --version >nul 2>&1 || set PY=python

if not exist .venv-build (
  %PY% -m venv .venv-build || goto :erro
)
call .venv-build\Scripts\activate.bat
python -m pip install --quiet --upgrade pip pyinstaller || goto :erro

python -m unittest discover -s tests -q || goto :erro

rem copia do banco e da planilha atuais, embutida no exe (o exe funciona sozinho)
if exist seed_build rmdir /s /q seed_build
mkdir seed_build
python -c "import sqlite3,sys;s=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()" "%~dp0..\data\igreja_escala.db" "%~dp0seed_build\igreja_escala.db" || goto :erro
copy /y "%~dp0..\POSICIONAMENTO E TAREFAS.xlsx" seed_build\ >nul || goto :erro

pyinstaller --noconfirm --clean --onefile --windowed ^
  --name EscalaIgreja ^
  --icon "%~dp0web\public\logo.ico" ^
  --add-data "%~dp0static;static" ^
  --add-data "%~dp0seed_build;seed" ^
  --exclude-module tkinter --exclude-module unittest --exclude-module pydoc ^
  --exclude-module lib2to3 --exclude-module distutils --exclude-module asyncio ^
  --distpath dist --workpath build --specpath build ^
  main.py || goto :erro

rem troca o exe (se o programa estiver aberto, feche-o antes)
copy /y dist\EscalaIgreja.exe ..\EscalaIgreja.exe >nul || (
  echo O EscalaIgreja.exe esta aberto. Feche o programa e rode build.bat de novo.
  goto :erro
)
rmdir /s /q build dist seed_build

echo.
echo Pronto: ..\EscalaIgreja.exe
exit /b 0

:erro
echo Falhou.
exit /b 1
