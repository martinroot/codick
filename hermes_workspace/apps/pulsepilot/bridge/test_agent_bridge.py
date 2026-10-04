import json
import sys
import tempfile
import time
import unittest
import uuid
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from pathlib import Path
from agent_bridge import Bridge, handler


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.worker = self.root / 'worker.py'
        self.worker.write_text('''import sys,time,json
from pathlib import Path
folder=Path(sys.argv[1])
prompt=Path(sys.argv[2]).read_text()
if prompt=='input':
    (folder/'status.json').write_text(json.dumps({'status':'waiting_input','question':'Which output?'}))
    answer=json.loads(sys.stdin.readline())['answer']
    (folder/'result.txt').write_text(answer)
elif prompt=='slow':
    print('starting',flush=True)
    time.sleep(20)
elif prompt=='fail':
    sys.exit(2)
else:
    (folder/'result.txt').write_text('verified '+prompt)
print('finished',flush=True)
''', encoding='utf-8')
        self.argv = [sys.executable, str(self.worker), '{job_dir}', '{prompt_file}']
        self.bridge = Bridge(self.root/'runs', self.argv, 7)

    def tearDown(self):
        for proc in self.bridge.processes.values():
            if proc.poll() is None:
                proc.kill()
            proc.wait()
        for thread in self.bridge.threads.values():
            thread.join(timeout=2)
        self.temp.cleanup()

    def submit(self, prompt='ok', resource='r'):
        data = dict(client_job_id=uuid.uuid4().hex, prompt=prompt, resource=resource)
        return data, self.bridge.submit(data)

    def until(self, run_id, status, seconds=3):
        deadline = time.monotonic()+seconds
        while time.monotonic()<deadline:
            result=self.bridge.get(run_id)
            if result['status']==status:
                return result
            time.sleep(.02)
        self.fail(f'Expected {status}, got {result}')

    def test_real_process_result(self):
        data, _ = self.submit()
        result = self.until(data['client_job_id'], 'completed')
        self.assertEqual(result['result'],'verified ok')

    def test_duplicate_submit_no_second_process(self):
        data, _ = self.submit('slow')
        self.bridge.submit(data)
        self.assertEqual(len(self.bridge.processes),1)

    def test_parallel_seven_and_limit(self):
        jobs=[self.submit('slow',str(i)) for i in range(7)]
        self.assertEqual(len(self.bridge.processes),7)
        with self.assertRaises(RuntimeError): self.submit('slow','eighth')

    def test_resource_lock(self):
        self.submit('slow','same-repo')
        with self.assertRaises(RuntimeError): self.submit('ok','same-repo')

    def test_wait_input_version_and_duplicate(self):
        data,_=self.submit('input')
        waiting=self.until(data['client_job_id'],'waiting_input')
        payload=dict(answer='artifact',input_id='answer-1',expected_version=waiting['version']-1)
        with self.assertRaises(RuntimeError):self.bridge.answer(data['client_job_id'],payload)
        payload['expected_version']=waiting['version']
        self.bridge.answer(data['client_job_id'],payload)
        self.bridge.answer(data['client_job_id'],payload)
        self.assertEqual(self.until(data['client_job_id'],'completed')['result'],'artifact')

    def test_worker_failure(self):
        data,_=self.submit('fail')
        self.until(data['client_job_id'],'failed')

    def test_cancel_confirmed_after_exit(self):
        data,_=self.submit('slow')
        self.bridge.cancel(data['client_job_id'])
        self.until(data['client_job_id'],'cancelled')

    def test_restart_never_resubmits_unknown(self):
        data,_=self.submit('slow')
        recovered=Bridge(self.root/'runs',self.argv)
        self.assertEqual(recovered.get(data['client_job_id'])['status'],'unknown')
        recovered.submit(data)
        self.assertEqual(len(recovered.processes),0)

    def test_unknown_resolution_requires_stopped_evidence(self):
        data,_=self.submit('slow')
        recovered=Bridge(self.root/'runs',self.argv)
        run=recovered.get(data['client_job_id'])
        with self.assertRaises(ValueError):
            recovered.resolve(data['client_job_id'],dict(status='cancelled',evidence='',expected_version=run['version']))
        self.bridge.processes[data['client_job_id']].kill()
        self.bridge.processes[data['client_job_id']].wait()
        self.bridge.threads[data['client_job_id']].join(timeout=2)
        resolved=recovered.resolve(data['client_job_id'],dict(status='cancelled',evidence='Worker stopped and checked',expected_version=run['version']))
        self.assertEqual(resolved['status'],'cancelled')

    def test_http_authentication(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(self.bridge,'test-token'))
        thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=.01),daemon=True)
        thread.start()
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/runs/not-a-run',timeout=2)
            self.assertEqual(error.exception.code,401)
        finally:server.shutdown();server.server_close();thread.join()

    def test_http_submit_contract(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(self.bridge,'test-token'))
        thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=.01),daemon=True)
        thread.start()
        try:
            run_id=uuid.uuid4().hex
            request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/runs',
                data=json.dumps(dict(client_job_id=run_id,prompt='ok',resource='http')).encode(),
                headers={'Authorization':'Bearer test-token','Content-Type':'application/json'})
            with urllib.request.urlopen(request,timeout=2) as response:result=json.load(response)
            self.assertEqual(result['id'],run_id)
            self.assertIsInstance(result['version'],int)
            self.assertIn('progress_at',result)
        finally:server.shutdown();server.server_close();thread.join()

    def test_idempotency_conflict(self):
        data,_=self.submit('slow')
        data['prompt']='other'
        with self.assertRaises(ValueError):self.bridge.submit(data)

    def test_invalid_path_rejected(self):
        with self.assertRaises(ValueError):self.bridge.submit(dict(client_job_id='../x',prompt='ok',resource='r'))

if __name__=='__main__':unittest.main()
