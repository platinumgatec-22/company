// Stand-in for the Claude artifact runtime (window.claude.use) used by the integrated apps in /apps.
// It provides the same small surface those pages call — db, user, assets, downloads, mcp — backed
// by the portal's own server instead of claude.ai.
(function () {
  'use strict';
  var app = document.currentScript && document.currentScript.dataset.app;
  if (!app) return;
  var base = '/apps/' + app + '/api';
  var POLL_MS = 5000;

  function fail(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function request(method, url, body, contentType) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.body = body;
      opts.headers['Content-Type'] = contentType || 'application/json';
    }
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.ok) return data;
        var code = (data && data.code) || (res.status === 401 || res.status === 403 ? 'not_granted'
          : res.status === 413 ? 'too_large' : 'unavailable');
        throw fail(code, data && data.message);
      });
    }, function () { throw fail('unavailable', 'network'); });
  }
  var send = function (method, url, data) { return request(method, url, JSON.stringify(data)); };

  // ---------- db: collections with live snapshots (polling) ----------
  var listeners = {};   // col -> array of {cb, errCb}
  var cache = null;     // col -> [{id, data}]
  var rev = -1;
  var timer = null;
  var inflight = null;

  function snapshot(col) {
    var rows = (cache && cache[col]) || [];
    return {
      docs: rows.map(function (r) { return { id: r.id, data: function () { return JSON.parse(JSON.stringify(r.data)); } }; }),
      empty: rows.length === 0,
      size: rows.length,
      metadata: { fromCache: false },
    };
  }

  function emit(col) {
    (listeners[col] || []).forEach(function (l) {
      try { l.cb(snapshot(col)); } catch (e) { console.error(e); }
    });
  }

  function poll() {
    if (inflight) return inflight;
    inflight = request('GET', base + '/db?rev=' + rev).then(function (res) {
      if (!res.same) {
        rev = res.rev;
        cache = res.cols || {};
        Object.keys(listeners).forEach(emit);
      }
    }, function (err) {
      Object.keys(listeners).forEach(function (col) {
        listeners[col].forEach(function (l) { if (l.errCb) l.errCb(err); });
      });
    }).then(function () { inflight = null; });
    return inflight;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      (document.hidden ? Promise.resolve() : poll()).then(schedule);
    }, POLL_MS);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  // Every write refreshes right away so the page sees its own change immediately.
  function after(p) { return p.then(function (r) { return poll().then(function () { return r; }); }); }

  function collection(col) {
    var url = base + '/db/' + encodeURIComponent(col);
    return {
      onSnapshot: function (cb, errCb) {
        var l = { cb: cb, errCb: errCb };
        (listeners[col] = listeners[col] || []).push(l);
        if (cache) setTimeout(function () { cb(snapshot(col)); }, 0);
        poll().then(schedule);
        return function () { listeners[col] = listeners[col].filter(function (x) { return x !== l; }); };
      },
      get: function () { return poll().then(function () { return snapshot(col); }); },
      add: function (data) { return after(send('POST', url, data)).then(function (r) { return { id: r.id }; }); },
      doc: function (id) {
        var durl = url + '/' + encodeURIComponent(id);
        return {
          id: id,
          set: function (data) { return after(send('PUT', durl, data)); },
          update: function (patch) { return after(send('PATCH', durl, patch)); },
          delete: function () { return after(request('DELETE', durl)); },
        };
      },
    };
  }

  // ---------- the other capabilities ----------
  var config = null;
  function getConfig() {
    if (!config) config = request('GET', base + '/config').catch(function () { return {}; });
    return config;
  }

  var MIME = { csv: 'text/csv;charset=utf-8', json: 'application/json', pdf: 'application/pdf', png: 'image/png', txt: 'text/plain;charset=utf-8' };

  var caps = {
    db: function () { return { collection: collection }; },
    user: function () {
      return getConfig().then(function (c) {
        return { name: c.user, can: function (perm) { return Promise.resolve(perm === 'data.write' ? c.canWrite !== false : true); } };
      });
    },
    assets: function () {
      return {
        upload: function (file, opts) {
          var type = (opts && opts.type) || file.type || 'application/octet-stream';
          return request('POST', base + '/blobs', file, type).then(function (r) { return { id: r.id, url: '/_blob/' + r.id }; });
        },
      };
    },
    downloads: function () {
      return {
        save: function (o) {
          var ext = String(o.filename || '').split('.').pop().toLowerCase();
          var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: MIME[ext] || 'application/octet-stream' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = o.filename || 'download';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
          return Promise.resolve({ saved: true });
        },
      };
    },
    mcp: function () {
      return getConfig().then(function (c) {
        if (!c.mcp) return null;
        return {
          callTool: function (server, tool, args) {
            return send('POST', base + '/mcp', { server: server, tool: tool, args: args || {} });
          },
        };
      });
    },
  };

  window.claude = {
    use: function (name) {
      var make = caps[name];
      return Promise.resolve(make ? make() : null);
    },
  };
})();
