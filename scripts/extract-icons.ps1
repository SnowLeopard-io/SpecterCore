# Extract STANDARD Windows file-type icons via SHGetFileInfo, saved at native
# 32x32 (no upscaling -> crisp). Core logic is in C# to avoid PS 5.1
# nested-type reflection quirks.
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing.dll @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class IconGen {
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

$jobs = @(
  @{ p = 'C:\__folder__'; dir = $true;  n = 'folder' }
  @{ p = 'C:\__t__.txt';   dir = $false; n = 'text-document' }
  @{ p = 'C:\__t__.md';    dir = $false; n = 'text-document-md' }
  @{ p = 'C:\__t__.log';   dir = $false; n = 'text-document-log' }
  @{ p = 'C:\__t__.json';  dir = $false; n = 'text-document-json' }
  @{ p = 'C:\__t__.ini';   dir = $false; n = 'text-document-ini' }
  @{ p = 'C:\__t__.png';   dir = $false; n = 'image-file' }
  @{ p = 'C:\__t__.jpg';   dir = $false; n = 'image-file-jpg' }
  @{ p = 'C:\__t__.mp3';   dir = $false; n = 'audio-file' }
  @{ p = 'C:\__t__.wav';   dir = $false; n = 'audio-file-wav' }
  @{ p = 'C:\__t__.exe';   dir = $false; n = 'application' }
  @{ p = 'C:\__t__.dll';   dir = $false; n = 'library' }
  @{ p = 'C:\__t__.bkapp'; dir = $false; n = 'package' }
  @{ p = 'C:\__t__.xyz';   dir = $false; n = 'document' }
)

foreach ($j in $jobs) {
  $dest = Join-Path $outDir ($j.n + '.png')
  Write-Output ([IconGen]::Save($j.p, [bool]$j.dir, $dest))
}
Write-Output 'DONE'
