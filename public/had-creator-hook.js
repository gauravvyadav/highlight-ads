/* MAIN-world hook: tags nodes inserted while an ad script runs (data-had-ac). Dependency-free; isolated-world DOM calls bypass these wrappers. */
(function () {
  if (window.__hadCreatorHook) return;
  window.__hadCreatorHook = true;

  var ATTR = 'data-had-ac';

  // Mirror of BUNDLED_PATTERNS in utils/filterlist.ts — keep in sync.
  var AD_RE =
    /ad_filterlist_demo_param=1|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.|ads\.yahoo\.com|amazon-adsystem\.com|criteo\.com|criteo\.net|outbrain\.com|outbrainimg\.com|taboola\.com|taboolasyndication\.com|moatads\.com|adsrvr\.org|adnxs\.com|rubiconproject\.com|pubmatic\.com|openx\.net|smartadserver\.com|adform\.net|adskeeper\.|mgid\.com|revcontent\.com|zemanta\.com|sharethrough\.com|indexww\.com|2mdn\.net|googletagservices\.com\/gpt|\/ads\/|\/adserver|\/ad_banner|\/banner_ad|popunder|popupad|prebid|gpt\.js|fbevents\.js|adsbygoogle|pagead2\./i;

  var URL_RE = /https?:\/\/[^\s"'()\]]+/g;

  // First ad-script URL on the current stack, if any.
  function creatorIsAd() {
    // Fast path: check document.currentScript without stack inspection
    var cs = document.currentScript;
    if (cs && cs.src) {
      return AD_RE.test(cs.src) ? cs.src : null;
    }

    var stack = '';
    try {
      var err = new Error();
      stack = err.stack || '';
    } catch (e) {
      stack = '';
    }
    if (!stack || stack.indexOf('http') === -1) return null;
    var m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(stack)) !== null) {
      var url = m[0];
      // Our own file never matches an ad pattern.
      if (AD_RE.test(url)) return url;
    }
    return null;
  }

  function tag(el, creator) {
    try {
      if (!el.hasAttribute(ATTR)) {
        el.setAttribute(ATTR, creator.slice(0, 160));
      }
    } catch (e) {
      // Read-only node — skip.
    }
  }

  // Fast check: only check elements that can realistically be ad creatives/containers.
  // Bypasses 99.9% of normal DOM insertions (spans, paragraphs, buttons, list items, SVGs).
  function isAdCandidate(node) {
    if (!(node instanceof Element)) return false;
    var tag = node.tagName;
    if (
      tag === 'IFRAME' ||
      tag === 'EMBED' ||
      tag === 'OBJECT' ||
      tag === 'INS' ||
      tag === 'SCRIPT' ||
      tag === 'IMG' ||
      tag === 'VIDEO'
    ) {
      return true;
    }
    var id = node.id;
    if (typeof id === 'string' && id && /ad|banner|sponsor/i.test(id)) return true;
    var cls = node.className;
    if (typeof cls === 'string' && cls && /ad|banner|sponsor/i.test(cls)) return true;
    return false;
  }

  // Wrap an insertion method (null indexes = every argument; stack captured lazily).
  function hookNodes(proto, name, indexes) {
    var orig;
    try {
      orig = proto[name];
      if (typeof orig !== 'function' || orig.__hadHooked) return;
    } catch (e) {
      return;
    }
    var wrapped = function () {
      var creator = null;
      var computed = false;
      var getCreator = function () {
        if (!computed) {
          computed = true;
          creator = creatorIsAd();
        }
        return creator;
      };
      var mark = function (node) {
        if (node instanceof Element) {
          if (!isAdCandidate(node)) return;
          var c = getCreator();
          if (c) tag(node, c);
        } else if (node instanceof DocumentFragment) {
          var kids = node.children;
          for (var i = 0; i < kids.length; i++) {
            var kid = kids[i];
            if (isAdCandidate(kid)) {
              var c2 = getCreator();
              if (c2) tag(kid, c2);
            }
          }
        }
      };
      for (var k = 0; k < (indexes ? indexes.length : arguments.length); k++) {
        var idx = indexes ? indexes[k] : k;
        if (idx < arguments.length) mark(arguments[idx]);
      }
      return orig.apply(this, arguments);
    };
    wrapped.__hadHooked = true;
    try {
      proto[name] = wrapped;
    } catch (e) {
      // Leave unwrapped.
    }
  }

  // insertAdjacentHTML takes an HTML string: tag what it parsed.
  function hookAdjacentHTML() {
    var orig;
    try {
      orig = Element.prototype.insertAdjacentHTML;
      if (typeof orig !== 'function' || orig.__hadHooked) return;
    } catch (e) {
      return;
    }
    var wrapped = function (position, html) {
      if (
        typeof html === 'string' &&
        html.indexOf('<iframe') === -1 &&
        html.indexOf('<img') === -1 &&
        html.indexOf('<script') === -1 &&
        html.indexOf('<ins') === -1 &&
        html.indexOf('ad') === -1
      ) {
        return orig.apply(this, arguments);
      }
      var pos = String(position).toLowerCase();
      var parent = this;
      var startNode = null;
      var endNode = null;
      try {
        if (pos === 'beforebegin') {
          parent = this.parentNode;
          startNode = this.previousSibling;
          endNode = this;
        } else if (pos === 'afterend') {
          parent = this.parentNode;
          startNode = this;
          endNode = this.nextSibling;
        } else if (pos === 'afterbegin') {
          endNode = this.firstChild;
        } else if (pos === 'beforeend') {
          startNode = this.lastChild;
        } else {
          return orig.apply(this, arguments);
        }
      } catch (e) {
        return orig.apply(this, arguments);
      }
      var r = orig.apply(this, arguments);
      var creator = null;
      var checked = false;
      try {
        var cur = startNode ? startNode.nextSibling : parent.firstChild;
        while (cur && cur !== endNode) {
          var next = cur.nextSibling;
          if (cur instanceof Element && isAdCandidate(cur)) {
            if (!checked) {
              checked = true;
              creator = creatorIsAd();
            }
            if (creator) tag(cur, creator);
          }
          cur = next;
        }
      } catch (e) {
        // Best effort — insertion already happened.
      }
      return r;
    };
    wrapped.__hadHooked = true;
    try {
      Element.prototype.insertAdjacentHTML = wrapped;
    } catch (e) {
      // Leave unwrapped.
    }
  }

  // innerHTML replacement: the new top-level children are ad-created.
  function hookInnerHTML() {
    var desc;
    try {
      desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      if (!desc || typeof desc.set !== 'function' || desc.set.__hadHooked) {
        return;
      }
    } catch (e) {
      return;
    }
    var origSet = desc.set;
    var wrappedSet = function (html) {
      origSet.call(this, html);
      if (
        typeof html === 'string' &&
        html.indexOf('<iframe') === -1 &&
        html.indexOf('<img') === -1 &&
        html.indexOf('<script') === -1 &&
        html.indexOf('<ins') === -1 &&
        html.indexOf('ad') === -1
      ) {
        return;
      }
      try {
        var kids = this.children;
        var creator = null;
        var checked = false;
        for (var i = 0; i < kids.length; i++) {
          if (isAdCandidate(kids[i])) {
            if (!checked) {
              checked = true;
              creator = creatorIsAd();
            }
            if (creator) tag(kids[i], creator);
          }
        }
      } catch (e) {
        // Best effort.
      }
    };
    wrappedSet.__hadHooked = true;
    try {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: wrappedSet,
      });
    } catch (e) {
      // Leave unwrapped.
    }
  }

  try {
    hookNodes(Node.prototype, 'appendChild', [0]);
    hookNodes(Node.prototype, 'insertBefore', [0]);
    hookNodes(Node.prototype, 'replaceChild', [0]);
    hookNodes(Element.prototype, 'append', null);
    hookNodes(Element.prototype, 'prepend', null);
    hookNodes(Element.prototype, 'before', null);
    hookNodes(Element.prototype, 'after', null);
    hookNodes(Element.prototype, 'replaceWith', null);
    hookNodes(Element.prototype, 'insertAdjacentElement', [1]);
    hookAdjacentHTML();
    hookInnerHTML();
  } catch (e) {
    // Hooking must never break the page.
  }
})();
