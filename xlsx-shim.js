// Tiny XLSX-like facade over XLSXWriter for popup.js compatibility.
(function () {
  function isAvailable() {
    return typeof XLSXWriter !== 'undefined';
  }

  function book_new() {
    return { sheetName: 'Sheet1', rows: [] };
  }

  function json_to_sheet(data) {
    if (!data || !data.length) return { columns: [], rows: [] };
    const columns = Object.keys(data[0]);
    const rows = data.map((obj) => columns.map((k) => obj[k]));
    rows.unshift(columns);
    return { columns, rows };
  }

  function book_append_sheet(workbook, sheet) {
    workbook.rows = sheet.rows;
  }

  function write(workbook, opts) {
    if (!isAvailable()) throw new Error('XLSXWriter not loaded');
    const writer = new XLSXWriter(workbook.sheetName || 'Sheet1');
    for (const row of workbook.rows) {
      writer.addRow(row);
    }
    return writer.generate();
  }

  const XLSX = {
    utils: { book_new, json_to_sheet, book_append_sheet },
    write,
  };

  if (typeof window !== 'undefined') window.XLSX = XLSX;
  if (typeof self !== 'undefined') self.XLSX = XLSX;
})();
