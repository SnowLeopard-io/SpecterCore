import struct

f = open(r'D:\Downloads\TraeWork_CN-Setup-x64.exe', 'rb').read()
e_lfanew = struct.unpack_from('<I', f, 0x3c)[0]
coff = e_lfanew + 4
num_sec = struct.unpack_from('<H', f, coff + 2)[0]
size_opt = struct.unpack_from('<H', f, coff + 16)[0]
sec_table = coff + 20 + size_opt
opt = coff + 20
image_base = struct.unpack_from('<I', f, opt + 28)[0]

print('section table at 0x%x, %d sections' % (sec_table, num_sec))
print('%-8s %-10s %-10s %-10s %-10s %-10s %s' % ('name', 'virtAddr', 'virtSize', 'rawPtr', 'rawSize', 'chars', 'RVA range'))
for i in range(num_sec):
    s = sec_table + i * 40
    name = f[s:s+8].rstrip(b'\0').decode('latin1')
    vsize = struct.unpack_from('<I', f, s + 8)[0]
    vaddr = struct.unpack_from('<I', f, s + 12)[0]
    rsize = struct.unpack_from('<I', f, s + 16)[0]
    rptr = struct.unpack_from('<I', f, s + 20)[0]
    chars = struct.unpack_from('<I', f, s + 36)[0]
    print('%-8s 0x%-8x 0x%-8x 0x%-8x 0x%-8x 0x%-8x [0x%x..0x%x]' % (
        name, vaddr, vsize, rptr, rsize, chars, vaddr, vaddr + max(vsize, rsize)))

# check what file offset corresponds to RVA 0xf7bc (0x40f7bc - image base)
rva = 0x40f7bc - image_base
print('\nRVA 0x%x (VA 0x40f7bc) file mapping:' % rva)
for i in range(num_sec):
    s = sec_table + i * 40
    name = f[s:s+8].rstrip(b'\0').decode('latin1')
    vsize = struct.unpack_from('<I', f, s + 8)[0]
    vaddr = struct.unpack_from('<I', f, s + 12)[0]
    rsize = struct.unpack_from('<I', f, s + 16)[0]
    rptr = struct.unpack_from('<I', f, s + 20)[0]
    span = max(vsize, rsize)
    if vaddr <= rva < vaddr + span:
        fo = rptr + (rva - vaddr)
        print('  in section %s, file offset 0x%x, in-raw=%s' % (name, fo, 'yes' if rva - vaddr < rsize else 'NO (slack zero-fill)'))
        data = f[fo:fo+16]
        print('  bytes at file 0x%x: %s' % (fo, data.hex(' ')))
