import { describe, it, expect } from 'vitest';
import { parseHlsPlaylist } from '../src/playlist/hls-parser.js';

const BASE = 'https://example.com/live/index.m3u8';

describe('parseHlsPlaylist', () => {
  it('parses a static VOD playlist with ENDLIST', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:10.0,',
      'clip0.mxf',
      '#EXTINF:8.5,',
      'clip1.mxf',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const pl = parseHlsPlaylist(text, BASE);
    expect(pl.endList).toBe(true);
    expect(pl.targetDuration).toBe(10);
    expect(pl.mediaSequence).toBe(0);
    expect(pl.segments).toEqual([
      { uri: 'https://example.com/live/clip0.mxf', durationSec: 10.0 },
      { uri: 'https://example.com/live/clip1.mxf', durationSec: 8.5 },
    ]);
  });

  it('treats a playlist without ENDLIST as live', () => {
    const text = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:4,\na.mxf\n';
    const pl = parseHlsPlaylist(text, BASE);
    expect(pl.endList).toBe(false);
    expect(pl.mediaSequence).toBe(5);
    expect(pl.segments).toHaveLength(1);
  });

  it('resolves absolute and relative segment URIs against the manifest URL', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:4,',
      'sub/a.mxf',
      '#EXTINF:4,',
      '/abs/b.mxf',
      '#EXTINF:4,',
      'https://cdn.example.net/c.mxf',
    ].join('\n');
    const pl = parseHlsPlaylist(text, BASE);
    expect(pl.segments.map(s => s.uri)).toEqual([
      'https://example.com/live/sub/a.mxf',
      'https://example.com/abs/b.mxf',
      'https://cdn.example.net/c.mxf',
    ]);
  });

  it('ignores unknown tags and blank lines, and tolerates a missing #EXTM3U header', () => {
    const text = '\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z\n#EXTINF:2.0,title here\nx.mxf\n\n';
    const pl = parseHlsPlaylist(text, BASE);
    expect(pl.segments).toEqual([{ uri: 'https://example.com/live/x.mxf', durationSec: 2.0 }]);
  });

  it('defaults media sequence to 0 and duration to 0 when absent', () => {
    const pl = parseHlsPlaylist('#EXTM3U\na.mxf\n', BASE);
    expect(pl.mediaSequence).toBe(0);
    expect(pl.segments[0].durationSec).toBe(0);
  });
});
