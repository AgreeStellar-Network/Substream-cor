/**
 * Build a simple PDF report for creator audit logs.
 *
 * The PDF is intentionally plain and uncompressed so the content remains easy
 * to review and deterministic in tests.
 *
 * @param {{creatorId: string, exportedAt: string, logs: object[]}} input Report data.
 * @returns {Buffer}
 */
function buildAuditLogPdf(input) {
  const lines = [
    'AgreeStellar Creator Audit Log',
    `Creator: ${input.creatorId}`,
    `Exported At: ${input.exportedAt}`,
    '',
  ];

  for (const log of input.logs) {
    lines.push(`Timestamp: ${log.timestamp}`);
    lines.push(`Action: ${log.action_type}`);
    lines.push(`Entity: ${log.entity_type} (${log.entity_id})`);
    lines.push(`IP Address: ${log.ip_address}`);
    lines.push(`Metadata: ${JSON.stringify(log.metadata)}`);
    lines.push('');
  }

  const pageLines = paginate(lines, 32);
  const objects = [];
  objects.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj');
  objects.push(
    `2 0 obj << /Type /Pages /Kids [${pageLines
      .map((_, index) => `${3 + index * 2} 0 R`)
      .join(' ')}] /Count ${pageLines.length} >> endobj`,
  );

  pageLines.forEach((page, index) => {
    const pageObjectId = 3 + index * 2;
    const contentObjectId = pageObjectId + 1;
    objects.push(
      `${pageObjectId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${contentObjectId} 0 R >> endobj`,
    );

    const content = buildPageContent(page);
    objects.push(
      `${contentObjectId} 0 obj << /Length ${Buffer.byteLength(content, 'utf8')} >> stream\n${content}\nendstream\nendobj`,
    );
  });

  objects.push('9 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${object}\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';

  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

/**
 * Split lines into page-sized chunks.
 *
 * @param {string[]} lines Source lines.
 * @param {number} pageSize Lines per page.
 * @returns {string[][]}
 */
function paginate(lines, pageSize) {
  const pages = [];

  for (let index = 0; index < lines.length; index += pageSize) {
    pages.push(lines.slice(index, index + pageSize));
  }

  return pages.length > 0 ? pages : [[]];
}

/**
 * Build the text drawing commands for a single PDF page.
 *
 * @param {string[]} lines Page lines.
 * @returns {string}
 */
function buildPageContent(lines) {
  const commands = ['BT', '/F1 11 Tf', '40 760 Td'];

  lines.forEach((line, index) => {
    if (index === 0) {
      commands.push(`(${escapePdfText(line)}) Tj`);
    } else {
      commands.push('0 -20 Td');
      commands.push(`(${escapePdfText(line)}) Tj`);
    }
  });

  commands.push('ET');
  return commands.join('\n');
}

/**
 * Escape PDF text operators.
 *
 * @param {string} value Raw text.
 * @returns {string}
 */
function escapePdfText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

module.exports = {
  buildAuditLogPdf,
};
