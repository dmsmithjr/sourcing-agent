import axios from "axios";
import { SHIP_TO_ZIP } from "./config.js";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const SCOPE = "https://api.ebay.com/oauth/api_scope";

// Refresh a minute early so a token never expires mid-request.
const EXPIRY_BUFFER_MS = 60_000;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error("EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be set");
  }

  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE });

  const { data } = await axios.post(TOKEN_URL, body.toString(), {
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS;
  return cachedToken;
}

// Cheapest quoted shipping option, or null when eBay gives no price.
function cheapestShipping(options = []) {
  const costs = options
    .map((o) => o.shippingCost?.value)
    .filter((v) => v !== undefined)
    .map(Number);
  return costs.length ? Math.min(...costs) : null;
}

async function browse(params) {
  const token = await getAccessToken();

  const { data } = await axios.get(SEARCH_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "X-EBAY-C-ENDUSERCTX": `contextualLocation=${encodeURIComponent(`country=US,zip=${SHIP_TO_ZIP}`)}`,
    },
    params,
  });
  return data;
}

async function search(params) {
  const data = await browse(params);
  return (data.itemSummaries ?? []).map((item) => ({
    itemId: item.itemId,
    title: item.title,
    price: Number(item.price?.value ?? 0),
    shippingCost: cheapestShipping(item.shippingOptions),
    currency: item.price?.currency ?? "USD",
    condition: item.condition ?? "Unknown",
    url: item.itemWebUrl,
    imageUrl: item.image?.imageUrl ?? null,
    seller: item.seller?.username ?? "unknown",
    sellerFeedback: item.seller?.feedbackPercentage ?? null,
  }));
}

/**
 * Search eBay for fixed-price listings at or below maxPrice (USD).
 * Returns a trimmed list of listing objects. extraParams narrows the search (see sizeFilter).
 */
export function searchListings(keyword, maxPrice, limit = 20, extraParams = {}) {
  return search({
    q: keyword,
    limit,
    sort: "newlyListed",
    filter: `price:[..${maxPrice}],priceCurrency:USD,buyingOptions:{FIXED_PRICE}`,
    ...extraParams,
  });
}

// Other ways people write the sizes eBay lists as S, M, L, XL, 2XL...
const SIZE_ALIASES = {
  small: "s", medium: "m", large: "l",
  xlarge: "xl", "x-large": "xl", xxl: "2xl", xxlarge: "2xl", "xx-large": "2xl", xxxl: "3xl",
};

function normalizeSize(size) {
  const s = String(size).toLowerCase().replace(/\b(us|men'?s|size)\b/g, "").replace(/\s+/g, "");
  return SIZE_ALIASES[s] ?? s;
}

// Sneakers list US, UK and EU sizes; clothing has "Size" plus a "Size Type" we don't want.
function pickSizeAspect(aspects) {
  const named = (pattern) => aspects.find((a) => pattern.test(a.localizedAspectName));
  return named(/^us shoe size/i) ?? named(/^size$/i) ?? named(/^(?!.*type).*size/i);
}

/**
 * Turns sizes like ["10", "10.5"] or ["L", "XL"] into extra search params so eBay only returns
 * listings in those sizes. eBay filters size per category, so this looks up the item's main
 * category and its size field first. Returns { params, aspect, sizes }. Throws when none of the
 * sizes are listed, so a typo doesn't quietly turn into a search that finds nothing.
 */
export async function sizeFilter(keyword, sizes) {
  const data = await browse({ q: keyword, limit: 1, fieldgroups: "ASPECT_REFINEMENTS" });
  const { dominantCategoryId, aspectDistributions = [] } = data.refinement ?? {};
  const aspect = dominantCategoryId && pickSizeAspect(aspectDistributions);
  if (!aspect) throw new Error(`eBay has no size filter for "${keyword}"`);

  const wanted = new Set(sizes.map(normalizeSize));
  const available = aspect.aspectValueDistributions.map((v) => v.localizedAspectValue);
  const matched = available.filter((v) => wanted.has(normalizeSize(v)));
  if (!matched.length) {
    throw new Error(
      `No "${keyword}" listings in size ${sizes.join(", ")}. eBay has: ${available.slice(0, 30).join(", ")}`
    );
  }
  return {
    params: {
      category_ids: dominantCategoryId,
      aspect_filter: `categoryId:${dominantCategoryId},${aspect.localizedAspectName}:{${matched.join("|")}}`,
    },
    aspect: aspect.localizedAspectName,
    sizes: matched,
  };
}

export function isUsed(condition) {
  return /pre-owned|used|parts/i.test(condition);
}

// Estimates use the 40th percentile rather than the median: these are asking prices, and
// items usually sell for somewhat less than sellers ask. A percentile also shrugs off the
// fakes and accessories at the bottom and the overpriced listings at the top.
const ESTIMATE_PERCENTILE = 0.4;
const ESTIMATE_SAMPLE_SIZE = 200;
// With fewer listings than this the estimate is too noisy to trust.
const MIN_ESTIMATE_LISTINGS = 10;

function percentile(values) {
  if (values.length < MIN_ESTIMATE_LISTINGS) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(ESTIMATE_PERCENTILE * (sorted.length - 1))]);
}

/**
 * Estimates what an item resells for from current Buy It Now listings (price + shipping),
 * separately for new and used condition. Pass sizeFilter params to price only those sizes.
 * Returns { all, new, used, sampleSize }; new/used are null when that condition has too few
 * listings. Throws if there are too few overall.
 */
export async function estimateResaleValue(keyword, extraParams = {}) {
  const listings = await search({
    q: keyword,
    limit: ESTIMATE_SAMPLE_SIZE,
    filter: "priceCurrency:USD,buyingOptions:{FIXED_PRICE}",
    ...extraParams,
  });
  const total = (l) => l.price + (l.shippingCost ?? 0);

  const all = percentile(listings.map(total));
  if (all === null) {
    throw new Error(`Only ${listings.length} eBay listing(s) found, too few to estimate a resale value`);
  }
  return {
    all,
    new: percentile(listings.filter((l) => !isUsed(l.condition)).map(total)),
    used: percentile(listings.filter((l) => isUsed(l.condition)).map(total)),
    sampleSize: listings.length,
  };
}
