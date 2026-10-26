const modals = [];
const notices = [];
const menus = [];
function installDom(window) {
  const proto = window.HTMLElement.prototype;
  proto.empty = function () { this.replaceChildren(); };
  proto.setText = function (s) { this.textContent = s; };
  proto.addClass = function (...names) { this.classList.add(...names.flatMap(n => n.split(' ')).filter(Boolean)); };
  proto.removeClass = function (...names) { this.classList.remove(...names); };
  proto.toggleClass = function (name, on) { this.classList.toggle(name, on); };
  proto.setAttr = function (name, value) { this.setAttribute(name, value); };
  proto.setAttrs = function (attrs) { for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v); };
  proto.show = function () { this.style.display = ''; };
  proto.hide = function () { this.style.display = 'none'; };
  proto.appendText = function (text) { this.append(window.document.createTextNode(text)); };
  proto.createEl = function (tag, options, callback) {
    const node = window.document.createElement(tag); this.append(node);
    if (typeof options === 'function') options(node);
    else if (options) {
      if (options.cls) node.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
      if (options.text !== undefined) node.textContent = options.text;
      if (options.type) node.type = options.type;
      if (options.value !== undefined) node.value = options.value;
      if (options.placeholder) node.setAttribute('placeholder', options.placeholder);
      if (options.attr) for (const [key, value] of Object.entries(options.attr)) node.setAttribute(key, value);
    }
    if (callback) callback(node);
    return node;
  };
  for (const [method, tag] of [['createDiv', 'div'], ['createSpan', 'span']]) proto[method] = function (opts, cb) { return this.createEl(tag, opts, cb); };
  proto.onClickEvent = function (callback) { this.addEventListener('click', callback); };
}
class Component {
  constructor() { this.children = []; this.disposers = []; }
  addChild(child) { this.children.push(child); child.load?.(); return child; }
  removeChild(child) { child.unload?.(); this.children = this.children.filter(x => x !== child); return child; }
  register(dispose) { this.disposers.push(dispose); }
  registerDomEvent(el, type, fn, options) { el.addEventListener(type, fn, options); this.register(() => el.removeEventListener(type, fn, options)); }
  registerEvent() {}
  registerInterval(id) { this.register(() => clearInterval(id)); }
  load() { this.onload?.(); }
  unload() { for (const child of this.children) child.unload?.(); for (const d of this.disposers) d(); this.onunload?.(); }
}
class ItemView extends Component {
  constructor(leaf) { super(); this.leaf = leaf; this.app = leaf.app; this.containerEl = document.createElement('div'); this.containerEl.className = 'workspace-leaf-content'; this.containerEl.dataset.type = 'local-issues-view'; this.contentEl = this.containerEl.createDiv({ cls: 'view-content' }); document.body.append(this.containerEl); }
  async setState() {}
}
class Modal extends Component {
  constructor(app) { super(); this.app = app; this.containerEl = document.createElement('div'); this.containerEl.className = 'modal-container'; this.modalEl = this.containerEl.createDiv({ cls: 'modal' }); this.headerEl = this.modalEl.createDiv({ cls: 'modal-header' }); this.titleEl = this.headerEl.createEl('div', { cls: 'modal-title' }); this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' }); }
  setTitle(title) { this.titleEl.textContent = title; return this; }
  open() { document.body.append(this.containerEl); modals.push(this); this.onOpen?.(); }
  close() { this.onClose?.(); this.containerEl.remove(); const i = modals.indexOf(this); if (i >= 0) modals.splice(i, 1); this.unload(); }
}
class AbstractInputSuggest extends Component {
  constructor(app, inputEl) { super(); this.app = app; this.inputEl = inputEl; this.suggestEl = document.createElement('div'); }
  setInstructions() {}
  close() {}
}
class Menu {
  constructor() { this.items = []; this.shown = false; menus.push(this); }
  addItem(cb) { const item = { setTitle(t) { this.title = t; return this; }, setIcon(icon) { this.icon = icon; return this; }, setChecked(value) { this.checked = value; return this; }, setDisabled(value) { this.disabled = value; return this; }, onClick(fn) { this.callback = fn; return this; } }; cb(item); this.items.push(item); return this; }
  addSeparator() { return this; }
  showAtMouseEvent(event) { this.shown = true; this.event = event; }
  showAtPosition(position) { this.shown = true; this.position = position; }
  select(title) { const item = this.items.find(i => i.title === title); if (!item || item.disabled || !item.callback) throw new Error(`菜单项不可用：${title}`); return item.callback(); }
}
class Notice { constructor(message) { notices.push(message); } }
const MarkdownRenderer = { async render(app, body, el, sourcePath, component) { el.textContent = body; el.dataset.sourcePath = sourcePath; } };
class Plugin extends Component {
  constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this.commands = []; this.views = new Map(); this.protocols = new Map(); }
  async loadData() { return this.app.savedData; }
  async saveData(data) { this.app.savedData = data; }
  registerView(type, factory) { this.views.set(type, factory); }
  addRibbonIcon(icon, label, callback) { this.ribbon = { icon, label, callback }; return document.createElement('div'); }
  addCommand(command) { this.commands.push(command); }
  addSettingTab(tab) { this.settingTab = tab; }
  registerObsidianProtocolHandler(action, handler) { this.protocols.set(action, handler); }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div'); } }
class TFile { constructor(path) { this.path = path; this.name = path.split('/').pop(); this.basename = this.name.replace(/\.[^.]+$/, ''); this.extension = this.name.split('.').pop(); } }
class FileSystemAdapter {}
class Setting {
  constructor(el) { this.settingEl = el.createDiv({ cls: 'setting-item' }); this.info = this.settingEl.createDiv(); this.controls = this.settingEl.createDiv(); }
  setName(text) { this.info.createDiv({ text }); return this; }
  setDesc(text) { this.info.createDiv({ text }); return this; }
  addText(cb) { cb(this.control('input')); return this; }
  addToggle(cb) { const c = this.control('input'); c.inputEl.type = 'checkbox'; cb(c); return this; }
  addButton(cb) { cb(this.control('button')); return this; }
  addDropdown(cb) { cb(this.control('select')); return this; }
  control(tag) {
    const el = this.controls.createEl(tag); const c = { inputEl: el, buttonEl: el, selectEl: el,
      setValue(v) { if (el.type === 'checkbox') el.checked = v; else el.value = v; return this; },
      setPlaceholder(v) { el.placeholder = v; return this; }, setButtonText(v) { el.textContent = v; return this; },
      setCta() { el.classList.add('mod-cta'); return this; }, setDisabled(v) { el.disabled = v; return this; },
      addOption(value, label) { const opt = el.createEl('option', { text: label }); opt.value = value; return this; },
      onChange(fn) { el.addEventListener('change', () => fn(el.type === 'checkbox' ? el.checked : el.value)); return this; },
      onClick(fn) { el.addEventListener('click', fn); return this; }, then(fn) { fn(this); return this; } };
    return c;
  }
}
module.exports = { installDom, Component, ItemView, Modal, AbstractInputSuggest, Menu, Notice, MarkdownRenderer,
  Plugin, PluginSettingTab, Setting, TFile, FileSystemAdapter,
  setIcon(el, icon) { el.dataset.icon = icon; el.setAttribute('aria-hidden', 'true'); },
  normalizePath: s => s.replace(/\\/g, '/').replace(/\/{2,}/g, '/'), modals, notices, menus,
};
