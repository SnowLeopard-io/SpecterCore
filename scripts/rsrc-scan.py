import struct
import sys

path = sys.argv[1] if len(sys.argv) > 1 else r"D:\Downloads\TraeWork_CN-Setup-x64.exe"
image = open(path, "rb").read()

def u16(o):
    return struct.unpack_from("<H", image, o)[0]

def u32(o):
    return struct.unpack_from("<I", image, o)[0]

e_lfanew = u32(0x3C)
nsec = u16(e_lfanew + 6)
opt_size = u16(e_lfanew + 20)
sec_tbl = e_lfanew + 24 + opt_size
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

magic = u16(e_lfanew + 24)
dd = (e_lfanew + 24) + (112 if magic == 0x20B else 96)
res_rva = u32(dd + 16)
ro = r2o(res_rva)

def walk(off, depth, path):
    n = u16(off + 12)
    i = u16(off + 14)
    for k in range(n + i):
        e = off + 16 + k * 8
        name = u32(e)
        data = u32(e + 4)
        label = name if not (name & 0x80000000) else "str@%x" % (name & 0x7FFFFFFF)
        if data & 0x80000000:
            sub = r2o(res_rva + (data & 0x7FFFFFFF))
            walk(sub, depth + 1, "%s/%s" % (path, label))
        else:
            de = r2o(res_rva + data)
            if de is None:
                continue
            drva = u32(de)
            dsz = u32(de + 4)
            doff = r2o(drva)
            first = image[doff : doff + 16] if doff is not None else b""
            print(
                "%s/%s name=%#x data_rva=0x%x size=0x%x (%d) fileoff=0x%x head=%s"
                % (path, label, name & 0x7FFFFFFF, drva, dsz, dsz, doff or 0, first.hex(" "))
            )

walk(ro, 0, "")
