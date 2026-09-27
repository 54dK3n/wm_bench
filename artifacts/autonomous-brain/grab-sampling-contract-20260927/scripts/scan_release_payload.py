#!/usr/bin/env python3
"""Read-only delivery scan. Extends the preserved scanner to ZIP members.

This packaging check is separate from the synthetic, network-disabled P6 tests.
No secret values, secret digests or source snippets are emitted.
"""
import importlib.util
import io
import stat
import sys
import zipfile
from pathlib import Path

source = Path("artifacts/autonomous-brain/stage1-delivery-20260926/scan_evidence.py")
spec = importlib.util.spec_from_file_location("preserved_secret_scan", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
OriginalScanner = module.Scanner


class ArchiveScanner(OriginalScanner):
    def scan_blob(self, data, unit, depth=0):
        if depth > 5:
            raise RuntimeError("Nested archive exceeds scan depth")
        if data.startswith(b"PK\x03\x04"):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for member in archive.infolist():
                    if member.is_dir():
                        continue
                    if stat.S_ISLNK(member.external_attr >> 16):
                        raise RuntimeError("ZIP contains a symbolic link")
                    if member.flag_bits & 1:
                        raise RuntimeError("ZIP contains an encrypted member")
                    self.scan_blob(archive.read(member), unit + "::" + member.filename, depth + 1)
            return
        return super().scan_blob(data, unit, depth)


module.Scanner = ArchiveScanner
if __name__ == "__main__":
    sys.exit(module.main())
