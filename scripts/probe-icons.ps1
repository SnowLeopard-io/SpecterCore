# Probe imageres.dll.mun indices to find a game / minesweeper-appropriate icon.
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class IconNative3 {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHDefExtractIcon")]
  public static extern int SHDefExtractIcon(string pszIconFile, int iIndex, uint uFlags,
    out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIconSize);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
"@

$outDir = $args[0]
$src = 'C:\Windows\SystemResources\imageres.dll.mun'

for ($idx = 0; $idx -le 15; $idx++) {
  try {
    $hLarge = [IntPtr]::Zero; $hSmall = [IntPtr]::Zero
    $hr = [IconNative3]::SHDefExtractIcon($src, $idx, 0, [ref]$hLarge, [ref]$hSmall, 0)
    if ($hr -ne 0 -or $hLarge -eq [IntPtr]::Zero) {
      Write-Output ("idx {0}: SKIP hr=0x{1:X}" -f $idx, $hr); continue
    }
    $icon = [System.Drawing.Icon]::FromHandle($hLarge)
    $bmp = $icon.ToBitmap()
    $out = New-Object System.Drawing.Bitmap(48, 48)
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($bmp, 0, 0, 48, 48)
    $g.Dispose()
    $dest = Join-Path $outDir ("probe-{0}.png" -f $idx)
    $out.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose(); $bmp.Dispose(); $icon.Dispose()
    [IconNative3]::DestroyIcon($hLarge) | Out-Null
    Write-Output ("idx {0}: OK" -f $idx)
  } catch {
    Write-Output ("idx {0}: ERR {1}" -f $idx, $_.Exception.Message)
  }
}
Write-Output 'PROBE-DONE'
