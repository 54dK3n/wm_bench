"""Archive exact UTF-8 record.sourceCode from completed native runs.

This offline tool never imports/executes a robot program or modifies any input.
It refuses to overwrite a differing archive and never derives execution bytes
by trimming program.py: trimming is only an independently reported comparison.
"""
import argparse
import ast
import base64
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_bytes())


def immutable_write(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise RuntimeError('Refusing to overwrite different archive: ' + str(path))
    else:
        path.write_bytes(data)


def source_identity(source):
    constants = {}
    for node in ast.parse(source).body:
        if not isinstance(node, ast.Assign):
            continue
        names = [target.id for target in node.targets if isinstance(target, ast.Name)]
        for name in names:
            if name in ('PROGRAM_VERSION', 'WM_KIT_COMMIT'):
                constants[name] = ast.literal_eval(node.value)
            elif name == '_WM_ZIP_BYTES':
                constants[name] = base64.b64decode(ast.literal_eval(node.value.args[0]))
    return {
        'version': constants['PROGRAM_VERSION'],
        'file_sha256': digest(source.encode('utf-8')),
        'wm_kit_commit': constants['WM_KIT_COMMIT'],
        'wm_embed_sha256': digest(constants['_WM_ZIP_BYTES']),
    }


def export(folder, maps):
    folder = folder.resolve()
    identity_path = folder / 'identity.json'
    identity = read_json(identity_path)
    original_path = folder / 'program.py'
    original = original_path.read_bytes()
    rows = []
    payloads = []
    for name in maps:
        raw_path = folder / (name + '.json')
        raw_bytes = raw_path.read_bytes()
        raw = json.loads(raw_bytes)
        record_path = Path(raw['fullRecordFile'])
        record_bytes = record_path.read_bytes()
        record = json.loads(record_bytes)
        source = record.get('sourceCode')
        if not isinstance(source, str):
            raise RuntimeError('Native sourceCode missing: ' + str(record_path))
        payload = source.encode('utf-8')
        payloads.append(payload)
        source_id = source_identity(source)
        versions = [(i, row) for i, row in enumerate(raw['lines'])
                    if row.get('event') == 'program_version']
        events = record['events']
        finished = [i for i, event in enumerate(events) if event.get('type') == 'run_finished']
        deliveries = [{'event_index': i, 'package_id': event.get('packageId'), 't_ms': event.get('t')}
                      for i, event in enumerate(events) if event.get('type') == 'package_delivered']
        export_meta = raw['fullRecordExport']
        checks = {
            'run_finished_in_native_record': bool(finished),
            'raw_run_is_finished': raw.get('runState') == '运行已结束' and not raw.get('timedOut'),
            'native_file_sha_matches_recorded_export': digest(record_bytes) == export_meta['sha256'],
            'native_file_bytes_match_recorded_export': len(record_bytes) == export_meta['bytes'],
            'native_run_id_matches_recorded_export': record['runId'] == export_meta['runId'],
            'native_task_id_matches_raw_and_export': record['taskId'] == raw['taskId'] == export_meta['taskId'],
            'native_events_match_raw_event_copy': events == raw['record']['events'],
            'source_identity_matches_identity_json': source_id == identity,
            'one_program_version_log_matches_identity': len(versions) == 1 and all(
                versions[0][1].get(k) == v for k, v in identity.items()),
            'native_source_exactly_equals_trimmed_original_only_as_comparison':
                payload == original.decode('utf-8').strip().encode('utf-8'),
        }
        if not all(checks.values()):
            raise RuntimeError(name + ' checks failed: ' + str([k for k, v in checks.items() if not v]))
        rows.append({
            'map': name, 'raw_file': str(raw_path), 'raw_sha256': digest(raw_bytes),
            'native_record_file': str(record_path), 'native_record_sha256': digest(record_bytes),
            'native_record_bytes': len(record_bytes), 'run_id': record['runId'],
            'sourceCode_unicode_characters': len(source), 'sourceCode_utf8_bytes': len(payload),
            'sourceCode_sha256': digest(payload), 'source_identity': source_id,
            'program_version_line_index': versions[0][0],
            'program_version': versions[0][1], 'native_run_finished_event_indices': finished,
            'native_delivery_events': deliveries, 'checks': checks,
        })
    if not payloads or any(payload != payloads[0] for payload in payloads):
        raise RuntimeError('Requested runs do not have a single byte-identical executed source')
    payload = payloads[0]
    artifact_path = folder / 'executed_program.py'
    sha_path = folder / 'executed_program.sha256'
    audit = {
        'schema': 'wm-executed-source-native-archive/v1',
        'scope': 'Offline exact sourceCode archival for completed runs only; no execution, simulation, source edit, test rerun or label change.',
        'indices': 'Zero-based raw.lines or native record.events arrays, not physical file lines.',
        'export_tool': str(Path(__file__).resolve()),
        'export_tool_sha256': digest(Path(__file__).read_bytes()),
        'method': 'JSON-decode full native record.sourceCode, UTF-8 encode exactly, write bytes without strip/normalization/newline insertion.',
        'folder': str(folder), 'maps': maps,
        'identity_file': str(identity_path), 'identity_file_sha256': digest(identity_path.read_bytes()),
        'identity': identity,
        'original_program_file': str(original_path), 'original_program_sha256': digest(original),
        'original_program_utf8_bytes': len(original),
        'original_program_leading_whitespace_characters': len(original.decode('utf-8')) - len(original.decode('utf-8').lstrip()),
        'original_program_trailing_whitespace_characters': len(original.decode('utf-8')) - len(original.decode('utf-8').rstrip()),
        'executed_program_file': str(artifact_path), 'executed_program_sha256_file': str(sha_path),
        'executed_program_sha256': digest(payload), 'executed_program_utf8_bytes': len(payload),
        'executed_program_ends_with_newline': payload.endswith(b'\n'),
        'all_requested_native_sources_byte_identical': True,
        'all_checks_pass': True, 'runs': rows,
        'reproduce': 'python3 ' + str(Path(__file__).resolve()) + ' --folder ' + str(folder) + ' --maps ' + ' '.join(maps),
    }
    docs = [
        '# 实际执行代码原样归档', '',
        f'核验通过：{len(rows)}局原生完整记录的 `sourceCode` UTF-8 字节完全一致，均匹配 `identity.file_sha256` 和每局 `program_version` 日志。', '',
        f'- 版本：`{identity["version"]}`',
        f'- [执行快照]({artifact_path})：`{digest(payload)}`，{len(payload):,} bytes。',
        f'- [校验文件]({sha_path})',
        f'- 原冻结程序：`{digest(original)}`，{len(original):,} bytes。',
        f'- wm_kit commit：`{identity["wm_kit_commit"]}`',
        f'- 嵌入ZIP SHA256：`{identity["wm_embed_sha256"]}`', '',
        '快照直接取完整原生记录中的sourceCode，未trim、重排或补换行。原program.py只作比较；其首尾空白经平台trim后恰与sourceCode一致，所以原文件SHA和实际执行SHA不同。本归档不替换原文件、不修改manifest或原报告。', '',
        '| 局 | 原生record | sourceCode bytes | 版本日志L | 完成事件E |',
        '|---|---|---:|---:|---|',
    ]
    for row in rows:
        docs.append(f'| [{row["map"]}]({row["raw_file"]}) | [{Path(row["native_record_file"]).name}]({row["native_record_file"]}) | {row["sourceCode_utf8_bytes"]} | {row["program_version_line_index"]} | {row["native_run_finished_event_indices"]} |')
    docs += ['', 'L/E均为零起始数组下标。[逐局JSON审计](' + str(folder / 'executed_snapshot_audit.json') + ')包含原生record导出SHA、runId、四项版本身份及逐字节核对；所有检查通过。', '',
             '[只读导出工具](' + str(Path(__file__).resolve()) + ')仅写上述新增归档；若已有同名归档不同会拒绝覆盖，可按JSON中的reproduce命令复跑。此存证只证明实际执行源码身份，不新增任何任务性能结论。', '']
    immutable_write(artifact_path, payload)
    immutable_write(sha_path, (digest(payload) + '  executed_program.py\n').encode())
    immutable_write(folder / 'executed_snapshot_audit.json', (json.dumps(audit, ensure_ascii=False, indent=2) + '\n').encode())
    immutable_write(folder / 'EXECUTED_SNAPSHOT.md', '\n'.join(docs).encode())
    return {'folder': str(folder), 'maps': maps, 'sha256': digest(payload), 'bytes': len(payload), 'all_checks_pass': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, required=True)
    parser.add_argument('--maps', nargs='+', required=True)
    args = parser.parse_args()
    if len(args.maps) != len(set(args.maps)) or any(
            name not in {f'map-{i:02}' for i in range(1, 11)} for name in args.maps):
        raise ValueError('Maps must be distinct map-01 through map-10 names')
    print(json.dumps(export(args.folder, args.maps), ensure_ascii=False))


if __name__ == '__main__':
    main()
