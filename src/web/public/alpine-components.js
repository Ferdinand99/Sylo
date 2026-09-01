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
});
