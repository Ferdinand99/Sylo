// Alpine components for the dashboard (Phase 2 of the modernization). Registered
// on alpine:init so load order relative to alpine.min.js doesn't matter.
document.addEventListener('alpine:init', function () {
  // Multi-select "chips + add dropdown" for roles / channels. Submits one hidden
  // <input name="<field>"> per selected id. Replaces the old app.js handlers.
  window.Alpine.data('chipPicker', function (cfg) {
    return {
      field: cfg.field,
      kind: cfg.kind === 'channel' ? 'channel' : 'role',
      items: Array.isArray(cfg.items) ? cfg.items : [],
      selectedIds: (Array.isArray(cfg.selected) ? cfg.selected : []).map(String),
      pick: '',
      get byId() {
        var m = {};
        this.items.forEach(function (i) {
          m[String(i.id)] = i;
        });
        return m;
      },
      get chips() {
        var by = this.byId;
        return this.selectedIds.map(function (id) {
          return by[id] || { id: id, name: id, color: '' };
        });
      },
      get available() {
        var sel = this.selectedIds;
        return this.items.filter(function (i) {
          return sel.indexOf(String(i.id)) === -1;
        });
      },
      add() {
        var id = String(this.pick || '');
        if (id && this.selectedIds.indexOf(id) === -1) this.selectedIds.push(id);
        this.pick = '';
      },
      remove(id) {
        id = String(id);
        this.selectedIds = this.selectedIds.filter(function (x) {
          return x !== id;
        });
      },
    };
  });

  // Reaction-role builder: the style toggle + the emoji/label/role rows.
  // (The in-place embed editor on the same page is the shared `embedEditor`.)
  window.Alpine.data('rrRows', function (cfg) {
    return {
      style: cfg.style === 'buttons' || cfg.style === 'select' ? cfg.style : 'reaction',
      roles: Array.isArray(cfg.roles) ? cfg.roles : [],
      btnStyles: ['secondary', 'primary', 'success', 'danger'],
      rows: (Array.isArray(cfg.pairs) && cfg.pairs.length ? cfg.pairs : [{}]).map(function (p) {
        return {
          emoji: p.display || '',
          label: p.label || '',
          roleId: p.roleId ? String(p.roleId) : '',
          btnStyle: p.btnStyle || 'secondary',
        };
      }),
      get max() {
        return this.style === 'reaction' ? 20 : 25;
      },
      get rowsTitle() {
        return this.style === 'reaction' ? 'Reactions & roles' : this.style === 'buttons' ? 'Buttons & roles' : 'Menu options';
      },
      get addLabel() {
        return this.style === 'reaction' ? '＋ Add reaction' : this.style === 'buttons' ? '＋ Add button' : '＋ Add option';
      },
      addRow() {
        if (this.rows.length < this.max) this.rows.push({ emoji: '', label: '', roleId: '', btnStyle: 'secondary' });
      },
      removeRow(i) {
        this.rows.splice(i, 1);
        if (!this.rows.length) this.addRow();
      },
    };
  });

  // Shared WYSIWYG embed editor. One component behind every ".wc-*" Discord
  // preview (reaction roles, polls, welcome channel, message builder, …).
  // Feature flags in cfg turn parts on/off; `footerKey` picks the serialised
  // key ("footerText" vs "footer"); `vars` adds insert-token buttons; the hidden
  // <input name="<cfg.hidden>"> in the surrounding <form> receives JSON.
  window.Alpine.data('embedEditor', function (cfg) {
    var HEX = /^#[0-9a-f]{6}$/i;
    var URL_RE = /^https?:\/\/\S+$/i;
    cfg = cfg || {};
    var dc = HEX.test(cfg.defaultColor) ? cfg.defaultColor : '#5865f2';
    var fk = cfg.footerKey || 'footerText';
    var s = cfg.spec && typeof cfg.spec === 'object' ? cfg.spec : {};
    var fid = 0;
    return {
      cfg: cfg,
      _form: null,
      _last: null,
      e: {
        content: String(s.content || ''),
        color: HEX.test(s.color) ? s.color : dc,
        authorName: String(s.authorName || ''),
        authorIcon: String(s.authorIcon || ''),
        title: String(s.title || ''),
        description: String(s.description || ''),
        image: String(s.image || ''),
        thumbnail: String(s.thumbnail || ''),
        footer: String(s[fk] || s.footer || s.footerText || ''),
        footerIcon: String(s.footerIcon || ''),
        fields: (Array.isArray(s.fields) ? s.fields : []).map(function (f) {
          return { id: 'f' + fid++, name: String(f.name || ''), value: String(f.value || ''), inline: !!f.inline };
        }),
      },
      init() {
        this._form = this.$el.closest('form');
        if (this._form) {
          this._form.addEventListener('submit', () => this.sync());
          this.sync(); // populate now so an untouched Save round-trips the spec
          this.$watch('e', () => this.sync()); // keep in sync for htmx serialisation
        }
        this.$el.addEventListener('focusin', (ev) => {
          var t = ev.target;
          if (t && t.classList && t.classList.contains('wc-ed')) this._last = t;
        });
      },
      get serialized() {
        var e = this.e;
        var c = this.cfg;
        var out = { kind: 'embed', color: e.color, title: e.title, image: e.image };
        if (c.content) out.content = e.content;
        if (c.author !== false) {
          out.authorName = e.authorName;
          out.authorIcon = e.authorIcon;
        }
        if (c.description !== false) out.description = e.description;
        if (c.thumb !== false) out.thumbnail = e.thumbnail;
        out[fk] = e.footer;
        if (c.footerIcon !== false) out.footerIcon = e.footerIcon;
        if (c.fields !== false) {
          out.fields = this.e.fields
            .map(function (f) {
              return { name: f.name, value: f.value, inline: !!f.inline };
            })
            .filter(function (f) {
              return f.name || f.value;
            });
        }
        return out;
      },
      sync() {
        if (!this._form) return;
        var h = this._form.querySelector('input[name="' + this.cfg.hidden + '"]');
        if (h) h.value = JSON.stringify(this.serialized);
      },
      addField() {
        this.e.fields.push({ id: 'f' + fid++, name: '', value: '', inline: false });
        this.sync();
      },
      removeField(i) {
        this.e.fields.splice(i, 1);
        this.sync();
      },
      pickImg(key) {
        var u = window.prompt('Image URL (https://…). Leave blank to remove.', this.e[key] || '');
        if (u === null) return;
        u = String(u).trim();
        this.e[key] = URL_RE.test(u) ? u : '';
      },
      insertVar(token) {
        var el = this._last || this.$root.querySelector('.wc-title');
        if (!el) return;
        el.textContent = (el.textContent + (el.textContent ? ' ' : '') + token).trim();
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
    };
  });
});
