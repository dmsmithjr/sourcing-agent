import axios from "axios";

// Appends one row per Discord alert to a Google Sheet through the Apps Script web app in
// scripts/googleSheets.gs. Optional: does nothing unless GOOGLE_SHEETS_WEBHOOK_URL is set.
export async function logAlertToSheet(item, listing, verdict, totalCost) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url) return;

  await axios.post(url, {
    date: new Date().toISOString(),
    watchlist: item.keyword,
    title: listing.title,
    price: listing.price,
    shipping: listing.shippingCost ?? "unknown",
    totalCost,
    condition: listing.condition,
    resaleValue: verdict.resale.value,
    resaleSource: verdict.resale.estimated ? "estimated" : "target",
    estimatedProfit: Number(verdict.estimatedProfit.toFixed(2)),
    seller: listing.seller,
    sellerFeedback: listing.sellerFeedback ?? "",
    size: item.size?.sizes.join(", ") ?? "",
    reasoning: verdict.reasoning,
    url: listing.url,
  });
}
