/**
 * Loader for the WASM pixel kernels (built from asm/kernels.ts → asm/build/kernels.wasm).
 *
 * Instantiated once per worker (or per Node test) via {@link ensureKernels}; the decoder then reads
 * the singleton synchronously via {@link getKernels}. When the kernels are unavailable (WASM/SIMD
 * unsupported, instantiation blocked by a strict CSP, or simply never loaded) getKernels() returns
 * null and the pure-JS {@link Mpeg2Decoder} keeps using plain JS-array planes — the fallback path.
 *
 * The byte source is supplied by the caller (read from disk in Node tests, fetched/bundled in the
 * worker) so this module stays environment-agnostic.
 */

export interface Kernels {
  memory: WebAssembly.Memory;
  /** Largest luma / chroma plane (bytes) the arena can hold; bigger frames fall back to JS arrays. */
  maxYBytes: number;
  maxCBytes: number;
  /** Plane base byte-offsets, indexed by slot 0=current, 1=forward, 2=backward. */
  planeY: readonly [number, number, number];
  planeCr: readonly [number, number, number];
  planeCb: readonly [number, number, number];
  /** IDCT scratch: write 64 premultiplied i32 coefficients at idctSrc, call idct(), read 64 at idctDst. */
  idctSrc: number;
  idctDst: number;
  idct(): void;
  /** IDCT the SRC coefficients, then add(inter)/copy(intra) the residual into a plane at byte offset `index` (stride `scan`); writes past `planeLen` are dropped (matches JS). */
  idctAddBlock(planePtr: number, index: number, scan: number, intra: number, planeLen: number): void;
  /** DC-only fast path: fill(intra)/add(inter) a constant 8×8 block (`dc` = (coeff0+128)>>8); writes past `planeLen` are dropped. */
  dcBlock(planePtr: number, index: number, scan: number, intra: number, dc: number, planeLen: number): void;
}

let singleton: Kernels | null = null;
let pending: Promise<Kernels | null> | null = null;

/** The instantiated kernels, or null if not (yet) available. Synchronous — for the decoder hot path. */
export function getKernels(): Kernels | null {
  return singleton;
}

/**
 * Instantiate the kernels from the given wasm bytes (idempotent; first call wins). Returns null and
 * leaves getKernels() null if instantiation fails for any reason — the caller then runs the JS path.
 */
export async function ensureKernels(bytes: BufferSource): Promise<Kernels | null> {
  if (singleton) return singleton;
  if (!pending) pending = instantiate(bytes);
  return pending;
}

async function instantiate(bytes: BufferSource): Promise<Kernels | null> {
  try {
    const { instance } = await WebAssembly.instantiate(bytes, { env: { abort() {} } });
    const ex = instance.exports as Record<string, CallableFunction> & { memory: WebAssembly.Memory };
    // The arena is reserved as static memory (see asm/kernels.ts), so the buffer is already sized and
    // never grows — views taken below stay valid for the module's lifetime.
    const py = ex.planeYPtr as (s: number) => number;
    const pcr = ex.planeCrPtr as (s: number) => number;
    const pcb = ex.planeCbPtr as (s: number) => number;
    singleton = {
      memory: ex.memory,
      maxYBytes: (ex.maxYBytes as () => number)(),
      maxCBytes: (ex.maxCBytes as () => number)(),
      planeY: [py(0), py(1), py(2)],
      planeCr: [pcr(0), pcr(1), pcr(2)],
      planeCb: [pcb(0), pcb(1), pcb(2)],
      idctSrc: (ex.idctSrcPtr as () => number)(),
      idctDst: (ex.idctDstPtr as () => number)(),
      idct: ex.idct as () => void,
      idctAddBlock: ex.idctAddBlock as (p: number, i: number, s: number, intra: number, len: number) => void,
      dcBlock: ex.dcBlock as (p: number, i: number, s: number, intra: number, dc: number, len: number) => void,
    };
    return singleton;
  } catch {
    singleton = null;
    return null;
  }
}

/** Test-only: drop the singleton so a test can re-instantiate or force the JS path. */
export function __resetKernelsForTest(): void {
  singleton = null;
  pending = null;
}
