param([Parameter(Mandatory=$true)][int]$AppProcessId,[Parameter(Mandatory=$true)][string]$OutputDirectory,[int]$ToggleCount=10)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
public static class FlickerCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  public class Sample {
    public long ms; public int left,top,width,height,style,backingGreen; public double r,g,b;
    public bool centerHitsIsland, outsideHitsIsland; public int region;
    public bool regionCenter,regionOutside;
  }
  public class Result { public List<Sample> samples=new List<Sample>(); public List<long> clicks=new List<long>(); public int target,scalePercent; }
  public delegate bool EnumProc(IntPtr h,IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,System.Text.StringBuilder text,int max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h,int n);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int hgt,uint flags);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr extra);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr h,IntPtr region);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
  [DllImport("gdi32.dll")] static extern bool PtInRegion(IntPtr h,int x,int y);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  static IntPtr Find(int pid) {
    IntPtr found=IntPtr.Zero;
    EnumWindows(delegate(IntPtr h,IntPtr l) { uint p; GetWindowThreadProcessId(h,out p); var text=new System.Text.StringBuilder(256); GetWindowText(h,text,256); if(p==pid&&text.ToString()=="Focus Island")found=h; return true; },IntPtr.Zero);
    if(found==IntPtr.Zero)throw new Exception("Island native window not found"); return found;
  }
  static bool Hits(IntPtr target,int x,int y) { Point p=new Point();p.X=x;p.Y=y;return GetAncestor(WindowFromPoint(p),2)==target; }
  public static Result Run(int pid,string output,int toggleCount) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    IntPtr target=Find(pid); Rect initial; GetWindowRect(target,out initial);
    double scale=GetDpiForWindow(target)/96.0;
    var bounds=Screen.FromHandle(target).Bounds;
    int cx=(bounds.Left+bounds.Right)/2, visibleTop=bounds.Top+(int)Math.Round(20*scale);
    int cropLeft=cx-(int)Math.Round(180*scale),cropTop=Math.Max(bounds.Top,visibleTop-(int)Math.Round(10*scale));
    int cropWidth=(int)Math.Round(360*scale),cropHeight=(int)Math.Round(370*scale);
    var result=new Result(); result.target=pid;result.scalePercent=(int)Math.Round(scale*100);
    Point saved;GetCursorPos(out saved);
    using(var backing=new Form())using(var bitmap=new Bitmap(cropWidth,cropHeight,PixelFormat.Format24bppRgb))using(var graphics=Graphics.FromImage(bitmap)) {
      backing.FormBorderStyle=FormBorderStyle.None;backing.ShowInTaskbar=false;backing.StartPosition=FormStartPosition.Manual;
      backing.Bounds=new Rectangle(cropLeft,cropTop,cropWidth,cropHeight);backing.BackColor=Color.FromArgb(24,240,120);backing.TopMost=true;
      backing.Show();SetWindowPos(target,new IntPtr(-1),0,0,0,0,0x0013);Application.DoEvents();Thread.Sleep(500);
      SetCursorPos(cx+(int)Math.Round(90*scale),visibleTop+(int)Math.Round(45*scale));
      var timer=Stopwatch.StartNew();long nextFrame=0;int toggles=0;bool down=false,hovering=false;long releaseAt=0,pressAt=0;long nextClick=400;
      try {
        while(timer.ElapsedMilliseconds<400+toggleCount*800+300) {
          long now=timer.ElapsedMilliseconds;
          if(down&&now>=releaseAt){mouse_event(4,0,0,0,UIntPtr.Zero);down=false;SetCursorPos(cx+(int)Math.Round(190*scale),visibleTop+(int)Math.Round(45*scale));}
          if(hovering&&now>=pressAt){mouse_event(2,0,0,0,UIntPtr.Zero);hovering=false;down=true;releaseAt=now+35;result.clicks.Add(now);toggles++;nextClick=400+toggles*800;}
          if(!down&&!hovering&&toggles<toggleCount&&now>=nextClick){
            // A point shared by the pill and the dial, away from controls.
            SetCursorPos(cx,visibleTop+(int)Math.Round(10*scale));hovering=true;pressAt=now+80;
          }
          if(now<nextFrame){Thread.Sleep(1);Application.DoEvents();continue;}
          nextFrame=now+8;
          graphics.CopyFromScreen(cropLeft,cropTop,0,0,bitmap.Size,CopyPixelOperation.SourceCopy);
          // This patch lies within the glass throughout both morph directions.
          int sampleX=cx-cropLeft,sampleY=visibleTop-cropTop;double red=0,green=0,blue=0;int count=0;
          for(int y=4;y<8;y++)for(int x=-7;x<=7;x++){var pixel=bitmap.GetPixel(sampleX+(int)Math.Round(x*scale),sampleY+(int)Math.Round(y*scale));red+=pixel.R;green+=pixel.G;blue+=pixel.B;count++;}
          Rect rect;GetWindowRect(target,out rect);IntPtr region=CreateRectRgn(0,0,0,0);int kind=GetWindowRgn(target,region);
          var s=new Sample();s.ms=timer.ElapsedMilliseconds;s.left=rect.Left;s.top=rect.Top;s.width=rect.Right-rect.Left;s.height=rect.Bottom-rect.Top;s.style=GetWindowLong(target,-20);
          s.r=Math.Round(red/count,2);s.g=Math.Round(green/count,2);s.b=Math.Round(blue/count,2);s.region=kind;
          s.backingGreen=bitmap.GetPixel(5,5).G;
          s.centerHitsIsland=Hits(target,cx,visibleTop+(int)Math.Round(10*scale));s.outsideHitsIsland=Hits(target,cx-(int)Math.Round(190*scale),visibleTop+(int)Math.Round(10*scale));
          s.regionCenter=kind>0&&PtInRegion(region,cx-rect.Left,visibleTop+(int)Math.Round(10*scale)-rect.Top);
          s.regionOutside=kind>0&&PtInRegion(region,cx-(int)Math.Round(190*scale)-rect.Left,visibleTop+(int)Math.Round(10*scale)-rect.Top);
          DeleteObject(region);result.samples.Add(s);
          if(result.samples.Count%25==1||s.g>160)bitmap.Save(Path.Combine(output,"frame-"+s.ms.ToString("D5")+".png"),ImageFormat.Png);
          Application.DoEvents();
        }
      } finally { if(down)mouse_event(4,0,0,0,UIntPtr.Zero);SetCursorPos(saved.X,saved.Y);backing.Close(); }
    }
    return result;
  }
}
'@
[FlickerCapture]::Run($AppProcessId,$OutputDirectory,$ToggleCount) | ConvertTo-Json -Depth 6 -Compress
