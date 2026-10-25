@echo off
setlocal
set "ROOT=%~dp0"
set "BASE=%ROOT%.."
if exist "%BASE%\.rustup" set "RUSTUP_HOME=%BASE%\.rustup"
if exist "%BASE%\.cargo" set "CARGO_HOME=%BASE%\.cargo"
if defined CARGO_HOME set "PATH=%CARGO_HOME%\bin;%PATH%"
set "VSWHERE=C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%I"
)
if defined VSINSTALL if exist "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%ROOT%"
call npx tauri build --no-bundle
if errorlevel 1 exit /b %errorlevel%
echo BUILD_OK
exit /b 0
