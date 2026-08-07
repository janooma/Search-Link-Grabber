const XLSXWriter = (function () {
  function crc32(bytes) {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) {
      crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
  }

  function writeUint32LE(arr, offset, val) {
    arr[offset] = val & 0xFF;
    arr[offset + 1] = (val >>> 8) & 0xFF;
    arr[offset + 2] = (val >>> 16) & 0xFF;
    arr[offset + 3] = (val >>> 24) & 0xFF;
  }

  function writeUint16LE(arr, offset, val) {
    arr[offset] = val & 0xFF;
    arr[offset + 1] = (val >>> 8) & 0xFF;
  }

  function pad2(n) { return n < 10 ? '0' + n : n; }

  function escapeXml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  class Writer {
    constructor(sheetName) {
      this.sheetName = sheetName || 'Sheet1';
      this.rows = [];
      this.sharedStrings = [];
      this.ssMap = new Map();
    }

    addRow(cells) {
      this.rows.push(cells);
    }

    _getSSIndex(val) {
      const s = String(val);
      if (this.ssMap.has(s)) return this.ssMap.get(s);
      const idx = this.sharedStrings.length;
      this.sharedStrings.push(s);
      this.ssMap.set(s, idx);
      return idx;
    }

    _colName(n) {
      let s = '';
      while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = ((n - 1) / 26) | 0;
      }
      return s;
    }

    generate() {
      const now = new Date();
      const created = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}Z`;

      const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

      let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>`;
      for (let r = 0; r < this.rows.length; r++) {
        sheetXml += `<row r="${r + 1}">`;
        const cells = this.rows[r];
        for (let c = 0; c < cells.length; c++) {
          const val = cells[c];
          const ref = this._colName(c + 1) + (r + 1);
          if (typeof val === 'number') {
            sheetXml += `<c r="${ref}"><v>${val}</v></c>`;
          } else {
            const si = this._getSSIndex(val);
            sheetXml += `<c r="${ref}" t="s"><v>${si}</v></c>`;
          }
        }
        sheetXml += '</row>';
      }
      sheetXml += '</sheetData></worksheet>';

      let ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.sharedStrings.length}" uniqueCount="${this.sharedStrings.length}">`;
      for (const s of this.sharedStrings) {
        ssXml += `<si><t>${escapeXml(s)}</t></si>`;
      }
      ssXml += '</sst>';

      const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${escapeXml(this.sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

      const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

      const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Scraped Data</dc:title>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
</cp:coreProperties>`;

      const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

      const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

      const files = [
        { name: '[Content_Types].xml', data: contentTypesXml },
        { name: '_rels/.rels', data: relsXml },
        { name: 'xl/workbook.xml', data: workbookXml },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
        { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
        { name: 'xl/sharedStrings.xml', data: ssXml },
        { name: 'xl/styles.xml', data: stylesXml },
        { name: 'docProps/core.xml', data: coreXml }
      ];

      const encoder = new TextEncoder();
      const parts = [];
      let centralDir = [];
      let offset = 0;

      for (const file of files) {
        const bytes = encoder.encode(file.data);
        const nameBytes = encoder.encode(file.name);
        const uncompressedSize = bytes.length;
        const compressedSize = uncompressedSize;
        const crc = crc32(bytes);

        const localHeader = new Uint8Array(30 + nameBytes.length);
        localHeader.set([0x50, 0x4B, 0x03, 0x04], 0); // signature
        writeUint16LE(localHeader, 4, 20); // version needed
        writeUint16LE(localHeader, 6, 0); // flags
        writeUint16LE(localHeader, 8, 0); // compression method (store)
        writeUint16LE(localHeader, 10, 0); // mod time
        writeUint16LE(localHeader, 12, 0); // mod date
        writeUint32LE(localHeader, 14, crc); // crc
        writeUint32LE(localHeader, 18, compressedSize); // compressed size
        writeUint32LE(localHeader, 22, uncompressedSize); // uncompressed size
        writeUint16LE(localHeader, 26, nameBytes.length); // name length
        writeUint16LE(localHeader, 28, 0); // extra length
        localHeader.set(nameBytes, 30);

        parts.push(localHeader);
        parts.push(bytes);

        const centralHeader = new Uint8Array(46 + nameBytes.length);
        centralHeader.set([0x50, 0x4B, 0x01, 0x02], 0); // signature
        writeUint16LE(centralHeader, 4, 20); // version made by
        writeUint16LE(centralHeader, 6, 20); // version needed
        writeUint16LE(centralHeader, 8, 0); // flags
        writeUint16LE(centralHeader, 10, 0); // compression method
        writeUint16LE(centralHeader, 12, 0); // mod time
        writeUint16LE(centralHeader, 14, 0); // mod date
        writeUint32LE(centralHeader, 16, crc); // crc
        writeUint32LE(centralHeader, 20, compressedSize); // compressed size
        writeUint32LE(centralHeader, 24, uncompressedSize); // uncompressed size
        writeUint16LE(centralHeader, 28, nameBytes.length); // name length
        writeUint16LE(centralHeader, 30, 0); // extra length
        writeUint16LE(centralHeader, 32, 0); // comment length
        writeUint16LE(centralHeader, 34, 0); // disk number start
        writeUint16LE(centralHeader, 36, 0); // internal file attrs
        writeUint32LE(centralHeader, 38, 0); // external file attrs
        writeUint32LE(centralHeader, 42, offset); // relative offset
        centralHeader.set(nameBytes, 46);
        centralDir.push(centralHeader);

        offset += localHeader.length + bytes.length;
      }

      const centralDirSize = centralDir.reduce((a, b) => a + b.length, 0);
      const centralDirOffset = offset;
      for (const h of centralDir) parts.push(h);

      const endRecord = new Uint8Array(22);
      endRecord.set([0x50, 0x4B, 0x05, 0x06], 0); // signature
      writeUint16LE(endRecord, 4, 0); // disk number
      writeUint16LE(endRecord, 6, 0); // disk with central dir
      writeUint16LE(endRecord, 8, files.length); // central dir entries on disk
      writeUint16LE(endRecord, 10, files.length); // total central dir entries
      writeUint32LE(endRecord, 12, centralDirSize); // central dir size
      writeUint32LE(endRecord, 16, centralDirOffset); // central dir offset
      writeUint16LE(endRecord, 20, 0); // comment length
      parts.push(endRecord);

      const totalSize = parts.reduce((a, b) => a + b.length, 0);
      const result = new Uint8Array(totalSize);
      let pos = 0;
      for (const p of parts) {
        result.set(p, pos);
        pos += p.length;
      }
      return result;
    }
  }

  return Writer;
}());

if (typeof window !== 'undefined') window.XLSXWriter = XLSXWriter;
if (typeof self !== 'undefined') self.XLSXWriter = XLSXWriter;
