"""SSH deployment helper: credentials arrive on stdin and are never saved."""
import json
import sys
import paramiko
import getpass
import base64
import hashlib
import secrets
import subprocess
import os
import pathlib

request = json.loads(base64.b64decode(getpass.getpass('SSH request base64 (input hidden): ')))
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    ssh_password = request.pop('password')
    for attempt in range(3):
        try:
            client.connect(request['host'], username='root', password=ssh_password, timeout=30, banner_timeout=30, auth_timeout=30, look_for_keys=False, allow_agent=False)
            break
        except (paramiko.SSHException, OSError):
            if attempt == 2:
                raise
            client.close()
            __import__('time').sleep(2)
    del ssh_password
    if request.get('uploads'):
        with client.open_sftp() as sftp:
            for item in request['uploads']:
                sftp.put(item['local'], item['remote'])
                sftp.chmod(item['remote'], 0o600)
                print('Uploaded: ' + item['remote'], flush=True)
    for command in request.get('commands', []):
        stdin, stdout, stderr = client.exec_command(command, timeout=600)
        stdin.close()
        # Read concurrently to avoid a full remote stderr pipe blocking stdout.
        channel = stdout.channel
        import time
        while not channel.exit_status_ready() or channel.recv_ready() or channel.recv_stderr_ready():
            if channel.recv_ready():
                sys.stdout.write(channel.recv(65536).decode('utf-8', 'replace')); sys.stdout.flush()
            if channel.recv_stderr_ready():
                sys.stdout.write(channel.recv_stderr(65536).decode('utf-8', 'replace')); sys.stdout.flush()
            time.sleep(0.05)
        code = channel.recv_exit_status()
        print('\nExit: ' + str(code), flush=True)
        if code:
            sys.exit(code)
    if request.get('browser_check'):
        token = secrets.token_hex(32)
        session_id = hashlib.sha256(token.encode()).hexdigest()
        create = "import sqlite3,json,time; d=sqlite3.connect('/var/lib/opslands/opslands.sqlite'); users=[json.loads(r[0]) for r in d.execute(\"SELECT payload FROM records WHERE kind='user'\")]; u=next(u for u in users if u['role']=='admin'); s={'id':'" + session_id + "','userId':u['id'],'expiresAt':int(time.time()*1000)+300000,'refreshedAt':int(time.time()*1000)}; d.execute('INSERT INTO records VALUES (?,?,?)',('session',s['id'],json.dumps(s))); d.commit()"
        _, stdout, stderr = client.exec_command('python3 -c ' + __import__('shlex').quote(create))
        if stdout.channel.recv_exit_status():
            raise RuntimeError(stderr.read().decode())
        try:
            root = pathlib.Path(__file__).resolve().parent.parent
            result = subprocess.run([os.environ['OPSLANDS_NODE'], str(root / 'scripts' / 'production-check.mjs')], input=json.dumps({'origin': 'https://land.portalwiki.world', 'token': token}), text=True, cwd=root, capture_output=True)
            print(result.stdout, flush=True)
            print(result.stderr, flush=True)
            if result.returncode:
                raise RuntimeError('Production browser QA failed')
        finally:
            cleanup = "import sqlite3; d=sqlite3.connect('/var/lib/opslands/opslands.sqlite'); d.execute(\"DELETE FROM records WHERE kind='session' AND id=?\",('" + session_id + "',)); d.commit()"
            _, stdout, _ = client.exec_command('python3 -c ' + __import__('shlex').quote(cleanup))
            stdout.channel.recv_exit_status()
finally:
    client.close()
