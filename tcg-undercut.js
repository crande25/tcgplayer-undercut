/*
 * TCG Undercut: a bookmarklet for the TCGplayer seller portal's Inventory page
 * (store.tcgplayer.com/admin/product/catalog).
 *
 * It reads every product in your inventory and lists the in-stock listings that cost buyers more
 * (price + shipping) than the TCG Lowest Listing, proposing the price that puts your total $0.01
 * under it. Nothing changes until you tick the rows, press Apply and confirm. Each save is the
 * request the Save button on that product's Manage page sends, and every saved price is read back
 * to check it.
 *
 * README.md describes the TCGplayer requests and the pricing rule. After editing, bump VERSION,
 * update CHANGELOG.md and run build.ps1 to rebuild install.html.
 */
(() => {
  'use strict';

  const VERSION = '0.4.0';
  const UNDERCUT_CENTS = 1;
  // A cut of at least BIG_DROP_PERCENT on a listing currently priced at BIG_DROP_MIN_PRICE_CENTS or
  // more starts unticked, so one stray cheap listing can't drag a valuable card down unnoticed.
  const BIG_DROP_PERCENT = 10;
  const BIG_DROP_MIN_PRICE_CENTS = 1000;
  const SCAN_CONCURRENCY = 3;
  const SAVE_PAUSE_MS = 400;
  const VERIFY_ATTEMPTS = 4;
  const VERIFY_PAUSE_MS = 1500;
  const HOST_ID = 'tcg-undercut';
  const INVENTORY_URL = 'https://store.tcgplayer.com/admin/product/catalog';
  const SIGNED_OUT = 'You are signed out of TCGplayer. Sign in, then click the bookmark again.';

  // The inventory and save requests only work from a store.tcgplayer.com page.
  if (location.hostname !== 'store.tcgplayer.com') {
    if (confirm('TCG Undercut runs on your seller portal Inventory page. Open it now?\n\nOnce it has loaded, click the bookmark again.')) {
      location.assign(INVENTORY_URL);
    }
    return;
  }
  // Replacing a panel that is mid-save would leave its saves running with nothing to show them.
  const running = document.getElementById(HOST_ID);
  if (running?.dataset.busy) {
    alert('TCG Undercut is still saving prices. Let it finish, then click the bookmark again.');
    return;
  }
  running?.remove();

  /* ---------- Reading and saving through the seller portal ---------- */

  // Stops the whole run (signed out, unsupported account setup), unlike one unreadable product.
  class FatalError extends Error {}

  const toCents = n => (n == null || n === '' || isNaN(n) ? null : Math.round(Number(n) * 100));
  const money = cents => (cents == null ? '–' : '$' + (cents / 100).toFixed(2));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isSignInPage = res => /\/log[io]n\b/i.test(res.url ? new URL(res.url).pathname : '');

  async function listInventory() {
    const products = new Map();
    for (let page = 1; ; page++) {
      const res = await fetch('/admin/product/searchcatalog', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest'},
        body: JSON.stringify({SearchOptions: {
          SearchValue: '', OnlyMyInventory: true, ListingType: 'AllListings', CategoryId: 0, SetNameId: 0,
          Rarity: 0, IsSealed: '', SortColumn: '', SortDirection: '', PageIndex: page, ItemsPerPage: 500,
        }}),
      });
      if (isSignInPage(res)) throw new FatalError(SIGNED_OUT);
      if (!res.ok || !/json/i.test(res.headers.get('content-type') || '')) {
        throw new FatalError(`Couldn't list your inventory (HTTP ${res.status}).`);
      }
      const data = await res.json();
      for (const p of data.Products || []) products.set(p.ProductId, p.ProductName);
      if (!data.Products?.length || page >= (data.TotalPageCount || 1)) break;
    }
    return [...products].map(([id, name]) => ({id, name}));
  }

  // Each product's Manage page embeds its condition rows (your price and quantity, the TCG
  // Lowest Listing, Market Price...) as JSON in an inline script: `searchResults: [...]`.
  async function readProduct(productId) {
    const res = await fetch(`/admin/product/manage/${productId}`, {credentials: 'same-origin', cache: 'no-store'});
    if (isSignInPage(res)) throw new FatalError(SIGNED_OUT);
    if (!res.ok) throw new Error(`couldn't load its Manage page (HTTP ${res.status})`);
    const html = await res.text();
    const rows = jsonArrayAfter(html, /searchResults:\s*(?=\[)/);
    if (!rows) throw new Error('its Manage page had no price data where TCG Undercut looks for it; TCGplayer may have changed the page');
    if (/\bisStaged:\s*true/.test(html)) {
      throw new FatalError('Your inventory is in staged mode. TCG Undercut only works on live inventory.');
    }
    if (/\bisSecondChannelEnabled:\s*true/.test(html)) {
      throw new FatalError('Your account also sells through My Store. TCG Undercut only handles the TCGplayer Marketplace price.');
    }
    const setting = (name, fallback) => {
      const m = new RegExp(name + ':\\s*([\\d.]+)').exec(html);
      return toCents(m ? m[1] : fallback);
    };
    const shipping = {
      minCents: setting('freeShippingMinimumShippingFee', 1.49),
      thresholdCents: setting('freeShippingMinimumSellerOrderAmt', 5),
    };
    return rows.map(row => toListing(row, shipping));
  }

  function jsonArrayAfter(text, pattern) {
    const m = pattern.exec(text);
    if (!m) return null;
    const start = m.index + m[0].length;
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && --depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
    return null;
  }

  function toListing(row, shipping) {
    const marketplace = (row.Prices || []).find(p => p.ChannelId === 0);
    return {
      key: [row.ProductId, row.ProductConditionId, row.StorePriceCustomId || ''].join(':'),
      productId: row.ProductId,
      productConditionId: row.ProductConditionId,
      conditionId: row.ConditionId,
      categoryName: row.CategoryName,
      productName: row.ProductName,
      setName: row.SetName,
      condition: row.ConditionName,
      photoTitle: row.IsCustomListing ? row.Title || 'untitled' : null,
      storePriceCustomId: row.StorePriceCustomId,
      qty: row.Quantity || 0,
      reserveQty: (marketplace && marketplace.ReserveQuantity) || 0,
      priceCents: marketplace ? toCents(marketplace.Price) : null,
      lowCents: toCents(row.LowestPrice),
      lowShipCents: toCents(row.LowestShipping) || 0,
      shipCents: toCents(row.ShippingPrice) || 0,
      marketCents: toCents(row.MarketPrice),
      shipping,
    };
  }

  // The request a Manage page's Save button sends (InventoryGridViewModel.updateInventory in
  // TCGplayer's pricing bundle): one entry per changed condition row, encoded as jQuery.post does.
  async function postPrices(changes) {
    const productQuantityPrices = changes.map(({listing: l, newCents}) => ({
      ProductId: l.productId,
      ProductName: l.productName,
      AddToQuantity: 0,
      ConditionQuantityPrices: [{
        ProductConditionId: l.productConditionId,
        ProductId: l.productId,
        ConditionId: l.conditionId,
        ChannelId: 0,
        CategoryName: l.categoryName,
        Quantity: l.qty,
        Price: (newCents / 100).toFixed(2),
        ExistingQuantity: 0,
        StorePriceCustomId: l.storePriceCustomId,
        ReserveQuantity: l.reserveQty,
      }],
    }));
    const res = await fetch('/admin/product/updateinventory', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest'},
      body: formEncode({productQuantityPrices}),
    });
    if (isSignInPage(res)) throw new FatalError(SIGNED_OUT);
    if (!res.ok) throw new Error(`TCGplayer rejected the save (HTTP ${res.status})`);
  }

  // jQuery.param's nested encoding: a[0][b]=c, spaces as '+', null as ''.
  function formEncode(data) {
    const pairs = [];
    (function add(value, prefix) {
      if (Array.isArray(value)) value.forEach((v, i) => add(v, `${prefix}[${i}]`));
      else if (value !== null && typeof value === 'object') Object.keys(value).forEach(k => add(value[k], prefix ? `${prefix}[${k}]` : k));
      else pairs.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(value == null ? '' : value));
    })(data, '');
    return pairs.join('&').replace(/%20/g, '+');
  }

  /* ---------- Pricing rule ---------- */

  // Buyers see listings sorted by price + shipping, so totals are compared, with the arithmetic of
  // TCGplayer's Match button: below the free-shipping threshold, your shipping counts as at least
  // the minimum fee. A change puts your total $0.01 under the cheapest listing's total.
  // Your shipping is judged from the cheapest listing's price, not your new one, so a cut can cross
  // below the threshold ($5.20 against a free-shipping $5.00 is offered $4.99). That is deliberate;
  // see README.md.
  function evaluate(l) {
    if (l.photoTitle) return {kind: 'skip', why: `photo listing “${l.photoTitle}”, not compared`};
    if (l.lowCents == null) return {kind: 'skip', why: 'no lowest listing to compare with'};
    const yourShipCents = l.lowCents >= l.shipping.thresholdCents
      ? Math.max(l.shipCents, 0)
      : Math.max(l.shipCents, l.shipping.minCents);
    // The price at which your total would exactly tie the cheapest listing's.
    const matchCents = l.lowCents + l.lowShipCents - yourShipCents;
    // A lowest listing at exactly your price is most likely your own (TCGplayer's SellerHasLowestPrice
    // flag can't be relied on), and undercutting it would lower your price again on every run.
    if (l.priceCents <= matchCents || l.priceCents === l.lowCents) return {kind: 'ok', yourShipCents};
    const newCents = matchCents - UNDERCUT_CENTS;
    if (newCents < 1) return {kind: 'skip', why: 'the new price would be under $0.01'};
    const dropCents = l.priceCents - newCents;
    const bigDrop = l.priceCents >= BIG_DROP_MIN_PRICE_CENTS && dropCents * 100 >= l.priceCents * BIG_DROP_PERCENT;
    return {kind: 'change', newCents, dropCents, bigDrop, yourShipCents};
  }

  /* ---------- State and actions ---------- */

  const ICONS = {pending: '', ok: '✓ ', warn: '⚠ ', error: '✗ '};
  const state = {
    phase: 'scanning', // scanning | review | confirm | applying | done | failed
    listings: [],
    unreadable: [],
    progress: {done: 0, total: 0},
    picked: new Map(), // key -> ticked; rows the user hasn't touched use the default
    results: new Map(), // key -> {kind: 'pending' | 'ok' | 'warn' | 'error', text}
    error: null,
    scannedAt: null,
  };
  let scanRun = 0;

  const changeRows = () => state.listings
    .map(listing => ({listing, ev: evaluate(listing)}))
    .filter(row => row.ev.kind === 'change');
  const isPicked = ({listing, ev}) => state.picked.get(listing.key) ?? !ev.bigDrop;

  async function scan() {
    const run = ++scanRun;
    Object.assign(state, {phase: 'scanning', listings: [], unreadable: [], progress: {done: 0, total: 0}, error: null});
    state.picked.clear();
    state.results.clear();
    render();
    try {
      const products = await listInventory();
      state.progress.total = products.length;
      const queue = products.slice();
      const worker = async () => {
        for (let product; (product = queue.shift());) {
          try {
            const listings = await readProduct(product.id);
            if (run !== scanRun) return;
            state.listings.push(...listings.filter(l => l.qty > 0 && l.priceCents > 0));
          } catch (e) {
            if (e instanceof FatalError) {
              queue.length = 0;
              throw e;
            }
            if (run === scanRun) state.unreadable.push(`${product.name}: ${e.message}`);
          }
          if (run !== scanRun) return;
          state.progress.done++;
          if (state.phase === 'scanning') render();
        }
      };
      await Promise.all(Array.from({length: SCAN_CONCURRENCY}, worker));
      if (run !== scanRun) return;
      state.listings.sort((a, b) => a.productName.localeCompare(b.productName) || a.condition.localeCompare(b.condition));
      state.scannedAt = new Date();
      state.phase = 'review';
    } catch (e) {
      if (run !== scanRun) return;
      state.phase = 'failed';
      state.error = e.message;
    }
    render();
  }

  // Leaving the page mid-save would stop it partway, so the browser asks first.
  const warnBeforeLeaving = event => {
    event.preventDefault();
    event.returnValue = '';
  };

  async function applyPicked(rows) {
    state.phase = 'applying';
    state.results.clear();
    for (const {listing} of rows) state.results.set(listing.key, {kind: 'pending', text: 'Waiting'});
    host.dataset.busy = 'true';
    window.addEventListener('beforeunload', warnBeforeLeaving);
    render();
    try {
      const byProduct = new Map();
      for (const {listing, ev} of rows) {
        if (!byProduct.has(listing.productId)) byProduct.set(listing.productId, []);
        byProduct.get(listing.productId).push({scanned: listing, newCents: ev.newCents});
      }
      for (const [productId, group] of byProduct) {
        group.forEach(change => setResult(change.scanned.key, 'pending', 'Saving…'));
        try {
          await saveProduct(productId, group);
        } catch (e) {
          for (const change of group) {
            if (state.results.get(change.scanned.key).kind === 'pending') setResult(change.scanned.key, 'error', e.message);
          }
          if (e instanceof FatalError) break;
        }
        await sleep(SAVE_PAUSE_MS);
      }
    } finally {
      delete host.dataset.busy;
      window.removeEventListener('beforeunload', warnBeforeLeaving);
      for (const [key, result] of state.results) {
        if (result.kind === 'pending') state.results.set(key, {kind: 'error', text: 'Not saved'});
      }
      state.phase = 'done';
      render();
    }
  }

  async function saveProduct(productId, group) {
    // Re-read first: the save carries each row's quantity, so it has to be current, and a price
    // or lowest listing that moved since the scan deserves a fresh look before anything is saved.
    const before = await readProduct(productId);
    const ready = [];
    for (const change of group) {
      const now = before.find(l => l.key === change.scanned.key);
      const unchanged = now && ['qty', 'priceCents', 'lowCents', 'lowShipCents'].every(f => now[f] === change.scanned[f]);
      if (unchanged) ready.push({...change, listing: now});
      else setResult(change.scanned.key, 'warn', 'Changed since the scan, so not saved. Rescan.');
    }
    if (!ready.length) return;
    await postPrices(ready);
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(VERIFY_PAUSE_MS);
      const after = await readProduct(productId);
      for (const change of ready) {
        const saved = after.find(l => l.key === change.scanned.key);
        if (saved?.priceCents === change.newCents) setResult(change.scanned.key, 'ok', `Saved at ${money(change.newCents)}`);
      }
      if (ready.every(change => state.results.get(change.scanned.key).kind === 'ok')) return;
    }
    for (const change of ready) {
      if (state.results.get(change.scanned.key).kind !== 'ok') {
        setResult(change.scanned.key, 'warn', 'Sent, but TCGplayer still shows the old price. Rescan in a minute to check.');
      }
    }
  }

  function setResult(key, kind, text) {
    state.results.set(key, {kind, text});
    const cell = resultCells.get(key);
    if (cell) {
      cell.className = `result is-${kind}`;
      cell.textContent = ICONS[kind] + text;
    }
    if (state.phase === 'applying') refreshFooter();
  }

  /* ---------- Panel ---------- */

  const resultCells = new Map();
  let footer = null;

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
      else if (name === 'checked' || name === 'disabled') el[name] = true;
      else el.setAttribute(name, value === true ? '' : value);
    }
    el.append(...children.flat(Infinity).filter(child => child != null && child !== false));
    return el;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const list = (title, lines, open) => h('details', {open},
    h('summary', {}, title),
    h('ul', {}, lines.map(line => h('li', {}, line))));

  function render() {
    resultCells.clear();
    footer = renderFooter();
    panel.replaceChildren(renderHeader(), renderBody(), footer);
  }

  function refreshFooter() {
    const next = renderFooter();
    footer.replaceWith(next);
    footer = next;
  }

  function renderHeader() {
    let subtitle = 'Reading your inventory…';
    if (state.phase === 'failed') subtitle = 'Stopped';
    else if (state.phase !== 'scanning') {
      const time = state.scannedAt.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
      subtitle = `Checked at ${time} · ${plural(state.listings.length, 'in-stock listing')}`;
    }
    const busy = ['scanning', 'confirm', 'applying'].includes(state.phase);
    return h('header', {},
      h('div', {}, h('h1', {}, 'TCG Undercut ', h('span', {class: 'version'}, `v${VERSION}`)), h('div', {class: 'muted'}, subtitle)),
      h('div', {class: 'spacer'}),
      h('button', {onclick: () => scan(), disabled: busy}, 'Rescan'),
      h('button', {class: 'icon', title: 'Close', 'aria-label': 'Close', onclick: close, disabled: state.phase === 'applying'}, '×'));
  }

  function renderBody() {
    const body = h('div', {class: 'body'});
    if (state.phase === 'scanning') {
      const {done, total} = state.progress;
      body.append(
        h('p', {class: 'lead'}, total ? `Reading product ${done} of ${total}…` : 'Listing your inventory…'),
        h('div', {class: 'bar'}, h('div', {style: `width: ${total ? Math.round(100 * done / total) : 0}%`})));
      return body;
    }
    if (state.phase === 'failed') {
      body.append(h('p', {class: 'note error'}, state.error));
      return body;
    }
    const rows = state.listings.map(listing => ({listing, ev: evaluate(listing)}));
    const changes = rows.filter(row => row.ev.kind === 'change');
    const atLowest = rows.filter(row => row.ev.kind === 'ok');
    const skipped = rows.filter(row => row.ev.kind === 'skip');
    let lead;
    if (state.phase === 'done') lead = 'Finished. Rescan to see your listings as they are now.';
    else if (state.phase === 'confirm') lead = 'Check the ticked rows, then confirm at the bottom.';
    else if (state.phase === 'applying') lead = 'Saving the ticked rows…';
    else if (!state.listings.length) lead = 'You have no in-stock listings to check.';
    else if (changes.length) {
      lead = `${plural(changes.length, 'listing')} ${changes.length === 1 ? 'costs' : 'cost'} buyers more than the cheapest listing, ` +
        'counting shipping. Each new price puts your total $0.01 under it. Untick any you want to leave alone.';
    } else {
      lead = `Nothing to change: none of your ${plural(state.listings.length, 'in-stock listing')} costs more than the cheapest listing, counting shipping.`;
    }
    body.append(h('p', {class: 'lead'}, lead));
    if (changes.length) body.append(renderTable(changes));
    if (atLowest.length) {
      body.append(list(`${atLowest.length} already at or below the lowest`, atLowest.map(({listing: l, ev}) =>
        `${l.productName} (${l.condition}): yours ${money(l.priceCents)} + ${money(ev.yourShipCents)} shipping, ` +
        `lowest ${money(l.lowCents)} + ${money(l.lowShipCents)} shipping`)));
    }
    if (skipped.length) {
      body.append(list(`${skipped.length} skipped`, skipped.map(({listing: l, ev}) => `${l.productName} (${l.condition}): ${ev.why}`)));
    }
    if (state.unreadable.length) {
      body.append(list(`${plural(state.unreadable.length, 'product')} couldn't be read`, state.unreadable, true));
    }
    return body;
  }

  function renderTable(changes) {
    const locked = state.phase !== 'review';
    const showResults = state.results.size > 0;
    const boxes = [];
    const all = h('input', {type: 'checkbox', 'aria-label': 'Select all', disabled: locked, onchange: () => {
      for (const row of changes) state.picked.set(row.listing.key, all.checked);
      boxes.forEach(box => { box.checked = all.checked; });
      refreshFooter();
    }});
    const syncAll = () => {
      const ticked = boxes.filter(box => box.checked).length;
      all.checked = ticked === boxes.length;
      all.indeterminate = ticked > 0 && ticked < boxes.length;
    };
    const tbody = h('tbody', {}, changes.map(row => {
      const {listing: l, ev} = row;
      const box = h('input', {type: 'checkbox', checked: isPicked(row), disabled: locked, 'aria-label': `Change ${l.productName} (${l.condition})`, onchange: () => {
        state.picked.set(l.key, box.checked);
        syncAll();
        refreshFooter();
      }});
      boxes.push(box);
      let resultCell = null;
      if (showResults) {
        const result = state.results.get(l.key);
        resultCell = h('td', {class: `result is-${result ? result.kind : 'none'}`}, result ? ICONS[result.kind] + result.text : 'Not selected');
        resultCells.set(l.key, resultCell);
      }
      return h('tr', {class: ev.bigDrop ? 'flag' : null},
        h('td', {}, box),
        h('td', {class: 'card'},
          h('a', {href: `/admin/product/manage/${l.productId}`, target: '_blank', rel: 'noopener'}, l.productName),
          h('div', {class: 'muted'}, l.setName)),
        h('td', {}, l.condition),
        h('td', {class: 'num'}, String(l.qty)),
        h('td', {class: 'num'}, money(l.priceCents), h('div', {class: 'muted'}, `+ ${money(ev.yourShipCents)} shipping`)),
        h('td', {class: 'num'}, money(l.lowCents), h('div', {class: 'muted'}, `+ ${money(l.lowShipCents)} shipping`)),
        h('td', {class: 'num'}, money(l.marketCents)),
        h('td', {class: 'num new'}, money(ev.newCents)),
        h('td', {class: 'num'}, `−${money(ev.dropCents)}`,
          // Rounded down, so a cut shown as 10% always counts as 10% for the Big drop rule.
          h('div', {class: 'muted'}, `−${Math.floor(100 * ev.dropCents / l.priceCents)}%`),
          ev.bigDrop ? h('div', {}, h('span', {class: 'chip', title: `A cut of ${BIG_DROP_PERCENT}% or more on a listing priced ${money(BIG_DROP_MIN_PRICE_CENTS)} or more`}, 'Big drop')) : null),
        resultCell);
    }));
    syncAll();
    const th = (text, cls) => h('th', {class: cls}, text);
    return h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, all), th('Card'), th('Condition'), th('Qty', 'num'), th('Your price', 'num'), th('Lowest listing', 'num'),
        th('Market', 'num'), th('New price', 'num'), th('Change', 'num'), showResults ? th('Result') : null)),
      tbody);
  }

  function renderFooter() {
    const el = h('footer', {});
    const spacer = () => h('div', {class: 'spacer'});
    if (state.phase === 'review' || state.phase === 'confirm') {
      const changes = changeRows();
      const picked = changes.filter(isPicked);
      if (state.phase === 'review') {
        el.append(
          h('span', {class: 'muted'}, changes.length ? `${picked.length} of ${changes.length} selected` : ''),
          spacer(),
          h('button', {onclick: close}, 'Close'),
          h('button', {class: 'primary', disabled: !picked.length, onclick: () => { state.phase = 'confirm'; render(); }},
            `Apply ${plural(picked.length, 'change')}`));
      } else {
        el.append(
          h('strong', {}, `Change ${plural(picked.length, 'price')} on TCGplayer now?`),
          spacer(),
          h('button', {onclick: () => { state.phase = 'review'; render(); }}, 'Cancel'),
          h('button', {class: 'primary', onclick: () => applyPicked(picked)}, `Yes, change ${plural(picked.length, 'price')}`));
      }
    } else if (state.phase === 'applying') {
      const results = [...state.results.values()];
      const finished = results.filter(r => r.kind !== 'pending').length;
      el.append(h('span', {}, `Saving ${Math.min(finished + 1, results.length)} of ${results.length}… keep this tab open until it finishes.`));
    } else if (state.phase === 'done') {
      const results = [...state.results.values()];
      const count = kind => results.filter(r => r.kind === kind).length;
      const parts = [`Saved ${count('ok')} of ${results.length}`];
      if (count('warn')) parts.push(`${count('warn')} to check`);
      if (count('error')) parts.push(`${count('error')} failed`);
      el.append(h('strong', {}, parts.join(' · ')), spacer(),
        h('button', {onclick: close}, 'Close'),
        h('button', {class: 'primary', onclick: () => scan()}, 'Rescan'));
    } else {
      el.append(spacer(),
        h('button', {onclick: close}, 'Close'),
        state.phase === 'failed' ? h('button', {class: 'primary', onclick: () => scan()}, 'Try again') : null);
    }
    return el;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647; display: flex; justify-content: center; align-items: flex-start;
      padding: 4vh 16px; background: rgba(17, 24, 39, .5);
      font: 14px/1.45 "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif; color: #1f2937;
    }
    .panel {
      width: min(1180px, 100%); max-height: 92vh; display: flex; flex-direction: column;
      background: #fff; border-radius: 10px; box-shadow: 0 24px 60px rgba(0, 0, 0, .35); overflow: hidden;
    }
    header, footer { display: flex; align-items: center; gap: 10px; padding: 12px 18px; }
    header { border-bottom: 1px solid #e5e7eb; }
    footer { border-top: 1px solid #e5e7eb; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 17px; font-weight: 600; }
    .version { color: #6b7280; font-size: 12px; font-weight: 400; }
    .muted { color: #6b7280; font-size: 12px; }
    .spacer { flex: 1; }
    button { font: inherit; padding: 6px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; color: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: #f3f4f6; }
    button:disabled { opacity: .45; cursor: default; }
    button.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; font-weight: 600; }
    button.primary:hover:not(:disabled) { background: #1e40af; }
    button.icon { border: 0; padding: 2px 8px; font-size: 22px; line-height: 1; color: #6b7280; }
    .body { flex: 1; overflow: auto; padding: 0 18px 14px; }
    .lead { margin: 14px 0 10px; }
    .bar { height: 6px; border-radius: 999px; background: #e5e7eb; overflow: hidden; }
    .bar > div { height: 100%; background: #1d4ed8; transition: width .2s; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th {
      position: sticky; top: 0; z-index: 1; padding: 8px; background: #fff; border-bottom: 1px solid #d1d5db;
      text-align: left; font-size: 12px; font-weight: 600; color: #4b5563; white-space: nowrap;
    }
    td { padding: 8px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; }
    .card a { color: #1d4ed8; font-weight: 500; text-decoration: none; }
    .card a:hover { text-decoration: underline; }
    .new { font-weight: 700; }
    tr.flag td { background: #fffbeb; }
    .chip { display: inline-block; margin-top: 3px; padding: 1px 7px; border-radius: 999px; background: #fde68a; color: #78350f; font-size: 11px; font-weight: 600; }
    .result { min-width: 150px; }
    .is-none, .is-pending { color: #6b7280; }
    .is-ok { color: #15803d; font-weight: 600; }
    .is-warn { color: #b45309; }
    .is-error { color: #b91c1c; }
    details { margin-top: 12px; }
    summary { cursor: pointer; font-weight: 500; }
    details ul { margin: 6px 0 0; padding-left: 20px; color: #4b5563; }
    .note { margin: 14px 0; padding: 10px 12px; border-radius: 8px; }
    .error { background: #fef2f2; color: #991b1b; }
  `;

  /* ---------- Start ---------- */

  const host = h('div', {id: HOST_ID});
  const shadow = host.attachShadow({mode: 'open'});
  const panel = h('div', {class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'TCG Undercut'});
  shadow.append(h('style', {}, CSS), h('div', {class: 'backdrop'}, panel));
  document.body.append(host);

  const onKeyDown = event => {
    if (event.key === 'Escape' && state.phase !== 'applying') close();
  };
  document.addEventListener('keydown', onKeyDown, true);

  function close() {
    scanRun++; // a scan still in flight stops updating the removed panel
    document.removeEventListener('keydown', onKeyDown, true);
    host.remove();
  }

  scan();
})();
