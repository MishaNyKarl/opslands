export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function validatePartner(input) {
  if (!input.name?.trim() || input.name.length > 100) throw new Error('Укажите название партнерки');
  if (!['GET', 'POST'].includes(input.method)) throw new Error('Метод должен быть GET или POST');
  if (!Array.isArray(input.fields) || input.fields.length > 30) throw new Error('Не более 30 полей');
  const keys = new Set();
  const fields = input.fields.map(f => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(f.key) || keys.has(f.key)) throw new Error('Ключи полей должны быть уникальными: латиница, цифры, _');
    keys.add(f.key);
    if (!f.label?.trim() || !['text', 'url', 'secret'].includes(f.type)) throw new Error('Укажите название и тип каждого поля');
    const target = String(f.target || f.key);
    if (!/^[a-zA-Z][a-zA-Z0-9_\[\]-]{0,79}$/.test(target)) throw new Error('Недопустимое имя поля формы');
    return { key: f.key, label: f.label.trim(), type: f.type, required: Boolean(f.required), target };
  });
  return { name: input.name.trim(), description: String(input.description || '').slice(0, 500), method: input.method, fields };
}
function httpUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
export function buildLanding(landing, partner, values, action) {
  if (!httpUrl(action)) throw new Error('Укажите полный HTTP(S) URL обработчика формы');
  const clean = Object.create(null);
  for (const field of partner.fields) {
    const value = String(values?.[field.key] ?? '').trim();
    if (value.length > 4000) throw new Error(`Слишком длинное значение: ${field.label}`);
    if (field.required && !value) throw new Error(`Заполните поле «${field.label}»`);
    if (field.type === 'url' && value && !httpUrl(value)) throw new Error(`Некорректный URL: ${field.label}`);
    clean[field.key] = value;
  }
  const files = { ...landing.files };
  const entry = Buffer.from(files[landing.entry], 'base64').toString('utf8');
  for (const token of ['{{form_action}}', '{{form_method}}', '{{hidden_fields}}']) {
    if (!entry.includes(token)) throw new Error(`Ленд не подготовлен: добавьте ${token} в основной HTML через редактор`);
  }
  const hidden = partner.fields.filter(f => clean[f.key]).map(f => `<input type="hidden" name="${escapeHtml(f.target)}" value="${escapeHtml(clean[f.key])}">`).join('\n');
  for (const [path, data] of Object.entries(files)) {
    if (!/\.html?$/i.test(path)) continue;
    let html = Buffer.from(data, 'base64').toString('utf8');
    html = html.replace(/\{\{(form_action|form_method|hidden_fields|pp\.([a-zA-Z][a-zA-Z0-9_]*))\}\}/g, (_, token, key) => {
      if (token === 'hidden_fields') return hidden;
      if (token === 'form_action') return escapeHtml(action);
      if (token === 'form_method') return partner.method;
      if (!Object.hasOwn(clean, key)) throw new Error(`Поле ${key} отсутствует у выбранной партнерки`);
      return escapeHtml(clean[key]);
    });
    files[path] = Buffer.from(html).toString('base64');
  }
  return files;
}
