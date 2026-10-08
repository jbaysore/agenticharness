param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$DesktopPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agentic Harness.lnk'),
  [string]$StartMenuPath = (Join-Path ([Environment]::GetFolderPath('Programs')) 'Agentic Harness.lnk'),
  [string]$ReadPath
)
$ErrorActionPreference = 'Stop'
# Edge labels an --app window as MSEdge.{host}_{path}. The local app origin's
# host is 127.0.0.1 and its path is /, and the port is not part of that id.
$AppUserModelId = 'MSEdge.127.0.0.1_/'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class HarnessShortcut {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  private class ShellLink {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  private interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr findData, int flags);
    void GetIDList(out IntPtr idList);
    void SetIDList(IntPtr idList);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int max);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int max);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
    void GetHotkey(out short hotkey);
    void SetHotkey(short hotkey);
    void GetShowCmd(out int showCmd);
    void SetShowCmd(int showCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int max, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, int reserved);
    void Resolve(IntPtr window, int flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
  private interface IPersistFile {
    void GetClassID(out Guid classId);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string file, bool remember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string file);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  private interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PropertyKey {
    public Guid FormatId;
    public uint PropertyId;
    public PropertyKey(Guid formatId, uint propertyId) {
      FormatId = formatId;
      PropertyId = propertyId;
    }
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PropVariant {
    public ushort VariantType;
    public ushort Reserved1;
    public ushort Reserved2;
    public ushort Reserved3;
    public IntPtr Pointer;
    public int PointerHigh;
    public static PropVariant FromString(string value) {
      var variant = new PropVariant();
      variant.VariantType = 31;
      variant.Pointer = Marshal.StringToCoTaskMemUni(value);
      return variant;
    }
  }

  [DllImport("ole32.dll")]
  private static extern int PropVariantClear(ref PropVariant value);

  public static void SetAppId(string shortcutPath, string appId) {
    var link = (IShellLinkW)new ShellLink();
    ((IPersistFile)link).Load(shortcutPath, 2);
    var store = (IPropertyStore)link;
    var key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    var variant = PropVariant.FromString(appId);
    try {
      int set = store.SetValue(ref key, ref variant);
      int committed = store.Commit();
      PropVariant check;
      int read = store.GetValue(ref key, out check);
      if (set != 0 || committed != 0 || read != 0 || check.VariantType != 31)
        throw new InvalidOperationException(
          "Could not store the taskbar app id. set=" + set + " commit=" + committed + " read=" + read + " vt=" + check.VariantType);
    } finally {
      PropVariantClear(ref variant);
    }
    ((IPersistFile)link).Save(shortcutPath, true);
  }

  public static string ReadAppId(string shortcutPath) {
    var link = (IShellLinkW)new ShellLink();
    ((IPersistFile)link).Load(shortcutPath, 0);
    var store = (IPropertyStore)link;
    var key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    PropVariant variant;
    int hr = store.GetValue(ref key, out variant);
    if (hr != 0 || variant.VariantType != 31 || variant.Pointer == IntPtr.Zero)
      return "hr=" + hr + ";vt=" + variant.VariantType;
    var value = Marshal.PtrToStringUni(variant.Pointer);
    PropVariantClear(ref variant);
    return value;
  }
}
'@

if ($ReadPath) {
  Write-Output ([HarnessShortcut]::ReadAppId((Resolve-Path -LiteralPath $ReadPath).Path))
  exit 0
}

$vbs = Join-Path $Root 'Launch Harness.vbs'
$icon = Join-Path $Root 'dist\icons\harness.ico'
if (-not (Test-Path -LiteralPath $icon)) { $icon = Join-Path $Root 'src\ui\icons\harness.ico' }
if (-not (Test-Path -LiteralPath $vbs)) { throw "Launch Harness.vbs is missing from $Root" }
if (-not (Test-Path -LiteralPath $icon)) { throw "The Harness icon is missing from $Root" }
$shell = New-Object -ComObject WScript.Shell
foreach ($path in @($DesktopPath, $StartMenuPath)) {
  $directory = Split-Path -Parent $path
  if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $shortcut.Arguments = '"' + $vbs + '"'
  $shortcut.WorkingDirectory = $Root
  $shortcut.Description = 'Open your subscription-backed coding workspace'
  $shortcut.IconLocation = $icon + ',0'
  $shortcut.Save()
  [HarnessShortcut]::SetAppId((Resolve-Path -LiteralPath $path).Path, $AppUserModelId)
}
Write-Output $AppUserModelId
