@echo off
REM ===========================================================================
REM make-test-clips.bat - generate MXF test clips for mxf.js Tier 3 verification
REM
REM Creates the corpus needed for the genericisation work (EXCEPT the OP-Atom
REM file, which is provided separately). Sources are synthetic (testsrc2 + sine
REM tones) so no input media is required.
REM
REM Requires: ffmpeg on PATH (built with libx264 + mxf muxer).
REM Usage:    make-test-clips.bat [output_dir]   (default output dir: C:\temp\mxf.js)
REM
REM NOTE: MXF audio is ALWAYS PCM - there is no separate "AES3" codec. What the
REM code calls "AES3" is just D-10's particular 8-channel PCM layout (a 4-byte
REM header + 32-bit words), not a different format. File (4) below uses a non-8
REM channel PCM layout to verify the channel count is taken from the descriptor
REM (not assumed to be 8), which is what D1.5 needs.
REM ===========================================================================

setlocal
set "OUT=%~1"
if "%OUT%"=="" set "OUT=C:\temp\mxf.js"
set "DUR=5"

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ERROR: ffmpeg not found on PATH.
  exit /b 1
)
if not exist "%OUT%" mkdir "%OUT%"

echo Output dir: %OUT%
echo.

REM ---------------------------------------------------------------------------
REM 1) UHD XAVC-like: H.264 High 4:2:2 INTRA, 3840x2160 @ 25p, OP1a, + stereo 24-bit PCM
REM    Tests D1.7: SPS-derived UHD dimensions in the avc1 box. Intra-only + High 4:2:2
REM    mirrors XAVC-Intra. (Chrome decodes High 4:2:2 in software; UHD 4:2:2 playback may
REM    be heavy - this primarily verifies mxf.js parsing / init-segment dimensions.)
echo [1/4] UHD XAVC (3840x2160p25, H.264 High 4:2:2 intra)...
ffmpeg -y -hide_banner -loglevel error ^
  -f lavfi -i testsrc2=size=3840x2160:rate=25 ^
  -f lavfi -i sine=frequency=440:sample_rate=48000 ^
  -t %DUR% ^
  -c:v libx264 -profile:v high422 -pix_fmt yuv422p -x264-params "keyint=1:no-scenecut=1" ^
  -c:a pcm_s24le -ac 2 -ar 48000 ^
  -f mxf "%OUT%\uhd_xavc_3840x2160p25.mxf"
if errorlevel 1 (echo   FAILED) else (echo   ok)

REM ---------------------------------------------------------------------------
REM 2) NTSC 29.97: MPEG-2 Long-GOP, 1920x1080 @ 30000/1001, OP1a, + stereo 24-bit PCM
REM    Tests non-PAL edit rate (30000/1001) end-to-end: timestamps, fps, chunk sizing,
REM    B-frame decode at NTSC rate.
echo [2/4] NTSC MPEG-2 (1920x1080 @ 30000/1001, Long-GOP)...
ffmpeg -y -hide_banner -loglevel error ^
  -f lavfi -i testsrc2=size=1920x1080:rate=30000/1001 ^
  -f lavfi -i sine=frequency=440:sample_rate=48000 ^
  -t %DUR% ^
  -c:v mpeg2video -pix_fmt yuv420p -b:v 25M -g 12 -bf 2 ^
  -c:a pcm_s24le -ac 2 -ar 48000 ^
  -f mxf "%OUT%\ntsc_mpeg2_1080_2997.mxf"
if errorlevel 1 (echo   FAILED) else (echo   ok)

REM ---------------------------------------------------------------------------
REM 3) Multi-audio: H.264 1080 @ 25p + TWO separate stereo 24-bit PCM audio tracks, OP1a
REM    Tests D1.1 multi-track audio (mxf.js currently assumes a single audio track).
echo [3/4] Multi-audio (1080p25 + two stereo PCM tracks)...
ffmpeg -y -hide_banner -loglevel error ^
  -f lavfi -i testsrc2=size=1920x1080:rate=25 ^
  -f lavfi -i sine=frequency=440:sample_rate=48000 ^
  -f lavfi -i sine=frequency=880:sample_rate=48000 ^
  -t %DUR% ^
  -map 0:v -map 1:a -map 2:a ^
  -c:v libx264 -profile:v high -pix_fmt yuv420p -g 12 ^
  -c:a pcm_s24le -ac 2 -ar 48000 ^
  -f mxf "%OUT%\multitrack_2audio_1080p25.mxf"
if errorlevel 1 (echo   FAILED) else (echo   ok)

REM ---------------------------------------------------------------------------
REM 4) Non-8ch multichannel PCM: H.264 1080 @ 25p + single 6-channel (5.1) 24-bit PCM, OP1a
REM    Tests D1.5: channel count taken from the descriptor (not assumed 8). See the top note -
REM    MXF audio is always PCM; "AES3" is just D-10's 8-channel PCM layout.
echo [4/4] Multichannel PCM (1080p25 + 6-channel PCM)...
ffmpeg -y -hide_banner -loglevel error ^
  -f lavfi -i testsrc2=size=1920x1080:rate=25 ^
  -f lavfi -i sine=frequency=440:sample_rate=48000 ^
  -t %DUR% ^
  -c:v libx264 -profile:v high -pix_fmt yuv420p -g 12 ^
  -c:a pcm_s24le -ac 6 -ar 48000 ^
  -f mxf "%OUT%\multichannel_6ch_1080p25.mxf"
if errorlevel 1 (echo   FAILED) else (echo   ok)

echo.
echo Done.
dir /b "%OUT%\*.mxf"
endlocal
