// Local maintainer diagnostic: only debugs processes created by this collector.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class DebugOutputCollector {
    [StructLayout(LayoutKind.Sequential)] struct Security { public uint size; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public uint size; public string reserved,desktop,title;
        public uint x,y,width,height,charsX,charsY,fill,flags;
        public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint processId,threadId; }
    [StructLayout(LayoutKind.Explicit, Size=176)] struct DebugEvent {
        [FieldOffset(0)] public uint code;
        [FieldOffset(4)] public uint processId;
        [FieldOffset(8)] public uint threadId;
        [FieldOffset(16)] public IntPtr pointer;
        [FieldOffset(16)] public uint value;
        [FieldOffset(24)] public IntPtr processHandle;
        [FieldOffset(32)] public IntPtr threadHandle;
        [FieldOffset(24)] public ushort unicode;
        [FieldOffset(26)] public ushort stringLength;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string directory,ref Startup startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool WaitForDebugEventEx(out DebugEvent ev,uint timeout);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ContinueDebugEvent(uint pid,uint tid,uint status);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DebugActiveProcessStop(uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process,IntPtr address,byte[] bytes,UIntPtr size,out UIntPtr read);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref Security security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandleW(IntPtr handle,StringBuilder path,uint size,uint flags);
    static string Quote(string value) {
        var text=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') {slashes++;continue;}
            if(c=='\"') {text.Append('\\',slashes*2+1);text.Append(c);slashes=0;continue;}
            text.Append('\\',slashes);slashes=0;text.Append(c);
        }
        text.Append('\\',slashes*2);text.Append('"');return text.ToString();
    }
    static void Check(bool ok) {if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
    static IntPtr File(string path,uint access,uint creation) {
        var security=new Security {size=(uint)Marshal.SizeOf(typeof(Security)),inherit=1};
        var handle=CreateFileW(path,access,3,ref security,creation,0x80,IntPtr.Zero);
        if(handle==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());return handle;
    }
    public static object Run(string executable,string[] arguments,string directory,string logPath,int timeoutMs,bool followChildren=false) {
        if(IntPtr.Size!=8)throw new InvalidOperationException("x64 diagnostic required");
        var command=new StringBuilder(Quote(executable)); foreach(string arg in arguments)command.Append(" "+Quote(arg));
        IntPtr output=File(logPath,0x40000000,2),input=IntPtr.Zero;
        var process=new ProcessInfo(); bool started=false,exited=false,timedOut=false;
        var messages=new List<string>(); var graphicsModules=new List<string>(); uint exitCode=0; var timer=Stopwatch.StartNew();
        var debugProcesses=new Dictionary<uint,IntPtr>();
        System.IO.File.WriteAllText(logPath+".debug.log", "", Encoding.UTF8);
        try {
            input=File("NUL",0x80000000,3);
            var startup=new Startup {size=(uint)Marshal.SizeOf(typeof(Startup)),flags=0x100,input=input,output=output,error=output};
            Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08000000 | (followChildren ? 1u : 2u),IntPtr.Zero,directory,ref startup,out process));started=true;
            CloseHandle(input);input=IntPtr.Zero;CloseHandle(output);output=IntPtr.Zero;
            // DEBUG_PROCESS follows descendants. The root can exit before a
            // WebView child; drain that child's events before another Run.
            while(!exited || debugProcesses.Count>0) {
                if(timer.ElapsedMilliseconds>timeoutMs) {
                    timedOut=true;
                    foreach(var handle in debugProcesses.Values)TerminateProcess(handle,124);
                    TerminateProcess(process.process,124);break;
                }
                DebugEvent ev;
                if(!WaitForDebugEventEx(out ev,250)) {
                    int error=Marshal.GetLastWin32Error(); if(error==121)continue;
                    throw new Win32Exception(error);
                }
                uint status=0x00010002;
                if(ev.code==3) {
                    debugProcesses.Add(ev.processId,ev.processHandle);
                }
                if(ev.code==1 && ev.value!=0x80000003 && ev.value!=0x80000004)status=0x80010001;
                if(ev.code==3 || ev.code==6) {
                    if(ev.pointer!=IntPtr.Zero) {
                        var path=new StringBuilder(32768);
                        uint length=GetFinalPathNameByHandleW(ev.pointer,path,32768,0);
                        if(length>0&&length<32768) {
                            string value=path.ToString();
                            if(value.IndexOf("d3d12",StringComparison.OrdinalIgnoreCase)>=0||value.IndexOf("dxgidebug",StringComparison.OrdinalIgnoreCase)>=0)graphicsModules.Add(value);
                        }
                        CloseHandle(ev.pointer);
                    }
                }
                if(ev.code==8) {
                    int size=ev.stringLength; // Windows reports bytes for ANSI and Unicode.
                    if(size>0) {
                        var bytes=new byte[size]; UIntPtr read;
                        Check(ReadProcessMemory(debugProcesses[ev.processId],ev.pointer,bytes,(UIntPtr)size,out read));
                        string message=(ev.unicode!=0?Encoding.Unicode:Encoding.Default).GetString(bytes,0,(int)read.ToUInt64());
                        int terminator=message.IndexOf('\0');
                        message=terminator<0?message:message.Substring(0,terminator);
                        messages.Add(message);
                        System.IO.File.AppendAllText(logPath+".debug.log",message+Environment.NewLine,Encoding.UTF8);
                    }
                }
                if(ev.code==5) {
                    if(ev.processId==process.processId) {exitCode=ev.value;exited=true;}
                    // ContinueDebugEvent closes the event-owned process/thread
                    // handles after EXIT_PROCESS_DEBUG_EVENT.
                    debugProcesses.Remove(ev.processId);
                }
                Check(ContinueDebugEvent(ev.processId,ev.threadId,status));
            }
            return new {exitCode=timedOut?124:exitCode,timedOut,debugStrings=messages,graphicsModules,durationMs=timer.ElapsedMilliseconds,processId=process.processId};
        } finally {
            if(started&&!exited) {TerminateProcess(process.process,124);WaitForSingleObject(process.process,5000);}
            foreach(var entry in debugProcesses) {
                TerminateProcess(entry.Value,124);
                DebugActiveProcessStop(entry.Key);
                CloseHandle(entry.Value);
            }
            if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);
            if(process.process!=IntPtr.Zero)CloseHandle(process.process);
            if(input!=IntPtr.Zero)CloseHandle(input);if(output!=IntPtr.Zero)CloseHandle(output);
        }
    }
}
