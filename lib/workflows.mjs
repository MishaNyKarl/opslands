import { randomUUID, createHash } from 'node:crypto';
import { prepareLanding } from './prepare.mjs';
import { zip } from './archive.mjs';

const cleanFiles = files => Object.fromEntries(Object.entries(files).filter(([path]) => path !== 'ops-config.php'));
const fingerprint = files => createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
export function workflowStore({ all, get, save, db }) {
  const transaction = action => { db.exec('BEGIN'); try { const result = action(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  function record(user, files, workflow, name, parentId = null) {
    return { id: randomUUID(), name: name.slice(0, 120), type: 'Лендинг', language: workflow.language || 'Оригинал', description: workflow.kind === 'source' ? 'Исходная страница и ресурсы. Прежние PHP-обработчики, скрытые реквизиты и журналы удалены.' : workflow.kind === 'prepared' ? `Формы подключены к ${workflow.partner}. Реквизиты вводятся при скачивании.` : workflow.mode === 'images' ? `Изображения адаптированы: ${workflow.country}. Тексты сохранены. Исходник доступен отдельно.` : `ИИ-адаптация: ${workflow.country} · ${workflow.language}. Исходник сохранен отдельно.`, author: user.name, ownerId: user.id, isGlobal: false, color: 'sage', parentId, entry: 'index.html', files: cleanFiles(files), downloads: 0, changes: 0, createdAt: new Date().toISOString(), demo: false, workflow };
  }
  function source(user, prepared, input = {}) {
    const files = cleanFiles(prepared.sourceFiles || prepared.files), hash = fingerprint(files);
    const existing = all('landing').find(l => l.ownerId === user.id && l.workflow?.kind === 'source' && l.workflow.fingerprint === hash);
    if (existing) return existing;
    const title = String(input.name || input.entry?.split('/').slice(-2, -1)[0] || 'Лендинг').replace(/\.zip$/i, '').slice(0, 80);
    const landing = record(user, files, { kind: 'source', partner: prepared.partner, fingerprint: hash }, title);
    landing.workflow.sourceId = landing.id; save('landing', landing); return landing;
  }
  function result(user, parent, files, workflow) {
    if (workflow.jobId) {
      const existing = all('landing').find(l => l.ownerId === user.id && l.workflow?.jobId === workflow.jobId); if (existing) return existing;
    }
    const hash = fingerprint(cleanFiles(files));
    if (workflow.kind === 'prepared') {
      const existing = all('landing').find(l => l.ownerId === user.id && l.workflow?.kind === 'prepared' && l.workflow.sourceId === parent.id && l.workflow.fingerprint === hash); if (existing) return existing;
    }
    const suffix = workflow.kind === 'prepared' ? 'Подготовлен' : `${workflow.country} / ${workflow.language}`;
    const landing = record(user, files, { ...workflow, sourceId: parent.id, fingerprint: hash }, `${parent.name} / ${suffix}`, parent.id);
    save('landing', landing); parent.changes++; save('landing', parent); return landing;
  }
  return {
    prepared(user, prepared, input) { return transaction(() => { const parent = source(user, prepared, input); const landing = result(user, parent, prepared.files, { kind: 'prepared', partner: prepared.partner }); landing.downloads++; save('landing', landing); return landing; }); },
    source(user, prepared, input) { return transaction(() => source(user, prepared, input)); },
    adapted(job, files) { return transaction(() => { const user = get('user', job.ownerId), parent = get('landing', job.sourceLandingId); if (parent.ownerId !== user.id) throw new Error('Исходник недоступен'); return result(user, parent, files, { kind: 'adapted', partner: job.partner, jobId: job.id, country: job.country, language: job.language, mode: job.mode, textModel: job.textModel, imageModel: job.imageModel }); }); },
    recover() {
      for (const job of all('adaptation')) {
        if (job.state !== 'ready' || job.resultLandingId) continue;
        let user, files;
        try { user = get('user', job.ownerId); files = job.files || get('adaptation-result', job.id).files; } catch { continue; }
        transaction(() => {
          let landing = all('landing').find(l => l.ownerId === user.id && l.workflow?.jobId === job.id);
          if (!landing) {
            if (job.sourceLandingId) landing = result(user, get('landing', job.sourceLandingId), files, { kind: 'adapted', partner: job.partner, jobId: job.id, country: job.country, language: job.language });
            else {
              landing = record(user, files, { kind: 'adapted', partner: job.partner, jobId: job.id, country: job.country, language: job.language, originalMissing: true }, `Адаптация / ${job.country || job.language || 'Лендинг'}`);
              landing.description = 'Результат из прежнего задания. Исходник не сохранялся прежней версией приложения.'; save('landing', landing);
            }
          }
          job.resultLandingId = landing.id; save('adaptation', job);
        });
      }
    },
    download(landing, values) {
      if (!landing.workflow) throw new Error('Этот ленд не относится к подготовке или адаптации');
      const files = { ...landing.files, 'index.html': Buffer.from(Buffer.from(landing.files['index.html'], 'base64').toString().replaceAll('<script src="ops-tracking.js" defer></script>', '')).toString('base64') };
      return zip(prepareLanding({ archive: zip(files).toString('base64'), entry: 'index.html', partner: landing.workflow.partner, values }).files);
    }
  };
}
