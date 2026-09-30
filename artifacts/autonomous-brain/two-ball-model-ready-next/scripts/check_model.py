"""Bounded same-environment checks. No platform/bridge/action execution."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(os.environ.get('WORLD_MODEL_ROOT', ROOT / 'vendor/wm_kit_opt2')).resolve()))
from autonomous_brain.llm import LLMClient

mode, destination = sys.argv[1:]
out = Path(destination)
base = urllib.parse.urlsplit(os.environ['LLM_BASE_URL'])
assert base.scheme == 'https' and base.hostname == 'api.deepseek.com' and not base.username and not base.password
assert not base.query and not base.fragment
host = base.hostname

def safe_proxy(value):
    parsed = urllib.parse.urlsplit(value if '://' in value else 'http://' + value)
    return {'scheme': parsed.scheme, 'host': parsed.hostname, 'port': parsed.port,
            'credentials_present': bool(parsed.username or parsed.password)}

def proxy_summary(values):
    result = {}
    for key, value in values.items():
        if key == 'no':
            result[key] = {'rule_count': len(value.split(',')), 'rules_sha256': hashlib.sha256(value.encode()).hexdigest()}
        else:
            result[key] = safe_proxy(value)
    return result

def error_chain(exc):
    result, seen = [], set()
    while isinstance(exc, BaseException) and id(exc) not in seen:
        seen.add(id(exc))
        result.append({'type': type(exc).__name__, 'errno': getattr(exc, 'errno', None),
                       'http_status': exc.code if isinstance(exc, urllib.error.HTTPError) else None})
        exc = getattr(exc, 'reason', None) or exc.__cause__ or exc.__context__
    return result

context = ssl._create_default_https_context()
proxies = urllib.request.getproxies()
bypass = urllib.request.proxy_bypass(host)
metadata = {'python_executable': sys.executable, 'python_version': sys.version,
    'tls_library': ssl.OPENSSL_VERSION, 'certificate_verification': context.verify_mode == ssl.CERT_REQUIRED,
    'hostname_verification': context.check_hostname, 'target': {'scheme': base.scheme, 'host': host, 'base_path': base.path},
    'urllib_environment_proxies': proxy_summary(urllib.request.getproxies_environment()),
    'urllib_effective_proxies': proxy_summary(proxies), 'target_proxy_bypass': bypass,
    'selected_https_proxy': None if bypass or not proxies.get('https') else safe_proxy(proxies['https']),
    'environment_changed': False, 'platform_started': False, 'actions_executed': 0}
(out / 'environment.json').write_text(json.dumps(metadata, indent=2) + '\n')
assert metadata['certificate_verification'] and metadata['hostname_verification']

result = {'mode': mode, 'status': 'NOT_RUN', 'platform_started': False, 'actions_executed': 0}
if mode == 'network':
    # Observe stages without changing sockets, proxy routing, TLS verification or retries.
    events = []
    originals = (socket.create_connection, ssl.SSLContext.wrap_socket, http.client.HTTPConnection._tunnel)
    def traced(label, original):
        def wrapper(*args, **kwargs):
            events.append({'stage': label, 'event': 'started'})
            try:
                value = original(*args, **kwargs)
            except BaseException as exc:
                events.append({'stage': label, 'event': 'failed', 'errors': error_chain(exc)})
                raise
            events.append({'stage': label, 'event': 'completed'})
            return value
        return wrapper
    socket.create_connection = traced('socket_create_connection', originals[0])
    ssl.SSLContext.wrap_socket = traced('tls_wrap_socket', originals[1])
    http.client.HTTPConnection._tunnel = traced('proxy_connect_tunnel', originals[2])
    result.update(method='GET', path=base.path.rstrip('/') + '/models', authentication_sent=False,
                  request_attempts=1, http_status=None, response_bytes=0, errors=[])
    started = time.monotonic()
    try:
        request = urllib.request.Request(urllib.parse.urlunsplit((base.scheme, base.netloc, result['path'], '', '')), method='GET')
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            result['http_status'] = response.code
            result['response_bytes'] = len(response.read(16384))
        result['status'] = 'HTTP_RESPONDED'
    except Exception as exc:
        result.update(status='BLOCKED_MODEL_TRANSPORT', errors=error_chain(exc))
    finally:
        socket.create_connection, ssl.SSLContext.wrap_socket, http.client.HTTPConnection._tunnel = originals
        result.update(events=events, elapsed_s=time.monotonic() - started)
else:
    source = ROOT / 'artifacts/autonomous-brain/two-ball-monitor-next/run-20260930T180642/map-05-run-1/brain/rounds.jsonl'
    original = source.read_bytes()
    state = json.loads(original.splitlines()[0])['state']
    result.update(state_source=str(source.relative_to(ROOT)), state_file_sha256=hashlib.sha256(original).hexdigest(),
                  transport_retry_limit=0, max_format_repairs=1, error_type=None)
    with LLMClient(out / 'llm.jsonl', timeout_s=60, transport_retries=0) as client:
        result['configuration'] = client.validate_formal_configuration()
        try:
            result['action'] = client.decide(state)
            result['status'] = 'PASS'
        except Exception as exc:
            result.update(status='FAIL', error_type=type(exc).__name__)
        record = client.last_record or {}
        result.update(request_count=client.call_count, decision_count=client.decision_count,
                      response_model=record.get('response_model'), transport_error=record.get('transport_error'),
                      transport_diagnostics=record.get('transport_diagnostics'), validation_error=record.get('validation_error'),
                      request_sha256=record.get('request_sha256'))
    records = [json.loads(line) for line in (out / 'llm.jsonl').read_text().splitlines()]
    result['calls'] = []
    for record in records:
        body = record.get('response_body') or ''
        chunks, incomplete_sse_lines = [], 0
        for line in body.splitlines():
            if line.startswith('data: ') and line[6:] != '[DONE]':
                try:
                    chunks.append(json.loads(line[6:]))
                except ValueError:
                    incomplete_sse_lines += 1
        result['calls'].append({'call_index': record['call_index'], 'request_sha256': record['request_sha256'],
            'response_sha256': hashlib.sha256(body.encode()).hexdigest(), 'sse_done': 'data: [DONE]' in body,
            'incomplete_sse_lines': incomplete_sse_lines,
            'finish_reasons': [choice['finish_reason'] for chunk in chunks for choice in chunk.get('choices', []) if choice.get('finish_reason')],
            'response_model': record.get('response_model'), 'validation_error': record.get('validation_error')})
(out / 'RESULT.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'environment': metadata, 'result': result}, ensure_ascii=False))
raise SystemExit(0 if result['status'] in {'HTTP_RESPONDED', 'PASS'} else 1)
