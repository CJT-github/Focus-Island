param([int]$AppProcessId)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PhoneRegionProbe {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h,IntPtr r);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
 [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr h,out Rect r);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
 public static IntPtr Find(uint pid) {IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);var name=new StringBuilder(256);GetWindowText(h,name,256);if(owner==pid && name.ToString()=="Focus Island")found=h;return true;},IntPtr.Zero);return found;}
}
'@
$h=[PhoneRegionProbe]::Find($AppProcessId)
if($h -eq [IntPtr]::Zero){throw 'Window not found'}
$r=[PhoneRegionProbe]::CreateRectRgn(0,0,0,0)
try {
 $kind=[PhoneRegionProbe]::GetWindowRgn($h,$r)
 $bounds=New-Object PhoneRegionProbe+Rect
 $outer=New-Object PhoneRegionProbe+Rect
 [void][PhoneRegionProbe]::GetRgnBox($r,[ref]$bounds)
 [void][PhoneRegionProbe]::GetWindowRect($h,[ref]$outer)
 @{kind=$kind;region=$bounds;outer=$outer}|ConvertTo-Json -Compress
} finally {[void][PhoneRegionProbe]::DeleteObject($r)}
