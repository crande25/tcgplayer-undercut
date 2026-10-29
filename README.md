# TCG Undercut: a TCGplayer repricing bookmarklet

**Install it: https://crande25.github.io/tcgplayer-undercut/**

TCG Undercut is a free bookmarklet for TCGplayer sellers. Click it on your seller portal's Inventory page and it checks every in-stock listing against the TCG Lowest Listing. Any listing that costs buyers more than the cheapest one, counting shipping, gets a proposed new price that puts it $0.01 under. You review the list, untick anything you want to leave alone, and confirm. Only then does it save, using the same request as the Save button on each product's Manage page, and it reads every new price back from TCGplayer to check it took.

It works with any product line in your TCGplayer inventory: Magic: The Gathering, Pokémon, Yu-Gi-Oh! and the rest. It has been tested with Magic singles and sealed product. There's nothing to install but a bookmark and no account to create. It runs in your browser with your existing TCGplayer sign-in and talks only to TCGplayer.

> **Unofficial.** TCG Undercut is not affiliated with, endorsed by or supported by TCGplayer. It uses the same seller-portal pages you do, and TCGplayer can change those at any time. Use it at your own risk, and make sure it fits TCGplayer's seller terms.

## What it does

- Compares price + shipping, the total TCGplayer sorts listings by, using the same arithmetic as TCGplayer's Match button.
- Shows every proposed change in one table: your price, the lowest listing, the market price, the new price and the size of the cut.
- Marks a cut of 10% or more on a listing priced $10 or more as a **Big drop** and leaves it unticked, in case the lowest listing is a mistake.
- Never raises a price, never changes a quantity, and never undercuts your own listing.
- Skips photo listings and out-of-stock items.
- Reads each product again just before saving, and doesn't save anything that changed since the scan.

## Install and use

1. Open the [install page](https://crande25.github.io/tcgplayer-undercut/) and drag the **TCG Undercut** button onto your bookmarks bar. In Chrome or Edge, press Ctrl+Shift+B to show the bar.
2. In the TCGplayer seller portal, open **Inventory** and click the bookmark.
3. Review the table, untick anything you want to keep as it is, click **Apply**, then **Yes, change prices**.

The install page also explains how it decides, what each result means, and its limits.

## Requirements and limits

- A TCGplayer seller account with live inventory. Staged inventory and accounts that also sell through a My Store channel aren't supported.
- A desktop browser that runs bookmarklets, such as Chrome or Edge. Bookmarklets don't run on the browser's new-tab page.
- It reads one page per product, so a large inventory takes a while: a few seconds per 10 products.

## License

MIT. See [LICENSE](LICENSE).

## For maintainers

### Files

| File | What it is |
| --- | --- |
| `tcg-undercut.js` | The bookmarklet source. The rules and limits are constants at the top. |
| `install.template.html` | The install page; the build fills in `{{BOOKMARKLET}}` and `{{VERSION}}`. |
| `build.ps1` | Builds `install.html` from the two files above. |
| `install.html` | Generated. Don't edit it by hand. GitHub Pages serves it. |
| `index.html` | Sends visitors from the Pages root to `install.html`. |
| `.nojekyll` | Makes GitHub Pages serve the files as they are. Jekyll would read the `{{…}}` placeholders in the Markdown files as template tags. |
| `CHANGELOG.md` | Every change, newest first. |

### Making a change

1. Edit `tcg-undercut.js`, and `install.template.html` if what users see or the rules change.
2. Bump `VERSION` in `tcg-undercut.js`, and move the changelog's Unreleased entries under that version.
3. Build: `powershell -ExecutionPolicy Bypass -File build.ps1` on Windows, or `pwsh build.ps1` with PowerShell 7 anywhere else. It fails if the encoded bookmarklet doesn't decode back to the source.
4. Commit and push. Pages publishes the new install page, and people replace their bookmark from it.

### How it talks to TCGplayer

Every request goes from a `store.tcgplayer.com` page to the same origin, with the seller's own sign-in. TCGplayer doesn't document any of these; they're what the seller portal's own pages use, found by reading those pages on 2026-10-28.

- **Inventory list.** `POST /admin/product/searchcatalog` with JSON `{SearchOptions: {OnlyMyInventory: true, PageIndex, ItemsPerPage: 500, …}}`. `PageIndex` starts at 1. The reply has `Products[].ProductId` and `TotalPageCount`. Its quantities are not reliable, so stock is read from each product's page instead.
- **One product.** `GET /admin/product/manage/{productId}`. An inline script holds `searchResults: [...]`, one row per condition: your `Prices[ChannelId 0].Price` and `Quantity`, `LowestPrice` and `LowestShipping` (the listing with the lowest price + shipping), `MarketPrice`, `ShippingPrice` (yours) and `IsCustomListing` (a photo listing). The same script has `freeShippingMinimumShippingFee` (1.49), `freeShippingMinimumSellerOrderAmt` (5.00), `isStaged` and `isSecondChannelEnabled`.
- **Save.** `POST /admin/product/updateinventory`, form-encoded the way `jQuery.param` does it: `productQuantityPrices[i][ProductId|ProductName|AddToQuantity]` and `productQuantityPrices[i][ConditionQuantityPrices][0][ProductConditionId|ProductId|ConditionId|ChannelId|CategoryName|Quantity|Price|ExistingQuantity|StorePriceCustomId|ReserveQuantity]`. This is what a Manage page's Save button sends (`InventoryGridViewModel.updateInventory` in `/admin/scripts/pricing/main-built.*.js`). `Quantity` is the absolute quantity, so the tool re-reads the product just before saving and sends the current value.

### The pricing rule

- Totals are compared using TCGplayer's Match-button arithmetic. Your shipping is `max(ShippingPrice, 1.49)` when the cheapest listing's price is under $5, otherwise `ShippingPrice`. The new price is their price + their shipping − your shipping − $0.01.
- **Deliberate:** your shipping is judged from the cheapest listing's price, not from your new one, so a cut can cross below $5. For example, $5.20 against a free-shipping $5.00 listing is offered $4.99, even though TCGplayer then counts $1.49 shipping on it. The owner reviewed this on 2026-10-28 and chose to keep it, so open an issue before changing it.
- There's no change when your price is already at or below that, or when it equals `LowestPrice`. A lowest listing at exactly your price is most likely yours: `SellerHasLowestPrice` is false even then. Right after a save, `LowestPrice` can still show the competitor you just undercut.
- Photo listings and out-of-stock rows are skipped. A Big drop is a cut of 10% or more on a listing priced at $10 or more; it starts unticked.
- Staged inventory and accounts with a second sales channel are refused, because the Manage page computes the saved quantity differently there.

### Testing without changing prices

- **Pricing and display.** Run the source on a `store.tcgplayer.com` page, for example from DevTools. Nothing is saved until **Yes, change N prices** is clicked.
- **The save path.** Wrap `window.fetch` so that non-GET requests are recorded and answered locally with a 200, then tick one row and confirm. The run should end with "Sent, but TCGplayer still shows the old price".
- **Checking the request.** To confirm the recorded body is still what TCGplayer sends, open that product's Manage page, set the price on the grid's view model, replace `jQuery.post` with a recorder, and call the view model's `updateInventory()`. The two bodies should match byte for byte.
