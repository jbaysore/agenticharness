Option Explicit
Dim shell, fs, root, nodePath, command
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
nodePath = root & "\bin\node.exe"
If Not fs.FileExists(nodePath) Then nodePath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
command = """" & nodePath & """ """ & root & "\scripts\launch.mjs"" --stop --no-browser"
shell.Run command, 0, True
