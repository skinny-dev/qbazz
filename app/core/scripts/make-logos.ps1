# Draws one square logo per sample shop (seed-logos/<slug>.png) from seed-logos/logos.json.
# Windows PowerShell + System.Drawing: no extra packages. The PNGs are committed, so this only
# needs to be run when the list or the colours change.
Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot 'seed-logos'
$items = [IO.File]::ReadAllText((Join-Path $dir 'logos.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$size = 512

foreach ($item in $items) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'

  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $from = [System.Drawing.ColorTranslator]::FromHtml($item.from)
  $to = [System.Drawing.ColorTranslator]::FromHtml($item.to)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $from, $to, 45
  $g.FillRectangle($brush, $rect)

  # two soft circles for depth
  $soft = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(38, 255, 255, 255))
  $g.FillEllipse($soft, -120, -140, 420, 420)
  $g.FillEllipse($soft, 300, 330, 330, 330)

  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = 'Center'
  $format.LineAlignment = 'Center'
  $format.FormatFlags = [System.Drawing.StringFormatFlags]::DirectionRightToLeft

  $white = [System.Drawing.Brushes]::White
  $big = New-Object System.Drawing.Font 'Segoe UI', 190, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $g.DrawString($item.letter, $big, $white, (New-Object System.Drawing.RectangleF 0, 70, $size, 300), $format)

  $small = New-Object System.Drawing.Font 'Segoe UI', 44, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $label = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
  $g.DrawString($item.name, $small, $label, (New-Object System.Drawing.RectangleF 0, 392, $size, 70), $format)

  $out = Join-Path $dir ($item.slug + '.png')
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "wrote $out"
}
