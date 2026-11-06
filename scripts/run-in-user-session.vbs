Option Explicit
Dim shell, powershell, command, code
If WScript.Arguments.Count <> 2 Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
' Start hidden at process creation, before PowerShell can allocate a console.
command = """" & powershell & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """ -RequestFile """ & WScript.Arguments(1) & """"
On Error Resume Next
code = shell.Run(command, 0, True)
If Err.Number <> 0 Then WScript.Quit 1
WScript.Quit code
