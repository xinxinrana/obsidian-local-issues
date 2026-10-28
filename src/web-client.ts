// Self-contained: the bundled function is served as a same-origin browser script.
export function startWebClient(services?: { request?: typeof fetch; navigate?: (url: string) => void }): void {
  const root = document.querySelector<HTMLElement>('#li-app');
  if (!root) return;
  const request = services?.request ?? window.fetch.bind(window);
  const navigate = services?.navigate ?? ((url: string) => {
    const target = new URL(url, location.href);
    if (target.pathname === location.pathname && target.search === location.search) {
      if (target.hash) history.replaceState(null, '', target);
      location.reload();
    } else location.assign(target.href);
  });
  const author = root.dataset.author || '我';
  let leaving = false, working = 0, active: HTMLFormElement | undefined;
  const baselines = new WeakMap<HTMLFormElement, string>();
  const uploads = new WeakMap<HTMLFormElement, number>();
  const busy = new WeakSet<HTMLElement>();
  const values = (form: HTMLFormElement) => JSON.stringify([...new FormData(form).entries()].filter(([, v]) => typeof v === 'string'));
  const forms = () => [...root.querySelectorAll<HTMLFormElement>('form[data-api]')];
  function dirty(form: HTMLFormElement): boolean { return !!uploads.get(form) || (baselines.has(form) && baselines.get(form) !== values(form)); }
  function dirtyOthers(except?: HTMLFormElement): boolean { return forms().some(f => f !== except && dirty(f)); }
  function feedback(host: HTMLElement, message: string, error = false): void {
    let el = host.querySelector<HTMLElement>(':scope > .feedback');
    if (!el) { el = document.createElement('p'); el.className = 'feedback'; host.append(el); }
    el.setAttribute('role', error ? 'alert' : 'status'); el.textContent = message;
  }
  function discard(except?: HTMLFormElement): boolean {
    if (working) { feedback(except ?? root!, '正在保存，请稍候。'); return false; }
    return !dirtyOthers(except) || window.confirm('离开将丢失尚未保存的修改，确定继续吗？');
  }
  async function api(path: string, method = 'GET', data?: unknown, revision?: string): Promise<any> {
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await request(path, { method, signal: controller.signal, headers: { Accept: 'application/json', 'X-Local-Issues': 'web',
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(revision ? { 'If-Match': revision } : {}) },
        body: data === undefined ? undefined : JSON.stringify(data) });
      let result;
      try { result = await response.json(); } catch { throw new Error('本地服务没有返回有效数据，请确认 Obsidian 和插件正在运行。'); }
      if (!response.ok || !result.ok) throw new Error(result.error?.message || '操作失败，请重试。');
      return result.data;
    } catch (error) { if (controller.signal.aborted) throw new Error('请求超时，请确认 Obsidian 和插件正在运行后重试。'); throw error; }
    finally { window.clearTimeout(timeout); }
  }
  function resize(textarea: HTMLTextAreaElement): void { textarea.style.height = 'auto'; textarea.style.height = `${textarea.scrollHeight}px`; }
  function initialize(form: HTMLFormElement): void {
    baselines.set(form, values(form));
    form.querySelectorAll('textarea').forEach(resize);
  }
  forms().forEach(initialize);
  function closeEditor(): void {
    if (!active) return;
    const container = active.closest<HTMLElement>('[data-editable]')!;
    container.querySelector<HTMLElement>('[data-display]')?.removeAttribute('hidden');
    container.classList.remove('editing'); active.remove(); active = undefined;
  }
  function openEditor(button: HTMLElement): void {
    if (active && dirty(active) && !window.confirm('切换编辑将丢失当前尚未保存的修改，确定继续吗？')) return;
    if (working) return;
    closeEditor();
    const template = document.getElementById(button.dataset.edit!) as HTMLTemplateElement | null;
    if (!template) return;
    const container = template.closest<HTMLElement>('[data-editable]')!;
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const form = fragment.querySelector<HTMLFormElement>('form')!;
    container.querySelector<HTMLElement>('[data-display]')?.setAttribute('hidden', '');
    container.append(fragment); container.classList.add('editing'); active = form; initialize(form);
    form.querySelector<HTMLElement>('textarea,input:not([type=hidden]),select')?.focus();
    form.scrollIntoView?.({ block: 'nearest' });
  }
  function payload(form: HTMLFormElement): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of new FormData(form)) {
      if (typeof value !== 'string') continue;
      if (key === 'dependencies') result[key] = new FormData(form).getAll(key).filter(v => v !== '');
      else if (key === 'labels' || key === 'assignees') result[key] = value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      else result[key] = value;
    }
    if (form.querySelector('[data-relations]') && !Object.hasOwn(result, 'dependencies')) result.dependencies = [];
    if (result.status === 'closed') { result.closeReason = result.closeReason || 'completed'; }
    return { ...result, actor: author, ...(form.dataset.author === 'true' ? { author } : {}) };
  }
  async function submit(form: HTMLFormElement): Promise<void> {
    if (busy.has(form) || uploads.get(form)) return;
    if (!form.reportValidity() || !discard(form)) return;
    busy.add(form); working++;
    const dataToSave = payload(form), fingerprint = values(form);
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>('input,textarea,button,select')];
    const disabled = controls.map(c => c.disabled);
    controls.forEach(c => c.disabled = true); feedback(form, '正在保存…');
    try {
      const data = await api(form.dataset.api!, form.dataset.method || 'POST', dataToSave, form.dataset.revision);
      baselines.set(form, fingerprint); feedback(form, '已保存');
      let destination = location.pathname + location.search;
      if (form.dataset.redirect === 'created') {
        try { const link = await api(`/api/links?ref=${encodeURIComponent(data.id)}`); const url = new URL(link.url); destination = url.pathname + url.search; }
        catch { destination = '/'; }
      } else if (form.dataset.redirect === 'comment') destination += `#${data.id}`;
      else if (form.dataset.anchor) destination += `#${form.dataset.anchor}`;
      leaving = true; navigate(destination);
    } catch (error) { feedback(form, error instanceof Error ? error.message : '保存失败，请重试。', true); }
    finally { working--; busy.delete(form); controls.forEach((c, index) => c.disabled = disabled[index]); }
  }
  async function upload(form: HTMLFormElement, files: File[]): Promise<void> {
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea[data-markdown]');
    if (!textarea || !form.dataset.ref || busy.has(form)) return;
    const send = form.querySelector<HTMLButtonElement>('[type=submit]');
    uploads.set(form, (uploads.get(form) || 0) + 1); if (send) send.disabled = true;
    try {
      for (const file of files) {
        if (!form.isConnected) return;
        if (!file.size || file.size > 16 * 1024 * 1024) throw new Error('每个附件须为 1 字节至 16 MB。');
        feedback(form, `正在上传 ${file.name}…`);
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('读取附件失败。')); reader.readAsDataURL(file);
        });
        const data = await api(form.dataset.upload!, 'POST', { name: file.name, base64 });
        if (!form.isConnected) return;
        const insertion = `${textarea.value ? '\n\n' : ''}${data.markdown}\n`;
        textarea.setRangeText(insertion, textarea.selectionStart, textarea.selectionEnd, 'end'); resize(textarea);
      }
      feedback(form, '附件已插入，保存后生效。');
    } catch (error) { feedback(form, error instanceof Error ? error.message : '上传失败，请重试。', true); }
    finally { uploads.set(form, (uploads.get(form) || 1) - 1); if (send) send.disabled = !!uploads.get(form); }
  }
  async function preview(button: HTMLButtonElement): Promise<void> {
    const form = button.closest<HTMLFormElement>('form')!;
    if (busy.has(button)) return;
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea[data-markdown]')!;
    const output = form.querySelector<HTMLElement>('[data-preview]')!;
    if (button.dataset.tab === 'write') { textarea.hidden = false; output.hidden = true; textarea.focus(); }
    else {
      busy.add(button); button.disabled = true;
      try {
        const body = textarea.value;
        const data = await api('/api/preview', 'POST', { body, ref: form.dataset.ref || '' });
        if (!form.isConnected) return;
        if (body !== textarea.value) { feedback(form, '内容已变化，请重新预览。'); return; }
        output.innerHTML = data.html; textarea.hidden = true; output.hidden = false;
      } catch (error) { feedback(form, error instanceof Error ? error.message : '预览失败。', true); return; }
      finally { busy.delete(button); button.disabled = false; }
    }
    form.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-selected', String(el === button)));
  }
  const statusPatch = (value: string) => value === 'open' ? { status: 'open' } : { status: 'closed', closeReason: value };
  async function changeStatus(select: HTMLSelectElement, target?: string): Promise<void> {
    const before = select.dataset.current!;
    if ((target ?? select.value) === before) return;
    if (busy.has(select) || !discard()) { select.value = before; return; }
    busy.add(select); select.disabled = true; working++;
    const host = select.closest<HTMLElement>('section,.row') || root!;
    feedback(host, '正在更新状态…');
    try {
      await api(`/api/issues/${select.dataset.issue}`, 'PATCH', { ...statusPatch(target ?? select.value), actor: author }, select.dataset.revision);
      leaving = true; navigate(location.pathname + location.search);
    } catch (error) { select.value = before; feedback(host, error instanceof Error ? error.message : '更新失败。', true); }
    finally { working--; busy.delete(select); select.disabled = false; }
  }
  async function removeComment(button: HTMLButtonElement): Promise<void> {
    if (busy.has(button) || working) return;
    const warning = dirtyOthers() ? '删除评论将丢失尚未保存的编辑，确定删除吗？' : '确定删除这条评论吗？';
    if (!window.confirm(warning)) return;
    const host = button.closest<HTMLElement>('article')!;
    busy.add(button); button.disabled = true; working++; feedback(host, '正在删除…');
    try {
      await api(`/api/comments/${button.dataset.delete}`, 'DELETE', {}, button.dataset.revision);
      leaving = true; navigate(location.pathname + location.search);
    } catch (error) { feedback(host, error instanceof Error ? error.message : '删除失败，请重试。', true); }
    finally { working--; busy.delete(button); button.disabled = false; }
  }
  const boxes = () => [...root.querySelectorAll<HTMLInputElement>('input[data-select-issue]')];
  async function refreshSelected(button: HTMLButtonElement): Promise<void> {
    if (working) return;
    const toolbar = button.closest<HTMLElement>('[data-batch]')!;
    button.disabled = true; working++;
    try {
      for (const box of boxes().filter(box => box.checked)) {
        const data = await api(`/api/issues/${box.dataset.selectIssue}`);
        box.dataset.revision = data.issue.revision; box.dataset.labels = JSON.stringify(data.issue.labels);
      }
      feedback(toolbar, '已读取所选议题的最新数据，可以重试批量操作。');
    } catch (error) { feedback(toolbar, error instanceof Error ? error.message : '刷新失败，请重试。', true); }
    finally { working--; button.disabled = false; }
  }
  function selection(): void {
    const all = boxes(), chosen = all.filter(c => c.checked);
    const selectAll = root!.querySelector<HTMLInputElement>('[data-select-all]');
    if (selectAll) { selectAll.checked = all.length > 0 && chosen.length === all.length; selectAll.indeterminate = chosen.length > 0 && chosen.length < all.length; }
    const toolbar = root!.querySelector<HTMLElement>('[data-batch]'); if (toolbar) toolbar.hidden = !chosen.length;
    const count = root!.querySelector('[data-selected-count]'); if (count) count.textContent = `已选择 ${chosen.length} 项`;
  }
  async function batch(button: HTMLButtonElement): Promise<void> {
    if (!discard() || busy.has(button)) return;
    const toolbar = button.closest<HTMLElement>('[data-batch]')!, chosen = boxes().filter(c => c.checked);
    if (!chosen.length) return;
    const value = toolbar.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-batch-value="${button.dataset.batchAction}"]`)!.value;
    if (button.dataset.batchAction?.includes('label') && !value.trim()) { feedback(toolbar, '请填写标签。', true); return; }
    const controls = [...root!.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('[data-batch] input,[data-batch] button,[data-batch] select,input[data-select-issue],input[data-select-all]')];
    controls.forEach(c => c.disabled = true); busy.add(button); working++;
    let done = 0; const failures: string[] = [];
    try {
      for (const box of chosen) {
        feedback(toolbar, `正在更新 ${++done}/${chosen.length}…`);
        try {
          const action = button.dataset.batchAction;
          const labels = JSON.parse(box.dataset.labels || '[]') as string[];
          const patch = action === 'status' ? statusPatch(value) : action === 'milestone' ? { milestone: value.trim() } : { labels: action === 'add-label' ? [...new Set([...labels, value.trim()])] : labels.filter(l => l !== value.trim()) };
          const data = await api(`/api/issues/${box.dataset.selectIssue}`, 'PATCH', { ...patch, actor: author }, box.dataset.revision);
          box.checked = false; box.dataset.revision = data.revision; box.dataset.labels = JSON.stringify(data.labels);
        } catch (error) { failures.push(`#${box.dataset.number}：${error instanceof Error ? error.message : '更新失败'}`); }
      }
      if (!failures.length) { leaving = true; navigate(location.pathname + location.search); }
      else feedback(toolbar, `${chosen.length - failures.length} 项成功，${failures.length} 项失败；仅保留失败项选中。${failures.slice(0, 3).join('；')}`, true);
    } finally { working--; busy.delete(button); controls.forEach(c => c.disabled = false); selection(); }
  }
  root.addEventListener('submit', event => {
    const form = event.target as HTMLFormElement;
    if (!form.dataset.api) {
      if (form.method !== 'get') return;
      event.preventDefault(); if (!discard()) return;
      const query = new URLSearchParams();
      for (const [name, value] of new FormData(form)) if (typeof value === 'string' && value.trim()) {
        if (name === 'label' || name === 'assignee') value.split(/[,，]/).map(s => s.trim()).filter(Boolean).forEach(v => query.append(name, v));
        else query.append(name, value);
      }
      leaving = true; navigate(`${new URL(form.action).pathname}?${query}`); return;
    }
    event.preventDefault(); void submit(form);
  });
  root.addEventListener('click', event => {
    const el = (event.target as Element).closest<HTMLElement>('button,a'); if (!el) return;
    if (el instanceof HTMLAnchorElement) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || el.target === '_blank' || el.hasAttribute('download') || el.getAttribute('href')?.startsWith('#') || el.protocol === 'obsidian:') return;
      if (!discard()) event.preventDefault(); else leaving = true;
    } else if (el.dataset.edit) openEditor(el);
    else if (el.hasAttribute('data-cancel')) {
      if (working) return;
      const form = el.closest<HTMLFormElement>('form')!;
      if (dirty(form) && !window.confirm('取消将丢失尚未保存的修改，确定继续吗？')) return;
      closeEditor();
    } else if (el.dataset.tab) void preview(el as HTMLButtonElement);
    else if (el.dataset.delete) void removeComment(el as HTMLButtonElement);
    else if (el.dataset.batchAction) void batch(el as HTMLButtonElement);
    else if (el.hasAttribute('data-refresh-selected')) void refreshSelected(el as HTMLButtonElement);
    else if (el.dataset.copy) {
      void Promise.resolve().then(() => navigator.clipboard.writeText(new URL(el.dataset.copy!, location.origin).href)).then(() => feedback(el.parentElement!, '链接已复制。')).catch(() => feedback(el.parentElement!, '复制失败，请复制浏览器地址栏链接。', true));
    }
    else if (el.dataset.removeRelation) {
      const chip = el.closest('[data-relation-chip]')!; chip.remove();
    } else if (el.hasAttribute('data-add-relation')) {
      const holder = el.closest<HTMLElement>('[data-relations]')!, select = holder.querySelector<HTMLSelectElement>('select')!;
      if (!select.value || holder.querySelector(`input[value="${CSS.escape(select.value)}"]`)) return;
      const chip = document.createElement('span'); chip.dataset.relationChip = ''; chip.className = 'label';
      const input = document.createElement('input'); input.type = 'hidden'; input.name = 'dependencies'; input.value = select.value;
      const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.removeRelation = 'true'; remove.textContent = select.selectedOptions[0].textContent; remove.setAttribute('aria-label', `移除依赖 ${remove.textContent}`);
      chip.append(input, remove); holder.querySelector('[data-chips]')!.append(chip); select.value = '';
    }
  });
  root.addEventListener('change', event => {
    const el = event.target as HTMLInputElement | HTMLSelectElement;
    if (el.hasAttribute('data-status')) void changeStatus(el as HTMLSelectElement);
    if (el.hasAttribute('data-select-all')) { boxes().forEach(box => box.checked = (el as HTMLInputElement).checked); selection(); }
    if (el.hasAttribute('data-select-issue')) selection();
    if (el instanceof HTMLInputElement && el.type === 'file') { void upload(el.closest('form')!, [...(el.files || [])]); el.value = ''; }
  });
  root.addEventListener('input', event => {
    const el = event.target as HTMLInputElement;
    const form = el.closest<HTMLFormElement>('form[data-api]');
    if (form && !baselines.has(form)) initialize(form);
    if (el instanceof HTMLTextAreaElement) resize(el);
    if (el.hasAttribute('data-relation-search')) {
      const select = el.closest('[data-relations]')!.querySelector<HTMLSelectElement>('select')!;
      for (const option of select.options) option.hidden = !!option.value && !option.textContent?.toLocaleLowerCase().includes(el.value.replace(/^[@/]/, '').toLocaleLowerCase());
    }
  });
  root.addEventListener('keydown', event => {
    const el = event.target;
    if (!(el instanceof HTMLTextAreaElement) || !(event.metaKey || event.ctrlKey)) return;
    const form = el.closest<HTMLFormElement>('form[data-api]')!;
    if (event.key === 'Enter') { event.preventDefault(); form.requestSubmit(); }
    if (event.shiftKey && event.key.toLowerCase() === 'u') { event.preventDefault(); form.querySelector<HTMLInputElement>('input[type=file]')?.click(); }
    if (['b', 'i'].includes(event.key.toLowerCase())) {
      event.preventDefault(); const delimiter = event.key.toLowerCase() === 'b' ? '**' : '*';
      el.setRangeText(`${delimiter}${el.value.slice(el.selectionStart, el.selectionEnd)}${delimiter}`, el.selectionStart, el.selectionEnd, 'select'); resize(el);
    }
  });
  root.addEventListener('paste', event => {
    const el = event.target as Element, form = el.closest<HTMLFormElement>('form[data-api]');
    const files = [...(event.clipboardData?.files || [])]; if (!form || !files.length) return;
    event.preventDefault(); void upload(form, files);
  });
  root.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files') && (event.target as Element).closest('form[data-api]')) event.preventDefault(); });
  root.addEventListener('drop', event => {
    const form = (event.target as Element).closest<HTMLFormElement>('form[data-api]');
    const files = [...(event.dataTransfer?.files || [])];
    if (form && files.length) { event.preventDefault(); void upload(form, files); return; }
    const column = (event.target as Element).closest<HTMLElement>('[data-drop-status]');
    const id = event.dataTransfer?.getData('application/x-local-issue');
    if (column && id) { event.preventDefault(); const select = root!.querySelector<HTMLSelectElement>(`select[data-issue="${CSS.escape(id)}"]`); if (select) void changeStatus(select, column.dataset.dropStatus); }
  });
  root.addEventListener('dragstart', event => { const row = (event.target as Element).closest<HTMLElement>('[data-drag-issue]'); if (row) event.dataTransfer?.setData('application/x-local-issue', row.dataset.dragIssue!); });
  root.querySelectorAll<HTMLElement>('[data-drop-status]').forEach(column => column.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('application/x-local-issue')) event.preventDefault(); }));
  window.addEventListener('beforeunload', event => { if (!leaving && (working || dirtyOthers())) { event.preventDefault(); event.returnValue = ''; } });
  selection();
}
