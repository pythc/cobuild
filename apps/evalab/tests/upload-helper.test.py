#!/usr/bin/env python3
"""Local mock tests for the direct-upload helper. Binds 127.0.0.1 only."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import contextlib
import io
from types import SimpleNamespace
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'public' / 'downloads' / 'upload-materials.py'
TOKEN = 'lu_' + ('A' * 43)
UPLOAD_ID = '11111111-1111-4111-8111-111111111111'
RECEIPT = {
    'id': '44444444-4444-4444-8444-444444444444',
    'sha256': 'ab' * 32,
    'repoSha': 'c' * 40,
    'receivedAt': '2026-09-28T00:00:00.000Z',
}


def load_helper():
    spec = importlib.util.spec_from_file_location('upload_materials', HELPER)
    if spec is None or spec.loader is None:
        raise RuntimeError('helper missing')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


HELPER_MOD = load_helper()


class PlatformRegressionTests(unittest.TestCase):
    def test_windows_directory_has_acl_at_creation_and_frees_descriptor(self):
        import ctypes
        from unittest.mock import Mock
        events = []
        def convert(sddl, revision, output, _size):
            events.append('descriptor')
            self.assertEqual(sddl, 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)')
            self.assertEqual(revision, 1)
            output._obj.value = 1234
            return True
        def create(_path, attrs):
            events.append('create')
            self.assertEqual(attrs._obj.descriptor, 1234)
            self.assertFalse(attrs._obj.inherit)
            return True
        advapi = SimpleNamespace(ConvertStringSecurityDescriptorToSecurityDescriptorW=Mock(side_effect=convert))
        kernel = SimpleNamespace(CreateDirectoryW=Mock(side_effect=create), LocalFree=Mock(side_effect=lambda _ptr: events.append('free')))
        with patch.object(HELPER_MOD, 'IS_WINDOWS', True), \
             patch.object(ctypes, 'WinDLL', side_effect=lambda name, **kw: advapi if name=='advapi32' else kernel, create=True):
            HELPER_MOD.make_private_directory('synthetic-directory')
        self.assertEqual(events, ['descriptor', 'create', 'free'])

    def test_windows_snapshot_upload_preserves_binary_bytes_without_fchmod(self):
        """Exercise the whole helper under Windows CRT/permission semantics."""
        state = State()
        server = serve(Handler, state)
        binary_flag = 0x10000000
        real_open, real_read, real_write, real_fstat = os.open, os.read, os.write, os.fstat
        binary_fds = {}
        def open_crt(path, flags, mode=0o777, **kw):
            fd = real_open(path, flags & ~binary_flag, mode, **kw)
            binary_fds[fd] = bool(flags & binary_flag)
            return fd
        def read_crt(fd, length):
            data = real_read(fd, length)
            return data if binary_fds.get(fd, True) else data.replace(b'\r\n', b'\n').split(b'\x1a')[0]
        def write_crt(fd, data):
            raw = bytes(data)
            return real_write(fd, raw if binary_fds.get(fd, True) else raw.replace(b'\n', b'\r\n'))
        def stat_windows(fd):
            info = real_fstat(fd)
            return SimpleNamespace(st_mode=(info.st_mode & ~0o777) | 0o666,
                                   st_size=info.st_size, st_ino=info.st_ino, st_dev=info.st_dev,
                                   st_mtime_ns=info.st_mtime_ns)
        def mkdir_test(path):
            # Win32 ACL creation is tested separately; these mocks emulate CRT I/O.
            os.mkdir(path, 0o700)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                src = Path(tmp) / '当前会话.jsonl'
                original = b'\r\n\x1a\xff\x00' + bytes(range(256)) + b'\n'
                src.write_bytes(original)
                state.on_manifest = lambda: src.write_bytes(original + b'APPENDED')
                output, errors = io.StringIO(), io.StringIO()
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(HELPER_MOD, 'IS_WINDOWS', True))
                    stack.enter_context(patch.object(HELPER_MOD, 'make_private_directory', side_effect=mkdir_test))
                    stack.enter_context(patch.object(os, 'O_BINARY', binary_flag, create=True))
                    stack.enter_context(patch.object(os, 'open', side_effect=open_crt))
                    stack.enter_context(patch.object(os, 'read', side_effect=read_crt))
                    stack.enter_context(patch.object(os, 'write', side_effect=write_crt))
                    stack.enter_context(patch.object(os, 'fstat', side_effect=stat_windows))
                    stack.enter_context(patch.object(os, 'fchmod', side_effect=AssertionError('Windows must not use fchmod'), create=True))
                    stack.enter_context(contextlib.redirect_stdout(output))
                    stack.enter_context(contextlib.redirect_stderr(errors))
                    result = HELPER_MOD.main(['--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}', '--token', TOKEN, '--snapshot', '--file', str(src)])
                self.assertEqual(result, 0, errors.getvalue())
                self.assertEqual(src.read_bytes(), original + b'APPENDED')
                self.assertEqual(list(state.blobs.values()), [original])
                self.assertIn('RECEIVED', output.getvalue())
                self.assertNotIn(TOKEN, output.getvalue() + errors.getvalue())
        finally:
            server.shutdown(); server.server_close()

    def test_posix_insecure_snapshot_reports_permissions_not_source_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'snapshot'
            data = b'unchanged'
            path.write_bytes(data); path.chmod(0o644)
            with patch.object(HELPER_MOD, 'IS_WINDOWS', False):
                with self.assertRaisesRegex(HELPER_MOD.UploadError, 'SNAPSHOT_PERMISSION_FAILED'):
                    HELPER_MOD.verify_snapshot_file(str(path), len(data), hashlib.sha256(data).hexdigest())
            self.assertEqual(path.read_bytes(), data)

    def test_snapshot_write_failure_does_not_claim_source_changed(self):
        with patch.object(os, 'write', side_effect=OSError('private-path SECRET must not be printed')):
            with self.assertRaisesRegex(HELPER_MOD.UploadError, '^SNAPSHOT_WRITE_FAILED:') as error:
                HELPER_MOD.write_full(-1, b'synthetic')
        self.assertNotIn('SECRET', str(error.exception))

    def test_private_directory_failure_stops_before_upload(self):
        with patch.object(HELPER_MOD, 'IS_WINDOWS', True), \
             patch.object(HELPER_MOD, 'make_private_directory', side_effect=OSError('private-path SECRET')), \
             patch.object(HELPER_MOD, 'upload') as upload:
            with self.assertRaisesRegex(HELPER_MOD.UploadError, '^TEMP_DIRECTORY_FAILED:') as error:
                with HELPER_MOD.private_temporary_directory():
                    self.fail('insecure temporary directory must not be used')
            upload.assert_not_called()
        self.assertNotIn('SECRET', str(error.exception))

    @unittest.skipUnless(os.name == 'nt', 'requires a native Windows runtime')
    def test_native_windows_private_directory_and_snapshot(self):
        # Run this test on Windows to verify real Win32 calls, not emulated stat bits.
        with HELPER_MOD.private_temporary_directory() as tmp:
            src = Path(tmp) / '会话.jsonl'
            data = b'\r\n\x1a\xff\x00' + bytes(range(256))
            src.write_bytes(data)
            captured = HELPER_MOD.capture_snapshots([(str(src), src.name, 'export')], HELPER_MOD.MAX_TOTAL_BYTES, tmp)
            self.assertEqual(Path(captured[0][0]).read_bytes(), data)
            self.assertEqual(src.read_bytes(), data)
        self.assertFalse(Path(tmp).exists())


class State:
    def __init__(self) -> None:
        self.files: list[dict] = []
        self.blobs: dict[str, bytes] = {}
        self.requests: list[dict] = []
        self.put_count = 0
        self.fail_put_number = 0
        self.manifest: dict | None = None
        self.reject_manifest_body = b''
        self.on_manifest = None
        self.manifest_hook_done = False
        self.conflict_on_change = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt: str, *args) -> None:
        return

    def _state(self) -> State:
        return self.server.state  # type: ignore[attr-defined]

    def _read(self) -> bytes:
        length = int(self.headers.get('Content-Length', '0') or '0')
        return self.rfile.read(length) if length else b''

    def _record(self, body: bytes) -> None:
        self._state().requests.append({
            'method': self.command,
            'path': self.path,
            'authorization': self.headers.get('Authorization'),
            'length': int(self.headers.get('Content-Length', '0') or '0'),
            'body': body,
        })

    def _json(self, code: int, payload: dict) -> None:
        raw = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(raw)

    def _auth_ok(self) -> bool:
        return self.headers.get('Authorization') == f'Bearer {TOKEN}'

    def _view(self) -> dict:
        files = sorted(self._state().files, key=lambda item: item['name'])
        return {
            'uploadId': UPLOAD_ID,
            'status': 'UPLOADING' if files else 'AWAITING_FILES',
            'expiresAt': '2026-09-28T00:00:00.000Z',
            'files': files,
        }

    def do_GET(self) -> None:
        body = self._read()
        self._record(body)
        if not self._auth_ok():
            self._json(401, {'message': 'no'})
            return
        self._json(200, self._view())

    def do_POST(self) -> None:
        body = self._read()
        self._record(body)
        if not self._auth_ok():
            self._json(401, {'message': 'no'})
            return
        if self.path.endswith('/complete'):
            self._json(200, {'status': 'RECEIVED', 'receipt': RECEIPT})
            return
        state = self._state()
        if state.on_manifest and not state.manifest_hook_done:
            state.manifest_hook_done = True
            state.on_manifest()
        if state.reject_manifest_body:
            self._json(400, {'message': state.reject_manifest_body.decode('utf-8')})
            return
        manifest = json.loads(body.decode('utf-8'))
        if state.conflict_on_change and state.files:
            if not same_manifest(manifest['files'], state.files):
                self._json(409, {'code': 'UPLOAD_INVALID', 'message': TOKEN + ' BODYMARKER9f3a'})
                return
            self._json(200, self._view())
            return
        state.manifest = manifest
        ids = [
            '22222222-2222-4222-8222-222222222222',
            '33333333-3333-4333-8333-333333333333',
        ]
        self._state().files = []
        self._state().blobs = {}
        for index, item in enumerate(manifest['files']):
            file_id = ids[index]
            self._state().files.append({
                'id': file_id,
                'name': item['name'],
                'sha256': item['sha256'],
                'bytes': item['bytes'],
                'receivedBytes': 0,
            })
            self._state().blobs[file_id] = b''
        self._json(200, self._view())

    def do_PUT(self) -> None:
        body = self._read()
        self._record(body)
        if not self._auth_ok():
            self._json(401, {'message': 'no'})
            return
        parsed = urllib.parse.urlsplit(self.path)
        file_id = parsed.path.rstrip('/').split('/')[-1]
        offset = int(urllib.parse.parse_qs(parsed.query)['offset'][0])
        state = self._state()
        state.put_count += 1
        current = state.blobs.get(file_id, b'')
        if offset != len(current) or state.put_count == state.fail_put_number:
            self._json(409, {'message': 'offset'})
            return
        state.blobs[file_id] = current + body
        for item in state.files:
            if item['id'] == file_id:
                item['receivedBytes'] = len(state.blobs[file_id])
        self._json(200, {'receivedBytes': len(state.blobs[file_id])})


class RedirectHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt: str, *args) -> None:
        return

    def _bounce(self) -> None:
        length = int(self.headers.get('Content-Length', '0') or '0')
        if length:
            self.rfile.read(length)
        self.server.hits.append({  # type: ignore[attr-defined]
            'path': self.path,
            'authorization': self.headers.get('Authorization'),
        })
        self.send_response(302)
        self.send_header('Location', self.server.location)  # type: ignore[attr-defined]
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()

    do_GET = _bounce
    do_POST = _bounce
    do_PUT = _bounce


class StealHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt: str, *args) -> None:
        return

    def _hit(self) -> None:
        length = int(self.headers.get('Content-Length', '0') or '0')
        if length:
            self.rfile.read(length)
        self.server.hits.append(self.headers.get('Authorization'))  # type: ignore[attr-defined]
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')

    do_GET = _hit
    do_POST = _hit
    do_PUT = _hit


def same_manifest(incoming: list[dict], current: list[dict]) -> bool:
    if len(incoming) != len(current):
        return False
    rows = {item['name']: item for item in current}
    if len(rows) != len(current):
        return False
    for item in incoming:
        row = rows.get(item['name'])
        if row is None or row['sha256'] != item['sha256'] or row['bytes'] != item['bytes']:
            return False
    return True


def serve(handler: type[BaseHTTPRequestHandler], state: State | None = None):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    if state is not None:
        server.state = state  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def run_cli(args: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged.pop('HTTP_PROXY', None)
    merged.pop('http_proxy', None)
    merged.pop('HTTPS_PROXY', None)
    merged.pop('https_proxy', None)
    merged.pop('ALL_PROXY', None)
    if env:
        merged.update(env)
    return subprocess.run(
        [sys.executable, str(HELPER), *args],
        capture_output=True,
        text=True,
        env=merged,
        timeout=60,
        check=False,
    )


class UploadHelperTest(unittest.TestCase):
    def test_source_does_not_scan_or_follow_redirects(self) -> None:
        text = HELPER.read_text(encoding='utf-8')
        for banned in ('os.walk', 'listdir', 'scandir', 'glob.glob', 'urlopen', 'HTTPRedirectHandler'):
            self.assertNotIn(banned, text)

    def test_rejects_non_loopback_http_without_connecting(self) -> None:
        started = time.monotonic()
        with self.assertRaises(HELPER_MOD.UploadError):
            HELPER_MOD.validate_upload_url(
                f'http://203.0.113.1/material-uploads/{UPLOAD_ID}',
            )
        self.assertLess(time.monotonic() - started, 2)
        with self.assertRaises(HELPER_MOD.UploadError):
            HELPER_MOD.validate_token('not-a-ticket')
        HELPER_MOD.validate_upload_url(f'http://127.0.0.1/material-uploads/{UPLOAD_ID}')
        HELPER_MOD.validate_upload_url(f'http://[::1]/material-uploads/{UPLOAD_ID}')

    def test_streams_bytes_resumes_offset_and_hides_secrets(self) -> None:
        state = State()
        state.fail_put_number = 2
        server = serve(Handler, state)
        port = server.server_address[1]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                folder = os.path.join(tmp, 'PATHMARKER_DIR')
                os.makedirs(folder)
                payload = b'\xff\xfeBODYMARKER9f3a\x00' + (b'abc' * 30)
                path = os.path.join(folder, 'note.bin')
                with open(path, 'wb') as handle:
                    handle.write(payload)
                before = os.stat(path).st_mtime_ns
                ticket = os.path.join(tmp, 'ticket.json')
                with open(ticket, 'w', encoding='utf-8') as handle:
                    json.dump({
                        'uploadUrl': f'http://127.0.0.1:{port}/material-uploads/{UPLOAD_ID}',
                        'uploadToken': TOKEN,
                        'chunkBytes': 40,
                        'maxTotalBytes': 1073741824,
                    }, handle)
                os.chmod(ticket, 0o600)
                proc = run_cli(['--ticket-file', ticket, '--file', path])
                after = os.stat(path).st_mtime_ns
                mode = stat.S_IMODE(os.stat(ticket).st_mode)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(before, after)
            self.assertEqual(mode, 0o600)
            self.assertNotIn('should be mode 0600', proc.stderr)
            combined = proc.stdout + proc.stderr
            self.assertNotIn(TOKEN, combined)
            self.assertNotIn('PATHMARKER_DIR', combined)
            self.assertNotIn('BODYMARKER9f3a', combined)
            self.assertNotIn(path, combined)
            stored = state.blobs['22222222-2222-4222-8222-222222222222']
            self.assertEqual(stored, payload)
            offsets = [
                int(urllib.parse.parse_qs(urllib.parse.urlsplit(item['path']).query)['offset'][0])
                for item in state.requests if item['method'] == 'PUT'
            ]
            self.assertEqual(offsets[0], 0)
            self.assertIn(40, offsets)
            self.assertGreaterEqual(len(offsets), 3)
            self.assertEqual(state.manifest['files'][0]['source'], 'agent-export')
            self.assertEqual(state.manifest['files'][0]['coverage'], 'export')
            self.assertEqual(state.manifest['files'][0]['sha256'], hashlib.sha256(payload).hexdigest())
            events = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
            self.assertEqual(events[-1]['status'], 'RECEIVED')
            self.assertEqual(events[-1]['receipt']['id'], RECEIPT['id'])
            for item in state.requests:
                self.assertEqual(item['authorization'], f'Bearer {TOKEN}')
                if item['method'] == 'PUT':
                    self.assertLessEqual(item['length'], 40)
                    self.assertEqual(item['length'], len(item['body']))
        finally:
            server.shutdown()
            server.server_close()

    def test_matches_files_when_server_sorts_by_name(self) -> None:
        state = State()
        server = serve(Handler, state)
        port = server.server_address[1]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                first = os.path.join(tmp, 'b.bin')
                second = os.path.join(tmp, 'a.bin')
                with open(first, 'wb') as handle:
                    handle.write(b'BBB')
                with open(second, 'wb') as handle:
                    handle.write(b'AAA')
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{port}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--file', first,
                    '--file', second,
                ])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            by_name = {item['name']: state.blobs[item['id']] for item in state.files}
            self.assertEqual(by_name['b.bin'], b'BBB')
            self.assertEqual(by_name['a.bin'], b'AAA')
        finally:
            server.shutdown()
            server.server_close()

    def test_redirect_does_not_forward_token(self) -> None:
        steal = serve(StealHandler)
        steal.hits = []  # type: ignore[attr-defined]
        bounce = serve(RedirectHandler)
        bounce.hits = []  # type: ignore[attr-defined]
        bounce.location = f'http://127.0.0.1:{steal.server_address[1]}/stolen'  # type: ignore[attr-defined]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'note.bin')
                with open(path, 'wb') as handle:
                    handle.write(b'BODYMARKER9f3a')
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{bounce.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--file', path,
                ])
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(steal.hits, [])  # type: ignore[attr-defined]
            self.assertEqual(len(bounce.hits), 1)  # type: ignore[attr-defined]
            self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
            self.assertNotIn('BODYMARKER9f3a', proc.stdout + proc.stderr)
        finally:
            bounce.shutdown()
            steal.shutdown()
            bounce.server_close()
            steal.server_close()

    def test_proxy_env_is_not_used(self) -> None:
        state = State()
        server = serve(Handler, state)
        steal = serve(StealHandler)
        steal.hits = []  # type: ignore[attr-defined]
        proxy = f'http://127.0.0.1:{steal.server_address[1]}'
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'note.bin')
                with open(path, 'wb') as handle:
                    handle.write(b'xyz')
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--file', path,
                ], env={
                    'HTTP_PROXY': proxy,
                    'http_proxy': proxy,
                    'HTTPS_PROXY': proxy,
                    'ALL_PROXY': proxy,
                })
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(steal.hits, [])  # type: ignore[attr-defined]
            self.assertEqual(state.blobs['22222222-2222-4222-8222-222222222222'], b'xyz')
        finally:
            server.shutdown()
            steal.shutdown()
            server.server_close()
            steal.server_close()

    def test_payload_json_rescue_marks_partial_and_cleans_temp(self) -> None:
        state = State()
        server = serve(Handler, state)
        port = server.server_address[1]
        content = 'LEGACY148 ' + ('Z' * (148 * 1024))
        try:
            with tempfile.TemporaryDirectory() as tmp:
                payload_path = os.path.join(tmp, 'payload.json')
                blob = content.encode('utf-8')
                document = {
                    'schemaVersion': 1,
                    'repoSha': 'd' * 40,
                    'manifest': {
                        'files': [{
                            'name': '会话记录.txt',
                            'sha256': hashlib.sha256(blob).hexdigest(),
                            'bytes': len(blob),
                            'source': 'cursor-export',
                            'coverage': 'partial',
                        }],
                    },
                    'files': [{'name': '会话记录.txt', 'content': content}],
                }
                with open(payload_path, 'w', encoding='utf-8') as handle:
                    json.dump(document, handle, ensure_ascii=False)
                before = Path(payload_path).read_bytes()
                scratch = os.path.join(tmp, 'scratch')
                os.makedirs(scratch)
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{port}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--payload-json', payload_path,
                ], env={'TMPDIR': scratch})
                self.assertEqual(Path(payload_path).read_bytes(), before)
                self.assertEqual(os.listdir(scratch), [])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(state.manifest['files'][0]['coverage'], 'partial')
            self.assertEqual(state.manifest['files'][0]['source'], 'agent-export')
            self.assertEqual(state.manifest['files'][0]['name'], '会话记录.txt')
            self.assertEqual(state.blobs['22222222-2222-4222-8222-222222222222'], blob)
            self.assertNotIn(content[:20], proc.stdout + proc.stderr)
        finally:
            server.shutdown()
            server.server_close()

    def test_ticket_mode_warning_does_not_chmod(self) -> None:
        state = State()
        server = serve(Handler, state)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'note.bin')
                with open(path, 'wb') as handle:
                    handle.write(b'abc')
                ticket = os.path.join(tmp, 'ticket.json')
                with open(ticket, 'w', encoding='utf-8') as handle:
                    json.dump({
                        'url': f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                        'token': TOKEN,
                    }, handle)
                os.chmod(ticket, 0o644)
                proc = run_cli(['--ticket-file', ticket, '--file', path])
                self.assertEqual(stat.S_IMODE(os.stat(ticket).st_mode), 0o644)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn('mode 0600', proc.stderr)
            self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
        finally:
            server.shutdown()
            server.server_close()

    def test_bounds_and_unchanged_checks(self) -> None:
        state = State()
        server = serve(Handler, state)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                huge = os.path.join(tmp, 'huge.bin')
                fd = os.open(huge, os.O_CREAT | os.O_WRONLY, 0o600)
                os.ftruncate(fd, HELPER_MOD.MAX_TOTAL_BYTES + 1)
                os.close(fd)
                started = time.monotonic()
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--file', huge,
                ])
                self.assertLess(time.monotonic() - started, 2)
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(state.requests, [])
                self.assertIn('1GiB', proc.stderr)

                folder = os.path.join(tmp, 'SECRET_LISTING')
                os.makedirs(folder)
                with open(os.path.join(folder, 'hidden-name.txt'), 'wb') as handle:
                    handle.write(b'nope')
                listed = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--file', folder,
                ])
                self.assertNotEqual(listed.returncode, 0)
                self.assertNotIn('hidden-name.txt', listed.stdout + listed.stderr)
                self.assertEqual(state.requests, [])

                outside = os.path.join(tmp, 'outside.bin')
                with open(outside, 'wb') as handle:
                    handle.write(b'CANARY')
                link = os.path.join(tmp, 'link.bin')
                os.symlink(outside, link)
                linked = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--file', link,
                ])
                self.assertNotEqual(linked.returncode, 0)
                self.assertNotIn('CANARY', linked.stdout + linked.stderr)
                self.assertEqual(state.requests, [])

                mutable = os.path.join(tmp, 'mutable.bin')
                with open(mutable, 'wb') as handle:
                    handle.write(b'one')
                snap = HELPER_MOD.snapshot(mutable)
                with open(mutable, 'ab') as handle:
                    handle.write(b' two')
                with self.assertRaises(HELPER_MOD.UploadError):
                    HELPER_MOD.hash_file(mutable, snap)
        finally:
            server.shutdown()
            server.server_close()

    def test_error_body_is_not_echoed_and_retries_stop(self) -> None:
        state = State()
        state.reject_manifest_body = f'{TOKEN} BODYMARKER9f3a'.encode('utf-8')
        server = serve(Handler, state)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'note.bin')
                with open(path, 'wb') as handle:
                    handle.write(b'abc')
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--file', path,
                ])
            self.assertNotEqual(proc.returncode, 0)
            self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
            self.assertNotIn('BODYMARKER9f3a', proc.stdout + proc.stderr)
            self.assertLess(len(state.requests), 20)
        finally:
            server.shutdown()
            server.server_close()

    def test_large_file_uses_bounded_chunks(self) -> None:
        state = State()
        server = serve(Handler, state)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'wide.bin')
                blob = b'Q' * (HELPER_MOD.MAX_CHUNK_BYTES + 10)
                with open(path, 'wb') as handle:
                    handle.write(blob)
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--file', path,
                ])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            puts = [item for item in state.requests if item['method'] == 'PUT']
            self.assertEqual(len(puts), 2)
            self.assertEqual(puts[0]['length'], HELPER_MOD.MAX_CHUNK_BYTES)
            self.assertEqual(puts[1]['length'], 10)
            self.assertEqual(state.blobs['22222222-2222-4222-8222-222222222222'], blob)
        finally:
            server.shutdown()
            server.server_close()

    def test_snapshot_uploads_exact_prefix_and_leaves_source(self) -> None:
        state = State()
        server = serve(Handler, state)
        port = server.server_address[1]
        first = b'alpha\r\n\xff\x00BODYMARKER9f3a' + bytes(range(256))
        second = b'\r\nbeta\r\n'
        try:
            with tempfile.TemporaryDirectory() as tmp:
                folder = os.path.join(tmp, 'PATHMARKER_DIR')
                os.makedirs(folder)
                log_path = os.path.join(folder, '会话.log')
                note_path = os.path.join(folder, 'note.bin')
                with open(log_path, 'wb') as handle:
                    handle.write(first)
                with open(note_path, 'wb') as handle:
                    handle.write(second)
                before_log = Path(log_path).read_bytes()
                before_note = Path(note_path).read_bytes()
                log_mtime = os.stat(log_path).st_mtime_ns
                ticket = os.path.join(tmp, 'ticket.json')
                with open(ticket, 'w', encoding='utf-8') as handle:
                    json.dump({
                        'uploadUrl': f'http://127.0.0.1:{port}/material-uploads/{UPLOAD_ID}',
                        'uploadToken': TOKEN,
                        'chunkBytes': 40,
                    }, handle)
                os.chmod(ticket, 0o600)
                proc = run_cli(['--ticket-file', ticket, '--snapshot', '--file', log_path, '--file', note_path])
                self.assertEqual(Path(log_path).read_bytes(), before_log)
                self.assertEqual(Path(note_path).read_bytes(), before_note)
                self.assertEqual(os.stat(log_path).st_mtime_ns, log_mtime)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            combined = proc.stdout + proc.stderr
            self.assertNotIn(TOKEN, combined)
            self.assertNotIn('PATHMARKER_DIR', combined)
            self.assertNotIn('BODYMARKER9f3a', combined)
            by_name = {item['name']: state.blobs[item['id']] for item in state.files}
            self.assertEqual(by_name['会话.log'], first)
            self.assertEqual(by_name['note.bin'], second)
            posted = {item['name']: item for item in state.manifest['files']}
            self.assertEqual(posted['会话.log']['sha256'], hashlib.sha256(first).hexdigest())
            self.assertEqual(posted['会话.log']['bytes'], len(first))
            self.assertEqual(posted['会话.log']['coverage'], 'export')
            self.assertEqual(posted['会话.log']['source'], 'agent-export')
            self.assertEqual(posted['note.bin']['sha256'], hashlib.sha256(second).hexdigest())
            log_id = next(item['id'] for item in state.files if item['name'] == '会话.log')
            log_puts = [item for item in state.requests if item['method'] == 'PUT' and log_id in item['path']]
            self.assertGreater(len(log_puts), 1)
            self.assertTrue(all(item['length'] <= 40 for item in log_puts))
            self.assertEqual(b''.join(item['body'] for item in log_puts), first)
        finally:
            server.shutdown()
            server.server_close()

    def test_snapshot_tolerates_append_after_capture(self) -> None:
        state = State()
        server = serve(Handler, state)
        original = b'prefix\r\n\xff'
        extra = b'\nAPPENDED-TAIL'
        path_box = {'path': ''}

        def grow() -> None:
            with open(path_box['path'], 'ab') as handle:
                handle.write(extra)

        state.on_manifest = grow
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'PATHMARKER_DIR.log')
                path_box['path'] = path
                with open(path, 'wb') as handle:
                    handle.write(original)
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--snapshot',
                    '--file', path,
                ])
                self.assertEqual(Path(path).read_bytes(), original + extra)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(state.blobs['22222222-2222-4222-8222-222222222222'], original)
            self.assertEqual(state.manifest['files'][0]['sha256'], hashlib.sha256(original).hexdigest())
            self.assertEqual(state.manifest['files'][0]['bytes'], len(original))
            self.assertNotIn('APPENDED-TAIL', proc.stdout + proc.stderr)
            self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
        finally:
            server.shutdown()
            server.server_close()

    def test_without_snapshot_append_during_send_is_rejected(self) -> None:
        state = State()
        server = serve(Handler, state)
        original = b'prefix\r\n\xff'
        path_box = {'path': ''}

        def grow() -> None:
            with open(path_box['path'], 'ab') as handle:
                handle.write(b'\nAPPENDED-TAIL')

        state.on_manifest = grow
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'active.log')
                path_box['path'] = path
                with open(path, 'wb') as handle:
                    handle.write(original)
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--file', path,
                ])
                self.assertEqual(Path(path).read_bytes(), original + b'\nAPPENDED-TAIL')
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn('file changed while sending', proc.stderr)
            self.assertNotIn('RECEIVED', proc.stdout)
            self.assertNotEqual(state.blobs.get('22222222-2222-4222-8222-222222222222'), original + b'\nAPPENDED-TAIL')
            self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
        finally:
            server.shutdown()
            server.server_close()

    def test_snapshot_capture_accepts_append_and_rejects_mutation(self) -> None:
        original = b'AAAA\r\n\xff\x00BBBB'
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'active.log')
            with open(path, 'wb') as handle:
                handle.write(original)
            def append() -> None:
                with open(path, 'ab') as handle:
                    handle.write(b'GROW')

            real_read, wrapped = patch_source_after_prefix(path, append)
            HELPER_MOD.os.read = wrapped
            try:
                copied = HELPER_MOD.capture_snapshots([(path, 'active.log', 'export')], HELPER_MOD.MAX_TOTAL_BYTES, tmp)
            finally:
                HELPER_MOD.os.read = real_read
            self.assertEqual(Path(path).read_bytes(), original + b'GROW')
            self.assertEqual(Path(copied[0][0]).read_bytes(), original)
            self.assertEqual(copied[0][1], 'active.log')
            self.assertEqual(copied[0][2], 'export')

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'active.log')
            with open(path, 'wb') as handle:
                handle.write(original)

            def overwrite() -> None:
                fd = os.open(path, os.O_WRONLY)
                try:
                    os.write(fd, b'Z' * len(original))
                finally:
                    os.close(fd)

            real_read, wrapped = patch_source_after_prefix(path, overwrite)
            HELPER_MOD.os.read = wrapped
            try:
                with self.assertRaises(HELPER_MOD.UploadError) as ctx:
                    HELPER_MOD.capture_snapshots([(path, 'active.log', 'export')], HELPER_MOD.MAX_TOTAL_BYTES, tmp)
            finally:
                HELPER_MOD.os.read = real_read
            self.assertIn('capturing', str(ctx.exception))
            self.assertEqual(Path(path).read_bytes(), b'Z' * len(original))
            snap = os.path.join(tmp, 'snap')
            if os.path.isdir(snap):
                self.assertEqual(os.listdir(snap), [])

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'active.log')
            with open(path, 'wb') as handle:
                handle.write(original)
            real_read, wrapped = patch_source_after_prefix(path, lambda: os.truncate(path, 0))
            HELPER_MOD.os.read = wrapped
            try:
                with self.assertRaises(HELPER_MOD.UploadError) as ctx:
                    HELPER_MOD.capture_snapshots([(path, 'active.log', 'export')], HELPER_MOD.MAX_TOTAL_BYTES, tmp)
            finally:
                HELPER_MOD.os.read = real_read
            self.assertIn('capturing', str(ctx.exception))
            self.assertEqual(Path(path).read_bytes(), b'')

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'active.log')
            with open(path, 'wb') as handle:
                handle.write(original)
            replacement = os.path.join(tmp, 'other.log')

            def replace() -> None:
                with open(replacement, 'wb') as handle:
                    handle.write(b'YYYY')
                os.replace(replacement, path)

            real_read, wrapped = patch_source_after_prefix(path, replace)
            HELPER_MOD.os.read = wrapped
            try:
                with self.assertRaises(HELPER_MOD.UploadError) as ctx:
                    HELPER_MOD.capture_snapshots([(path, 'active.log', 'export')], HELPER_MOD.MAX_TOTAL_BYTES, tmp)
            finally:
                HELPER_MOD.os.read = real_read
            self.assertIn('capturing', str(ctx.exception))
            self.assertEqual(Path(path).read_bytes(), b'YYYY')

    def test_snapshot_limits_and_cleanup_before_network(self) -> None:
        state = State()
        server = serve(Handler, state)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                scratch = os.path.join(tmp, 'scratch')
                os.makedirs(scratch)
                huge = os.path.join(tmp, 'huge.bin')
                fd = os.open(huge, os.O_CREAT | os.O_WRONLY, 0o600)
                os.ftruncate(fd, HELPER_MOD.MAX_TOTAL_BYTES + 1)
                os.close(fd)
                started = time.monotonic()
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--snapshot',
                    '--file', huge,
                ], env={'TMPDIR': scratch})
                self.assertLess(time.monotonic() - started, 2)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn('1GiB', proc.stderr)
                self.assertEqual(state.requests, [])
                self.assertEqual(os.listdir(scratch), [])

                empty = os.path.join(tmp, 'empty.log')
                open(empty, 'wb').close()
                outside = os.path.join(tmp, 'outside.bin')
                with open(outside, 'wb') as handle:
                    handle.write(b'CANARY')
                link = os.path.join(tmp, 'link.log')
                os.symlink(outside, link)
                linked = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--snapshot',
                    '--file', link,
                ], env={'TMPDIR': scratch})
                self.assertNotEqual(linked.returncode, 0)
                self.assertNotIn('CANARY', linked.stdout + linked.stderr)
                self.assertEqual(state.requests, [])
                self.assertEqual(os.listdir(scratch), [])

                blank = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--snapshot',
                    '--file', empty,
                ])
                self.assertNotEqual(blank.returncode, 0)
                self.assertEqual(state.requests, [])

                payload = os.path.join(tmp, 'payload.json')
                with open(payload, 'w', encoding='utf-8') as handle:
                    handle.write('{"files":[{"name":"a.txt","content":"SECRETTEXT"}]}')
                note = os.path.join(tmp, 'note.bin')
                with open(note, 'wb') as handle:
                    handle.write(b'abc')
                started = time.monotonic()
                rejected = run_cli([
                    '--url', f'http://127.0.0.1:9/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--snapshot',
                    '--payload-json', payload,
                    '--file', note,
                ])
                self.assertLess(time.monotonic() - started, 2)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn('snapshot', rejected.stderr)
                self.assertNotIn('SECRETTEXT', rejected.stdout + rejected.stderr)
                self.assertEqual(state.requests, [])

            real_read = HELPER_MOD.os.read

            def boom(fd: int, size: int) -> bytes:
                raise HELPER_MOD.UploadError('read too early')

            HELPER_MOD.os.read = boom
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    huge_local = os.path.join(tmp, 'huge.bin')
                    fd = os.open(huge_local, os.O_CREAT | os.O_WRONLY, 0o600)
                    os.ftruncate(fd, HELPER_MOD.MAX_TOTAL_BYTES + 1)
                    os.close(fd)
                    with self.assertRaises(HELPER_MOD.UploadError) as huge_err:
                        HELPER_MOD.capture_snapshots(
                            [(huge_local, 'huge.bin', 'export')],
                            HELPER_MOD.MAX_TOTAL_BYTES,
                            tmp,
                        )
                    self.assertIn('1GiB', str(huge_err.exception))
                    self.assertNotIn('snap', os.listdir(tmp))
                    first = os.path.join(tmp, 'a.bin')
                    second = os.path.join(tmp, 'b.bin')
                    with open(first, 'wb') as handle:
                        handle.write(b'123456')
                    with open(second, 'wb') as handle:
                        handle.write(b'123456')
                    with self.assertRaises(HELPER_MOD.UploadError) as ctx:
                        HELPER_MOD.capture_snapshots(
                            [(first, 'a.bin', 'export'), (second, 'b.bin', 'export')],
                            10,
                            tmp,
                        )
                    self.assertIn('upload limit', str(ctx.exception))
                    self.assertNotIn('snap', os.listdir(tmp))
                    os.link(first, os.path.join(tmp, 'alias.bin'))
                    with self.assertRaises(HELPER_MOD.UploadError) as dup:
                        HELPER_MOD.capture_snapshots(
                            [(first, 'a.bin', 'export'), (os.path.join(tmp, 'alias.bin'), 'alias.bin', 'export')],
                            HELPER_MOD.MAX_TOTAL_BYTES,
                            tmp,
                        )
                    self.assertIn('duplicate', str(dup.exception))
                    self.assertEqual(set(os.listdir(tmp)), {'huge.bin', 'a.bin', 'b.bin', 'alias.bin'})
            finally:
                HELPER_MOD.os.read = real_read
        finally:
            server.shutdown()
            server.server_close()

    def test_snapshot_cleans_private_temps_when_upload_fails(self) -> None:
        state = State()
        state.reject_manifest_body = f'{TOKEN} BODYMARKER9f3a'.encode('utf-8')
        modes: list[int] = []

        def record() -> None:
            for root, dirs, files in os.walk(state.scratch):
                for name in dirs:
                    info = os.lstat(os.path.join(root, name))
                    self.assertFalse(stat.S_ISLNK(info.st_mode))
                    modes.append(stat.S_IMODE(info.st_mode))
                for name in files:
                    info = os.lstat(os.path.join(root, name))
                    self.assertFalse(stat.S_ISLNK(info.st_mode))
                    modes.append(stat.S_IMODE(info.st_mode))

        state.on_manifest = record
        server = serve(Handler, state)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                scratch = os.path.join(tmp, 'scratch')
                os.makedirs(scratch)
                state.scratch = scratch
                path = os.path.join(tmp, 'PATHMARKER_DIR.log')
                with open(path, 'wb') as handle:
                    handle.write(b'\r\nBODYMARKER9f3a\xff')
                before = Path(path).read_bytes()
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--snapshot',
                    '--file', path,
                ], env={'TMPDIR': scratch})
                self.assertEqual(Path(path).read_bytes(), before)
                self.assertEqual(os.listdir(scratch), [])
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn(0o700, modes)
            self.assertIn(0o600, modes)
            self.assertTrue(all(mode in {0o700, 0o600} for mode in modes))
            self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
            self.assertNotIn('BODYMARKER9f3a', proc.stdout + proc.stderr)
            self.assertNotIn('PATHMARKER_DIR', proc.stdout + proc.stderr)
        finally:
            server.shutdown()
            server.server_close()

    def test_snapshot_conflict_does_not_replace_manifest(self) -> None:
        state = State()
        state.conflict_on_change = True
        file_id = '22222222-2222-4222-8222-222222222222'
        state.files = [{
            'id': file_id,
            'name': 'active.log',
            'sha256': 'ab' * 32,
            'bytes': 4,
            'receivedBytes': 4,
        }]
        state.blobs[file_id] = b'KEEP'
        server = serve(Handler, state)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'active.log')
                with open(path, 'wb') as handle:
                    handle.write(b'NEXT\r\n')
                started = time.monotonic()
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--snapshot',
                    '--file', path,
                ])
                self.assertLess(time.monotonic() - started, 3)
                self.assertEqual(Path(path).read_bytes(), b'NEXT\r\n')
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn('conflict', proc.stderr)
            self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
            self.assertNotIn('BODYMARKER9f3a', proc.stdout + proc.stderr)
            self.assertEqual(state.blobs[file_id], b'KEEP')
            self.assertEqual(state.files[0]['sha256'], 'ab' * 32)
            self.assertEqual([item for item in state.requests if item['method'] == 'PUT'], [])
            posts = [item for item in state.requests if item['method'] == 'POST']
            self.assertEqual(len(posts), 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_snapshot_identical_capture_resumes_without_replacing(self) -> None:
        payload = b'same\r\n'
        digest = hashlib.sha256(payload).hexdigest()
        state = State()
        state.conflict_on_change = True
        file_id = '22222222-2222-4222-8222-222222222222'
        state.files = [{
            'id': file_id,
            'name': 'active.log',
            'sha256': digest,
            'bytes': len(payload),
            'receivedBytes': len(payload),
        }]
        state.blobs[file_id] = payload
        server = serve(Handler, state)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'active.log')
                with open(path, 'wb') as handle:
                    handle.write(payload)
                proc = run_cli([
                    '--url', f'http://127.0.0.1:{server.server_address[1]}/material-uploads/{UPLOAD_ID}',
                    '--token', TOKEN,
                    '--snapshot',
                    '--file', path,
                ])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(state.blobs[file_id], payload)
            self.assertEqual([item for item in state.requests if item['method'] == 'PUT'], [])
            events = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
            self.assertEqual(events[-1]['status'], 'RECEIVED')
        finally:
            server.shutdown()
            server.server_close()


def patch_source_after_prefix(path: str, mutate) -> tuple:
    info = os.stat(path)
    real_read = HELPER_MOD.os.read
    seen = {'bytes': 0, 'done': False}

    def wrapped(fd: int, size: int) -> bytes:
        data = real_read(fd, size)
        try:
            current = os.fstat(fd)
        except OSError:
            return data
        if not seen['done'] and current.st_ino == info.st_ino and current.st_dev == info.st_dev:
            seen['bytes'] += len(data)
            if seen['bytes'] >= info.st_size:
                seen['done'] = True
                mutate()
        return data

    return real_read, wrapped


if __name__ == '__main__':
    unittest.main()
