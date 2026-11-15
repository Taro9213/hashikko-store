// A stand-in for Hashikko's sdk.js, used only by "Try it here" on the store website.
// Saving works while the page is open, and nothing leaves the page.
(() => {
  const saved = {};
  window.hashikko = {
    call: async (type, extra) => {
      extra = extra || {};
      if (type === 'storage.get') return { ok: true, value: Object.prototype.hasOwnProperty.call(saved, extra.key) ? JSON.parse(saved[extra.key]) : null };
      if (type === 'storage.set') { saved[extra.key] = JSON.stringify(extra.value === undefined ? null : extra.value); return { ok: true }; }
      if (type === 'clipboard.write') return { ok: true };
      return { ok: false, reason: 'preview' };
    },
    onVisible: (cb) => { setTimeout(() => cb(true), 0); },
    close: () => {},
    focus: () => {},
  };
})();
