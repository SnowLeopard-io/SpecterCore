"""Disassemble a window of a PE .text section to study frame contracts."""
import sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

path = sys.argv[1] if len(sys.argv) > 1 else r"D:\Downloads\TraeWork_CN-Setup-x64.exe"
start = int(sys.argv[2], 16)
length = int(sys.argv[3], 16)
image = open(path, "rb").read()

e_lfanew = int.from_bytes(image[0x3c:0x40], "little")
coff = e_lfanew + 4
num_sections = int.from_bytes(image[coff + 2 : coff + 4], "little")
opt_size = int.from_bytes(image[coff + 16 : coff + 18], "little")
sec_table = coff + 20 + opt_size

secs = []
for i in range(num_sections):
    s = sec_table + i * 40
    name = image[s : s + 8].rstrip(b"\0").decode("latin1")
    vsize = int.from_bytes(image[s + 8 : s + 12], "little")
    va = int.from_bytes(image[s + 12 : s + 16], "little")
    rsize = int.from_bytes(image[s + 16 : s + 20], "little")
    roff = int.from_bytes(image[s + 20 : s + 24], "little")
    secs.append((name, va, vsize, rsize, roff))
    print(f"section {name}: va=0x{va:x} vsize=0x{vsize:x} raw=0x{roff:x}+0x{rsize:x}")

BASE = 0x400000

def file_offset(addr):
    for name, va, vsize, rsize, roff in secs:
        if BASE + va <= addr < BASE + va + max(vsize, rsize):
            return roff + (addr - BASE - va)
    return None

off = file_offset(start)
if off is None:
    print(f"address 0x{start:x} not in any section")
    sys.exit(1)
code = image[off : off + length]
md = Cs(CS_ARCH_X86, CS_MODE_32)
md.detail = False
for ins in md.disasm(code, start):
    print(f"0x{ins.address:08x}: {ins.mnemonic:8s} {ins.op_str}")
