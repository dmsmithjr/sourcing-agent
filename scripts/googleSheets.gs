// Paste this into your Google Sheet: Extensions → Apps Script → replace everything → Save.
// Then Deploy → New deployment → type "Web app", Execute as "Me", Who has access "Anyone".
// Copy the Web app URL into GOOGLE_SHEETS_WEBHOOK_URL.

const HEADERS = [
  "Date", "Watchlist", "Title", "Price", "Shipping", "Total Cost", "Condition",
  "Resale Value", "Resale Source", "Est. Net Profit", "Seller", "Feedback %",
  "Size", "Gemini Reasoning", "Link",
];

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  }
  sheet.appendRow([
    new Date(data.date), data.watchlist, data.title, data.price, data.shipping,
    data.totalCost, data.condition, data.resaleValue, data.resaleSource,
    data.estimatedProfit, data.seller, data.sellerFeedback, data.size,
    data.reasoning, data.url,
  ]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
