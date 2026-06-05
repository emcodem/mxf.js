/**
 * Wraps an emscripten-compiled ffmpeg decoder module.
 *
 * Expected C exports (same naming as the bundled mpeg2-decoder.wasm demo):
 *   dec_create(codec: string, w: int, h: int) → ctx
 *   dec_send_packet(ctx, ptr, len) → int
 *   dec_receive_frame(ctx) → 1 (frame ready) | 0 (buffering)
 *   dec_frame_width(ctx) → int
 *   dec_frame_height(ctx) → int
 *   dec_get_rgba(ctx, rgbaPtr) → 0 on success
 *   dec_free(ctx) → void
 *
 * ffmpeg handles B-frame display reordering internally, so frames come out in
 * presentation order. No held-anchor or open-GOP suppression needed.
 */

export interface RgbaFrame {
  width: number;
  height: number;
  /** RGBA pixel data, width × height × 4 bytes. */
  data: Uint8ClampedArray;
  /** 1=I (keyframe), 2=P, 3=B, 0=unknown. */
  pictType: number;
}

interface EmscriptenModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cwrap(name: string, returnType: string | null, argTypes: string[]): (...a: any[]) => any;
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(ptr: number): void;
}

export class WasmFfmpegDecoder {
  private ctx: number;
  private _rgbaPtr = 0;
  private _rgbaCap = 0;

  // Bound cwrap wrappers typed after construction.
  private readonly _decSendPacket: (ctx: number, ptr: number, len: number) => number;
  private readonly _decReceiveFrame: (ctx: number) => number;
  private readonly _decWidth:  (ctx: number) => number;
  private readonly _decHeight: (ctx: number) => number;
  private readonly _decGetRgba:  (ctx: number, ptr: number) => number;
  private readonly _decPictType: (ctx: number) => number;
  private readonly _decCreate:   (codec: string, w: number, h: number) => number;
  private readonly _decFree:     (ctx: number) => void;

  private constructor(
    private readonly mod: EmscriptenModule,
    private readonly ffmpegCodec: string,
  ) {
    this._decCreate       = mod.cwrap('dec_create',         'number', ['string', 'number', 'number']);
    this._decSendPacket   = mod.cwrap('dec_send_packet',    'number', ['number', 'number', 'number']);
    this._decReceiveFrame = mod.cwrap('dec_receive_frame',  'number', ['number']);
    this._decWidth        = mod.cwrap('dec_frame_width',    'number', ['number']);
    this._decHeight       = mod.cwrap('dec_frame_height',   'number', ['number']);
    this._decGetRgba      = mod.cwrap('dec_get_rgba',       'number', ['number', 'number']);
    this._decPictType     = mod.cwrap('dec_frame_pict_type','number', ['number']);
    this._decFree         = mod.cwrap('dec_free',           null,     ['number']);

    this.ctx = this._decCreate(ffmpegCodec, 0, 0);
    if (!this.ctx) throw new Error(`WasmFfmpegDecoder: dec_create failed for codec '${ffmpegCodec}'`);
  }

  /**
   * Load the emscripten .js factory module from the given URL and open a decoder context.
   * Requires a module worker (the worker must be spawned with { type: 'module' }).
   */
  static async load(moduleUrl: string, ffmpegCodec: string): Promise<WasmFfmpegDecoder> {
    // Dynamic import of the emscripten-generated ES module factory.
    // @vite-ignore: runtime URL, not a build-time dependency.
    const mod = await import(/* @vite-ignore */ moduleUrl) as { default: () => Promise<EmscriptenModule> };
    const instance = await mod.default();
    return new WasmFfmpegDecoder(instance, ffmpegCodec);
  }

  /**
   * Push a chunk of elementary-stream bytes; return any frames that are now ready.
   * Chunk size is arbitrary — the wasm mpegvideo parser handles boundaries internally.
   */
  decode(esBytes: Uint8Array): RgbaFrame[] {
    const ptr = this.mod._malloc(esBytes.length);
    if (!ptr) throw new Error(`WasmFfmpegDecoder: _malloc(${esBytes.length}) returned 0 — wasm heap OOM`);
    this.mod.HEAPU8.set(esBytes, ptr);
    const ret = this._decSendPacket(this.ctx, ptr, esBytes.length);
    this.mod._free(ptr);
    if (ret !== 0) console.warn(`[WasmFfmpegDecoder] dec_send_packet returned ${ret}`);
    return this._drain();
  }

  /**
   * Nudge the mpegvideo parser to emit any picture it has buffered.
   *
   * The mpegvideo parser is stream-oriented: it only considers a picture complete when it sees
   * the NEXT picture's start code. After feeding exactly one edit unit (e.g. for a probe), the
   * last slice sits in the parser's internal buffer and neither draining nor a NULL-packet flush
   * reaches it. Feeding the MPEG-2 sequence_end_code (0x000001B7) signals end-of-sequence,
   * which forces the parser to flush the buffered picture into the decoder output queue.
   */
  nudgeParser(): RgbaFrame[] {
    return this.decode(new Uint8Array([0x00, 0x00, 0x01, 0xb7]));
  }

  /** Signal end-of-stream to the decoder; return any remaining buffered frames. */
  flush(): RgbaFrame[] {
    const ret = this._decSendPacket(this.ctx, 0, 0);
    if (ret !== 0) console.warn(`[WasmFfmpegDecoder] dec_send_packet(flush) returned ${ret}`);
    return this._drain();
  }

  /** Recreate the decoder context (called on seek to drop stale reference frames). */
  reset(): void {
    if (this._rgbaPtr) { this.mod._free(this._rgbaPtr); this._rgbaPtr = 0; this._rgbaCap = 0; }
    this._decFree(this.ctx);
    this.ctx = this._decCreate(this.ffmpegCodec, 0, 0);
    if (!this.ctx) throw new Error('WasmFfmpegDecoder: dec_create failed on reset');
  }

  close(): void {
    if (this._rgbaPtr) { this.mod._free(this._rgbaPtr); this._rgbaPtr = 0; this._rgbaCap = 0; }
    if (this.ctx) { this._decFree(this.ctx); this.ctx = 0; }
  }

  private _drain(): RgbaFrame[] {
    const frames: RgbaFrame[] = [];
    let rc: number;
    while ((rc = this._decReceiveFrame(this.ctx)) === 1) {
      const w = this._decWidth(this.ctx);
      const h = this._decHeight(this.ctx);
      const need = w * h * 4;
      if (need > this._rgbaCap) {
        if (this._rgbaPtr) this.mod._free(this._rgbaPtr);
        this._rgbaPtr = this.mod._malloc(need);
        if (!this._rgbaPtr) {
          // wasm heap OOM — can't allocate output buffer for this frame
          this._rgbaCap = 0;
          throw new Error(`WasmFfmpegDecoder: _malloc(${need}) returned 0 — wasm heap OOM allocating ${w}×${h} RGBA output buffer (~${(need/1048576).toFixed(1)} MB)`);
        }
        this._rgbaCap = need;
      }
      const rgbaRet = this._decGetRgba(this.ctx, this._rgbaPtr);
      if (rgbaRet !== 0) {
        console.warn(`[WasmFfmpegDecoder] dec_get_rgba returned ${rgbaRet} for ${w}×${h} frame`);
        continue;
      }
      // Slice a copy: the wasm buffer is reused on the next frame.
      const raw = this.mod.HEAPU8.slice(this._rgbaPtr, this._rgbaPtr + need);
      frames.push({ width: w, height: h, data: new Uint8ClampedArray(raw.buffer), pictType: this._decPictType(this.ctx) });
    }
    if (rc !== 0) console.log(`[WasmFfmpegDecoder] dec_receive_frame returned ${rc} (0 = need more input, expected)`);
    return frames;
  }
}
