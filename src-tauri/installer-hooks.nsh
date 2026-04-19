; EmailAgent installer cleanup hooks.
; Intentionally aggressive: remove previous install artifacts and app-local state
; so upgrades behave like clean-machine installs.

!macro _EA_CLEAN_PATH target
  ClearErrors
  RMDir /r "${target}"
!macroend

!macro _EA_KILL_RUNNING
  nsExec::ExecToLog 'taskkill /F /T /IM "EmailAgent Desktop.exe"'
!macroend

!macro _EA_CLEAN_USER_STATE
  !insertmacro _EA_CLEAN_PATH "$LOCALAPPDATA\com.emailagent.desktop"
  !insertmacro _EA_CLEAN_PATH "$APPDATA\com.emailagent.desktop"
  !insertmacro _EA_CLEAN_PATH "$LOCALAPPDATA\EmailAgent Desktop"
  !insertmacro _EA_CLEAN_PATH "$APPDATA\EmailAgent Desktop"
  !insertmacro _EA_CLEAN_PATH "$TEMP\emailagent-desktop"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _EA_KILL_RUNNING
  !insertmacro _EA_CLEAN_PATH "$INSTDIR"
  !insertmacro _EA_CLEAN_USER_STATE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _EA_KILL_RUNNING
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro _EA_CLEAN_PATH "$INSTDIR"
  !insertmacro _EA_CLEAN_USER_STATE
!macroend
