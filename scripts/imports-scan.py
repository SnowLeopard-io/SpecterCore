import struct

image = open(r"C:\Windows\SysWOW64\notepad.exe", "rb").read()

def u16(o):
    return struct.unpack_from("<H", image, o)[0]

def u32(o):
    return struct.unpack_from("<I", image, o)[0]

def u64(o):
    return struct.unpack_from("<Q", image, o)[0]

e_lfanew = u32(0x3C)
coff = e_lfanew + 4
nsec = u16(coff + 2)
opt_size = u16(coff + 16)
sec_tbl = coff + 20 + opt_size
magic = u16(e_lfanew + 24)
base = u32(e_lfanew + 24 + 28)
dd = (e_lfanew + 24) + (112 if magic == 0x20B else 96)
imp_rva = u32(dd + 8)

secs = []
for i in range(nsec):
    s = sec_tbl + i * 40
    va = u32(s + 12)
    vs = u32(s + 8)
    rs = u32(s + 16)
    ro = u32(s + 20)
    secs.append((va, max(vs, rs), ro))

def r2o(rva):
    for va, span, ro in secs:
        if va <= rva < va + span:
            return ro + (rva - va)
    return None

def cstr(off):
    end = image.index(b"\0", off)
    return image[off:end].decode("latin1")

def cwstr(off):
    out = []
    i = off
    while i + 1 < len(image):
        c = u16(i)
        if c == 0:
            break
        out.append(chr(c))
        i += 2
    return "".join(out)

print("image base:", hex(base))
o = r2o(imp_rva)
i = 0
while True:
    d = o + i * 20
    oft = u32(d)
    ts = u32(d + 4)
    fwd = u32(d + 8)
    name_rva = u32(d + 12)
    ft = u32(d + 16)
    if name_rva == 0 and oft == 0 and ft == 0:
        break
    dll = cstr(r2o(name_rva))
    # list the first few functions with their IAT slots
    if "user32" in dll.lower() or "kernel32" in dll.lower() or "api-ms" in dll.lower():
        pass
    slots = []
    slot = ft if ft else oft
    k = 0
    while True:
        entry = u32(r2o(slot + k * 4)) if magic == 0x10B else u64(r2o(slot + k * 8))
        if entry == 0:
            break
        if entry & 0x80000000:
            name = "#ord%d" % (entry & 0xFFFF)
        else:
            name = cstr(r2o(entry + 2))
        rva = slot + k * 4 if magic == 0x10B else slot + k * 8
        if 0x2A568 - 0x20 <= rva <= 0x2A568 + 0x40:
            print("HIT dll=%s slot_rva=0x%x name=%s" % (dll, rva, name))
        slots.append((rva, name))
        k += 1
    print("dll=%s funcs=%d first=%s" % (dll, k, slots[0] if slots else None))
    i += 1
