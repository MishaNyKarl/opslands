"""Run with the existing OpsVault venv as an authorized operator. No secret output."""
import os
import sys
import json
import sqlite3
import pathlib
import secrets

env_path = pathlib.Path('/etc/opslands-sso.env')
db = sqlite3.connect('/var/lib/opslands/opslands.sqlite')
backup_path = pathlib.Path('/var/lib/opslands/backups/before-sso.sqlite')
backup_path.parent.mkdir(mode=0o700, exist_ok=True)
if not backup_path.exists():
    with sqlite3.connect(backup_path) as backup:
        db.backup(backup)
    backup_path.chmod(0o600)
users = [json.loads(row[0]) for row in db.execute("SELECT payload FROM records WHERE kind='user'")]
pilot = next(user for user in users if user['login'] == 'admin')
if not env_path.exists():
    values = {
        'SSO_CLIENT_ID': 'opslands', 'SSO_CLIENT_SECRET': secrets.token_urlsafe(48),
        'SSO_ENCRYPTION_KEY': secrets.token_urlsafe(32), 'SSO_ENABLED': '1', 'SSO_JIT': '0',
        'SSO_REDIRECT_URI': 'https://land.portalwiki.world/auth/opsvault/callback',
        'SSO_LINK_USERS': pilot['id'], 'SSO_EMERGENCY_USERS': pilot['id'],
    }
    fd = os.open(str(env_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(''.join(f'{key}={value}\n' for key,value in values.items()))
else:
    values = dict(line.strip().split('=',1) for line in env_path.read_text().splitlines() if '=' in line)
sys.path.insert(0, '/opt/opsvault')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'opsvault.settings')
os.environ['SSO_REGISTER_CLIENT_ID'] = values['SSO_CLIENT_ID']
os.environ['SSO_REGISTER_CLIENT_SECRET'] = values['SSO_CLIENT_SECRET']
import django
django.setup()
from django.core.management import call_command
call_command('sso_register_service', 'opslands', name='OPSLands', redirect_uri=values['SSO_REDIRECT_URI'], post_logout_uri='https://land.portalwiki.world/')
call_command('sso_grant', 'karlmichael', 'opslands', role='admin')
print('Registered OPSLands and explicit pilot grant. Existing local IDs and owners untouched.')
print('Data counts:', dict(db.execute('SELECT kind,COUNT(*) FROM records GROUP BY kind').fetchall()))
