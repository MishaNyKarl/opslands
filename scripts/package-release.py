"""Build a release plus a transactionally consistent SQLite snapshot."""
import pathlib
import sqlite3
import tarfile

root = pathlib.Path(__file__).resolve().parent.parent
output = root / 'data' / 'deploy'
output.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(root / 'data' / 'opslands.sqlite') as source:
    with sqlite3.connect(output / 'opslands.sqlite') as target:
        source.backup(target)
        print('Snapshot:', dict(target.execute('SELECT kind, COUNT(*) FROM records GROUP BY kind').fetchall()))
with tarfile.open(output / 'release.tar.gz', 'w:gz') as archive:
    for name in ['server.mjs', 'package.json', 'pnpm-lock.yaml', 'lib', 'public', 'README.md']:
        archive.add(root / name, arcname='app/' + name)
    archive.add(output / 'opslands.sqlite', arcname='database/opslands.sqlite')
print('Release:', output / 'release.tar.gz')
