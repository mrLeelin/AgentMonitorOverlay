param([Parameter(Mandatory=$true)][string]$Source,[string]$OutputDir=$PSScriptRoot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$out = $OutputDir
Copy-Item -LiteralPath $Source -Destination (Join-Path $out 'generated-strip.png')
$raw = [System.Drawing.Bitmap]::new($Source)
$old = [System.Drawing.Bitmap]::new((Join-Path $out '../../packages/ui/src/board/assets/chibi-run.png'))
$boxes = @()
for ($i = 0; $i -lt 8; $i++) {
    $left = [int][Math]::Round($i * $raw.Width / 8)
    $right = [int][Math]::Round(($i + 1) * $raw.Width / 8)
    $minX = $right; $minY = $raw.Height; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $raw.Height; $y++) {
        for ($x = $left; $x -lt $right; $x++) {
            if ($raw.GetPixel($x, $y).A -gt 8) {
                $minX = [Math]::Min($minX, $x); $minY = [Math]::Min($minY, $y)
                $maxX = [Math]::Max($maxX, $x); $maxY = [Math]::Max($maxY, $y)
            }
        }
    }
    if ($maxX -lt 0) { throw "Frame $i is empty" }
    $boxes += [pscustomobject]@{ X=$minX; Y=$minY; Width=($maxX-$minX+1); Height=($maxY-$minY+1) }
}
$maxWidth = ($boxes | Measure-Object Width -Maximum).Maximum
$top = ($boxes | Measure-Object Y -Minimum).Minimum
$bottom = ($boxes | ForEach-Object { $_.Y + $_.Height } | Measure-Object -Maximum).Maximum
$scale = [Math]::Min(88 / $maxWidth, 88 / ($bottom-$top))
$sheet = [System.Drawing.Bitmap]::new(768,96)
$sheetG = [System.Drawing.Graphics]::FromImage($sheet)
$sheetG.Clear([System.Drawing.Color]::Transparent)
$sheetG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$sheetG.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$frameDir = Join-Path $out 'frames'
$previewDir = Join-Path $out 'preview-frames'
[void][System.IO.Directory]::CreateDirectory($frameDir)
[void][System.IO.Directory]::CreateDirectory($previewDir)
$font = [System.Drawing.Font]::new('Microsoft YaHei',14)
$smallFont = [System.Drawing.Font]::new('Microsoft YaHei',11)
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#aab5c7'))
$green = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#55c995'))
for ($i = 0; $i -lt 8; $i++) {
    $b = $boxes[$i]
    $w = [int][Math]::Round($b.Width*$scale); $h = [int][Math]::Round($b.Height*$scale)
    $x = [int][Math]::Round((96-$w)/2)
    $y = 4 + [int][Math]::Round(($b.Y-$top)*$scale)
    $frame = [System.Drawing.Bitmap]::new(96,96)
    $g = [System.Drawing.Graphics]::FromImage($frame)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($raw,[System.Drawing.Rectangle]::new($x,$y,$w,$h),[System.Drawing.Rectangle]::new($b.X,$b.Y,$b.Width,$b.Height),[System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $frame.Save((Join-Path $frameDir ('{0:D2}.png' -f ($i+1))),[System.Drawing.Imaging.ImageFormat]::Png)
    $sheetG.DrawImageUnscaled($frame,$i*96,0)
    $p = [System.Drawing.Bitmap]::new(640,340)
    $pg = [System.Drawing.Graphics]::FromImage($p)
    $pg.Clear([System.Drawing.ColorTranslator]::FromHtml('#171d28'))
    $pg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $pg.DrawString('Claude · 新版',$font,[System.Drawing.Brushes]::White,65,18)
    $pg.DrawString('其他模型 · 原版',$font,[System.Drawing.Brushes]::White,355,18)
    $pg.DrawImage($frame,[System.Drawing.Rectangle]::new(76,58,160,160))
    $pg.DrawImage($old,[System.Drawing.Rectangle]::new(374,58,160,160),[System.Drawing.Rectangle]::new($i*96,0,96,96),[System.Drawing.GraphicsUnit]::Pixel)
    foreach ($baseX in @(74,372)) {
        $pg.FillEllipse($green,$baseX,256,7,7)
        $pg.DrawString('运行中',$smallFont,$muted,($baseX+17),248)
    }
    $pg.DrawImage($frame,[System.Drawing.Rectangle]::new(148,247,24,24))
    $pg.DrawImage($old,[System.Drawing.Rectangle]::new(446,247,24,24),[System.Drawing.Rectangle]::new($i*96,0,96,96),[System.Drawing.GraphicsUnit]::Pixel)
    $pg.DrawString('8 帧循环 / 0.8 秒 · 下方为 24px 实际大小',$smallFont,$muted,139,306)
    $p.Save((Join-Path $previewDir ('{0:D2}.png' -f ($i+1))),[System.Drawing.Imaging.ImageFormat]::Png)
    $pg.Dispose(); $p.Dispose(); $frame.Dispose()
}
$sheetG.Dispose()
$sheet.Save((Join-Path $out 'claude-run-8x96.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose(); $raw.Dispose(); $old.Dispose(); $font.Dispose(); $smallFont.Dispose(); $muted.Dispose(); $green.Dispose()
[pscustomobject]@{Frames=8;SheetWidth=768;SheetHeight=96;FrameSize=96;DisplaySize=24;DurationSeconds=0.8;SharedScale=$scale;SourceBoxes=$boxes} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $out 'validation.json') -Encoding utf8
