param([string]$NodePath, [string]$Entry, [string]$ArgumentsBase64)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class DshJobHost {
    [StructLayout(LayoutKind.Sequential)] struct BASIC {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED {
        public BASIC BasicLimitInformation;
        public IO IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    // Kept open until host exit; the OS then kills all remaining job members.
    static IntPtr job;
    public static void Enter() {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var info = new EXTENDED();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info))) throw new Win32Exception();
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    }
    static string Quote(string s) {
        return "\"" + System.Text.RegularExpressions.Regex.Replace(s, "(\\\\*)\"", "$1$1\\\"").TrimEnd('\\')
            + new string('\\', s.Length - s.TrimEnd('\\').Length) + new string('\\', s.Length - s.TrimEnd('\\').Length) + "\"";
    }
    public static int Run(string node, string entry, string[] args) {
        string command = Quote(entry);
        foreach (string arg in args) command += " " + Quote(arg);
        var start = new ProcessStartInfo(node, command);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using (var process = Process.Start(start)) {
            var stdout = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var stderr = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            process.WaitForExit();
            // Descendants may retain the pipes; host exit closes the Job Object.
            System.Threading.Tasks.Task.WaitAll(new [] { stdout, stderr }, 2000);
            return process.ExitCode;
        }
    }
}
'@
    [DshJobHost]::Enter()
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))
    [string[]]$childArguments = ConvertFrom-Json $decoded
    $code = [DshJobHost]::Run($NodePath, $Entry, $childArguments)
    exit $code
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 125
}
