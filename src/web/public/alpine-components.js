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

  // Ordered list of embed / banner blocks (max 10) plus the message text. Same
  // ".wc-*" preview look as `embedEditor`, but the spec is a list with reorder,
  // so it is its own component. Drives the markup in partials/embed-block.ejs.
  // Serialises into the surrounding <form>'s <input name="spec">:
  //   { content, embeds:[…] }              — welcome-channel
  //   { content, embeds:[…], rows:[…] }    — msg-builder (cfg.links: true)
  // cfg: { spec, max, presets?, links? }.
  window.Alpine.data('embedList', function (cfg) {
    var HEX = /^#[0-9a-f]{6}$/i;
    var URL_RE = /^https?:\/\/\S+$/i;
    cfg = cfg || {};
    var spec = cfg.spec && typeof cfg.spec === 'object' ? cfg.spec : { content: '', embeds: [] };
    var specRows = Array.isArray(spec.rows) ? spec.rows : [];
    // Keep every component row that isn't purely link buttons; the link editor
    // owns the rest.
    var keepRows = specRows.filter(function (r) {
      return r.type !== 'buttons' || (r.buttons || []).some(function (b) {
        return b.style !== 'link';
      });
    });
    var linkSeed = specRows
      .flatMap(function (r) {
        return r.type === 'buttons' ? r.buttons || [] : [];
      })
      .filter(function (b) {
        return b.style === 'link' || b.url;
      })
      .map(function (b) {
        return { label: b.label || '', url: b.url || '', emoji: b.emoji || '' };
      });
    var uid = 0;
    function normEmbed(e) {
      e = e && typeof e === 'object' ? e : {};
      return {
        id: 'e' + uid++,
        kind: e.kind === 'banner' ? 'banner' : 'embed',
        color: HEX.test(e.color) ? e.color : '#5865f2',
        authorName: String(e.authorName || ''),
        authorIcon: String(e.authorIcon || ''),
        title: String(e.title || ''),
        description: String(e.description || ''),
        image: String(e.image || ''),
        thumbnail: String(e.thumbnail || ''),
        footerText: String(e.footerText || ''),
        footerIcon: String(e.footerIcon || ''),
        fields: (Array.isArray(e.fields) ? e.fields : []).map(function (f) {
          return { id: 'f' + uid++, name: String(f.name || ''), value: String(f.value || ''), inline: !!f.inline };
        }),
      };
    }
    return {
      max: cfg.max || 10,
      maxLinks: 5,
      presets: Array.isArray(cfg.presets) ? cfg.presets : [],
      hasLinks: !!cfg.links,
      keepRows: keepRows,
      content: String(spec.content || ''),
      items: (Array.isArray(spec.embeds) ? spec.embeds : []).map(normEmbed),
      links: linkSeed,
      _form: null,
      init() {
        this._form =
          this.$el.matches && this.$el.matches('form')
            ? this.$el
            : this.$root.querySelector('form') || this.$el.closest('form');
        if (this._form) {
          this._form.addEventListener('submit', () => this.serialize());
          this.serialize();
          this.$watch('items', () => this.serialize());
          this.$watch('content', () => this.serialize());
          this.$watch('links', () => this.serialize());
        }
      },
      get full() {
        return this.items.length >= this.max;
      },
      addEmbed() {
        if (!this.full) this.items.push(normEmbed({}));
      },
      addPreset(id) {
        if (this.full) return;
        var p = this.presets.find(function (x) {
          return x.id === id;
        });
        if (!p) return;
        this.items.push(normEmbed(JSON.parse(JSON.stringify(p.defaults || { kind: 'embed' }))));
      },
      addLink() {
        if (this.links.length < this.maxLinks) this.links.push({ label: '', url: '', emoji: '' });
      },
      removeLink(i) {
        this.links.splice(i, 1);
      },
      remove(i) {
        this.items.splice(i, 1);
      },
      move(i, d) {
        var j = i + d;
        if (j < 0 || j >= this.items.length) return;
        var it = this.items.splice(i, 1)[0];
        this.items.splice(j, 0, it);
      },
      reset() {
        if (!window.confirm('Clear all elements and the message text?')) return;
        this.items = [];
        this.content = '';
      },
      addField(row) {
        row.fields.push({ id: 'f' + uid++, name: '', value: '', inline: false });
      },
      removeField(row, fi) {
        row.fields.splice(fi, 1);
      },
      pickImg(row, key) {
        var u = window.prompt('Image URL (https://…). Leave blank to remove.', row[key] || '');
        if (u === null) return;
        u = String(u).trim();
        row[key] = URL_RE.test(u) ? u : '';
      },
      get serialized() {
        var out = {
          content: this.content,
          embeds: this.items.map(function (e) {
            return {
              kind: e.kind === 'banner' ? 'banner' : 'embed',
              color: e.color,
              authorName: e.authorName,
              authorIcon: e.authorIcon,
              title: e.title,
              description: e.description,
              image: e.image,
              thumbnail: e.thumbnail,
              footerText: e.footerText,
              footerIcon: e.footerIcon,
              fields: e.fields
                .map(function (f) {
                  return { name: f.name, value: f.value, inline: !!f.inline };
                })
                .filter(function (f) {
                  return f.name || f.value;
                }),
            };
          }),
        };
        if (this.hasLinks) {
          var buttons = this.links
            .map(function (b) {
              return {
                style: 'link',
                label: String(b.label || '').trim(),
                emoji: String(b.emoji || '').trim(),
                url: String(b.url || '').trim(),
              };
            })
            .filter(function (b) {
              return b.url && (b.label || b.emoji);
            });
          out.rows = buttons.length ? this.keepRows.concat([{ type: 'buttons', buttons: buttons }]) : this.keepRows;
        }
        return out;
      },
      serialize() {
        if (!this._form) return;
        var h = this._form.querySelector('input[name="spec"]');
        if (h) h.value = JSON.stringify(this.serialized);
      },
    };
  });

  // Temp-voice hub builder: a live preview of the channel-name template.
  window.Alpine.data('tvName', function (tpl) {
    var DEFAULT = "#{index} - {username}'s Channel";
    return {
      tpl: String(tpl || ''),
      get preview() {
        return (this.tpl.trim() || DEFAULT)
          .replace(/\{index\}/g, '1')
          .replace(/\{count\}/g, '1')
          .replace(/\{username\}/g, 'ferdinand')
          .replace(/\{user\}/g, 'Ferdinand')
          .slice(0, 100);
      },
    };
  });

  // Reminder builder: just the toggle state (message-type tabs, single/recurring
  // schedule, start/end time switches). The in-place embed editor on the same
  // page is a nested `embedEditor`; weekday chips carry their own tiny x-data.
  window.Alpine.data('reminderBuilder', function (cfg) {
    cfg = cfg || {};
    return {
      msgType: cfg.msgType === 'embed' ? 'embed' : 'text',
      mode: cfg.mode === 'single' ? 'single' : 'multiple',
      enableStart: !!cfg.enableStart,
      enableEnd: !!cfg.enableEnd,
    };
  });
});
