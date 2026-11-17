// Seed HTTP authorization fixtures through the test database, never through a login bypass.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';

export function seedSession(data, { name, login, role = 'member' }, mode = 'oidc') {
  const db = new DatabaseSync(join(data, 'opslands.sqlite'));
  const user = { id: randomUUID(), name, login, role, createdAt: new Date().toISOString() };
  const token = randomBytes(32).toString('hex');
  const session = { id: createHash('sha256').update(token).digest('hex'), userId: user.id, mode, expiresAt: Date.now() + 86400000, refreshedAt: Date.now() };
  const save = db.prepare('INSERT INTO records VALUES (?,?,?)');
  save.run('user', user.id, JSON.stringify(user));
  save.run('session', session.id, JSON.stringify(session));
  db.close();
  return { user, cookie: `opslands_session=${token}` };
}
