/**
 * Minimal WebAssembly binary encoder (WASM MVP subset).
 *
 * The x86 JIT compiles decoded basic blocks to real WASM bytecode using this
 * encoder, then instantiates the result with `new WebAssembly.Module`. This is
 * the runtime half of the design-doc requirement "每条 x86 指令翻译成等价的
 * WASM 指令序列" (4.1.5) and it avoids a native C++/WASI toolchain until one
 * is available in CI.
 */

export type ValType = 'i32' | 'i64' | 'f32' | 'f64';

const VAL_TYPE_CODE: Record<ValType, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

/** Unsigned LEB128 (section sizes, indices, memarg offsets). */
function uleb(value: number): number[] {
  const out: number[] = [];
  let n = value >>> 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

/** Signed LEB128 for 32-bit integers (i32.const, function indices). */
function sleb32(value: number): number[] {
  const out: number[] = [];
  let n = value | 0;
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
      more = false;
    } else {
      b |= 0x80;
    }
    out.push(b);
  }
  return out;
}

/** Signed LEB128 for 64-bit values stored as JS safe integers (i64.const). */
function sleb64(value: number): number[] {
  const out: number[] = [];
  let n = value;
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n = Math.floor(n / 128); // arithmetic shift on arbitrary precision
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
      more = false;
    } else {
      b |= 0x80;
    }
    out.push(b);
  }
  return out;
}

interface LocalDecl {
  count: number;
  type: ValType;
}

/**
 * A single WASM function body builder.
 * Locals are referenced by index: declared locals come first, then the
 * function parameters (the JIT blocks take no parameters).
 */
export class WasmFunction {
  readonly locals: ValType[] = [];
  private readonly buf: number[] = [];
  private labelStack: number[] = [];
  private maxLocals = 0;

  declareLocal(type: ValType): number {
    const idx = this.locals.length;
    this.locals.push(type);
    this.maxLocals = Math.max(this.maxLocals, this.locals.length);
    return idx;
  }

  // ---- control flow ----
  unreachable(): void {
    this.buf.push(0x00);
  }
  nop(): void {
    this.buf.push(0x01);
  }
  block(): number {
    this.buf.push(0x02, 0x40);
    this.labelStack.push(this.labelStack.length);
    return this.labelStack.length - 1;
  }
  loop(): number {
    this.buf.push(0x03, 0x40);
    this.labelStack.push(this.labelStack.length);
    return this.labelStack.length - 1;
  }
  ifBlock(): number {
    this.buf.push(0x04, 0x40);
    this.labelStack.push(this.labelStack.length);
    return this.labelStack.length - 1;
  }
  elseBlock(): void {
    this.buf.push(0x05);
  }
  end(): void {
    this.buf.push(0x0b);
    this.labelStack.pop();
  }
  /** br to the label (by id returned from `block`/`loop`/`ifBlock`). */
  br(label: number): void {
    const depth = this.labelDepth(label);
    this.buf.push(0x0c, ...uleb(depth));
  }
  brIf(label: number): void {
    const depth = this.labelDepth(label);
    this.buf.push(0x0d, ...uleb(depth));
  }

  /** Converts a label id to the relative depth seen from the current position. */
  private labelDepth(label: number): number {
    const depth = this.labelStack.length - 1 - label;
    if (depth < 0) throw new Error(`br to an already-closed label ${label}`);
    return depth;
  }
  return_(): void {
    this.buf.push(0x0f);
  }
  call(funcIndex: number): void {
    this.buf.push(0x10, ...uleb(funcIndex));
  }

  // ---- variable access ----
  localGet(index: number): void {
    this.buf.push(0x20, ...uleb(index));
  }
  localSet(index: number): void {
    this.buf.push(0x21, ...uleb(index));
  }
  localTee(index: number): void {
    this.buf.push(0x22, ...uleb(index));
  }

  // ---- constants ----
  i32Const(value: number): void {
    this.buf.push(0x41, ...sleb32(value));
  }
  i64Const(value: number): void {
    this.buf.push(0x42, ...sleb64(value));
  }

  // ---- memory access (memarg: align log2 then offset uleb) ----
  private memarg(alignLog2: number, offset: number): void {
    this.buf.push(...uleb(alignLog2), ...uleb(offset));
  }
  i32Load(offset = 0): void {
    this.buf.push(0x28);
    this.memarg(2, offset);
  }
  i32Load8S(offset = 0): void {
    this.buf.push(0x2c);
    this.memarg(0, offset);
  }
  i32Load8U(offset = 0): void {
    this.buf.push(0x2d);
    this.memarg(0, offset);
  }
  i32Load16S(offset = 0): void {
    this.buf.push(0x2e);
    this.memarg(1, offset);
  }
  i32Load16U(offset = 0): void {
    this.buf.push(0x2f);
    this.memarg(1, offset);
  }
  i32Store(offset = 0): void {
    this.buf.push(0x36);
    this.memarg(2, offset);
  }
  i32Store8(offset = 0): void {
    this.buf.push(0x3a);
    this.memarg(0, offset);
  }
  i32Store16(offset = 0): void {
    this.buf.push(0x3b);
    this.memarg(1, offset);
  }
  i64Load(offset = 0): void {
    this.buf.push(0x29);
    this.memarg(3, offset);
  }
  i64Store(offset = 0): void {
    this.buf.push(0x37);
    this.memarg(3, offset);
  }

  // ---- i32 comparisons ----
  i32Eqz(): void {
    this.buf.push(0x45);
  }
  i32Eq(): void {
    this.buf.push(0x46);
  }
  i32Ne(): void {
    this.buf.push(0x47);
  }
  i32LtS(): void {
    this.buf.push(0x48);
  }
  i32LtU(): void {
    this.buf.push(0x49);
  }
  i32GtS(): void {
    this.buf.push(0x4a);
  }
  i32GtU(): void {
    this.buf.push(0x4b);
  }
  i32LeS(): void {
    this.buf.push(0x4c);
  }
  i32LeU(): void {
    this.buf.push(0x4d);
  }
  i32GeS(): void {
    this.buf.push(0x4e);
  }
  i32GeU(): void {
    this.buf.push(0x4f);
  }

  // ---- i64 comparisons ----
  i64Eqz(): void {
    this.buf.push(0x50);
  }
  i64Eq(): void {
    this.buf.push(0x51);
  }
  i64Ne(): void {
    this.buf.push(0x52);
  }
  i64LtS(): void {
    this.buf.push(0x53);
  }
  i64LtU(): void {
    this.buf.push(0x54);
  }
  i64GtS(): void {
    this.buf.push(0x55);
  }
  i64GtU(): void {
    this.buf.push(0x56);
  }
  i64LeU(): void {
    this.buf.push(0x58);
  }
  i64GeU(): void {
    this.buf.push(0x5a);
  }

  // ---- i32 numeric ----
  i32Clz(): void {
    this.buf.push(0x67);
  }
  i32Ctz(): void {
    this.buf.push(0x68);
  }
  i32Popcnt(): void {
    this.buf.push(0x69);
  }
  i32Add(): void {
    this.buf.push(0x6a);
  }
  i32Sub(): void {
    this.buf.push(0x6b);
  }
  i32Mul(): void {
    this.buf.push(0x6c);
  }
  i32DivS(): void {
    this.buf.push(0x6d);
  }
  i32DivU(): void {
    this.buf.push(0x6e);
  }
  i32RemS(): void {
    this.buf.push(0x6f);
  }
  i32RemU(): void {
    this.buf.push(0x70);
  }
  i32And(): void {
    this.buf.push(0x71);
  }
  i32Or(): void {
    this.buf.push(0x72);
  }
  i32Xor(): void {
    this.buf.push(0x73);
  }
  i32Shl(): void {
    this.buf.push(0x74);
  }
  i32ShrS(): void {
    this.buf.push(0x75);
  }
  i32ShrU(): void {
    this.buf.push(0x76);
  }
  i32Rotl(): void {
    this.buf.push(0x77);
  }
  i32Rotr(): void {
    this.buf.push(0x78);
  }

  // ---- i64 numeric ----
  i64Clz(): void {
    this.buf.push(0x79);
  }
  i64Ctz(): void {
    this.buf.push(0x7a);
  }
  i64Popcnt(): void {
    this.buf.push(0x7b);
  }
  i64Add(): void {
    this.buf.push(0x7c);
  }
  i64Sub(): void {
    this.buf.push(0x7d);
  }
  i64ExtendI32S(): void {
    this.buf.push(0xac);
  }
  i64ExtendI32U(): void {
    this.buf.push(0xad);
  }
  i64Mul(): void {
    this.buf.push(0x7e);
  }
  i64DivS(): void {
    this.buf.push(0x7f);
  }
  i64DivU(): void {
    this.buf.push(0x80);
  }
  i64RemS(): void {
    this.buf.push(0x81);
  }
  i64RemU(): void {
    this.buf.push(0x82);
  }
  i64And(): void {
    this.buf.push(0x83);
  }
  i64Or(): void {
    this.buf.push(0x84);
  }
  i64Xor(): void {
    this.buf.push(0x85);
  }
  i64Shl(): void {
    this.buf.push(0x86);
  }
  i64ShrS(): void {
    this.buf.push(0x87);
  }
  i64ShrU(): void {
    this.buf.push(0x88);
  }
  i64Rotl(): void {
    this.buf.push(0x89);
  }
  i64Rotr(): void {
    this.buf.push(0x8a);
  }
  i32WrapI64(): void {
    this.buf.push(0xa7);
  }

  // ---- f64 memory + conversions (for x87 FILD/FISTP) ----
  f64Load(offset = 0): void {
    this.buf.push(0x2a);
    this.memarg(3, offset);
  }
  f64Store(offset = 0): void {
    this.buf.push(0x39);
    this.memarg(3, offset);
  }
  f64ConvertI32S(): void {
    this.buf.push(0xb7);
  }
  f64ConvertI32U(): void {
    this.buf.push(0xb8);
  }
  i32TruncF64S(): void {
    this.buf.push(0xaa);
  }
  i32TruncF64U(): void {
    this.buf.push(0xab);
  }

  // ---- parametric ----
  select(): void {
    this.buf.push(0x1b);
  }
  drop(): void {
    this.buf.push(0x1a);
  }

  /** Serialize this function body into code-section bytes. */
  codeSectionEntry(): { localsDecl: number[]; body: number[] } {
    // locals: run-length encoded <count> <valtype>
    const decl: LocalDecl[] = [];
    for (const type of this.locals) {
      const last = decl[decl.length - 1];
      if (last && last.type === type) last.count += 1;
      else decl.push({ count: 1, type });
    }
    const localsDecl: number[] = [...uleb(decl.length)];
    for (const d of decl) {
      localsDecl.push(...uleb(d.count), VAL_TYPE_CODE[d.type]);
    }
    return { localsDecl, body: this.buf };
  }

  get labelCount(): number {
    return this.labelStack.length;
  }
}

interface WasmExport {
  name: string;
  kind: number; // 0=func 1=table 2=memory 3=global
  index: number;
}

interface MemoryImport {
  min: number;
  max?: number;
}

/**
 * WASM module builder producing the full binary. Imports are placed first so
 * their function indices precede the defined functions.
 */
export class WasmModuleBuilder {
  private readonly types: { params: ValType[]; results: ValType[] }[] = [];
  private readonly typeIds = new Map<string, number>();
  private readonly funcImports: { typeIdx: number }[] = [];
  private memoryImport: MemoryImport | null = null;
  private readonly definedFuncTypes: number[] = [];
  private readonly exports: WasmExport[] = [];
  private readonly funcs: WasmFunction[] = [];

  /** Returns the type section index (function type id). */
  addType(params: ValType[], results: ValType[]): number {
    const key = `${params.join(',')}->${results.join(',')}`;
    const existing = this.typeIds.get(key);
    if (existing !== undefined) return existing;
    const idx = this.types.length;
    this.types.push({ params, results });
    this.typeIds.set(key, idx);
    return idx;
  }

  /** Imports the shared linear memory; returns its module-relative index. */
  addMemoryImport(module: string, name: string, min: number, max?: number): number {
    this.memoryImport = { min, max };
    void module;
    void name;
    return 0;
  }

  /** Declares an imported function (used only when calling helpers). */
  addFunctionImport(typeIdx: number): number {
    const idx = this.funcImports.length;
    this.funcImports.push({ typeIdx });
    return idx;
  }

  /**
   * Defines a new function with the given type and returns its index.
   * Pass an existing `WasmFunction` to emit a pre-built body.
   */
  defineFunction(typeIdx: number, existing?: WasmFunction): WasmFunction {
    const fn = existing ?? new WasmFunction();
    this.definedFuncTypes.push(typeIdx);
    this.funcs.push(fn);
    return fn;
  }

  /** Exports a defined or imported function. */
  exportFunction(name: string, index: number): void {
    this.exports.push({ name, kind: 0, index });
  }

  /** Export the shared memory under a stable name (for JS-side access). */
  exportMemory(name: string): void {
    this.exports.push({ name, kind: 2, index: 0 });
  }

  build(): Uint8Array {
    const out: number[] = [];
    // magic + version
    out.push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

    // 1. type section
    if (this.types.length > 0) {
      const body: number[] = [...uleb(this.types.length)];
      for (const t of this.types) {
        body.push(0x60);
        body.push(...uleb(t.params.length));
        for (const p of t.params) body.push(VAL_TYPE_CODE[p]);
        body.push(...uleb(t.results.length));
        for (const r of t.results) body.push(VAL_TYPE_CODE[r]);
      }
      this.pushSection(out, 1, body);
    }

    // 2. import section
    const imports: { module: string; name: string; bytes: number[] }[] = [];
    for (const fi of this.funcImports) {
      imports.push({ module: 'env', name: 'import', bytes: [0x00, ...uleb(fi.typeIdx)] });
    }
    if (this.memoryImport) {
      imports.push({
        module: 'env',
        name: 'memory',
        bytes: this.memoryImport.max === undefined ? [0x02, 0x00, ...uleb(this.memoryImport.min)] : [0x02, 0x01, ...uleb(this.memoryImport.min), ...uleb(this.memoryImport.max)],
      });
    }
    if (imports.length > 0) {
      const body: number[] = [...uleb(imports.length)];
      for (const imp of imports) {
        body.push(...uleb(imp.module.length));
        for (const c of imp.module) body.push(c.charCodeAt(0));
        body.push(...uleb(imp.name.length));
        for (const c of imp.name) body.push(c.charCodeAt(0));
        body.push(...imp.bytes);
      }
      this.pushSection(out, 2, body);
    }

    // 3. function section (defined functions)
    if (this.definedFuncTypes.length > 0) {
      const body: number[] = [...uleb(this.definedFuncTypes.length)];
      for (const t of this.definedFuncTypes) body.push(...uleb(t));
      this.pushSection(out, 3, body);
    }

    // 7. export section
    if (this.exports.length > 0) {
      const body: number[] = [...uleb(this.exports.length)];
      for (const e of this.exports) {
        body.push(...uleb(e.name.length));
        for (const c of e.name) body.push(c.charCodeAt(0));
        body.push(e.kind, ...uleb(e.index));
      }
      this.pushSection(out, 7, body);
    }

    // 10. code section
    if (this.funcs.length > 0) {
      const body: number[] = [...uleb(this.funcs.length)];
      for (const fn of this.funcs) {
        const { localsDecl, body: fnBody } = fn.codeSectionEntry();
        const size = [...uleb(localsDecl.length + fnBody.length)];
        body.push(...size, ...localsDecl, ...fnBody);
      }
      this.pushSection(out, 10, body);
    }

    return new Uint8Array(out);
  }

  private pushSection(out: number[], id: number, body: number[]): void {
    out.push(id);
    out.push(...uleb(body.length));
    out.push(...body);
  }
}
