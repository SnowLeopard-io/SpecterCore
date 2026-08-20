# Extract the "This PC" and "Local Disk" shell icons (for System Info / drive).
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing.dll @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class ShellIcon2 {
  const int SHGFI_ICON = 0x100;
  const int SHGFI_LARGEICON = 0x0;
  const int SHGFI_USEFILEATTRIBUTES = 0x10;
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
  const uint FILE_ATTRIBUTE_NORMAL = 0x80;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEINFO {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes,
    ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll")]
  static extern bool DestroyIcon(IntPtr hIcon);

  public static string Save(string displayPath, bool isDir, string outFile) {
    SHFILEINFO info = new SHFILEINFO();
    uint attrs = isDir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
    uint flags = SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES;
    IntPtr h = SHGetFileInfo(displayPath, attrs, ref info, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), flags);
    if (h == IntPtr.Zero || info.hIcon == IntPtr.Zero) return "SKIP: no icon";
    try {
      using (Icon icon = Icon.FromHandle(info.hIcon))
      using (Bitmap bmp = icon.ToBitmap())
      using (Bitmap clone = new Bitmap(bmp.Width, bmp.Height, PixelFormat.Format32bppArgb)) {
        using (Graphics g = Graphics.FromImage(clone)) {
          g.Clear(Color.Transparent);
          g.DrawImage(bmp, 0, 0, bmp.Width, bmp.Height);
        }
        Directory.CreateDirectory(Path.GetDirectoryName(outFile));
        clone.Save(outFile, ImageFormat.Png);
        return "OK " + bmp.Width + "x" + bmp.Height + " -> " + outFile;
      }
    } finally {
      DestroyIcon(info.hIcon);
    }
  }
}
"@

$outDir = $args[0]
if (-not $outDir) { $outDir = 'C:\Users\HUAWEI\Desktop\windows\apps\web\public\icons' }

# This PC shell namespace object.
Write-Output ([ShellIcon2]::Save('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}', $false, (Join-Path $outDir 'this-pc.png')))
# Local disk (C:\) drive icon.
Write-Output ([ShellIcon2]::Save('C:\', $true, (Join-Path $outDir 'local-disk.png')))
Write-Output 'DONE'
