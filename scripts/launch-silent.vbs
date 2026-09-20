' Darklauncher silent launcher - starts the app with no visible console window.
' Called by Darklauncher.bat:  wscript.exe scripts\launch-silent.vbs "C:\path\to\project\."
Option Explicit
Dim sh, fso, dir, exe, appDir, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count >= 1 Then
  dir = WScript.Arguments(0)
Else
  dir = sh.CurrentDirectory & "\"
End If

' Normalize: drop the trailing "\." passed by the .bat wrapper
If Right(dir, 2) = "\." Then dir = Left(dir, Len(dir) - 2)

If Right(dir, 1) <> "\" Then dir = dir & "\"
appDir = Left(dir, Len(dir) - 1)

exe = dir & "node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then WScript.Quit 1

sh.CurrentDirectory = appDir
cmd = Chr(34) & exe & Chr(34) & " " & Chr(34) & appDir & Chr(34)
sh.Run cmd, 0, False
