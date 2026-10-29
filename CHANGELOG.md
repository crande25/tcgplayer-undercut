# Changelog

All notable changes to TCG Undercut, newest first. The version shows in the panel header and on the install page.

## Unreleased

### For users

- Published at https://github.com/crande25/tcgplayer-undercut under the MIT License, with the install page online at https://crande25.github.io/tcgplayer-undercut/.
- Docs: the README is rewritten for people who find the project on GitHub and says plainly that the tool is unofficial. The install page links to the repository, carries the same notice, and has a description for search results and link previews. The bookmarklet itself is unchanged.

### Internal

- Added `LICENSE` (MIT), `index.html` (sends the Pages root to `install.html`) and `.nojekyll`, which makes Pages serve files as they are. Jekyll would read the `{{…}}` placeholders in the Markdown files as template tags.
- Commits use the account's GitHub noreply address, which keeps the owner's email out of the public history.

## 0.4.0 — 2026-10-28

### For users

- New: the panel header and the install page show the version number, so you can tell which bookmark you have installed.
- New: while saving, the footer counts progress ("Saving 3 of 9…").
- Changed: clicking the bookmark again while it is saving shows a message and leaves the running save alone. Previously it hid the panel while the saves carried on unseen. Your browser now also asks before you close or leave the tab mid-save.
- Changed: clearer messages when a product's page won't load or doesn't contain the expected price data, and when you have no in-stock listings.
- Docs: the install page is rewritten around price + shipping and adds what each result means, what the tool won't do, and its limits. New `README.md` for maintainers.

### Internal

- New `VERSION` constant. `build.ps1` copies it into the install page (`{{VERSION}}`), and fails if the encoded bookmarklet doesn't decode back to the source.
- While saving, the panel's host element carries `data-busy` and a `beforeunload` handler is registered. Both are removed in a `finally` block, which also moves the panel to its finished state if an unexpected error escapes.
- `readProduct()` now reports a failed page load and a page without the `searchResults` data as separate errors.
- Reviewed and kept on purpose: your shipping is judged from the cheapest listing's price (TCGplayer's Match arithmetic), so a cut can cross below $5. See `README.md`.

## 0.3.0 — 2026-10-28

### For users

- Changed: a "Big drop" (marked, and unticked until you tick it) is now a cut of 10% or more on a listing currently priced $10.00 or more. It used to be a cut of at least 30% and at least $1.00.
- Changed: the Change column rounds percentages down, so a cut shown as 10% always counts as one.

### Internal

- `BIG_DROP_CENTS` (a minimum cut) is replaced by `BIG_DROP_MIN_PRICE_CENTS` = 1000 (a minimum current price), and `BIG_DROP_PERCENT` goes from 30 to 10.

## 0.2.0 — 2026-10-28

### For users

- Changed: always compares price + shipping, the total buyers sort by, using TCGplayer's Match-button math. The "Compare with" choice is gone, and your price now shows the shipping it is compared with.
- Changed: a lowest listing at exactly your price is treated as your own and left alone, so running the tool again can't keep lowering your own price.
- Changed: clicked on a page outside store.tcgplayer.com (such as sellerportal.tcgplayer.com), the bookmark offers to open the Inventory page instead of only showing a message. The install page says to run it from Inventory, and that a blank new tab can't run it.
- Fixed: the install page and changelog said "at least 30% and $1.00" for a Big drop, which read as if $1.00 alone was enough. They now say both are needed. The rule itself was unchanged.

### Internal

- Removed the item-price comparison mode and its `localStorage` key `tcg-undercut:mode`; a value already stored there is ignored. `evaluate()` no longer takes a mode and also returns `yourShipCents`. Added the `INVENTORY_URL` constant for the off-site prompt.

## 0.1.0 — 2026-10-28

### For users

- New: the TCG Undercut bookmarklet. It scans every in-stock listing, lists the ones priced above the TCG Lowest Listing with a proposed price of lowest − $0.01, and saves only the rows you tick, after a separate "Yes, change N prices" step. Each saved price is read back from TCGplayer to confirm it took.
- Two ways to compare: the lowest listing's item price (default), or price + shipping using the same math as TCGplayer's Match button. The choice is remembered in that browser.
- Safeguards: prices only go down; listings already at or below the lowest are left alone; photo listings and out-of-stock rows are skipped; a cut that is both at least 30% and at least $1.00 starts unticked and is marked "Big drop"; each product is re-read just before saving, and a row whose quantity, price or lowest listing changed since the scan is not saved.
- `install.html`: drag-to-install page with a copy-and-paste fallback and usage notes.

### Internal

- Lists inventory with `POST /admin/product/searchcatalog` and reads each product's condition rows from the `searchResults` JSON embedded in `/admin/product/manage/{productId}`. Saves with `POST /admin/product/updateinventory`, using the same jQuery-style form body as the Manage page's Save button, checked byte for byte against the page's own request.
- Refuses to run on staged inventory or on accounts with a second (My Store) channel, because the Manage page computes the saved quantity differently there.
- `build.ps1` percent-encodes the source into a `javascript:` URL and writes `install.html` from `install.template.html`.
