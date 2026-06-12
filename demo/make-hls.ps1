<#
  Encode an MPEG-2 video MXF and split it into 2-second, GOP-aligned MXF clips with
  ffmpeg's `segment` muxer, emitting a STATIC (#EXT-X-ENDLIST) m3u8 of those clips.

  Each segment is a complete, structurally-identical MXF file (its own header/footer,
  timestamps reset to 0) — exactly what mxf.js's playlist mode expects: clip 0's header
  is parsed once and reused for the rest.

  Usage:
    # generated 20s test source (no input needed):
    pwsh demo/make-hls.ps1
    # or from a real source clip:
    pwsh demo/make-hls.ps1 -Input C:\temp\mxf.js\vistek.mxf -Duration 20

  Output: demo/hls/clip000.mxf, clip001.mxf, ... + demo/hls/playlist.m3u8
#>
param(
  [string]$Input = "",
  [int]$Duration = 20,
  [int]$SegmentSeconds = 2,
  [int]$Fps = 25,
  [string]$Size = "640x480",
  [string]$OutDir = "$PSScriptRoot\hls"
)

$ErrorActionPreference = "Stop"
$ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ff) { throw "ffmpeg not found on PATH" }

if (Test-Path $OutDir) { Remove-Item "$OutDir\*" -Force -ErrorAction SilentlyContinue }
else { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path
if ($Input) { $Input = (Resolve-Path $Input -ErrorAction SilentlyContinue).Path }

# Force a keyframe exactly every SegmentSeconds so each 2s segment starts on a GOP boundary.
$gop = $SegmentSeconds * $Fps
$kf  = "expr:gte(t,n_forced*$SegmentSeconds)"

# Common encode + segmenting args. NOTE: ffmpeg's segment_list writes the *output filename pattern*
# verbatim into each m3u8 EXTINF entry — so we use RELATIVE names (clip%03d.mxf / playlist.m3u8) and
# run ffmpeg with the working dir set to $OutDir. Absolute paths here would emit absolute Windows
# paths as segment URIs, which won't resolve against the manifest URL.
$enc = @(
  "-c:v", "mpeg2video", "-pix_fmt", "yuv420p", "-b:v", "5M",
  "-g", "$gop", "-force_key_frames", $kf,
  "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
  "-f", "segment",
  "-segment_time", "$SegmentSeconds",
  "-segment_format", "mxf",
  "-reset_timestamps", "1",
  "-segment_list", "playlist.m3u8",
  "-segment_list_type", "m3u8",
  "clip%03d.mxf"
)

Push-Location $OutDir
try {
  if ($Input -and (Test-Path $Input)) {
    Write-Host "[make-hls] segmenting $Input -> $OutDir"
    & $ff -y -i $Input -t $Duration @enc
  } else {
    Write-Host "[make-hls] generating ${Duration}s testsrc ($Size @ ${Fps}fps) -> $OutDir"
    & $ff -y `
      -f lavfi -i "testsrc=size=$Size`:rate=$Fps`:duration=$Duration" `
      -f lavfi -i "sine=frequency=440:duration=$Duration" @enc
  }
} finally { Pop-Location }

if ($LASTEXITCODE -ne 0) { throw "ffmpeg exited with code $LASTEXITCODE" }

Write-Host ""
Write-Host "[make-hls] done. Clips + playlist in $OutDir"
Get-ChildItem $OutDir | Select-Object Name, Length | Format-Table -AutoSize
Write-Host "----- playlist.m3u8 -----"
Get-Content "$OutDir\playlist.m3u8"
