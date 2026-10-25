; Inkstone NSIS hooks.
; Per-user layout requested for release: %LOCALAPPDATA%\Programs\Inkstone.
; Tauri's default InstallDir is %LOCALAPPDATA%\Inkstone, so rewrite it before
; files, registry values and shortcuts are created.
;
; File association is registered as an "Open with" candidate only:
;   - we write our own ProgID and OpenWithProgids entries
;   - we never write the default value of .md/.markdown
;   - uninstall removes only Inkstone-owned keys/values

!macro NSIS_HOOK_PREINSTALL
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Inkstone"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Inkstone.md" "" "Inkstone Markdown Document"
  WriteRegStr SHCTX "Software\Classes\Inkstone.md\DefaultIcon" "" "$\"$INSTDIR\Inkstone.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Inkstone.md\shell\open\command" "" "$\"$INSTDIR\Inkstone.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "Inkstone.md" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "Inkstone.md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\Inkstone.exe" "FriendlyAppName" "Inkstone"
  WriteRegStr SHCTX "Software\Classes\Applications\Inkstone.exe\shell\open\command" "" "$\"$INSTDIR\Inkstone.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\Applications\Inkstone.exe\SupportedTypes" ".md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\Inkstone.exe\SupportedTypes" ".markdown" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "Inkstone.md"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "Inkstone.md"
  DeleteRegKey SHCTX "Software\Classes\Inkstone.md"
  DeleteRegKey SHCTX "Software\Classes\Applications\Inkstone.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
