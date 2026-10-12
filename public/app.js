import { icon } from './icons.js';
document.querySelectorAll('[data-lucide]').forEach(el => el.innerHTML = icon(el.dataset.lucide));
const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let user = '', account = null;
let ssoEnabled = false;
const state = { view: 'catalog', landings: [], partners: [], query: '', type: '', language: '', sort: 'new' };
const modal = $('#modal'), content = $('#content');
$('.local-badge').lastChild.textContent = ['localhost', '127.0.0.1'].includes(location.hostname) ? ' Локальный MVP' : ' Командный MVP';
const labels = { catalog: 'Все ленды', popular: 'Популярные', mine: 'Мои ленды', partners: 'Партнерки', admin: 'Администрирование' };
async function api(path, data) {
  const res = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!res.ok) { const error = await res.json(); if (res.status === 401 && !path.startsWith('/api/auth/')) showAuth(false); throw new Error(error.error || 'Ошибка сервера'); }
  return res.json();
}
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 4000); }
function showModal(html, kicker = 'OPSLANDS / НОВАЯ СБОРКА') { $('#modal-kicker').textContent = kicker; $('#modal-body').innerHTML = html; modal.showModal(); }
function error(form, e) { $('.error', form).textContent = e.message; $('.error', form).classList.add('visible'); }
function profile() { $('#profile-name').innerHTML = `${esc(user)}<small>${account.role === 'admin' ? 'Администратор' : 'Участник команды'}</small>`; $('.avatar').textContent = user[0].toUpperCase(); $('#admin-nav').hidden = account.role !== 'admin'; }
function size(n) { return n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`; }
function date(value) { return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', timeZone: 'Europe/Moscow' }); }
async function load() { Object.assign(state, await api('/api/catalog')); render(); }
function stats() {
  const values = [ ['Лендов в библиотеке', state.landings.length, 'layout-grid'], ['Сборок скачано', state.landings.reduce((n, l) => n + l.downloads, 0), 'download'], ['Версий создано', state.landings.reduce((n, l) => n + l.changes, 0), 'git-fork'], ['Партнерок подключено', state.partners.length, 'handshake'] ];
  $('#stats').innerHTML = values.map(([label, value, glyph]) => `<div class="stat"><div><span class="stat-label">${label}</span><strong class="stat-value">${value.toLocaleString('ru')}</strong></div><span class="stat-icon">${icon(glyph)}</span></div>`).join('');
}
function render() {
  profile(); stats(); $('#nav-count').textContent = state.landings.length;
  $('#breadcrumb').textContent = labels[state.view];
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#page-title').innerHTML = { catalog: 'Ленды, готовые к работе<span>.</span>', popular: 'То, что выбирает команда<span>.</span>', mine: 'Ваш вклад в библиотеку<span>.</span>', partners: 'Партнерки и подключения<span>.</span>', admin: 'Все под контролем<span>.</span>' }[state.view];
  $('#page-description').textContent = state.view === 'partners' ? 'Настройте поля один раз. Используйте их в каждой новой сборке.' : 'Выберите шаблон, настройте партнерку и скачайте свою сборку.';
  $('#add-main').innerHTML = `${icon('plus')} ${state.view === 'partners' ? 'Добавить партнерку' : 'Добавить ленд'}`;
  $('#add-main').hidden = state.view === 'partners' && account.role !== 'admin';
  if (state.view === 'admin') { $('#add-main').innerHTML = `${icon('plus')} Создать пользователя`; $('#page-description').textContent = 'Все пользователи и ленды команды, включая личные и неопубликованные.'; renderAdmin().catch(e => toast(e.message)); return; }
  if (state.view === 'partners') return renderPartners();
  const types = [...new Set(state.landings.map(l => l.type))].sort(), languages = [...new Set(state.landings.map(l => l.language))].sort();
  content.innerHTML = `<div class="toolbar"><label class="search"><span>${icon('search')}</span><input id="search" aria-label="Поиск ленда" placeholder="Найти ленд, тип или автора…" value="${esc(state.query)}"></label><select id="type-filter" aria-label="Тип"><option value="">Все типы</option>${types.map(t => `<option ${state.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><select id="language-filter" aria-label="Язык"><option value="">Все языки</option>${languages.map(t => `<option ${state.language === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><select id="sort" class="sort" aria-label="Сортировка"><option value="new">Сначала новые</option><option value="downloads">По скачиваниям</option><option value="changes">По изменениям</option></select></div><div class="section-label"><strong id="result-label"></strong><span>ШАБЛОН → ПАРТНЕРКА → ZIP</span></div><div class="grid" id="grid"></div><div class="hint"><span>${icon('arrow-up-right')}</span><div><b>Хорошие ленды работают снова.</b> Сохраните свой вариант в библиотеку — команда сможет использовать его в следующем запуске.</div></div>`;
  $('#sort').value = state.sort;
  $('#search').addEventListener('input', e => { state.query = e.target.value; cards(); });
  $('#type-filter').addEventListener('change', e => { state.type = e.target.value; cards(); });
  $('#language-filter').addEventListener('change', e => { state.language = e.target.value; cards(); });
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; cards(); }); cards();
}
function cards() {
  const items = state.landings.filter(l => (state.view !== 'mine' || l.ownerId === account.id) && (!state.type || l.type === state.type) && (!state.language || l.language === state.language) && `${l.name} ${l.type} ${l.author} ${l.description}`.toLowerCase().includes(state.query.toLowerCase()));
  items.sort((a, b) => (state.sort === 'downloads' ? b.downloads - a.downloads : state.sort === 'changes' ? b.changes - a.changes : 0) || b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name));
  $('#result-label').textContent = `${labels[state.view].toUpperCase()} / ${items.length}`;
  $('#grid').innerHTML = items.length ? items.map(l => `<article class="card"><div class="preview"><span class="preview-tag">${l.ready ? 'Готов к сборке' : 'Нужна разметка формы'}</span><iframe sandbox="allow-same-origin" loading="lazy" tabindex="-1" aria-hidden="true" src="/preview/${l.id}/${encodeURI(l.entry)}"></iframe></div><div class="card-body"><div class="card-tags"><span class="chip">${esc(l.type)}</span><span class="chip">${esc(l.language)}</span>${visibilityBadge(l)}${l.demo ? '<span class="chip demo">Демо</span>' : l.parentId ? '<span class="chip version">Новая версия</span>' : ''}</div><h3>${esc(l.name)}</h3><p class="card-description">${esc(l.description || 'Шаблон команды, готовый к новой задаче.')}</p><div class="card-meta"><span class="tiny-avatar">${esc(l.author[0]?.toUpperCase())}</span><span>${esc(l.author)}</span><time>${date(l.createdAt)}</time></div><div class="card-bottom"><span title="Успешные сборки">${icon('download')} ${l.downloads}</span><span title="Созданные версии">${icon('git-fork')} ${l.changes}</span><button class="card-edit" data-edit="${l.id}" title="Изменить и сохранить новую версию" aria-label="Изменить ${esc(l.name)}">${icon('pencil')}</button><button class="card-build" data-build="${l.id}">Собрать ленд ${icon('arrow-up-right')}</button></div></div></article>`).join('') : '<div class="empty">Лендов пока нет. Загрузите свой шаблон или измените фильтры.</div>';
  document.querySelectorAll('[data-build]').forEach(b => b.onclick = () => openBuild(b.dataset.build).catch(e => toast(e.message)));
  bindVisibility();
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEditor(b.dataset.edit).catch(e => toast(e.message)));
}
function renderPartners() {
  content.innerHTML = `<div class="section-label"><strong>ПРОФИЛИ ПОДКЛЮЧЕНИЯ / ${state.partners.length}</strong><span>НАСТРАИВАЕМЫЕ ПОЛЯ</span></div><div class="partners-grid">${state.partners.map(p => `<article class="partner-card"><span class="chip">${p.method} · Прямая форма</span><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><div class="chips">${p.fields.map(f => `<span class="chip">${esc(f.label)}${f.required ? ' *' : ''}</span>`).join('') || '<span class="chip">Без дополнительных полей</span>'}</div>${account.role === 'admin' ? `<button class="secondary" data-partner="${p.id}">Настроить профиль ${icon('arrow-up-right')}</button>` : ''}</article>`).join('')}</div><div class="hint"><div><b>Новая партнерка без изменения кода.</b> Задайте поля, их имена в форме и метод отправки. URL обработчика заполняется при сборке. API с секретным ключом на сервере потребует отдельного адаптера.</div></div>`;
  document.querySelectorAll('[data-partner]').forEach(b => b.onclick = () => openPartner(state.partners.find(p => p.id === b.dataset.partner)));
}
async function openBuild(id) {
  const l = state.landings.find(l => l.id === id);
  if (!state.partners.length) return toast('Сначала добавьте партнерку');
  showModal(`<form class="modal-content" id="build-form"><h2>Соберите свой ленд</h2><p class="subtitle">${esc(l.name)} · ${l.fileCount} файлов · ${size(l.size)}</p><div class="build-layout"><div class="build-preview"><iframe sandbox="allow-same-origin" src="/preview/${l.id}/${encodeURI(l.entry)}" title="Предпросмотр ленда"></iframe><div class="preview-controls"><button class="secondary" type="button" id="mobile-preview">${icon('smartphone')} Мобильный</button><button class="secondary" type="button" id="desktop-preview">${icon('monitor')} По ширине</button></div></div><div class="fields"><div class="info-box">01 Выберите партнерку<br>02 Укажите параметры<br>03 Скачайте готовый ZIP</div><label>Партнерская программа<select name="partnerId">${state.partners.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><p id="partner-description" class="subtitle"></p><label>URL обработчика формы *<input name="action" type="url" required placeholder="https://example.com/submit"><small>Адрес, который принимает поля name, phone и параметры ниже.</small></label><div id="build-fields" class="fields"></div><div class="info-box">Параметры этой сборки не сохраняются в библиотеке. Проверьте отправку заявки на своем хостинге.</div>${l.ready ? '' : '<div class="info-box">Сначала добавьте маркеры формы через «Изменить ленд». Сборка проверит разметку.</div>'}<div class="error" role="alert"></div></div></div><div class="modal-actions"><button type="button" class="secondary" id="build-edit">Изменить ленд</button><button class="primary" type="submit">${icon('download')} Скачать ZIP</button></div></form>`);
  const form = $('#build-form');
  const refresh = () => { const p = state.partners.find(p => p.id === form.elements.partnerId.value); $('#partner-description').textContent = p.description; $('#build-fields').innerHTML = p.fields.map(f => `<label>${esc(f.label)} ${f.required ? '*' : ''}<input data-key="${f.key}" type="${f.type === 'secret' ? 'password' : f.type === 'url' ? 'url' : 'text'}" ${f.required ? 'required' : ''} autocomplete="off" placeholder="${esc(f.key)}"></label>`).join(''); };
  form.elements.partnerId.onchange = refresh; refresh();
  $('#mobile-preview').onclick = () => { $('.build-preview iframe').width = '320'; $('.build-preview iframe').style.maxWidth = '320px'; $('.build-preview iframe').style.alignSelf = 'center'; };
  $('#desktop-preview').onclick = () => { $('.build-preview iframe').style.maxWidth = '100%'; $('.build-preview iframe').style.alignSelf = 'stretch'; };
  $('#build-edit').onclick = () => { modal.close(); openEditor(id).catch(e => toast(e.message)); };
  form.onsubmit = async e => {
    e.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true; button.textContent = 'Собираем…'; $('.error', form).classList.remove('visible');
    try {
      const values = Object.fromEntries([...form.querySelectorAll('[data-key]')].map(i => [i.dataset.key, i.value]));
      const res = await fetch(`/api/landings/${id}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partnerId: form.elements.partnerId.value, action: form.elements.action.value, values }) });
      if (!res.ok) throw new Error((await res.json()).error);
      const url = URL.createObjectURL(await res.blob()), a = document.createElement('a'); a.href = url; a.download = `opslands-${id}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      modal.close(); await load(); toast('Архив готов. Скачивание началось.');
    } catch (e) { error(form, e); } finally { button.disabled = false; button.innerHTML = `${icon('download')} Скачать ZIP`; }
  };
}
async function base64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Не удалось прочитать файл')); reader.readAsDataURL(file); }); }
async function openEditor(id) {
  const l = id ? await api(`/api/landings/${id}`) : null;
  const html = l ? new TextDecoder().decode(Uint8Array.from(atob(l.files[l.entry]), c => c.charCodeAt(0))) : '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Мой ленд</title></head>\n<body>\n<h1>Ваш заголовок</h1>\n<form action="{{form_action}}" method="{{form_method}}">\n{{hidden_fields}}\n<input name="name" placeholder="Имя" required>\n<input name="phone" type="tel" placeholder="Телефон" required>\n<button>Отправить заявку</button>\n</form>\n</body></html>';
  showModal(`<form class="modal-content fields" id="edit-form"><div><h2>${l ? 'Сохранить новую версию' : 'Добавить ленд'}</h2><p class="subtitle">${l ? 'Исходный шаблон останется в библиотеке. Ваша версия получит отдельную карточку.' : 'Загрузите ZIP с файлами, HTML или создайте шаблон в редакторе.'}</p></div><div class="two"><label>Название *<input name="name" maxlength="120" required value="${esc(l ? l.name + ' / v2' : '')}" placeholder="Например: История / Испания"></label><label>Автор<input readonly value="${esc(user)}"></label></div><div class="two"><label>Тип<input name="type" required value="${esc(l?.type || 'История')}" list="landing-types"><datalist id="landing-types"><option>История</option><option>Статья</option><option>Витрина</option><option>Интервью</option><option>Квиз</option></datalist></label><label>Язык / гео<input name="language" maxlength="20" required value="${esc(l?.language || 'RU')}"></label></div><label class="sharing-field"><span><input type="checkbox" name="isGlobal"> Показывать всем участникам команды</span><small>По умолчанию ленд доступен только вам и администратору.</small></label><label>Описание<textarea name="description" maxlength="1000">${esc(l?.description || '')}</textarea></label><div class="two"><label>${l ? 'Заменить файлы архивом / HTML' : 'Загрузить ZIP / HTML'}<input id="upload" type="file" accept=".zip,.html,.htm"><small>ZIP до 20 МБ, распакованный до 40 МБ. Файлы сохраняются вместе с лендом.</small></label><label>Основной HTML файл<input name="entry" value="${esc(l?.entry || 'index.html')}" placeholder="index.html"><small>Путь относительно корня архива.</small></label></div><div class="tokens">Для сборки поместите в форму:<br><code>&lt;form action="{{form_action}}" method="{{form_method}}"&gt;</code><br><code>{{hidden_fields}}</code> — внутри формы. Поля заявки: <code>name</code> и <code>phone</code>.<br>Дополнительная подстановка: <code>{{pp.offer_id}}</code> в тексте или значении HTML атрибута. Для серверных API потребуется адаптер.</div><label>HTML основного файла<textarea name="html" class="code" spellcheck="false">${esc(html)}</textarea><small id="html-help">Редактируйте текст и разметку. После загрузки ZIP снимите флажок ниже, чтобы использовать HTML из архива.</small></label><label><span><input type="checkbox" name="useHtml" checked> Использовать HTML из редактора</span></label>${l ? `<label>Файлы шаблона<div class="file-list">${Object.keys(l.files).map(esc).join('<br>')}</div></label><div class="two"><label>Добавить или заменить картинку / другой файл<input type="file" id="asset"><small>Один файл за сохранение версии.</small></label><label>Путь файла в ленде<input name="assetPath" placeholder="images/hero.jpg"><small>Укажите такой же путь в HTML.</small></label></div>` : ''}<div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="secondary" id="cancel-edit">Отмена</button><button class="primary" type="submit">${l ? 'Сохранить новую версию' : 'Добавить в библиотеку'} ${icon('arrow-up-right')}</button></div></form>`, 'OPSLANDS / БИБЛИОТЕКА');
  const form = $('#edit-form'); let archive;
  $('#cancel-edit').onclick = () => modal.close();
  $('#upload').onchange = async e => {
    try {
      const file = e.target.files[0]; if (!file) return; if (file.size > 20 * 1024 * 1024) throw new Error('Файл превышает 20 МБ');
      if (/\.zip$/i.test(file.name)) { archive = await base64(file); form.elements.useHtml.checked = false; toast('Архив выбран. HTML будет взят из архива.'); }
      else { archive = undefined; form.elements.html.value = await file.text(); form.elements.useHtml.checked = true; }
    } catch (e) { error(form, e); }
  };
  if (l) $('#asset').onchange = e => { if (e.target.files[0] && !form.elements.assetPath.value) form.elements.assetPath.value = e.target.files[0].name; };
  form.onsubmit = async e => {
    e.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true;
    try {
      const assetFile = $('#asset', form)?.files[0]; if (assetFile?.size > 10 * 1024 * 1024) throw new Error('Ресурс превышает 10 МБ');
      await api('/api/landings', { name: form.elements.name.value, type: form.elements.type.value, language: form.elements.language.value, description: form.elements.description.value, isGlobal: form.elements.isGlobal.checked, parentId: l?.id, entry: form.elements.entry.value, archive, ...(form.elements.useHtml.checked ? { html: form.elements.html.value } : {}), ...(assetFile ? { asset: { path: form.elements.assetPath.value, data: await base64(assetFile) } } : {}) });
      modal.close(); await load(); toast(l ? 'Новая версия добавлена в библиотеку' : 'Ленд добавлен в библиотеку');
    } catch (e) { error(form, e); } finally { button.disabled = false; }
  };
}
function fieldRow(f = {}) { return `<div class="field-row"><input data-prop="label" required placeholder="Название" aria-label="Название поля" value="${esc(f.label)}"><input data-prop="key" required placeholder="offer_id" aria-label="Ключ подстановки" value="${esc(f.key)}"><input data-prop="target" placeholder="Имя в форме" aria-label="Имя в форме" value="${esc(f.target)}"><select data-prop="type" aria-label="Тип поля"><option value="text" ${!f.type || f.type === 'text' ? 'selected' : ''}>Текст</option><option value="url" ${f.type === 'url' ? 'selected' : ''}>URL</option><option value="secret" ${f.type === 'secret' ? 'selected' : ''}>Пароль</option></select><label><input type="checkbox" data-prop="required" ${f.required ? 'checked' : ''}> Обяз.</label><button type="button" data-remove aria-label="Удалить поле">${icon('x')}</button></div>`; }
function openPartner(partner) {
  showModal(`<form class="modal-content fields" id="partner-form"><div><h2>${partner ? 'Настроить партнерку' : 'Новая партнерка'}</h2><p class="subtitle">Профиль определяет поля для сборки и параметры отправки формы.</p></div><div class="two"><label>Название *<input name="name" maxlength="100" required value="${esc(partner?.name)}" placeholder="Название ПП"></label><label>Метод отправки<select name="method"><option ${partner?.method === 'POST' ? 'selected' : ''}>POST</option><option ${partner?.method === 'GET' ? 'selected' : ''}>GET</option></select></label></div><label>Описание / инструкция<textarea name="description" maxlength="500" placeholder="Какие значения нужны, где их найти…">${esc(partner?.description)}</textarea></label><div><h3>Поля сборки</h3><p class="subtitle">Ключ используется в {{pp.ключ}}. Имя в форме — параметр, который принимает ПП.</p><div class="field-row field-head"><span>Название</span><span>Ключ</span><span>Имя в форме</span><span>Тип</span><span>Обяз.</span><span></span></div><div class="field-list" id="field-list">${(partner?.fields || [{ label: 'ID оффера', key: 'offer_id', target: 'offer_id', type: 'text', required: true }]).map(fieldRow).join('')}</div><button type="button" class="secondary" id="add-field">${icon('plus')} Добавить поле</button></div><div class="info-box">Поддерживается прямая отправка формы на HTTP(S) URL. Тип «Пароль» скрывает ввод, но значение будет доступно в скачанном HTML. Серверные API-ключи в такие поля не помещайте.</div><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="secondary" id="cancel-partner">Отмена</button><button type="submit" class="primary">Сохранить профиль ${icon('check')}</button></div></form>`, 'OPSLANDS / ПАРТНЕРСКИЕ ПРОГРАММЫ');
  const form = $('#partner-form');
  $('#cancel-partner').onclick = () => modal.close();
  $('#add-field').onclick = () => $('#field-list').insertAdjacentHTML('beforeend', fieldRow());
  $('#field-list').onclick = e => { if (e.target.closest('[data-remove]')) e.target.closest('.field-row').remove(); };
  form.onsubmit = async e => {
    e.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true;
    try {
      const fields = [...form.querySelectorAll('#field-list .field-row')].map(row => Object.fromEntries([...row.querySelectorAll('[data-prop]')].map(i => [i.dataset.prop, i.type === 'checkbox' ? i.checked : i.value])));
      await api('/api/partners', { id: partner?.id, name: form.elements.name.value, description: form.elements.description.value, method: form.elements.method.value, fields });
      modal.close(); await load(); toast('Профиль партнерки сохранен');
    } catch (e) { error(form, e); } finally { button.disabled = false; }
  };
}
$('#close-modal').onclick = () => modal.close();
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { state.view = b.dataset.view; state.query = ''; state.type = ''; state.language = ''; state.sort = state.view === 'popular' ? 'downloads' : 'new'; render(); });
$('#add-main').onclick = () => state.view === 'admin' ? openUserForm() : state.view === 'partners' ? openPartner() : openEditor().catch(e => toast(e.message));
$('#profile').onclick = () => {
  showModal(`<div class="modal-content fields"><h2>${esc(account.name)}</h2><p class="subtitle">${esc(account.login)} · ${account.role === 'admin' ? 'Администратор' : 'Участник команды'}</p><div class="info-box">Вход сохранен на этом устройстве. Повторно вводить пароль при открытии платформы не нужно.</div>${account.ssoLinked ? `<div class="info-box">Связан с OpsVault: ${esc(account.opsvaultName)}. <a href="${esc(account.credentialUrl)}" target="_blank" rel="noreferrer">Реквизиты в OpsVault</a></div>` : ssoEnabled ? `<button class="primary" id="link-opsvault">Связать OpsVault</button>` : ''}${account.sessionMode === 'oidc' ? '<button class="secondary" id="global-logout">Выйти из OpsVault на этом устройстве</button>' : ''}<div class="modal-actions"><button class="secondary" id="logout">Выйти из аккаунта</button></div></div>`, 'OPSLANDS / АККАУНТ');
  if ($('#link-opsvault')) $('#link-opsvault').onclick = linkOpsVault;
  if ($('#global-logout')) $('#global-logout').onclick = async () => { try { await api('/auth/opsvault/logout', {}); showAuth(false); } catch(e) { toast(e.message); } };
  $('#logout').onclick = async () => { try { await api('/api/auth/logout', {}); showAuth(false); } catch (e) { toast(e.message); } };
};
start().catch(e => { document.body.classList.remove('booting'); content.innerHTML = `<div class="empty">Не удалось загрузить приложение: ${esc(e.message)}. Обновите страницу.</div>`; });

async function start() {
  const session = await api('/api/auth/me');
  ssoEnabled = session.ssoEnabled;
  if (!session.user) return showAuth(session.needsSetup);
  account = session.user; user = account.name;
  await load(); document.body.classList.remove('booting', 'auth-required'); $('#auth-root').hidden = true;
  if (session.pendingLink) confirmLink(session.pendingLink);
  if (new URLSearchParams(location.search).get('opsvault') === 'error') toast('Вход OpsVault не завершен. Для первого входа откройте профиль локального аккаунта и свяжите его.');
  if (location.search) history.replaceState(null, '', '/');
}
function showAuth(setup) {
  if (modal.open) modal.close(); account = null; user = ''; state.view = 'catalog';
  document.body.classList.remove('booting'); document.body.classList.add('auth-required');
  const root = $('#auth-root'); root.hidden = false;
  root.innerHTML = `<div class="auth-intro"><a class="brand" href="/">ops<span>lands</span>${icon('arrow-up-right')}</a><p class="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО КОМАНДЫ</p><h1>Один вход.<br>Все ваши ленды.</h1><p>Библиотека шаблонов, личные версии и готовые сборки — в одном месте.</p><span class="auth-note">${icon('check')} Вход сохраняется на этом устройстве</span></div><form id="login-form" class="auth-card fields"><div><p class="eyebrow">${setup ? 'ПЕРВЫЙ ЗАПУСК' : 'С ВОЗВРАЩЕНИЕМ'}</p><h2>${setup ? 'Создайте администратора' : 'Войти в OPSLands'}</h2><p class="subtitle">${setup ? 'Первый аккаунт получит управление командой и всеми лендами.' : 'Войдите один раз. Дальше платформа откроется сразу.'}</p></div>${setup ? '<label>Ваше имя<input name="name" autocomplete="name" required maxlength="80" placeholder="Как к вам обращаться"></label>' : ''}${ssoEnabled && !setup ? '<a class="secondary wide sso-login" href="/auth/opsvault/login">Войти через OpsVault</a><p class="auth-divider">или логин и пароль OPSLands</p>' : ''}<label>Логин<input name="login" autocomplete="username" required minlength="3" maxlength="80" placeholder="your.login" autocapitalize="none" spellcheck="false"></label><label>Пароль<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? 'minlength="8"' : ''} maxlength="200" placeholder="${setup ? 'Минимум 8 символов' : 'Ваш пароль'}"></label><div class="error" role="alert"></div><button class="primary wide" type="submit">${setup ? 'Создать и войти' : 'Войти'} ${icon('arrow-up-right')}</button><p class="auth-footnote">${setup ? 'Существующие демо будут общими. Загруженные ранее ленды станут вашими личными.' : 'Аккаунты для команды создает администратор.'}</p></form>`;
  const form = $('#login-form');
  form.onsubmit = async e => {
    e.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true; $('.error', form).classList.remove('visible');
    try {
      const result = await api(setup ? '/api/auth/setup' : '/api/auth/login', { login: form.elements.login.value, password: form.elements.password.value, name: form.elements.name?.value });
      account = result.user; user = account.name; await load(); root.hidden = true; root.innerHTML = ''; document.body.classList.remove('auth-required');
    } catch (e) { error(form, e); } finally { button.disabled = false; }
  };
}
function visibilityBadge(l) {
  const label = l.isGlobal ? 'Общий' : 'Личный';
  return account.role === 'admin' || l.ownerId === account.id ? `<button type="button" class="chip visibility-toggle ${l.isGlobal ? 'global' : ''}" data-visibility="${l.id}" data-global="${l.isGlobal ? '1' : '0'}" title="${l.isGlobal ? 'Сделать личным' : 'Показать всей команде'}">${label}</button>` : `<span class="chip global">${label}</span>`;
}
function bindVisibility() {
  document.querySelectorAll('[data-visibility]').forEach(button => button.onclick = async () => {
    button.disabled = true;
    try { await api(`/api/landings/${button.dataset.visibility}/visibility`, { isGlobal: button.dataset.global !== '1' }); await load(); toast(button.dataset.global === '1' ? 'Ленд теперь личный' : 'Ленд доступен всей команде'); } catch (e) { toast(e.message); button.disabled = false; }
  });
}
async function renderAdmin() {
  const data = await api('/api/admin'); if (state.view !== 'admin') return;
  const names = new Map(data.users.map(u => [u.id, u.name]));
  content.innerHTML = `<div class="admin-heading"><div><h2>Пользователи <span class="chip">${data.users.length}</span></h2><p>Администраторы управляют всей библиотекой. Участники видят свои и общие ленды.</p></div></div><div class="table-scroll"><table class="admin-table"><thead><tr><th>Пользователь</th><th>Логин</th><th>Роль</th><th>Ленды</th><th></th></tr></thead><tbody>${data.users.map(u => `<tr><td><strong>${esc(u.name)}</strong>${u.id === account.id ? '<span class="chip">Вы</span>' : ''}</td><td>${esc(u.login)}</td><td><span class="chip ${u.role === 'admin' ? 'global' : ''}">${u.role === 'admin' ? 'Администратор' : 'Участник'}</span></td><td>${data.landings.filter(l => l.ownerId === u.id).length}</td><td><button class="danger-link" data-delete-user="${u.id}" ${u.id === account.id ? 'disabled' : ''}>Удалить</button></td></tr>`).join('')}</tbody></table></div><div class="admin-heading"><div><h2>Все ленды <span class="chip">${data.landings.length}</span></h2><p>Включая личные ленды и шаблоны удаленных пользователей.</p></div><label class="search"><span>${icon('search')}</span><input id="admin-search" aria-label="Поиск всех лендов" placeholder="Название или автор…"></label></div><div class="table-scroll"><table class="admin-table"><thead><tr><th>Ленд</th><th>Владелец</th><th>Видимость</th><th>Скачивания / версии</th><th></th></tr></thead><tbody id="admin-landings"></tbody></table></div>`;
  function rows() {
    const query = $('#admin-search').value.toLowerCase();
    $('#admin-landings').innerHTML = data.landings.filter(l => `${l.name} ${names.get(l.ownerId) || l.author}`.toLowerCase().includes(query)).map(l => `<tr><td><strong>${esc(l.name)}</strong><small>${esc(l.type)} · ${esc(l.language)}</small></td><td>${esc(names.get(l.ownerId) || `${l.author} (аккаунт удален)`)}</td><td>${visibilityBadge(l)}</td><td>${l.downloads} / ${l.changes}</td><td><div class="table-actions"><button class="secondary" data-admin-edit="${l.id}" aria-label="Изменить ${esc(l.name)}">${icon('pencil')}</button><button class="secondary" data-admin-build="${l.id}">Собрать ${icon('download')}</button></div></td></tr>`).join('') || '<tr><td colspan="5">Ленды не найдены</td></tr>';
    bindVisibility();
    document.querySelectorAll('[data-admin-edit]').forEach(b => b.onclick = () => openEditor(b.dataset.adminEdit).catch(e => toast(e.message)));
    document.querySelectorAll('[data-admin-build]').forEach(b => b.onclick = () => openBuild(b.dataset.adminBuild).catch(e => toast(e.message)));
  }
  $('#admin-search').oninput = rows; rows();
  document.querySelectorAll('[data-delete-user]').forEach(button => button.onclick = () => {
    const target = data.users.find(u => u.id === button.dataset.deleteUser);
    showModal(`<div class="modal-content fields"><h2>Удалить ${esc(target.name)}?</h2><p class="subtitle">Пользователь потеряет доступ, его сессии будут завершены. Ленды сохранятся: личные будут доступны администраторам, общие — всей команде.</p><div class="error" role="alert"></div><div class="modal-actions"><button class="secondary" id="cancel-delete">Отмена</button><button class="danger-button" id="confirm-delete">Удалить пользователя</button></div></div>`, 'OPSLANDS / ПОЛЬЗОВАТЕЛИ');
    $('#cancel-delete').onclick = () => modal.close();
    $('#confirm-delete').onclick = async e => {
      e.target.disabled = true;
      try { await api(`/api/admin/users/${target.id}/delete`, {}); modal.close(); await load(); toast('Пользователь удален. Ленды сохранены.'); } catch (e) { error($('.modal-content'), e); $('#confirm-delete').disabled = false; }
    };
  });
}
function openUserForm() {
  showModal(`<form class="modal-content fields" id="user-form"><h2>Новый пользователь</h2><p class="subtitle">Передайте участнику логин и пароль. После первого входа сессия сохранится на его устройстве.</p><div class="two"><label>Имя<input name="name" required maxlength="80" autocomplete="off"></label><label>Логин<input name="login" required minlength="3" maxlength="80" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="name.surname"></label></div><div class="two"><label>Пароль<input name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password"></label><label>Роль<select name="role"><option value="member">Участник</option><option value="admin">Администратор</option></select></label></div><div class="error" role="alert"></div><div class="modal-actions"><button type="button" class="secondary" id="cancel-user">Отмена</button><button type="submit" class="primary">Создать пользователя ${icon('check')}</button></div></form>`, 'OPSLANDS / КОМАНДА');
  $('#cancel-user').onclick = () => modal.close(); const form = $('#user-form');
  form.onsubmit = async e => {
    e.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true;
    try { await api('/api/admin/users', Object.fromEntries(new FormData(form))); modal.close(); await renderAdmin(); toast('Пользователь создан'); } catch (e) { error(form, e); } finally { button.disabled = false; }
  };
}
function linkOpsVault() {
  modal.close();
  showModal(`<form class="modal-content fields" id="link-form"><h2>Связать аккаунт с OpsVault</h2><p class="subtitle">Ваш ID, ленды и пароль OPSLands сохранятся. Введите пароль именно OPSLands, не пароль портала.</p><label>Пароль OPSLands<input name="password" type="password" required maxlength="200" autocomplete="current-password"></label><label><span><input name="consent" type="checkbox" required> Согласен сохранить логин и пароль OPSLands в своем зашифрованном хранилище OpsVault</span></label><div class="error" role="alert"></div><div class="modal-actions"><button class="primary">Продолжить в OpsVault</button></div></form>`, 'OPSLANDS / СВЯЗЫВАНИЕ');
  const form = $('#link-form'); form.onsubmit = async e => {
    e.preventDefault(); const button = $('button', form); button.disabled = true;
    try { const result = await api('/auth/opsvault/link/start', { password: form.elements.password.value, consent: form.elements.consent.checked }); location.assign(result.redirect); } catch(e) { error(form, e); button.disabled = false; }
  };
}
function confirmLink(pending) {
  showModal(`<div class="modal-content fields"><h2>Подтвердите оба аккаунта</h2><div class="info-box">OPSLands: <strong>${esc(pending.localLogin)}</strong><br>OpsVault: <strong>${esc(pending.opsvaultName)}</strong></div><p class="subtitle">Связать эти аккаунты и сохранить отдельные реквизиты OPSLands в OpsVault? Владельцы лендов и ваш пароль останутся прежними.</p><div class="error" role="alert"></div><div class="modal-actions"><button class="secondary" id="cancel-link">Отмена</button><button class="primary" id="confirm-link">Подтвердить связь</button></div></div>`, 'OPSLANDS / ПОДТВЕРЖДЕНИЕ');
  $('#cancel-link').onclick = () => modal.close();
  $('#confirm-link').onclick = async e => { e.target.disabled = true; try { await api('/auth/opsvault/link/confirm', { confirm: true }); modal.close(); await start(); toast('Аккаунты связаны. Реквизиты сохранены в OpsVault.'); } catch(e) { error($('.modal-content'), e); $('#confirm-link').disabled = false; } };
}
