#!/usr/bin/env python3
"""Read-only, value-redacting secret scan of the preserved stage-1 evidence.

The only write is the explicitly named, previously absent JSON report. Archive
members are inspected in memory; original evidence and the manifest are not edited.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import re
import shlex
import tarfile
from pathlib import Path
from urllib.parse import quote


SENSITIVE_NAME = re.compile(
    r"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?token|"
    r"client[_-]?secret|password|passwd|credential|authorization|"
    r"(?:^|[_-])auth(?:$|[_-])|cookie|(?:^|[_-])secret(?:$|[_-])|"
    r"(?:^|[_-])token(?:$|[_-])|private[_-]?key)", re.I)
JSON_FIELD = re.compile(
    rb'(?<!\\)"(?P<key>[A-Za-z_][A-Za-z0-9_-]*)"\s*:\s*')
RULES = {
    "private_key_block": re.compile(rb"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"),
    "github_token": re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})"),
    "api_token": re.compile(rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}"),
    "aws_access_key": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "google_api_key": re.compile(rb"\bAIza[A-Za-z0-9_-]{30,}"),
    "slack_token": re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{16,}"),
    "jwt": re.compile(rb"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    "url_embedded_credentials": re.compile(rb"\b(?:https?|wss?|ftp)://[^\s/\"'<>@]+@[^\s/\"'<>]+", re.I),
    "bearer_token": re.compile(rb"\bBearer\s+[A-Za-z0-9._~+/-]{12,}", re.I),
}
PLACEHOLDERS = {
    "redacted", "[redacted]", "<redacted>", "hidden", "[hidden]", "<hidden>",
    "test", "test-key", "test_key", "fake", "fake-key", "dummy", "dummy-key",
    "your-api-key", "your_api_key", "your-key", "your_key", "not-a-key",
    "test-api-key", "sk-test", "example", "placeholder", "none", "null",
    "<not recorded>",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_secret_values(path: Path) -> list[bytes]:
    """Read this one authorized file only; never output names, values, or digests."""
    if not path.is_file():
        return []
    values = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].lstrip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        if not SENSITIVE_NAME.search(key.strip()):
            continue
        try:
            parts = shlex.split(raw_value, comments=True, posix=True)
        except ValueError:
            raise RuntimeError("Sensitive environment entry could not be parsed safely") from None
        value = " ".join(parts)
        if not value:
            continue
        # Match common representations without recording the secret or its digest.
        forms = {value.encode(), json.dumps(value, ensure_ascii=True)[1:-1].encode(),
                 quote(value, safe="").encode(), base64.b64encode(value.encode())}
        values.extend(forms)
    return sorted(set(values))


def placeholder(value: str) -> bool:
    lowered = value.lower().strip()
    return lowered in PLACEHOLDERS or bool(re.fullmatch(r"[xX*•.]{3,}", value))


class Scanner:
    def __init__(self, secrets: list[bytes]):
        self.secrets = secrets
        self.findings: list[dict] = []
        self.units: list[dict] = []
        self.expanded_bytes = 0
        self.json_credential_fields_checked = 0
        self.empty_credential_fields = 0

    def finding(self, unit: str, rule: str, data: bytes, offset: int,
                field: str | None = None, disposition: str = "block_upload",
                explanation: str | None = None):
        item = {"file": unit, "rule": rule,
                "line": data.count(b"\n", 0, offset) + 1,
                "disposition": disposition}
        if field:
            item["field"] = field
        if explanation:
            item["classification"] = explanation
        if item not in self.findings:
            self.findings.append(item)

    def scan_text(self, data: bytes, unit: str):
        self.expanded_bytes += len(data)
        self.units.append({"file": unit, "bytes": len(data), "sha256": digest(data)})
        for value in self.secrets:
            offset = data.find(value)
            if offset >= 0:
                self.finding(unit, "local_sensitive_environment_value", data, offset)
        for rule, pattern in RULES.items():
            for match in pattern.finditer(data):
                self.finding(unit, rule, data, match.start())

        # Lexical JSON key scanning covers huge JSON/JSONL without constructing the
        # full object graph. Keys escaped inside model-message strings do not match.
        # Recurse into decoded message strings is not needed for the exact-value and
        # token/URL scans above; those also inspect the entire serialized byte stream.
        for match in JSON_FIELD.finditer(data):
            key = match["key"].decode("ascii")
            if not SENSITIVE_NAME.search(key):
                continue
            self.json_credential_fields_checked += 1
            tail = data[match.end():match.end() + 65536]
            if key == "Authorization" and tail.startswith(b'f"Bearer {self._api_key}"'):
                self.finding(unit, "credential_field_source_expression", data, match.start(), key,
                             "source_expression", "Exact Python f-string references runtime self._api_key; no literal credential")
                continue
            try:
                value, _ = json.JSONDecoder().raw_decode(tail.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                # Source-code expressions are not JSON values, but remain explicit
                # findings for a human to classify rather than silently ignored.
                self.finding(unit, "credential_field_not_json_literal", data, match.start(), key)
                continue
            if value is None or value is False or value == "" or value == [] or value == {}:
                self.empty_credential_fields += 1
                continue
            if isinstance(value, str) and placeholder(value):
                self.finding(unit, "nonempty_credential_field", data, match.start(), key,
                             "documented_placeholder", "Exact public placeholder allowlist")
            else:
                self.finding(unit, "nonempty_credential_field", data, match.start(), key)

    def scan_blob(self, data: bytes, unit: str, depth: int = 0):
        if depth > 5:
            raise RuntimeError("Nested archive exceeds scan depth")
        if data.startswith(b"\x1f\x8b"):
            expanded = gzip.decompress(data)  # Also checks CRC and stream truncation.
            if unit.endswith((".tar.gz", ".tgz")):
                with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
                    for member in archive.getmembers():
                        if member.isfile():
                            stream = archive.extractfile(member)
                            if stream is None:
                                raise RuntimeError("Unreadable archive member")
                            self.scan_blob(stream.read(), unit + "::" + member.name, depth + 1)
                        elif not member.isdir():
                            raise RuntimeError("Archive contains a non-regular member")
            else:
                self.scan_blob(expanded, unit + "::gzip", depth + 1)
            return
        self.scan_text(data, unit)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--manifest", type=Path, default=Path("artifacts/autonomous-brain/stage1-review-20260926/SHA256SUMS"))
    parser.add_argument("--env", type=Path, default=Path(".env.local"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    out = args.out if args.out.is_absolute() else repo / args.out
    if out.exists():
        raise SystemExit("Refusing to overwrite an existing report")
    manifest = args.manifest if args.manifest.is_absolute() else repo / args.manifest
    env_path = args.env if args.env.is_absolute() else repo / args.env
    scanner = Scanner(load_secret_values(env_path))
    checked = []
    for line in manifest.read_text().splitlines():
        expected, name = line.split(maxsplit=1)
        path = (repo / name.strip()).resolve()
        if not path.is_relative_to(repo):
            raise SystemExit("Manifest path escapes repository")
        data = path.read_bytes()
        actual = digest(data)
        checked.append({"file": name, "bytes": len(data), "sha256": actual,
                        "matches_original_manifest": actual == expected})
        scanner.scan_blob(data, name)
    blocking = [x for x in scanner.findings if x["disposition"] == "block_upload"]
    result = {
        "schema": "preserved-evidence-secret-scan/v1",
        "read_only_original_evidence": True,
        "manifest": str(manifest.relative_to(repo)),
        "manifest_sha256": digest(manifest.read_bytes()),
        "source_file_count": len(checked),
        "source_bytes": sum(x["bytes"] for x in checked),
        "all_original_sha256_match": all(x["matches_original_manifest"] for x in checked),
        "expanded_scan_unit_count": len(scanner.units),
        "expanded_bytes_scanned": scanner.expanded_bytes,
        "json_credential_fields_checked": scanner.json_credential_fields_checked,
        "empty_credential_fields": scanner.empty_credential_fields,
        "actual_local_env_sensitive_values_checked": bool(scanner.secrets),
        "rules": list(RULES) + ["local_sensitive_environment_value", "nonempty_credential_field", "credential_field_not_json_literal", "credential_field_source_expression"],
        "findings": scanner.findings,
        "blocking_finding_count": len(blocking),
        "upload_scan_pass": not blocking and all(x["matches_original_manifest"] for x in checked),
        "files": checked,
        "expanded_scan_units": scanner.units,
        "limitations": [
            "Pattern scanning cannot prove absence of every arbitrary/unknown secret format.",
            "Actual secret comparison reads only sensitive nonempty entries from the explicitly selected .env.local, in memory; no secret values or their hashes are emitted.",
            "Credential JSON keys are scanned lexically, including large JSON/JSONL; quoted source examples may require explicit classification.",
            "Gzip payloads and all regular members of frozen-runtime-source.tar.gz are recursively scanned without extraction; unsupported archive entries fail closed.",
            "No OCR of images or decoding of arbitrary embedded binary image data is performed.",
            "Report covers exactly the original manifest files, not future delivery files or the archive container created afterward.",
        ],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("x") as stream:
        json.dump(result, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    print(json.dumps({k: result[k] for k in ("source_file_count", "all_original_sha256_match", "expanded_scan_unit_count", "expanded_bytes_scanned", "blocking_finding_count", "upload_scan_pass")}, ensure_ascii=False))
    for finding in scanner.findings:
        print(json.dumps(finding, ensure_ascii=False))
    return 0 if result["upload_scan_pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
