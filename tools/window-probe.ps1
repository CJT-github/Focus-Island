param([int]$AppProcessId, [int]$CursorX = -2147483648, [int]$CursorY = -2147483648, [int]$DragToX = -2147483648, [int]$DragToY = -2147483648)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FocusProbe {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor,Work; public int Flags; }
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref Point p);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr h,ref MonitorInfo info);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 public static IntPtr[] Windows(uint pid) {var a=new List<IntPtr>();EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid)a.Add(h);return true;},IntPtr.Zero);return a.ToArray();}
}
'@
$cursor=New-Object FocusProbe+Point
[void][FocusProbe]::GetCursorPos([ref]$cursor)
if($CursorX -ne -2147483648 -and $CursorY -ne -2147483648){[void][FocusProbe]::SetCursorPos($CursorX,$CursorY);Start-Sleep -Milliseconds 180}
if($DragToX -ne -2147483648 -and $DragToY -ne -2147483648){
 if($CursorX -eq -2147483648 -or $CursorY -eq -2147483648){throw 'Drag requires a starting point'}
 try {
  [FocusProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 180
  for($step=1;$step -le 10;$step++){
   [void][FocusProbe]::SetCursorPos(($CursorX+($DragToX-$CursorX)*$step/10),($CursorY+($DragToY-$CursorY)*$step/10))
   Start-Sleep -Milliseconds 20
  }
 } finally {
  [FocusProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 150
  [void][FocusProbe]::SetCursorPos($cursor.X,$cursor.Y)
 }
 Start-Sleep -Milliseconds 150
}
$windows=@(foreach($handle in [FocusProbe]::Windows($AppProcessId)){
 $title=New-Object Text.StringBuilder 256
 [void][FocusProbe]::GetWindowText($handle,$title,256)
 if($title.ToString() -notlike 'Focus Island*'){continue}
 $outer=New-Object FocusProbe+Rect;$client=New-Object FocusProbe+Rect;$origin=New-Object FocusProbe+Point
 [void][FocusProbe]::GetWindowRect($handle,[ref]$outer);[void][FocusProbe]::GetClientRect($handle,[ref]$client);[void][FocusProbe]::ClientToScreen($handle,[ref]$origin)
 $monitor=New-Object FocusProbe+MonitorInfo;$monitor.Size=40
 [void][FocusProbe]::GetMonitorInfo([FocusProbe]::MonitorFromWindow($handle,2),[ref]$monitor)
 @{title=$title.ToString();outer=$outer;client=$client;origin=$origin;monitor=$monitor.Monitor;work=$monitor.Work;exStyle=[FocusProbe]::GetWindowLongPtrW($handle,-20).ToInt64()}
})
@{cursor=$cursor;windows=$windows}|ConvertTo-Json -Depth 6 -Compress
