"""Local autonomous worker adapter. Python 3.10+, standard library only."""
import argparse
import json
import os
import re
import secrets
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ACTIVE = {'queued', 'running', 'waiting_input', 'blocked', 'unknown'}
PUBLIC = ('id', 'status', 'version', 'summary', 'question', 'result', 'progress_at')


class Bridge:
    def __init__(self, root, argv, max_parallel=7):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.argv = argv
        self.maximum = max(1, min(7, max_parallel))
        self.lock = threading.RLock()
        self.jobs = {}
        self.processes = {}
        self.threads = {}
        for path in self.root.glob('*/run.json'):
            job = json.loads(path.read_text(encoding='utf-8'))
            if job['status'] in ACTIVE:
                job.update(status='unknown', summary='Bridge restarted; previous process outcome must be checked. No automatic retry.', version=job['version'] + 1)
            self.jobs[job['id']] = job
            self.save(job)

    def save(self, job):
        path = self.root / job['id'] / 'run.json'
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
        temp.replace(path)

    def change(self, job, **values):
        job.update(values)
        job['version'] += 1
        job['progress_at'] = int(time.time())
        self.save(job)

    def view(self, job):
        return {key: job.get(key, '') for key in PUBLIC}

    def refresh(self, job):
        path = self.root / job['id'] / 'status.json'
        if path.exists() and job['status'] in ACTIVE:
            stamp = path.stat().st_mtime_ns
            if stamp > job.get('status_stamp', 0):
                try:
                    status = json.loads(path.read_text(encoding='utf-8'))
                    if status.get('status') in {'running', 'waiting_input', 'blocked'}:
                        self.change(job, status=status['status'], summary=str(status.get('summary', ''))[:4000], question=str(status.get('question', ''))[:4000], status_stamp=stamp)
                except (OSError, ValueError):
                    pass  # worker can atomically replace file; a partial write is retried later
        process = self.processes.get(job['id'])
        if process is not None and process.poll() is not None and job.get('output_finished') and job['status'] in ACTIVE:
            result_file = self.root / job['id'] / 'result.txt'
            result = result_file.read_text(encoding='utf-8', errors='replace')[:30000] if result_file.exists() else job.get('summary', '')
            cancelled = job.get('cancel_requested', False)
            self.change(job, status='cancelled' if cancelled else ('completed' if process.returncode == 0 else 'failed'),
                        result=result, question='', summary=f'Worker exited: {process.returncode}. Operator review required.' if not cancelled else 'Worker stopped.')
        return self.view(job)

    def submit(self, data):
        run_id = data.get('client_job_id', '')
        if not isinstance(run_id, str) or not re.fullmatch(r'[a-f0-9]{32}', run_id):
            raise ValueError('client_job_id must be a 32-character lowercase UUID hex')
        prompt = data.get('prompt')
        resource = data.get('resource')
        if not isinstance(prompt, str) or not prompt.strip() or not isinstance(resource, str) or not resource.strip():
            raise ValueError('prompt and resource required')
        with self.lock:
            if run_id in self.jobs:
                old = self.jobs[run_id]
                if old['prompt'] != prompt or old['resource'] != resource:
                    raise ValueError('idempotency key reused for different input')
                return self.refresh(old)
            for job in self.jobs.values():
                self.refresh(job)
            active = [j for j in self.jobs.values() if j['status'] in ACTIVE]
            if len(active) >= self.maximum or any(j['resource'] == resource for j in active):
                raise RuntimeError('capacity or resource reserved')
            folder = self.root / run_id
            folder.mkdir()
            prompt_file = folder / 'prompt.txt'
            prompt_file.write_text(prompt, encoding='utf-8')
            job = dict(id=run_id, status='queued', version=1, summary='Worker queued', question='', result='',
                       progress_at=int(time.time()), prompt=prompt, resource=resource,
                       project_id=data.get('project_id', ''), node_id=data.get('node_id', ''), inputs={})
            self.jobs[run_id] = job
            self.save(job)
            values = {'prompt_file': str(prompt_file), 'job_dir': str(folder), 'run_id': run_id}
            argv = []
            for part in self.argv:
                for key, value in values.items():
                    part = part.replace('{' + key + '}', value)
                argv.append(part)
            try:
                isolation = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
                process = subprocess.Popen(argv, cwd=folder, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', shell=False, **isolation)
                self.processes[run_id] = process
                self.change(job, status='running', summary='Real worker process started')
                thread = threading.Thread(target=self.collect, args=(run_id, process), daemon=True)
                self.threads[run_id] = thread
                thread.start()
            except OSError as error:
                self.change(job, status='failed', summary=f'Cannot start worker: {error}')
            return self.view(job)

    def collect(self, run_id, process):
        try:
            with (self.root / run_id / 'worker.log').open('a', encoding='utf-8') as log:
                for line in process.stdout:
                    log.write(line)
                    log.flush()
                    with self.lock:
                        job = self.jobs[run_id]
                        if job['status'] in ACTIVE:
                            self.change(job, summary=line.strip()[:4000])
        finally:
            process.wait()
            process.stdout.close()
            process.stdin.close()
            with self.lock:
                self.jobs[run_id]['output_finished'] = True
                self.refresh(self.jobs[run_id])

    def get(self, run_id):
        with self.lock:
            return self.refresh(self.jobs[run_id])

    def answer(self, run_id, data):
        with self.lock:
            job = self.jobs[run_id]
            self.refresh(job)
            input_id = data.get('input_id')
            answer = data.get('answer')
            if not isinstance(input_id, str) or not isinstance(answer, str) or not answer.strip():
                raise ValueError('input_id and answer required')
            if input_id in job['inputs']:
                if job['inputs'][input_id] != answer:
                    raise RuntimeError('input id reused with different answer')
                return self.view(job)
            if job['status'] != 'waiting_input' or data.get('expected_version') != job['version']:
                raise RuntimeError('state/version changed; refresh first')
            process = self.processes.get(run_id)
            if process is None or process.poll() is not None:
                raise RuntimeError('worker not available')
            payload = json.dumps({'input_id': input_id, 'answer': answer}, ensure_ascii=False)
            job['inputs'][input_id] = answer
            self.save(job)  # reserve input id before delivery; uncertain delivery is never repeated
            try:
                process.stdin.write(payload + '\n')
                process.stdin.flush()
            except (OSError, ValueError):
                self.change(job, status='unknown', summary='Input delivery uncertain; inspect worker. No automatic redelivery.')
                return self.view(job)
            (self.root / run_id / 'input.json').write_text(payload, encoding='utf-8')
            self.change(job, status='running', question='', summary='Input delivered to worker')
            return self.view(job)

    def cancel(self, run_id):
        with self.lock:
            job = self.jobs[run_id]
            self.refresh(job)
            if job['status'] not in ACTIVE:
                return self.view(job)
            process = self.processes.get(run_id)
            if process is None:
                self.change(job, status='unknown', summary='Process ownership lost; stop/check it in the worker environment.')
                return self.view(job)
            job['cancel_requested'] = True
            if os.name == 'nt':
                stopped = subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
                if stopped.returncode != 0 and process.poll() is None:
                    self.change(job, status='unknown', summary='Worker tree stop not confirmed.')
                    return self.view(job)
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.change(job, summary='Termination requested; final status follows after worker exit')
            return self.refresh(job)

    def resolve(self, run_id, data):
        with self.lock:
            job = self.jobs[run_id]
            process = self.processes.get(run_id)
            if job['status'] != 'unknown' or data.get('expected_version') != job['version']:
                raise RuntimeError('only current unknown outcome can be resolved')
            if process is not None and process.poll() is None:
                raise RuntimeError('owned worker is still running; cancel it first')
            evidence = data.get('evidence')
            if data.get('status') != 'cancelled' or not isinstance(evidence, str) or not evidence.strip():
                raise ValueError('verified cancellation evidence required')
            self.change(job, status='cancelled', summary='Stopped outcome confirmed by operator: ' + evidence[:4000])
            return self.view(job)


def handler(bridge, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, data):
            payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def handle_request(self):
            if not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.reply(401, {'error': 'unauthorized'})
                return
            try:
                self.connection.settimeout(10)
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 <= length <= 1_000_000:
                    raise ValueError('body too large')
                data = json.loads(self.rfile.read(length)) if length else {}
                path = self.path.split('?', 1)[0].strip('/').split('/')
                if self.command == 'POST' and path == ['runs']:
                    result = bridge.submit(data)
                elif len(path) >= 2 and path[0] == 'runs' and re.fullmatch(r'[a-f0-9]{32}', path[1]):
                    if self.command == 'GET' and len(path) == 2:
                        result = bridge.get(path[1])
                    elif self.command == 'POST' and len(path) == 3 and path[2] == 'input':
                        result = bridge.answer(path[1], data)
                    elif self.command == 'POST' and len(path) == 3 and path[2] == 'cancel':
                        result = bridge.cancel(path[1])
                    elif self.command == 'POST' and len(path) == 3 and path[2] == 'resolve':
                        result = bridge.resolve(path[1], data)
                    else:
                        raise KeyError('route')
                else:
                    raise KeyError('route')
                self.reply(200, result)
            except KeyError:
                self.reply(404, {'error': 'run/route not found'})
            except RuntimeError as error:
                self.reply(409, {'error': str(error)})
            except (ValueError, TypeError) as error:
                self.reply(400, {'error': str(error)})
            except Exception:
                self.reply(500, {'error': 'adapter operation failed; check the run status before retry'})

        do_GET = handle_request
        do_POST = handle_request
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker-config', required=True)
    parser.add_argument('--state-dir', default='agent-runs')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8808)
    parser.add_argument('--max-parallel', type=int, default=7)
    args = parser.parse_args()
    token = os.environ.get('PULSEPILOT_BRIDGE_TOKEN', '')
    if len(token) < 16:
        parser.error('set PULSEPILOT_BRIDGE_TOKEN to a token of at least 16 characters')
    config = json.loads(Path(args.worker_config).read_text(encoding='utf-8'))
    argv = config.get('argv')
    if not isinstance(argv, list) or not argv or not all(isinstance(item, str) for item in argv):
        parser.error('worker config must contain a nonempty argv array')
    state_root = Path(args.state_dir).resolve()
    state_root.mkdir(parents=True, exist_ok=True)
    instance_lock = (state_root / 'bridge.lock').open('a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            instance_lock.write(b'0')
            instance_lock.flush()
            instance_lock.seek(0)
            msvcrt.locking(instance_lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(instance_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        parser.error('another Bridge already owns this state directory')
    bridge = Bridge(args.state_dir, argv, args.max_parallel)
    server = ThreadingHTTPServer((args.host, args.port), handler(bridge, token))
    print(f'Agent Bridge listening on {args.host}:{args.port}; slots={bridge.maximum}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
