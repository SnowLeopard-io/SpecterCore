import struct

f = open(r'D:\Downloads\TraeWork_CN-Setup-x64.exe', 'rb').read()
e_lfanew = struct.unpack_from('<I', f, 0x3c)[0]
machine = struct.unpack_from('<H', f, e_lfanew + 4)[0]
magic = struct.unpack_from('<H', f, e_lfanew + 4 + 20)[0]
opt = e_lfanew + 4 + 20
subsystem = struct.unpack_from('<H', f, opt + 68)[0]
entry = struct.unpack_from('<I', f, opt + 16)[0]
image_base = struct.unpack_from('<I', f, opt + 28)[0]
machines = {0x14c: 'i386 (32-bit)', 0x8664: 'x86-64'}
magics = {0x10b: 'PE32 32-bit', 0x20b: 'PE32+ 64-bit'}
subs = {2: 'GUI', 3: 'CUI'}
print('file size:', len(f), 'bytes')
print('machine: 0x%04x (%s)' % (machine, machines.get(machine, '?')))
print('magic: 0x%03x (%s)' % (magic, magics.get(magic, '?')))
print('subsystem: %d (%s)' % (subsystem, subs.get(subsystem, '?')))
print('entry RVA: 0x%x, image base: 0x%x' % (entry, image_base))
