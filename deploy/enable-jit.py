"""Enable JIT without touching OAuth secrets, grants or existing users."""
import os
import pathlib
import sqlite3
import json

config = pathlib.Path('/etc/opslands-sso.env')
lines = config.read_text().splitlines()
settings = dict(line.split('=', 1) for line in lines if '=' in line)
if settings.get('SSO_ENABLED') != '1':
    raise SystemExit('Enable the registered SSO client first')
database = sqlite3.connect('/var/lib/opslands/opslands.sqlite')
backup_path = pathlib.Path('/var/lib/opslands/backups/before-jit.sqlite')
if not backup_path.exists():
    with sqlite3.connect(backup_path) as backup:
        database.backup(backup)
    backup_path.chmod(0o600)
new_lines = [line for line in lines if not line.startswith('SSO_JIT=')]
new_lines.append('SSO_JIT=1')
temp_path = pathlib.Path(str(config) + '.jit-tmp')
fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write('\n'.join(new_lines) + '\n')
temp_path.chmod(0o600)
os.replace(temp_path, config)
print('SSO_JIT=1; client secrets and grants unchanged; database backed up.')
print('Data counts:', dict(database.execute('SELECT kind,COUNT(*) FROM records GROUP BY kind').fetchall()))
