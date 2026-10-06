Option Explicit
Dim shell, fs, root, nodePath, command
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
nodePath = root & "\bin\node.exe"
If Not fs.FileExists(nodePath) Then nodePath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fs.FileExists(nodePath) Then
  MsgBox "The Node runtime is missing. Extract the complete Harness Windows package and launch it again.", 16, "Agentic Harness"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
command = """" & nodePath & """ """ & root & "\scripts\launch.mjs"""
shell.Run command, 0, False
