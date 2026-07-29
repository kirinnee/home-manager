import { describe, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import {
  DocumentExtractionError,
  extractDocxText,
  extractPdfText,
  type DocumentExtractionErrorCode,
} from './document-extract';

function pdfWithContent(stream: string, resources = ''): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R ${resources} >>`;
  objects[4] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  if (resources) objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const count = resources ? 5 : 4;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    offsets[index] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= count; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

function textPdf(text: string): Uint8Array {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  return pdfWithContent(`BT /F1 18 Tf 20 100 Td (${escaped}) Tj ET`, '/Resources << /Font << /F1 5 0 R >> >>');
}

// One-page fixture encrypted with qpdf 12.3.2 (AES-256, user password
// `secret`). Keeping the bytes here makes the production PasswordException
// mapping testable without a system qpdf dependency.
const PASSWORD_PROTECTED_PDF =
  'JVBERi0xLjcKJb/3ov4KMSAwIG9iago8PCAvRXh0ZW5zaW9ucyA8PCAvQURCRSA8PCAvQmFzZVZlcnNpb24gLzEuNyAvRXh0ZW5zaW9uTGV2ZWwgOCA+PiA+PiAvUGFnZXMgMiAwIFIgL1R5cGUgL0NhdGFsb2cgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcyA+PgplbmRvYmoKMyAwIG9iago8PCAvQ29udGVudHMgNCAwIFIgL01lZGlhQm94IFsgMCAwIDMwMCAxNDQgXSAvUGFyZW50IDIgMCBSIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+IC9UeXBlIC9QYWdlID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggODAgL0ZpbHRlciAvRmxhdGVEZWNvZGUgPj4Kc3RyZWFtCraA7rIhBw/0E5vYNUptqP+jClMnGohYd+3FA8vDPHYnaQMKuoQbKbBCV2rpx3wWO9uUUDjshbHt3p/SS2yf1CvkXPjTi1J0A+2crzcxQ7SoZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9CYXNlRm9udCAvSGVsdmV0aWNhIC9TdWJ0eXBlIC9UeXBlMSAvVHlwZSAvRm9udCA+PgplbmRvYmoKNiAwIG9iago8PCAvQ0YgPDwgL1N0ZENGIDw8IC9BdXRoRXZlbnQgL0RvY09wZW4gL0NGTSAvQUVTVjMgL0xlbmd0aCAzMiA+PiA+PiAvRmlsdGVyIC9TdGFuZGFyZCAvTGVuZ3RoIDI1NiAvTyA8NjhlNDMzNzZkN2U0NDJkYzY5NzNlNjdlMjQ5MDc4NmQ2M2VmZGE3YmFhOThiYjE5NDIxMTlmYWVkZGU2ODMzNmUzM2JiZjJmNzU4YTkyM2U3YjUxMDQxYzM3OTQzMmY5PiAvT0UgPGMzMTllZWU1NjRhMTQyMmZkY2QwODM4ZWUwZjI1MGM3ODc4NzFkODNjODYzYWI4YWExNWU2NjlmODA5NWI0NmI+IC9QIC00IC9QZXJtcyA8YTNlNTVkM2MxMGI0M2MyOTFiMDY1OGViYjUzNGViOTc+IC9SIDYgL1N0bUYgL1N0ZENGIC9TdHJGIC9TdGRDRiAvVSA8NjZiYjM1MGU3ZjYxM2U5MDg4ZmIzZTlkYWRmNTAwODBiNTdmYjFkYmIwOGU1OTkxMmM1N2JkYTdmN2M0MDFmNDQyOTkxZDU2NzM4NmQ1YzZiNWFlY2QzYzI4OWU5NGJkPiAvVUUgPDk3OTliYWEyOTRmYjAyYTIwNmM5Yjk5Y2JmZTk4OTYyOWUyM2JmZmRmMWNiNDZkM2YxMzJhNjVhNWU0YTEyZWM+IC9WIDUgPj4KZW5kb2JqCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMTMwIDAwMDAwIG4gCjAwMDAwMDAxODkgMDAwMDAgbiAKMDAwMDAwMDMxNyAwMDAwMCBuIAowMDAwMDAwNDY3IDAwMDAwIG4gCjAwMDAwMDA1MzcgMDAwMDAgbiAKdHJhaWxlciA8PCAvUm9vdCAxIDAgUiAvU2l6ZSA3IC9JRCBbPDA4OTgxMWMxYzEyNTEzNzIwZjZhYTA0ZDI1ODU3M2RlPjwwODk4MTFjMWMxMjUxMzcyMGY2YWEwNGQyNTg1NzNkZT5dIC9FbmNyeXB0IDYgMCBSID4+CnN0YXJ0eHJlZgoxMDg0CiUlRU9GCg==';

const CRC_TABLE = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    const localEntry = Buffer.concat([localHeader, nameBytes, compressed]);
    local.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([centralHeader, nameBytes]));
    offset += localEntry.length;
  }
  const localBytes = Buffer.concat(local);
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return new Uint8Array(Buffer.concat([localBytes, centralBytes, end]));
}

function docx(documentXml: string, contentType = true): Uint8Array {
  return zip({
    '[Content_Types].xml': contentType
      ? `<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
      : '<?xml version="1.0"?><Types/>',
    'word/document.xml': documentXml,
  });
}

function code(error: unknown): DocumentExtractionErrorCode | undefined {
  return error instanceof DocumentExtractionError ? error.code : undefined;
}

describe('PDF extraction', () => {
  test('extracts bounded text and reports character truncation honestly', async () => {
    const extracted = await extractPdfText(textPdf('KTEAM PDF fixture hello'), { maxCharacters: 10 });
    expect(extracted).toMatchObject({
      method: 'pdfjs',
      text: 'KTEAM PDF',
      characters: 9,
      truncated: true,
      totalPages: 1,
      pagesRead: 1,
    });
  });

  test('distinguishes image-only PDFs from successful extraction', async () => {
    const error = await extractPdfText(pdfWithContent('0 0 1 rg 20 20 160 100 re f')).catch(value => value);
    expect(code(error)).toBe('no_extractable_text');
    expect(String(error.message)).toContain('scan or image-only PDF');
  });

  test('returns a safe typed error for malformed PDF bytes', async () => {
    const error = await extractPdfText(new TextEncoder().encode('%PDF-not-really')).catch(value => value);
    expect(code(error)).toBe('unreadable_document');
    expect(error.message).toBe('file is not a readable PDF');
  });

  test('reports a real password-protected PDF explicitly', async () => {
    const error = await extractPdfText(new Uint8Array(Buffer.from(PASSWORD_PROTECTED_PDF, 'base64'))).catch(
      value => value,
    );
    expect(code(error)).toBe('password_protected_document');
    expect(error.message).toBe('PDF is password-protected; kteam could not extract text');
  });
});

describe('DOCX extraction', () => {
  test('validates OOXML and extracts text, tabs, breaks and entities', () => {
    const extracted = extractDocxText(
      docx(
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Hello &amp; goodbye</w:t></w:r><w:tab/><w:r><w:t>tab</w:t></w:r><w:br/><w:r><w:t>line</w:t></w:r></w:p></w:body></w:document>',
      ),
    );
    expect(extracted).toEqual({
      method: 'docx-xml',
      text: 'Hello & goodbye tab\nline',
      characters: 24,
      truncated: false,
    });
  });

  test('reports truncation without pretending the whole DOCX was delivered', () => {
    const extracted = extractDocxText(
      docx('<w:document><w:body><w:p><w:r><w:t>abcdefghij</w:t></w:r></w:p></w:body></w:document>'),
      { maxCharacters: 5 },
    );
    expect(extracted).toMatchObject({ text: 'abcde', characters: 5, truncated: true });
  });

  test('rejects ZIP files that merely carry a docx suffix or contain no text', () => {
    expect(
      code(
        (() => {
          try {
            return extractDocxText(docx('<w:document/>', false));
          } catch (error) {
            return error;
          }
        })(),
      ),
    ).toBe('unreadable_document');
    expect(
      code(
        (() => {
          try {
            return extractDocxText(docx('<w:document><w:body><w:p/></w:body></w:document>'));
          } catch (error) {
            return error;
          }
        })(),
      ),
    ).toBe('no_extractable_text');
  });
});
