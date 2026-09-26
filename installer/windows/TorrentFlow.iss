; TorrentFlow per-user Windows installer (Inno Setup 6).
;
; Build:  iscc /DAppVersion=1.2.3 /DSourceExe=<path>\TorrentFlow.exe installer\windows\TorrentFlow.iss
; (scripts\publish-exe.ps1 -Version 1.2.3 -Installer does both steps.)
;
; Installs without admin to %LOCALAPPDATA%\Programs\TorrentFlow. App data lives separately in
; %LOCALAPPDATA%\TorrentFlow and is kept on uninstall unless the user asks to remove it.
; The in-app updater runs this setup with /SILENT /UPDATE=1 after the app has closed itself.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
; Windows version resources are numeric only (1.2.3-beta.1+abc1234 -> 1.2.3).
#ifndef AppNumericVersion
  #define AppNumericVersion AppVersion
  #if Pos("+", AppNumericVersion) > 0
    #define AppNumericVersion Copy(AppNumericVersion, 1, Pos("+", AppNumericVersion) - 1)
  #endif
  #if Pos("-", AppNumericVersion) > 0
    #define AppNumericVersion Copy(AppNumericVersion, 1, Pos("-", AppNumericVersion) - 1)
  #endif
#endif
#ifndef SourceExe
  #define SourceExe "..\..\artifacts\exe\TorrentFlow.exe"
#endif

#define AppName "TorrentFlow"
#define AppExe "TorrentFlow.exe"
#define RunKey "Software\Microsoft\Windows\CurrentVersion\Run"

[Setup]
AppId={{6F1B9E2A-4C57-4E8B-9D3A-7A2C5B1E0F42}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=TorrentFlow
AppPublisherURL=https://github.com/fideliskaruri/torrent-aggregator
AppSupportURL=https://github.com/fideliskaruri/torrent-aggregator/issues
AppUpdatesURL=https://github.com/fideliskaruri/torrent-aggregator/releases
VersionInfoVersion={#AppNumericVersion}
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#AppName}
DisableDirPage=auto
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
SetupIconFile=..\..\server\TorrentFlow.Api\Desktop\TorrentFlow.ico
OutputDir=..\..\artifacts\exe
OutputBaseFilename=TorrentFlow-Setup-{#AppVersion}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=force
RestartApplications=no
UsePreviousTasks=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "autostart"; Description: "Start TorrentFlow when I sign in to Windows (runs in the tray)"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "{#AppExe}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
; Same value the in-app "Start with Windows" toggle writes. Skipped on in-app updates so a silent
; update never overrides what the user chose in Settings since installing.
Root: HKCU; Subkey: "{#RunKey}"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"" --background"; Tasks: autostart; Check: not IsUpdate

[Run]
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\{#AppExe}"; Parameters: "--background"; WorkingDir: "{app}"; Flags: nowait; Check: IsUpdate

[Code]
function IsUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

// Closes only the copy installed in the app folder (a portable TorrentFlow.exe elsewhere keeps running).
// taskkill without /F posts WM_CLOSE to the tray window, which shuts the server down cleanly;
// anything still running after 15 seconds is force-stopped. If PowerShell is unavailable the
// Restart Manager (CloseApplications=force) still closes the app before files are replaced.
procedure CloseTorrentFlow;
var
  ResultCode: Integer;
  ExePath, Script: String;
begin
  ExePath := ExpandConstant('{app}\{#AppExe}');
  if not FileExists(ExePath) then
    Exit;
  StringChangeEx(ExePath, '''', '''''', True);
  Script :=
    '$exe=''' + ExePath + ''';' +
    '$p=@(Get-Process -Name TorrentFlow -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe });' +
    'if ($p.Count -gt 0) {' +
    '  foreach ($x in $p) { taskkill.exe /PID $x.Id | Out-Null };' +
    '  $p | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue;' +
    '  $p | Where-Object { -not $_.HasExited } | Stop-Process -Force -ErrorAction SilentlyContinue' +
    '}';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  CloseTorrentFlow;
  Result := '';
end;

function InitializeUninstall: Boolean;
begin
  CloseTorrentFlow;
  Result := True;
end;

procedure RemoveAutostartIfOurs;
var
  Command: String;
begin
  if RegQueryStringValue(HKCU, '{#RunKey}', '{#AppName}', Command) then
    if Pos(Lowercase(ExpandConstant('{app}\{#AppExe}')), Lowercase(Command)) > 0 then
      RegDeleteValue(HKCU, '{#RunKey}', '{#AppName}');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep <> usPostUninstall then
    Exit;

  RemoveAutostartIfOurs;

  DataDir := ExpandConstant('{localappdata}\{#AppName}');
  if UninstallSilent or not DirExists(DataDir) then
    Exit;

  if MsgBox('Also remove my TorrentFlow data?' + #13#10#13#10 +
            'This deletes your library, settings and search history, plus anything downloaded into the default folder inside:' + #13#10 +
            DataDir + #13#10#13#10 +
            'Choose No to keep it for a future install.',
            mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
  begin
    if not DelTree(DataDir, True, True, True) then
      MsgBox('Some files in ' + DataDir + ' could not be removed. You can delete the folder yourself.', mbInformation, MB_OK);
  end;
end;
