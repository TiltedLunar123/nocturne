/**
 * Settings page.
 *
 * The preview panel is worth noticing: it is rendered by running the real
 * transform over a fixed set of light-page colours, so it cannot drift away
 * from what the engine does. A hand-painted mock would.
 */
(function () {
  'use strict';

  const api = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : globalThis.chrome;
  const NX = globalThis.NX;
  const { MSG } = NX.browser;

  const el = (id) => document.getElementById(id);
  let settings = null;

  const SLIDERS = ['brightness', 'contrast', 'saturation', 'minContrast', 'dimImages'];

  /** A representative light page, in the colours a real one would use. */
  const SAMPLE = {
    bar: '#f1f3f7',
    barText: '#111827',
    page: '#ffffff',
    heading: '#111827',
    text: '#4b5563',
    card: '#f9fafb',
    border: '#e5e7eb',
    button: '#2563eb',
    buttonText: '#ffffff',
    link: '#1d4ed8',
  };

  function renderPreview() {
    const tuning = settings;
    const bg = (hex) => NX.color.format(NX.theme.mapBackground(NX.color.parse(hex).rgb, tuning));
    const fg = (hex) => NX.color.format(NX.theme.mapForeground(NX.color.parse(hex).rgb, tuning));
    const line = (hex) => NX.color.format(NX.theme.mapBorder(NX.color.parse(hex).rgb, tuning));
    const accent = (hex) => NX.color.format(NX.theme.mapAccent(NX.color.parse(hex).rgb, tuning));

    // Text is contrast-corrected against its own background, exactly as the
    // engine does it, so the preview shows the corrected result and not the
    // raw ramp output.
    const pageBg = NX.theme.mapBackground(NX.color.parse(SAMPLE.page).rgb, tuning);
    const bodyText = NX.color.format(
      NX.theme.ensureContrast(
        NX.theme.mapForeground(NX.color.parse(SAMPLE.text).rgb, tuning),
        pageBg,
        tuning
      )
    );

    const host = el('preview');
    host.innerHTML = '';
    host.style.background = NX.color.format(pageBg);

    const bar = document.createElement('div');
    bar.className = 'pv-bar';
    bar.style.background = bg(SAMPLE.bar);
    bar.style.color = fg(SAMPLE.barText);
    bar.style.borderBottomColor = line(SAMPLE.border);
    bar.textContent = 'example.com';

    const body = document.createElement('div');
    body.className = 'pv-body';

    const heading = document.createElement('h3');
    heading.style.color = fg(SAMPLE.heading);
    heading.textContent = 'A heading on a light page';

    const paragraph = document.createElement('p');
    paragraph.style.color = bodyText;
    paragraph.append('Body text, and ');
    const link = document.createElement('span');
    link.className = 'pv-link';
    link.style.color = accent(SAMPLE.link);
    link.textContent = 'a link';
    paragraph.append(link, ', at the contrast this setting guarantees.');

    const card = document.createElement('div');
    card.className = 'pv-card';
    card.style.background = bg(SAMPLE.card);
    card.style.borderColor = line(SAMPLE.border);
    card.style.color = bodyText;
    card.textContent = 'A raised card stays lighter than the page behind it.';

    const button = document.createElement('span');
    button.className = 'pv-btn';
    button.style.background = accent(SAMPLE.button);
    button.style.color = NX.color.format(
      NX.theme.ensureContrast(
        NX.color.parse(SAMPLE.buttonText).rgb,
        NX.theme.mapAccent(NX.color.parse(SAMPLE.button).rgb, tuning),
        tuning
      )
    );
    button.textContent = 'Primary action';

    body.append(heading, paragraph, card, button);
    host.append(bar, body);
  }

  function renderPalettes() {
    const host = el('palettes');
    host.textContent = '';
    for (const [id, palette] of Object.entries(NX.theme.PALETTES)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(settings.palette === id));

      const chip = document.createElement('span');
      chip.className = 'chip';
      const surface = NX.color.format(NX.theme.mapBackground([1, 1, 1], { palette: id }));
      const ink = NX.color.format(NX.theme.mapForeground([0, 0, 0], { palette: id }));
      chip.style.background = `linear-gradient(135deg, ${surface} 0 62%, ${ink} 62% 100%)`;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = palette.label;

      button.append(chip, name);
      button.addEventListener('click', () => save({ palette: id }));
      host.append(button);
    }
  }

  function renderSites() {
    const host = el('sites');
    host.textContent = '';
    const entries = Object.entries(settings.sites || {});
    el('sites-empty').hidden = entries.length > 0;

    for (const [origin, site] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      const item = document.createElement('li');

      const left = document.createElement('div');
      const host_ = document.createElement('div');
      host_.className = 'host';
      host_.textContent = origin;
      const detail = document.createElement('div');
      detail.className = 'detail';
      const bits = [];
      if (site.enabled === false) bits.push('off');
      if (site.mode) bits.push(site.mode);
      if (site.palette) bits.push(site.palette);
      for (const key of ['brightness', 'contrast', 'saturation']) {
        if (site[key] !== undefined) bits.push(`${key} ${site[key]}`);
      }
      detail.textContent = bits.length ? bits.join(', ') : 'custom';
      left.append(host_, detail);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button small';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        const reply = await NX.browser.send({ type: MSG.RESET_SITE, origin });
        if (reply && reply.settings) settings = reply.settings;
        render();
      });

      item.append(left, remove);
      host.append(item);
    }
  }

  function render() {
    el('enabled').value = String(settings.enabled);
    el('schedule-kind').value = settings.schedule.kind;
    el('clock-row').hidden = settings.schedule.kind !== 'clock';
    el('schedule-from').value = settings.schedule.from;
    el('schedule-to').value = settings.schedule.to;
    el('stubborn').checked = settings.stubborn;

    for (const key of SLIDERS) {
      el(key).value = settings[key];
      el(`${key}-out`).textContent =
        key === 'minContrast' ? `${Number(settings[key]).toFixed(1)}:1` : settings[key];
    }

    renderPalettes();
    renderPreview();
    renderSites();
  }

  async function save(patch) {
    // Send the change, not this page's whole snapshot. This page can sit open
    // for a long time while the popup writes settings underneath it.
    const reply = await NX.browser.send({ type: MSG.PATCH_SETTINGS, patch });
    settings = reply && reply.settings
      ? reply.settings
      : NX.settings.sanitise({ ...settings, ...patch });
    render();
  }

  /**
   * The optional all-sites grant. permissions.request must be called from a
   * user gesture, which is why this lives here and not in the service worker.
   */
  async function toggleStubborn(wanted) {
    const note = el('stubborn-note');
    if (!wanted) {
      await api.permissions.remove({ origins: ['<all_urls>'] }).catch(() => {});
      note.hidden = true;
      await save({ stubborn: false });
      return;
    }
    let granted = false;
    try {
      granted = await api.permissions.request({ origins: ['<all_urls>'] });
    } catch {
      granted = false;
    }
    if (!granted) {
      el('stubborn').checked = false;
      note.hidden = false;
      note.textContent = 'Permission was not granted, so this stays off.';
      return;
    }
    note.hidden = true;
    await save({ stubborn: true });
  }

  function wire() {
    el('enabled').addEventListener('change', (e) => save({ enabled: e.target.value === 'true' }));
    el('schedule-kind').addEventListener('change', (e) =>
      save({ schedule: { ...settings.schedule, kind: e.target.value } })
    );
    el('schedule-from').addEventListener('change', (e) =>
      save({ schedule: { ...settings.schedule, from: e.target.value } })
    );
    el('schedule-to').addEventListener('change', (e) =>
      save({ schedule: { ...settings.schedule, to: e.target.value } })
    );
    el('stubborn').addEventListener('change', (e) => toggleStubborn(e.target.checked));

    for (const key of SLIDERS) {
      const input = el(key);
      // Preview live while dragging; persist once on release.
      input.addEventListener('input', () => {
        settings = { ...settings, [key]: Number(input.value) };
        el(`${key}-out`).textContent =
          key === 'minContrast' ? `${Number(input.value).toFixed(1)}:1` : input.value;
        renderPreview();
      });
      input.addEventListener('change', () => save({ [key]: Number(input.value) }));
    }

    el('export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'nocturne-settings.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    el('reset-all').addEventListener('click', async () => {
      if (!confirm('Reset every Nocturne setting, including per-site ones?')) return;
      await save(NX.settings.DEFAULTS);
    });
  }

  async function init() {
    settings = await NX.browser.readSettings();
    const manifest = api.runtime.getManifest();
    el('version').textContent = `Version ${manifest.version}`;
    wire();
    render();
  }

  init();
})();
