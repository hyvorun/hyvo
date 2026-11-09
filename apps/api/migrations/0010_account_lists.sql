-- HYVO holder utilities (docs/OPEN_ITEMS.md item 33): a holder's watchlist of Pons launches and the wallets they follow on
-- /track, kept with their account so the lists reach their other browsers. Everyone else keeps them in their own browser
-- only. One row per wallet and list: a PUT replaces the whole list, one write.
CREATE TABLE account_lists (
  address TEXT NOT NULL,          -- the signed-in wallet, lowercase
  list TEXT NOT NULL,             -- 'watchlist' | 'tracked'
  items_json TEXT NOT NULL,       -- a JSON array of lowercase addresses, in the order saved
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (address, list)
);
