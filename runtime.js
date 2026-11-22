/* Expense Tracker – tiny offline runtime.
   Renders the design's screen files (screens/*.dc.html) without any library:
   {{holes}}, <sc-for>, <sc-if>, event handlers and a React-style component lifecycle.
   Everything runs on this device; nothing is sent anywhere. */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var BOOL_ATTR = { disabled: 1, hidden: 1, readonly: 1, required: 1, multiple: 1, autofocus: 1, open: 1, selected: 1 };
  var TEXT_INPUT = { text: 1, number: 1, tel: 1, email: 1, search: 1, url: 1, password: 1, date: 1, time: 1, 'datetime-local': 1, month: 1 };

  // ---------- 1. a small HTML parser (keeps attribute case, understands <sc-*> inside <select>) ----------
  function decode(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp|#39);/g, function (m, e) {
      if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>';
      if (e === 'quot') return '"'; if (e === 'apos' || e === '#39') return "'"; if (e === 'nbsp') return ' ';
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return m;
    });
  }
  function parse(html) {
    var root = { tag: '#root', attrs: {}, kids: [] }, stack = [root], i = 0, n = html.length;
    var re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g, m;
    while ((m = re.exec(html))) {
      if (m.index > i) push({ text: decode(html.slice(i, m.index)) });
      i = re.lastIndex;
      if (m[0].slice(0, 4) === '<!--') continue;
      if (m[1]) { // close tag
        var t = m[1].toLowerCase();
        for (var k = stack.length - 1; k > 0; k--) if (stack[k].tag === t) { stack.length = k; break; }
        continue;
      }
      var tag = m[2].toLowerCase(), attrs = {}, order = [];
      var ar = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, a;
      while ((a = ar.exec(m[3] || ''))) {
        var v = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : '';
        attrs[a[1]] = decode(v); order.push(a[1]);
      }
      var parent = stack[stack.length - 1];
      var svg = tag === 'svg' || !!parent.svg;
      var node = { tag: tag, attrs: attrs, order: order, kids: [], svg: svg };
      parent.kids.push(node);
      if (!m[4] && !VOID[tag]) stack.push(node);
    }
    if (i < n) push({ text: decode(html.slice(i)) });
    function push(t) { stack[stack.length - 1].kids.push(t); }
    return root;
  }

  // ---------- 2. holes ----------
  function lookup(path, scope) {
    path = path.trim();
    if (path === 'true') return true; if (path === 'false') return false;
    var parts = path.split('.'), v = scope;
    for (var i = 0; i < parts.length; i++) { if (v == null) return undefined; v = v[parts[i]]; }
    return v;
  }
  var EXACT = /^\{\{([^{}]+)\}\}$/, ANY = /\{\{([^{}]+)\}\}/g;
  function value(str, scope) {
    var m = EXACT.exec(str);
    if (m) return lookup(m[1], scope);
    if (str.indexOf('{{') === -1) return str;
    return str.replace(ANY, function (_, p) { var v = lookup(p, scope); return v == null ? '' : String(v); });
  }

  // ---------- 3. template -> virtual tree ----------
  // vnode: {t:'el', tag, svg, attrs, on, kids} | {t:'tx', s} | {t:'grp', kids}
  function build(node, scope) {
    if (node.text != null) return { t: 'tx', s: value(node.text, scope) };
    if (node.tag === 'sc-if') {
      var ok = value(node.attrs.value || '', scope);
      return { t: 'grp', kids: ok ? kidsOf(node, scope) : [] };
    }
    if (node.tag === 'sc-for') {
      var list = value(node.attrs.list || '', scope) || [], as = node.attrs.as || 'item', out = [];
      for (var i = 0; i < list.length; i++) {
        var sc = Object.create(scope); sc[as] = list[i];
        out.push({ t: 'grp', kids: kidsOf(node, sc) });
      }
      return { t: 'grp', kids: out };
    }
    var attrs = {}, on = {};
    for (var k = 0; k < node.order.length; k++) {
      var name = node.order[k];
      if (name.indexOf('hint-') === 0) continue;
      var v = value(node.attrs[name], scope);
      if (/^on[A-Z]/.test(name)) { if (typeof v === 'function') on[name] = v; continue; }
      attrs[name] = v;
    }
    if (node.tag === 'a' && typeof attrs.href === 'string' && /\.dc\.html$/.test(attrs.href)) attrs.href = '#' + attrs.href.replace(/\.dc\.html$/, '');
    return { t: 'el', tag: node.tag, svg: node.svg, attrs: attrs, on: on, kids: kidsOf(node, scope) };
  }
  function kidsOf(node, scope) { var out = []; for (var i = 0; i < node.kids.length; i++) out.push(build(node.kids[i], scope)); return out; }
  function flat(kids, out) { out = out || []; for (var i = 0; i < kids.length; i++) { if (kids[i].t === 'grp') flat(kids[i].kids, out); else out.push(kids[i]); } return out; }

  // ---------- 4. virtual tree -> real DOM (in-place patching keeps focus and scroll) ----------
  function eventName(prop, tag, attrs) {
    var e = prop.slice(2).toLowerCase();
    if (e === 'change' && (tag === 'textarea' || (tag === 'input' && TEXT_INPUT[(attrs.type || 'text').toLowerCase()]))) return 'input';
    return e;
  }
  function create(v) {
    if (v.t === 'tx') return document.createTextNode(v.s == null ? '' : String(v.s));
    if (v.t === 'grp') { var g = document.createElement('dc-group'); patchKids(g, [], v.kids); return g; }
    var el = v.svg ? document.createElementNS(SVG_NS, v.tag) : document.createElement(v.tag);
    el.__v = { attrs: {}, on: {}, kids: [] };
    patchEl(el, el.__v, v);
    return el;
  }
  function setAttr(el, name, val, isSvg) {
    if (name === 'value' && !isSvg && 'value' in el && el.tagName !== 'OPTION' && el.tagName !== 'BUTTON' && el.tagName !== 'LI') { return; } // handled after children
    if (name === 'checked' && !isSvg) { return; }
    if (val == null || val === false && !/^aria-/.test(name)) { el.removeAttribute(name); return; }
    if (val === true && !/^aria-/.test(name)) { el.setAttribute(name, BOOL_ATTR[name.toLowerCase()] ? '' : 'true'); return; }
    var attr = name === 'className' ? 'class' : name === 'htmlFor' ? 'for' : name;
    el.setAttribute(attr, String(val));
  }
  function patchEl(el, old, v) {
    var a = v.attrs, oa = old.attrs || {}, k;
    for (k in oa) if (!(k in a)) el.removeAttribute(k === 'className' ? 'class' : k);
    for (k in a) if (a[k] !== oa[k]) setAttr(el, k, a[k], v.svg);
    // events: one stable listener per type that calls the latest handler
    el.__h = el.__h || {};
    var types = {};
    for (k in v.on) {
      var type = eventName(k, v.tag, a); types[type] = 1;
      if (!el.__h[type]) {
        (function (t) {
          el.addEventListener(t, function (ev) { var h = el.__h[t]; if (h) { h.call(null, ev); flush(); } });
        })(type);
      }
      el.__h[type] = v.on[k];
    }
    for (k in el.__h) if (!types[k]) el.__h[k] = null;
    if (v.tag === 'select') patchSelect(el, v);
    else patchKids(el, old.kids || [], v.kids);
    // controlled form values
    if ('value' in a && !v.svg && v.tag !== 'option' && v.tag !== 'button') {
      var want = a.value == null ? '' : String(a.value);
      if (v.tag === 'input' && a.type === 'file') {} else if (el.value !== want) el.value = want;
    }
    if ('checked' in a && !v.svg) { var c = !!a.checked; if (el.checked !== c) el.checked = c; }
    el.__v = v;
  }
  function patchSelect(el, v) {
    var opts = flat(v.kids).filter(function (k) { return k.t === 'el'; });
    var sig = JSON.stringify(opts.map(function (o) { return [o.attrs.value, flat(o.kids).map(function (t) { return t.s; }).join('')]; }));
    if (el.__sig !== sig) {
      while (el.firstChild) el.removeChild(el.firstChild);
      opts.forEach(function (o) { el.appendChild(create(o)); });
      el.__sig = sig;
    }
  }
  function same(a, b) { return a && b && a.t === b.t && (a.t !== 'el' || a.tag === b.tag); }
  function patchKids(parent, oldKids, kids) {
    var nodes = parent.childNodes, i;
    for (i = 0; i < kids.length; i++) {
      var v = kids[i], o = oldKids[i], dom = nodes[i];
      if (!dom || !same(o, v)) {
        var fresh = create(v);
        if (dom) parent.replaceChild(fresh, dom); else parent.appendChild(fresh);
        continue;
      }
      if (v.t === 'tx') { var s = v.s == null ? '' : String(v.s); if (dom.nodeValue !== s) dom.nodeValue = s; }
      else if (v.t === 'grp') patchKids(dom, o.kids, v.kids);
      else patchEl(dom, dom.__v || o, v);
    }
    while (nodes.length > kids.length) parent.removeChild(parent.lastChild);
    parent.__kids = kids;
  }

  // ---------- 5. component base (React-style API used by the screens) ----------
  var dirty = [], scheduled = false;
  function schedule(c) { if (dirty.indexOf(c) === -1) dirty.push(c); if (!scheduled) { scheduled = true; Promise.resolve().then(flush); } }
  function flush() {
    scheduled = false;
    var guard = 0;
    while (dirty.length && guard++ < 50) { var list = dirty; dirty = []; list.forEach(function (c) { if (c.__mounted) c.__render(); }); }
  }
  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (patch, cb) {
    var prev = this.state || {};
    var p = typeof patch === 'function' ? patch(prev, this.props) : patch;
    if (p == null) return;
    this.state = Object.assign({}, prev, p);
    if (!this.__prevState) this.__prevState = prev;
    if (cb) (this.__cbs = this.__cbs || []).push(cb);
    if (this.__mounted) schedule(this);
  };
  DCLogic.prototype.forceUpdate = function () { if (this.__mounted) schedule(this); };
  DCLogic.prototype.__render = function () {
    var vals;
    try { vals = this.renderVals() || {}; } catch (e) { console.error(e); return; }
    var tree = kidsOf(this.__tpl, vals);
    patchKids(this.__host, this.__host.__kids || [], tree);
    var prevState = this.__prevState; this.__prevState = null;
    if (this.__didMount && this.componentDidUpdate) { try { this.componentDidUpdate(this.props, prevState || this.state); } catch (e) { console.error(e); } }
    var cbs = this.__cbs; this.__cbs = null; if (cbs) cbs.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
  };
  window.DCLogic = DCLogic;

  // ---------- 6. screens, router, head tags ----------
  function loadScreen(name, html) {
    var body = /<x-dc>([\s\S]*)<\/x-dc>/.exec(html);
    var inner = body ? body[1] : '';
    var helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(inner);
    inner = inner.replace(/<helmet>[\s\S]*?<\/helmet>/, '');
    var sm = /<script type="text\/x-dc"([^>]*)>([\s\S]*?)<\/script>/.exec(html);
    var props = {};
    try {
      var pm = sm ? /data-props='([^']*)'/.exec(sm[1]) : null;
      var dp = pm ? JSON.parse(decode(pm[1])) : {};
      Object.keys(dp).forEach(function (k) { if (k[0] !== '$' && dp[k] && 'default' in dp[k]) props[k] = dp[k].default; });
    } catch (e) {}
    var Cls = null;
    try { Cls = new Function('DCLogic', (sm ? sm[2] : '') + '\n;return typeof Component !== "undefined" ? Component : null;')(DCLogic); } catch (e) { console.error(name, e); }
    return { name: name, tpl: parse(inner), helmet: helmet ? helmet[1] : '', Cls: Cls, props: props };
  }
  function addHead(helmetHtml) {
    var tmp = document.createElement('div'); tmp.innerHTML = helmetHtml;
    Array.prototype.forEach.call(tmp.children, function (n) {
      var key = n.outerHTML;
      if (document.head.querySelector('[data-dc-head="' + btoa(unescape(encodeURIComponent(key))).slice(0, 60) + '"]')) return;
      n.setAttribute('data-dc-head', btoa(unescape(encodeURIComponent(key))).slice(0, 60));
      document.head.appendChild(n);
    });
  }

  var screens = {}, current = null, host = null;
  function show(name) {
    var sc = screens[name] || screens[Object.keys(screens)[0]];
    if (!sc || !sc.Cls) return;
    if (current) {
      try { current.componentWillUnmount && current.componentWillUnmount(); } catch (e) { console.error(e); }
      current.__mounted = false;
    }
    host.innerHTML = ''; host.__kids = [];
    var c = new sc.Cls(Object.assign({}, sc.props));
    if (!c.state) c.state = {};
    c.__tpl = sc.tpl; c.__host = host; c.__mounted = true;
    current = c;
    c.__render();
    c.__didMount = true;
    try { c.componentDidMount && c.componentDidMount(); } catch (e) { console.error(e); }
    flush();
    window.scrollTo(0, 0);
    document.title = 'Expense tracker';
  }
  function route() { show((location.hash || '#Main').slice(1)); }

  window.ExpenseApp = {
    start: function (el, files) {
      host = el;
      return Promise.all(files.map(function (f) {
        return fetch('screens/' + f + '.dc.html').then(function (r) { return r.text(); }).then(function (t) {
          var s = loadScreen(f, t); screens[f] = s; addHead(s.helmet);
        });
      })).then(function () {
        window.addEventListener('hashchange', route);
        route();
      });
    },
    _internals: { parse: parse, build: build, loadScreen: loadScreen, show: show, screens: screens, flush: flush, setHost: function (h) { host = h; } }
  };
})();
