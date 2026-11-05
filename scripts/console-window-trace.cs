// Passive Windows desktop diagnostics, compiled by trace-console-windows.ps1.
// WinEvent hooks catch sub-second windows; polling is a fallback. Nothing is
// injected into other processes and no window, focus or process is modified.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace Harness.Diagnostics {
  public static class ConsoleWindowTrace {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry {
      public uint size, usage, id;
      public IntPtr heap;
      public uint module, threads, parent;
      public int priority;
      public uint flags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort length, maximum; public IntPtr buffer; }
    [StructLayout(LayoutKind.Sequential)] struct BasicInfo { public IntPtr reserved, peb, r1, r2, id, parent; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point point; }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
    delegate void EventCallback(IntPtr hook, uint kind, IntPtr window, int obj, int child, uint thread, uint time);
    delegate bool WindowCallback(IntPtr window, IntPtr parameter);

    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr handle, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr handle, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder buffer, ref int length);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint process, out uint session);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int info, IntPtr buffer, int length, out int required);
    [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")] static extern int QueryBasicInfo(IntPtr handle, int info, out BasicInfo buffer, int length, out int required);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint minimum, uint maximum, IntPtr module, EventCallback callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint minimum, uint maximum, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder buffer, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder buffer, int length);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int info, StringBuilder buffer, int length, out int required);

    public sealed class ProcessRecord {
      public uint id, parent, session;
      public string name, path, command, createdUtc, role;
      public PowerShellDetails powerShell;
      [ScriptIgnore] public DateTime lastSeen;
    }
    public sealed class PowerShellDetails {
      public string mode, scriptName, payloadSha256, knownAction, windowStyle;
      public bool noProfile, nonInteractive;
    }
    sealed class WindowRecord {
      public string handle, className, title, titleSha256, titleKind, firstSeenUtc;
      public uint processId;
      public bool console, visible, foreground;
      public List<ProcessRecord> ancestry;
      [ScriptIgnore] public DateTime lastSeen;
    }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly EventCallback Callback = OnEvent;
    static readonly Dictionary<uint, ProcessRecord> Processes = new Dictionary<uint, ProcessRecord>();
    static readonly Dictionary<long, WindowRecord> Windows = new Dictionary<long, WindowRecord>();
    static readonly Dictionary<string, int> Counts = new Dictionary<string, int>();
    static readonly Queue<ProcessRecord> Recent = new Queue<ProcessRecord>();
    static readonly Queue<ProcessRecord> RecentPowerShell = new Queue<ProcessRecord>();
    static readonly HashSet<ProcessRecord> RegisteredShells = new HashSet<ProcessRecord>();
    static StreamWriter writer;
    static string directory, startedUtc, expiresUtc, lastConsoleUtc, lastVisibleConsoleUtc;
    static long eventCount, windowCount, consoleCount, visibleConsoleCount, processCount, gitCount, powerShellCount;
    static int self;
    static bool initial, includeCommandLines;

    static string Hash(string text) {
      using (var sha = SHA256.Create())
        return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
    }
    static string[] Arguments(string command) {
      int count;
      IntPtr pointer = CommandLineToArgvW(command, out count);
      if (pointer == IntPtr.Zero) return new string[0];
      try {
        var args = new string[count];
        for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size));
        return args;
      } finally { LocalFree(pointer); }
    }
    // Keep enough to identify the launch path without storing scripts, command
    // text, environment variables or decoded EncodedCommand payloads.
    public static PowerShellDetails DescribePowerShell(string name, string command) {
      if (!Regex.IsMatch(name ?? "", @"^(powershell|pwsh)\.exe$", RegexOptions.IgnoreCase)) return null;
      var result = new PowerShellDetails { mode = command == null ? "unavailable" : "interactive" };
      if (command == null) return result;
      string[] args = Arguments(command);
      for (int i = 1; i < args.Length; i++) {
        string flag = args[i].ToLowerInvariant();
        if (flag == "-noprofile" || flag == "-nop") result.noProfile = true;
        if (flag == "-noninteractive" || flag == "-noni") result.nonInteractive = true;
        if ((flag == "-windowstyle" || flag == "-w") && i + 1 < args.Length) {
          string style = args[++i].ToLowerInvariant();
          result.windowStyle = new[] { "hidden", "normal", "minimized", "maximized" }.Contains(style) ? style : "other";
        } else if (flag == "-file" || flag == "-f") {
          result.mode = "file";
          if (i + 1 < args.Length) {
            result.scriptName = Path.GetFileName(args[i + 1]);
            result.payloadSha256 = Hash(args[i + 1]);
          }
          break;
        } else if (new[] { "-encodedcommand", "-enc", "-ec", "-e", "-command", "-c", "-commandwithargs" }.Contains(flag)) {
          bool encoded = flag != "-command" && flag != "-c" && flag != "-commandwithargs";
          result.mode = encoded ? "encoded" : "command";
          string payload = String.Join(" ", args.Skip(i + 1));
          if (encoded) {
            try { payload = Encoding.Unicode.GetString(Convert.FromBase64String(payload)); }
            catch (FormatException) { result.mode = "invalid-encoded"; break; }
          }
          result.payloadSha256 = Hash(payload);
          if (payload.Contains("Get-CimInstance Win32_Process")) result.knownAction = "process-parent-scan";
          else if (payload.Contains("Get-AppxPackage -Name OpenAI.Codex")) result.knownAction = "codex-package-discovery";
          else if (payload.Contains("$harnessCommandSucceeded") && payload.Contains("[Console]::OutputEncoding")) result.knownAction = "harness-foreground-command";
          break;
        }
      }
      return result;
    }

    static string Clean(string command) {
      if (command == null) return null;
      command = Regex.Replace(command, @"(?i)(-(?:EncodedCommand|enc)\s+)\S+", "$1[omitted]");
      command = Regex.Replace(command, @"(?i)(--?(?:password|token|api[-_]?key|secret|authorization)(?:=|\s+))(?:""[^""]*""|'[^']*'|[^\s]+)", "$1[redacted]");
      command = Regex.Replace(command, @"(?i)(\b\w*(?:TOKEN|PASSWORD|SECRET|API_KEY)\w*\s*=\s*)(?:""[^""]*""|'[^']*'|[^\s]+)", "$1[redacted]");
      command = Regex.Replace(command, @"(?i)(Bearer\s+)\S+", "$1[redacted]");
      command = Regex.Replace(command, @"(https?://)[^/\s@]+@", "$1[redacted]@");
      return command.Length > 4096 ? command.Substring(0, 3072) + "...[clipped]..." + command.Substring(command.Length - 768) : command;
    }
    static bool Relevant(string name) {
      return Regex.IsMatch(name ?? "", @"^(git|bash|sh|cmd|powershell|pwsh|conhost|OpenConsole|WindowsTerminal|codex|claude|node|agent|git-credential-manager)\.exe$", RegexOptions.IgnoreCase);
    }
    static string Command(IntPtr handle) {
      int length;
      NtQueryInformationProcess(handle, 60, IntPtr.Zero, 0, out length);
      if (length < 1 || length > 1000000) return null;
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        if (NtQueryInformationProcess(handle, 60, buffer, length, out length) != 0) return null;
        UnicodeString value = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
        return Marshal.PtrToStringUni(value.buffer, value.length / 2);
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    static ProcessRecord ReadProcess(uint id, uint parent, string name) {
      var record = new ProcessRecord { id = id, parent = parent, name = name, lastSeen = DateTime.UtcNow, powerShell = DescribePowerShell(name, null) };
      ProcessIdToSessionId(id, out record.session);
      IntPtr handle = OpenProcess(0x1000, false, id);
      if (handle == IntPtr.Zero) return record;
      try {
        var path = new StringBuilder(4096);
        int length = path.Capacity;
        if (QueryFullProcessImageName(handle, 0, path, ref length)) {
          record.path = path.ToString();
          if (String.IsNullOrEmpty(record.name)) record.name = Path.GetFileName(record.path);
        }
        FileTime created, exited, kernel, user;
        if (GetProcessTimes(handle, out created, out exited, out kernel, out user))
          record.createdUtc = DateTime.FromFileTimeUtc(((long)created.high << 32) | created.low).ToString("o");
        if (parent == 0) {
          BasicInfo basic;
          if (QueryBasicInfo(handle, 0, out basic, Marshal.SizeOf(typeof(BasicInfo)), out length) == 0)
            record.parent = unchecked((uint)basic.parent.ToInt64());
        }
        if (Relevant(record.name)) {
          string command = Command(handle);
          record.powerShell = DescribePowerShell(record.name, command);
          if (command != null && String.Equals(record.name, "node.exe", StringComparison.OrdinalIgnoreCase)) {
            string normalized = command.Replace('\\', '/');
            if (normalized.Contains("/src/server.mjs")) record.role = "harness-host";
            else if (normalized.Contains("/scripts/launch.mjs")) record.role = "harness-launcher";
          }
          if (command != null && String.Equals(record.name, "codex.exe", StringComparison.OrdinalIgnoreCase) && command.Contains("app-server")) record.role = "codex-app-server";
          record.command = includeCommandLines ? Clean(command) : null;
        }
      } finally { CloseHandle(handle); }
      return record;
    }
    static void Snapshot() {
      var shells = new List<ProcessRecord>();
      IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
      if (snapshot == new IntPtr(-1)) return;
      try {
        var entry = new ProcessEntry();
        entry.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
        DateTime now = DateTime.UtcNow;
        if (Process32First(snapshot, ref entry)) do {
          ProcessRecord known;
          bool fresh = !Processes.TryGetValue(entry.id, out known) || known.parent != entry.parent || known.name != entry.name || (now - known.lastSeen).TotalSeconds > 1;
          if (fresh) {
            known = ReadProcess(entry.id, entry.parent, entry.name);
            Processes[entry.id] = known;
            if (!initial && Relevant(known.name)) {
              processCount++;
              if (String.Equals(known.name, "git.exe", StringComparison.OrdinalIgnoreCase)) gitCount++;
              Recent.Enqueue(known);
              string key = known.parent + " " + known.name + " " + (known.role ?? (known.powerShell == null ? "" : known.powerShell.knownAction ?? known.powerShell.scriptName ?? known.powerShell.mode));
              if (!Counts.ContainsKey(key)) Counts[key] = 0;
              Counts[key]++;
            }
          }
          // A window hook may have discovered this record before the next
          // snapshot. Still emit its start once, including unreadable shells.
          if (known.powerShell != null && RegisteredShells.Add(known)) {
            RecentPowerShell.Enqueue(known);
            if (!initial) { powerShellCount++; shells.Add(known); }
          }
          known.lastSeen = now;
        } while (Process32Next(snapshot, ref entry));
      } finally { CloseHandle(snapshot); }
      foreach (var shell in shells)
        Write(new { type = "powershell-start", utc = DateTime.UtcNow.ToString("o"), process = shell, ancestry = Ancestry(shell.id) });
      while (Recent.Count > 256 || (Recent.Count > 0 && (DateTime.UtcNow - Recent.Peek().lastSeen).TotalSeconds > 5)) Recent.Dequeue();
      while (RecentPowerShell.Count > 128 || (RecentPowerShell.Count > 0 && (DateTime.UtcNow - RecentPowerShell.Peek().lastSeen).TotalSeconds > 10)) RecentPowerShell.Dequeue();
    }
    static List<ProcessRecord> Ancestry(uint id) {
      var result = new List<ProcessRecord>();
      var seen = new HashSet<uint>();
      string childCreated = null;
      while (id != 0 && result.Count < 10 && seen.Add(id)) {
        ProcessRecord record;
        if (!Processes.TryGetValue(id, out record)) {
          record = ReadProcess(id, 0, null);
          Processes[id] = record;
        }
        // A cached PID may already belong to a newer, unrelated process.
        if (childCreated != null && record.createdUtc != null && String.CompareOrdinal(record.createdUtc, childCreated) > 0) break;
        result.Add(record);
        childCreated = record.createdUtc;
        id = record.parent;
      }
      return result;
    }
    static string ObjectName(IntPtr handle) {
      var buffer = new StringBuilder(256); int required;
      return GetUserObjectInformation(handle, 2, buffer, 512, out required) ? buffer.ToString() : null;
    }
    static void OpenLog() {
      writer = new StreamWriter(Path.Combine(directory, "events.jsonl"), true, new UTF8Encoding(false));
      writer.AutoFlush = true;
    }
    static void Write(object value) {
      if (writer.BaseStream.Length > 8 * 1024 * 1024) {
        writer.Dispose();
        string oldest = Path.Combine(directory, "events.3.jsonl");
        if (File.Exists(oldest)) File.Delete(oldest);
        for (int i = 2; i >= 0; i--) {
          string from = Path.Combine(directory, i == 0 ? "events.jsonl" : "events." + i + ".jsonl");
          string to = Path.Combine(directory, "events." + (i + 1) + ".jsonl");
          if (File.Exists(from)) File.Move(from, to);
        }
        OpenLog();
      }
      writer.WriteLine(Json.Serialize(value));
    }
    static void Status(string state, string reason) {
      string file = Path.Combine(directory, "status.json"), temporary = file + ".tmp";
      File.WriteAllText(temporary, Json.Serialize(new {
        state = state, reason = reason, processId = self, startedUtc = startedUtc,
        expiresUtc = expiresUtc, heartbeatUtc = DateTime.UtcNow.ToString("o"),
        windowEvents = windowCount, consoleEvents = consoleCount, visibleConsoleEvents = visibleConsoleCount,
        processStarts = processCount, gitProcessStarts = gitCount, powerShellStarts = powerShellCount, lastConsoleUtc = lastConsoleUtc,
        captureCommandLines = includeCommandLines,
        lastVisibleConsoleUtc = lastVisibleConsoleUtc, logFile = Path.Combine(directory, "events.jsonl")
      }), new UTF8Encoding(false));
      if (File.Exists(file)) File.Replace(temporary, file, null);
      else File.Move(temporary, file);
    }
    static WindowRecord Describe(IntPtr handle) {
      uint process;
      GetWindowThreadProcessId(handle, out process);
      var className = new StringBuilder(256); GetClassName(handle, className, className.Capacity);
      var title = new StringBuilder(2048); GetWindowText(handle, title, title.Capacity);
      WindowRecord previous;
      Windows.TryGetValue(handle.ToInt64(), out previous);
      if (process == 0 && previous != null) return previous;
      var record = new WindowRecord {
        handle = "0x" + handle.ToInt64().ToString("x"), processId = process,
        className = className.ToString(), title = includeCommandLines ? Clean(title.ToString()) : null,
        titleSha256 = Hash(title.ToString()),
        titleKind = Regex.IsMatch(title.ToString(), @"powershell|pwsh", RegexOptions.IgnoreCase) ? "powershell" : null,
        visible = IsWindowVisible(handle), foreground = GetForegroundWindow() == handle,
        firstSeenUtc = previous == null ? DateTime.UtcNow.ToString("o") : previous.firstSeenUtc,
        lastSeen = DateTime.UtcNow, ancestry = Ancestry(process)
      };
      string processName = record.ancestry.Count > 0 ? record.ancestry[0].name : "";
      record.console = Regex.IsMatch(record.className + " " + title.ToString(), @"Console|CASCADIA|[\\/]Git[\\/]|Command Prompt|powershell|pwsh", RegexOptions.IgnoreCase)
        || Regex.IsMatch(processName ?? "", @"^(conhost|OpenConsole|WindowsTerminal|cmd|git|bash|sh|powershell|pwsh)\.exe$", RegexOptions.IgnoreCase);
      return record;
    }
    static void Record(string kind, IntPtr handle, uint eventTime) {
      if (handle == IntPtr.Zero) return;
      WindowRecord record = Describe(handle);
      windowCount++;
      if (record.console) { consoleCount++; lastConsoleUtc = DateTime.UtcNow.ToString("o"); }
      if (record.console && (record.visible || record.foreground)) { visibleConsoleCount++; lastVisibleConsoleUtc = DateTime.UtcNow.ToString("o"); }
      Write(new {
        type = "window", kind = kind, utc = DateTime.UtcNow.ToString("o"), eventTick = eventTime,
        window = record, recentProcesses = record.processId == 0 ? Recent.ToArray() : null,
        // A terminal host may own the window instead of its PowerShell client.
        // These are timing candidates, not proof of ownership.
        recentPowerShell = record.console && (record.visible || record.foreground)
          ? RecentPowerShell.Where(p => (DateTime.UtcNow - p.lastSeen).TotalSeconds <= 10).Select(p => new { process = p, ancestry = Ancestry(p.id) }).ToArray() : null
      });
      if (record.processId != 0) Windows[handle.ToInt64()] = record;
    }
    static void OnEvent(IntPtr hook, uint kind, IntPtr handle, int obj, int child, uint thread, uint time) {
      eventCount++;
      if (obj != 0 || child != 0 || handle == IntPtr.Zero) return;
      try {
        WindowRecord cached;
        bool known = Windows.TryGetValue(handle.ToInt64(), out cached);
        if (kind == 0x8001 || kind == 0x8003) {
          if (known) { Record(kind == 0x8001 ? "destroy" : "hide", handle, time); if (kind == 0x8001) Windows.Remove(handle.ToInt64()); }
          return;
        }
        IntPtr root = GetAncestor(handle, 2);
        if (root != IntPtr.Zero && root != handle) return;
        if (kind == 3 || kind == 0x8002) Record(kind == 3 ? "foreground" : "show", handle, time);
        else if (Describe(handle).console) Record(kind == 0x800C ? "title" : "create", handle, time);
      } catch (Exception error) { Write(new { type = "capture-error", utc = DateTime.UtcNow.ToString("o"), error = error.Message }); }
    }
    static void VisibleConsole(IntPtr handle) {
      if (!IsWindowVisible(handle)) return;
      var record = Describe(handle);
      WindowRecord old;
      if (record.console && (!Windows.TryGetValue(handle.ToInt64(), out old) || old.titleSha256 != record.titleSha256 || old.visible != record.visible))
        Record("poll-visible-console", handle, 0);
    }
    public static void Run(string runDirectory, int seconds) {
      Run(runDirectory, seconds, false);
    }
    public static void Run(string runDirectory, int seconds, bool captureCommandLines) {
      includeCommandLines = captureCommandLines;
      directory = Path.GetFullPath(runDirectory);
      self = System.Diagnostics.Process.GetCurrentProcess().Id;
      startedUtc = DateTime.UtcNow.ToString("o");
      DateTime end = DateTime.UtcNow.AddSeconds(seconds);
      expiresUtc = end.ToString("o");
      var hooks = new List<IntPtr>();
      string reason = "duration-elapsed";
      OpenLog();
      try {
        initial = true; Snapshot(); initial = false;
        hooks.Add(SetWinEventHook(3, 3, IntPtr.Zero, Callback, 0, 0, 0));
        hooks.Add(SetWinEventHook(0x8000, 0x8003, IntPtr.Zero, Callback, 0, 0, 0));
        hooks.Add(SetWinEventHook(0x800C, 0x800C, IntPtr.Zero, Callback, 0, 0, 0));
        if (hooks.Any(h => h == IntPtr.Zero)) throw new InvalidOperationException("Windows did not allow a desktop event hook.");
        uint session; ProcessIdToSessionId((uint)self, out session);
        if (session == 0) throw new InvalidOperationException("The logger must run in the signed-in desktop session, not a service session.");
        Write(new { type = "started", utc = startedUtc, processId = self, session = session, station = ObjectName(GetProcessWindowStation()), desktop = ObjectName(GetThreadDesktop(GetCurrentThreadId())), captureCommandLines = includeCommandLines, expiresUtc = expiresUtc });
        Status("running", null);
        IntPtr foreground = IntPtr.Zero;
        DateTime nextSnapshot = DateTime.MinValue, nextWindows = DateTime.MinValue, nextStatus = DateTime.UtcNow.AddSeconds(5), nextSummary = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < end) {
          if (File.Exists(Path.Combine(directory, "stop.request"))) { reason = "stop-requested"; break; }
          DateTime now = DateTime.UtcNow;
          if (now >= nextSnapshot) { Snapshot(); nextSnapshot = now.AddMilliseconds(50); }
          IntPtr current = GetForegroundWindow();
          if (current != foreground) { Record("poll-foreground", current, 0); foreground = current; }
          Message message;
          while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref message); DispatchMessage(ref message); }
          if (now >= nextWindows) { EnumWindows((window, unused) => { VisibleConsole(window); return true; }, IntPtr.Zero); nextWindows = now.AddMilliseconds(100); }
          if (now >= nextStatus) { Status("running", null); nextStatus = now.AddSeconds(5); }
          if (now >= nextSummary) {
            Write(new { type = "process-summary", utc = now.ToString("o"), hookEvents = eventCount, gitProcessStarts = gitCount, groups = Counts.OrderByDescending(pair => pair.Value).Take(40).Select(pair => new { command = pair.Key, count = pair.Value }).ToArray() });
            Counts.Clear(); nextSummary = now.AddSeconds(30);
            foreach (uint id in Processes.Where(pair => (now - pair.Value.lastSeen).TotalMinutes > 3).Select(pair => pair.Key).ToArray()) Processes.Remove(id);
            RegisteredShells.RemoveWhere(p => (now - p.lastSeen).TotalMinutes > 3);
            foreach (long id in Windows.Where(pair => (now - pair.Value.lastSeen).TotalMinutes > 10).Select(pair => pair.Key).ToArray()) Windows.Remove(id);
          }
          Thread.Sleep(10);
        }
      } catch (Exception error) {
        reason = "error: " + error.Message;
        Write(new { type = "error", utc = DateTime.UtcNow.ToString("o"), error = error.ToString() });
        throw;
      } finally {
        foreach (IntPtr hook in hooks) if (hook != IntPtr.Zero) UnhookWinEvent(hook);
        Write(new { type = "stopped", utc = DateTime.UtcNow.ToString("o"), reason = reason });
        Status("stopped", reason);
        writer.Dispose();
      }
    }
  }
}
