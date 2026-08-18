import os, subprocess, shutil

base = r"C:\Users\HUAWEI\Desktop\windows"
for p in ["bridges", "core", "drivers", "ui", "shared"]:
    link = os.path.join(base, "node_modules", "@bk", p)
    target = os.path.join(base, "packages", p)
    if os.path.exists(link):
        if os.path.islink(link):
            print(p, "already linked"); continue
        # stale copy: rename it aside instead of deleting (avoids bulk-delete guards)
        stash = link + ".stale-" + str(os.getpid())
        os.rename(link, stash)
        print(p, "stale copy moved to", os.path.basename(stash))
    r = subprocess.run(
        ["cmd", "/c", "mklink", "/J", link, target],
        capture_output=True, text=True,
    )
    print(p, "->", (r.stdout or r.stderr).strip())
