/**
 * .xlsx / .xls 导入 — SheetJS 解析首个工作表,转 CSV 后走现有 parseMatrix 管线。
 */
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {
  MAX_XLSX_ENTRY_BYTES,
  MAX_XLSX_TOTAL_BYTES,
  assertXlsxArchiveBudget,
  detectExcelContainer,
  errText,
  assertXlsxImportSize,
  type XlsxArchiveEntryBudget,
} from './adapter';

export const XLSX_WORKSHEET_LIMITS = Object.freeze({
  rows: 200_000,
  columns: 256,
  cells: 2_000_000,
  stringLength: 32_767,
  textCharacters: 20_000_000,
});

/**
 * BIFF8/OLE has no ZIP member that can be inspected before SheetJS materialises
 * the workbook.  Keep the legacy format deliberately smaller than OOXML so a
 * user-opened .xls cannot turn the synchronous parser into an unbounded WebView
 * allocation.  Two MiB is still ample for the small, internal worksheets this
 * compatibility path is intended to support.
 */
export const MAX_BIFF8_IMPORT_BYTES = 2 * 1024 * 1024;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function updateCrc32(state: number, chunk: Uint8Array): number {
  let crc = state;
  for (let i = 0; i < chunk.byteLength; i++) {
    crc = CRC32_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function checkImportCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消 Excel 导入', 'AbortError');
}

// 包括弹窗关闭后重新打开的请求在内，同一时刻只校验/解析一个工作簿。
// 同步 SheetJS 不能中途打断；取消必须在进入它之前生效。
let excelImportTail: Promise<void> = Promise.resolve();

type StreamingZipObject = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
};

const PACKAGE_METADATA_LIMIT_BYTES = 2 * 1024 * 1024;
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const CONTENT_TYPES_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/content-types';
const PACKAGE_RELATIONSHIPS_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
]);
const SPREADSHEET_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const OFFICE_RELATIONSHIPS_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet',
]);
const WORKSHEET_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const WORKBOOK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const SHEETJS_WORKBOOK_CONTENT_TYPES = new Set([
  WORKBOOK_CONTENT_TYPE,
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  'application/vnd.ms-excel.sheet.binary.macroEnabled.main',
  'application/vnd.ms-excel.addin.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
]);

interface ParsedXmlAttribute {
  localName: string;
  namespaceUri: string | null;
  value: string;
  rawValue: string;
}

interface ParsedXmlElement {
  qualifiedName: string;
  localName: string;
  namespaceUri: string | null;
  attributes: ParsedXmlAttribute[];
  children: ParsedXmlElement[];
}

interface OpenXmlElement {
  element: ParsedXmlElement;
  namespaces: Map<string, string>;
}

function splitXmlName(
  name: string,
  label: string,
): { prefix: string; localName: string } {
  // OOXML vocabulary and namespace prefixes are ASCII XML names.  Restricting
  // metadata names to that subset avoids accepting visually-confusable names.
  const match = /^(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)$/.exec(name);
  if (!match) throw new Error(`Excel ${label} XML 名称无效`);
  return { prefix: match[1] ?? '', localName: match[2] };
}

function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function decodeXmlAttributeValue(value: string, label: string): string {
  let decoded = '';
  let cursor = 0;
  while (cursor < value.length) {
    const ampersand = value.indexOf('&', cursor);
    if (ampersand < 0) return decoded + value.slice(cursor);
    decoded += value.slice(cursor, ampersand);
    const semicolon = value.indexOf(';', ampersand + 1);
    if (semicolon < 0) throw new Error(`Excel ${label} XML 属性实体未完整`);
    const entity = value.slice(ampersand + 1, semicolon);
    const named: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
    };
    if (Object.prototype.hasOwnProperty.call(named, entity)) {
      decoded += named[entity];
    } else {
      const numeric = /^#(\d+)$/.exec(entity);
      const hexadecimal = /^#x([\dA-Fa-f]+)$/.exec(entity);
      const codePoint = numeric
        ? Number(numeric[1])
        : hexadecimal
          ? Number.parseInt(hexadecimal[1], 16)
          : Number.NaN;
      if (!Number.isSafeInteger(codePoint) || !isValidXmlCodePoint(codePoint)) {
        throw new Error(`Excel ${label} XML 属性实体无效`);
      }
      decoded += String.fromCodePoint(codePoint);
    }
    cursor = semicolon + 1;
  }
  return decoded;
}

function findXmlTagEnd(xml: string, start: number, label: string): number {
  let quote = '';
  for (let index = start; index < xml.length; index++) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    } else if (char === '<') {
      throw new Error(`Excel ${label} XML 标签结构无效`);
    }
  }
  throw new Error(`Excel ${label} XML 标签未完整`);
}

function parseXmlStartTag(
  source: string,
  parentNamespaces: ReadonlyMap<string, string>,
  label: string,
): {
  element: ParsedXmlElement;
  namespaces: Map<string, string>;
  selfClosing: boolean;
} {
  let end = source.length;
  while (end > 0 && /\s/.test(source[end - 1])) end--;
  const selfClosing = source[end - 1] === '/';
  if (selfClosing) {
    end--;
    while (end > 0 && /\s/.test(source[end - 1])) end--;
  }

  let cursor = 0;
  while (cursor < end && /\s/.test(source[cursor])) cursor++;
  const nameStart = cursor;
  while (cursor < end && !/[\s=]/.test(source[cursor])) cursor++;
  const qualifiedName = source.slice(nameStart, cursor);
  if (!qualifiedName) throw new Error(`Excel ${label} XML 标签名为空`);
  const elementName = splitXmlName(qualifiedName, label);

  const rawAttributes: Array<{
    qualifiedName: string;
    value: string;
    rawValue: string;
  }> = [];
  const seenAttributeNames = new Set<string>();
  while (cursor < end) {
    while (cursor < end && /\s/.test(source[cursor])) cursor++;
    if (cursor >= end) break;
    const attributeStart = cursor;
    while (cursor < end && !/[\s=]/.test(source[cursor])) cursor++;
    const attributeName = source.slice(attributeStart, cursor);
    splitXmlName(attributeName, label);
    if (seenAttributeNames.has(attributeName)) {
      throw new Error(`Excel ${label} XML 含重复属性「${attributeName}」`);
    }
    seenAttributeNames.add(attributeName);
    while (cursor < end && /\s/.test(source[cursor])) cursor++;
    if (source[cursor] !== '=')
      throw new Error(`Excel ${label} XML 属性「${attributeName}」缺少赋值`);
    cursor++;
    while (cursor < end && /\s/.test(source[cursor])) cursor++;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Excel ${label} XML 属性「${attributeName}」未使用引号`);
    }
    cursor++;
    const valueStart = cursor;
    while (cursor < end && source[cursor] !== quote) {
      if (source[cursor] === '<')
        throw new Error(`Excel ${label} XML 属性「${attributeName}」无效`);
      cursor++;
    }
    if (cursor >= end)
      throw new Error(`Excel ${label} XML 属性「${attributeName}」未完整`);
    const rawValue = source.slice(valueStart, cursor);
    rawAttributes.push({
      qualifiedName: attributeName,
      value: decodeXmlAttributeValue(rawValue, label),
      rawValue,
    });
    cursor++;
  }

  const hasNamespaceDeclaration = rawAttributes.some(
    (raw) =>
      raw.qualifiedName === 'xmlns' || raw.qualifiedName.startsWith('xmlns:'),
  );
  // Worksheet scanning invokes this for every c/v/f tag.  Namespace scopes are
  // immutable after creation, so ordinary descendants can safely share the
  // parent's map instead of allocating millions of identical Maps.
  let namespaces =
    parentNamespaces instanceof Map
      ? parentNamespaces
      : new Map<string, string>(parentNamespaces);
  if (hasNamespaceDeclaration || namespaces.get('xml') !== XML_NAMESPACE) {
    namespaces = new Map(parentNamespaces);
    namespaces.set('xml', XML_NAMESPACE);
  }
  for (const raw of rawAttributes) {
    if (
      (raw.qualifiedName === 'xmlns' ||
        raw.qualifiedName.startsWith('xmlns:')) &&
      raw.rawValue.includes('&')
    ) {
      throw new Error(`Excel ${label} XML 命名空间声明不得使用实体`);
    }
    if (raw.qualifiedName === 'xmlns') namespaces.set('', raw.value);
    else if (raw.qualifiedName.startsWith('xmlns:')) {
      const prefix = raw.qualifiedName.slice('xmlns:'.length);
      if (!prefix || prefix === 'xmlns')
        throw new Error(`Excel ${label} XML 命名空间声明无效`);
      namespaces.set(prefix, raw.value);
    }
  }

  const elementNamespace = elementName.prefix
    ? namespaces.get(elementName.prefix)
    : (namespaces.get('') ?? null);
  if (elementName.prefix && !elementNamespace) {
    throw new Error(
      `Excel ${label} XML 标签使用未声明前缀「${elementName.prefix}」`,
    );
  }
  const attributes: ParsedXmlAttribute[] = [];
  for (const raw of rawAttributes) {
    if (raw.qualifiedName === 'xmlns' || raw.qualifiedName.startsWith('xmlns:'))
      continue;
    const name = splitXmlName(raw.qualifiedName, label);
    // SheetJS parsexmltag canonicalises an unprefixed attribute at its first
    // underscore (`Target_x` -> `Target`, `r_x` -> `r`) and lets the alias
    // overwrite the genuine attribute.  XML namespaces are handled above and
    // are not ordinary attributes; no OOXML attribute consumed here needs an
    // underscore, so reject this ambiguous parser dialect fail-closed.
    if (name.localName.includes('_')) {
      throw new Error(
        `Excel ${label} XML 属性「${raw.qualifiedName}」含不允许的下划线别名`,
      );
    }
    const namespaceUri = name.prefix ? namespaces.get(name.prefix) : null;
    if (name.prefix && !namespaceUri) {
      throw new Error(
        `Excel ${label} XML 属性使用未声明前缀「${name.prefix}」`,
      );
    }
    attributes.push({
      localName: name.localName,
      namespaceUri: namespaceUri ?? null,
      value: raw.value,
      rawValue: raw.rawValue,
    });
  }

  return {
    element: {
      qualifiedName,
      localName: elementName.localName,
      namespaceUri: elementNamespace ?? null,
      attributes,
      children: [],
    },
    namespaces,
    selfClosing,
  };
}

function parseXmlDocument(xml: string, label: string): ParsedXmlElement {
  const stack: OpenXmlElement[] = [];
  let root: ParsedXmlElement | null = null;
  let cursor = 0;
  let elementCount = 0;
  let seenXmlDeclaration = false;
  while (cursor < xml.length) {
    const opening = xml.indexOf('<', cursor);
    const text = opening < 0 ? xml.slice(cursor) : xml.slice(cursor, opening);
    if (stack.length === 0 && text.trim() !== '') {
      throw new Error(`Excel ${label} XML 根元素外含非空白内容`);
    }
    if (opening < 0) break;
    if (xml.startsWith('<!--', opening)) {
      throw new Error(`Excel ${label} XML 不得包含注释`);
    }
    if (xml.startsWith('<![CDATA[', opening)) {
      throw new Error(`Excel ${label} XML 不得包含 CDATA`);
    }
    if (xml.startsWith('<?', opening)) {
      const closing = xml.indexOf('?>', opening + 2);
      if (closing < 0) throw new Error(`Excel ${label} XML 处理指令未完整`);
      const instruction = xml.slice(opening + 2, closing).trimStart();
      if (
        seenXmlDeclaration ||
        root !== null ||
        stack.length !== 0 ||
        !/^xml(?:\s|$)/.test(instruction)
      ) {
        throw new Error(`Excel ${label} XML 含不允许的处理指令`);
      }
      seenXmlDeclaration = true;
      cursor = closing + 2;
      continue;
    }
    if (xml.startsWith('<!', opening)) {
      // Metadata never needs a DTD.  Rejecting declarations also prevents custom
      // entities from changing relationship targets during parsing.
      throw new Error(`Excel ${label} XML 含不允许的声明`);
    }

    const tagEnd = findXmlTagEnd(xml, opening + 1, label);
    const tag = xml.slice(opening + 1, tagEnd);
    if (/^\s*\//.test(tag)) {
      const closingName = tag.replace(/^\s*\/\s*/, '').trim();
      splitXmlName(closingName, label);
      const current = stack.pop();
      if (!current || current.element.qualifiedName !== closingName) {
        throw new Error(`Excel ${label} XML 闭合标签「${closingName}」不匹配`);
      }
    } else {
      const parentNamespaces =
        stack[stack.length - 1]?.namespaces ?? new Map<string, string>();
      const parsed = parseXmlStartTag(tag, parentNamespaces, label);
      elementCount++;
      if (elementCount > 50_000)
        throw new Error(`Excel ${label} XML 元素数过多`);
      const parent = stack[stack.length - 1]?.element;
      if (parent) parent.children.push(parsed.element);
      else if (root) throw new Error(`Excel ${label} XML 含多个根元素`);
      else root = parsed.element;
      if (!parsed.selfClosing) {
        if (stack.length >= 128) throw new Error(`Excel ${label} XML 嵌套过深`);
        stack.push({ element: parsed.element, namespaces: parsed.namespaces });
      }
    }
    cursor = tagEnd + 1;
  }
  if (stack.length > 0) throw new Error(`Excel ${label} XML 标签未完整`);
  if (!root) throw new Error(`Excel ${label} XML 缺少根元素`);
  return root;
}

function attributes(
  element: ParsedXmlElement,
  localName: string,
  namespaceUri: string | null,
): ParsedXmlAttribute[] {
  return element.attributes.filter(
    (item) =>
      item.localName === localName && item.namespaceUri === namespaceUri,
  );
}

interface ParsedXmlPosition {
  element: ParsedXmlElement;
  parent: ParsedXmlElement | null;
}

function xmlPositions(root: ParsedXmlElement): ParsedXmlPosition[] {
  const positions: ParsedXmlPosition[] = [];
  const visit = (
    element: ParsedXmlElement,
    parent: ParsedXmlElement | null,
  ) => {
    positions.push({ element, parent });
    for (const child of element.children) visit(child, element);
  };
  visit(root, null);
  return positions;
}

/** SheetJS strips only an ASCII-word namespace prefix from workbook/content-
 * type tags.  Accepting a wider XML name here could make the guard choose a tag
 * that the production parser ignores. */
function isSheetJsNamespacedTag(
  element: ParsedXmlElement,
  localName: string,
): boolean {
  return (
    element.qualifiedName === localName ||
    new RegExp(`^[A-Za-z0-9_]+:${localName}$`).test(element.qualifiedName)
  );
}

function semanticAttributes(
  element: ParsedXmlElement,
  localName: string,
): ParsedXmlAttribute[] {
  const foldedName = localName.toLowerCase();
  return element.attributes.filter(
    (item) => item.localName.toLowerCase() === foldedName,
  );
}

function requiredAttribute(
  element: ParsedXmlElement,
  localName: string,
  namespaceUri: string | null,
  label: string,
): string {
  const semanticMatches = semanticAttributes(element, localName);
  const matches = attributes(element, localName, namespaceUri);
  if (
    semanticMatches.length !== 1 ||
    matches.length !== 1 ||
    matches[0].value === '' ||
    matches[0].rawValue.includes('&')
  ) {
    throw new Error(`Excel ${label}缺少或重复属性「${localName}」`);
  }
  return matches[0].value;
}

function optionalAttribute(
  element: ParsedXmlElement,
  localName: string,
  namespaceUri: string | null,
  label: string,
): string | null {
  const semanticMatches = semanticAttributes(element, localName);
  const matches = attributes(element, localName, namespaceUri);
  if (
    semanticMatches.length > 1 ||
    matches.length !== semanticMatches.length ||
    matches.some((item) => item.rawValue.includes('&'))
  )
    throw new Error(`Excel ${label}含重复属性「${localName}」`);
  return matches[0]?.value ?? null;
}

function decodePackagePathSegment(segment: string, label: string): string {
  // SheetJS looks ZIP names up literally and does not percent-decode relationship
  // targets.  Decoding here would let the guard scan a different, attacker-chosen
  // entry (for example %2D versus '-').
  if (segment.includes('%'))
    throw new Error(`Excel ${label}不得含 percent-escape`);
  if (segment === '..') throw new Error(`Excel ${label}尝试穿越包内目录`);
  if (segment === '.') throw new Error(`Excel ${label}不得含点段`);
  if (
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(`Excel ${label}路径不安全`);
  }
  return segment;
}

function normalizeRelationshipTarget(target: string): string {
  if (
    target === '' ||
    target.startsWith('/') ||
    target.startsWith('\\') ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(target) ||
    target.includes('?') ||
    target.includes('#') ||
    // The production SheetJS path builder removes the first literal `xl/`
    // substring before prepending `xl/`; reject that ambiguous non-standard form.
    target.includes('xl/')
  ) {
    throw new Error('Excel 首表 relationship target 不是安全的包内相对路径');
  }
  const normalized = ['xl'];
  for (const rawSegment of target.split('/')) {
    if (rawSegment === '')
      throw new Error('Excel 首表 relationship target 路径不安全');
    const segment = decodePackagePathSegment(
      rawSegment,
      '首表 relationship target',
    );
    normalized.push(segment);
  }
  if (normalized.length === 1)
    throw new Error('Excel 首表 relationship target 为空');
  return normalized.join('/');
}

function normalizeContentTypePartName(partName: string): string {
  if (
    !partName.startsWith('/') ||
    partName.startsWith('//') ||
    partName.includes('?') ||
    partName.includes('#') ||
    partName.includes('%')
  ) {
    throw new Error(
      'Excel [Content_Types].xml PartName 不是安全的包内绝对路径',
    );
  }
  const normalized: string[] = [];
  for (const rawSegment of partName.slice(1).split('/')) {
    if (rawSegment === '')
      throw new Error('Excel [Content_Types].xml PartName 路径不安全');
    const segment = decodePackagePathSegment(
      rawSegment,
      '[Content_Types].xml PartName',
    );
    normalized.push(segment);
  }
  if (normalized.length === 0)
    throw new Error('Excel [Content_Types].xml PartName 为空');
  return normalized.join('/');
}

async function readPackageMetadata(
  zip: JSZip,
  entriesByName: ReadonlyMap<string, XlsxArchiveEntryBudget>,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  checkImportCancelled(signal);
  const expected = entriesByName.get(name);
  const item = zip.files[name];
  if (!expected || !item || item.dir)
    throw new Error(`Excel 缺少必需内部部件「${name}」`);
  if (expected.uncompressedBytes > PACKAGE_METADATA_LIMIT_BYTES) {
    throw new Error(`Excel 内部元数据部件「${name}」过大`);
  }
  const bytes = await item.async('uint8array');
  checkImportCancelled(signal);
  if (bytes.byteLength !== expected.uncompressedBytes) {
    throw new Error(
      `Excel ZIP 条目「${name}」实际展开大小与中央目录声明不一致`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Excel 内部部件「${name}」不是有效 UTF-8 XML`);
  }
}

function worksheetRelationshipIds(workbookXml: string): string[] {
  const workbook = parseXmlDocument(workbookXml, 'workbook.xml');
  if (
    workbook.localName !== 'workbook' ||
    !isSheetJsNamespacedTag(workbook, 'workbook') ||
    !workbook.namespaceUri ||
    !SPREADSHEET_NAMESPACES.has(workbook.namespaceUri)
  ) {
    throw new Error('Excel workbook.xml 根元素或命名空间无效');
  }
  const positions = xmlPositions(workbook);
  const sheetsPositions = positions.filter(
    ({ element }) => element.localName.toLowerCase() === 'sheets',
  );
  if (
    sheetsPositions.length !== 1 ||
    sheetsPositions[0].parent !== workbook ||
    sheetsPositions[0].element.localName !== 'sheets' ||
    sheetsPositions[0].element.namespaceUri !== workbook.namespaceUri
  ) {
    throw new Error('Excel workbook.xml 缺少或重复 sheets 元素');
  }
  const sheetsContainer = sheetsPositions[0].element;
  const sheetPositions = positions.filter(
    ({ element }) => element.localName.toLowerCase() === 'sheet',
  );
  if (sheetPositions.length === 0)
    throw new Error('Excel workbook.xml 未声明工作表');

  const relationshipIds: string[] = [];
  for (const { element: sheet, parent } of sheetPositions) {
    // parse_wb_xml strips namespaces from every tag in document order, without
    // checking ancestry or namespace URI.  Anything that it could interpret as
    // a sheet must be the exact normative child we also interpret.
    if (
      sheet.localName !== 'sheet' ||
      !isSheetJsNamespacedTag(sheet, 'sheet') ||
      parent !== sheetsContainer ||
      sheet.namespaceUri !== workbook.namespaceUri
    ) {
      throw new Error('Excel workbook.xml 含可被解析为首表的非规范 sheet 结构');
    }
    const idCandidates = semanticAttributes(sheet, 'id');
    const relationshipId = idCandidates[0];
    if (
      idCandidates.length !== 1 ||
      relationshipId.localName !== 'id' ||
      !relationshipId.namespaceUri ||
      !OFFICE_RELATIONSHIPS_NAMESPACES.has(relationshipId.namespaceUri) ||
      relationshipId.value === '' ||
      relationshipId.rawValue.includes('&')
    ) {
      throw new Error(
        'Excel workbook.xml 工作表缺少、重复或含异常 relationship id',
      );
    }
    relationshipIds.push(relationshipId.value);
  }
  if (new Set(relationshipIds).size !== relationshipIds.length) {
    throw new Error('Excel workbook.xml 工作表使用重复 relationship id');
  }
  return relationshipIds;
}

interface WorkbookRelationship {
  type: string;
  target: string;
  targetMode: string | null;
}

function firstWorksheetTarget(
  workbookRelsXml: string,
  relationshipIds: readonly string[],
): string {
  const relationships = parseXmlDocument(workbookRelsXml, 'workbook.xml.rels');
  if (
    relationships.localName !== 'Relationships' ||
    relationships.qualifiedName !== 'Relationships' ||
    !relationships.namespaceUri ||
    !PACKAGE_RELATIONSHIPS_NAMESPACES.has(relationships.namespaceUri)
  ) {
    throw new Error('Excel workbook.xml.rels 根元素或命名空间无效');
  }
  const relationshipPositions = xmlPositions(relationships).filter(
    ({ element }) => element.localName.toLowerCase() === 'relationship',
  );
  const byId = new Map<string, WorkbookRelationship>();
  for (const { element: relationship, parent } of relationshipPositions) {
    // parse_rels recognises only the literal unprefixed `<Relationship` token,
    // but does so at any nesting depth and irrespective of namespace.  Restrict
    // the document to one unambiguous representation.
    if (
      relationship.localName !== 'Relationship' ||
      relationship.qualifiedName !== 'Relationship' ||
      parent !== relationships ||
      relationship.namespaceUri !== relationships.namespaceUri
    ) {
      throw new Error('Excel workbook.xml.rels 含非规范 Relationship 结构');
    }
    const id = requiredAttribute(
      relationship,
      'Id',
      null,
      'workbook relationship ',
    );
    if (byId.has(id))
      throw new Error(
        `Excel workbook.xml.rels 含重复 relationship Id「${id}」`,
      );
    byId.set(id, {
      type: requiredAttribute(
        relationship,
        'Type',
        null,
        'workbook relationship ',
      ),
      target: requiredAttribute(
        relationship,
        'Target',
        null,
        'workbook relationship ',
      ),
      targetMode: optionalAttribute(
        relationship,
        'TargetMode',
        null,
        'workbook relationship ',
      ),
    });
  }

  const selectedRelationships = relationshipIds.map((relationshipId) => {
    const selected = byId.get(relationshipId);
    if (!selected) {
      throw new Error(
        `Excel workbook.xml.rels 缺少工作表 relationship「${relationshipId}」`,
      );
    }
    if (selected.targetMode !== null && selected.targetMode !== 'Internal') {
      throw new Error(
        'Excel 工作表 relationship 为外部或无效 TargetMode，已拒绝导入',
      );
    }
    return {
      type: selected.type,
      target: normalizeRelationshipTarget(selected.target),
    };
  });
  const first = selectedRelationships[0];
  if (!first || !WORKSHEET_RELATIONSHIP_TYPES.has(first.type))
    throw new Error('Excel 首表 relationship Type 不是 worksheet');
  return first.target;
}

function assertWorksheetContentType(
  contentTypesXml: string,
  worksheetEntryName: string,
): void {
  const types = parseXmlDocument(contentTypesXml, '[Content_Types].xml');
  if (
    types.localName !== 'Types' ||
    !isSheetJsNamespacedTag(types, 'Types') ||
    types.namespaceUri !== CONTENT_TYPES_NAMESPACE
  ) {
    throw new Error('Excel [Content_Types].xml 根元素或命名空间无效');
  }
  const typedPositions = xmlPositions(types).filter(({ element }) => {
    const localName = element.localName.toLowerCase();
    return localName === 'override' || localName === 'default';
  });
  const overrides = new Map<string, string>();
  const defaults = new Map<string, string>();
  const workbookParts: string[] = [];
  for (const { element: child, parent } of typedPositions) {
    if (
      parent !== types ||
      child.namespaceUri !== CONTENT_TYPES_NAMESPACE ||
      !isSheetJsNamespacedTag(child, child.localName) ||
      (child.localName !== 'Override' && child.localName !== 'Default')
    ) {
      throw new Error(
        'Excel [Content_Types].xml 含可被 SheetJS 识别的非规范类型声明',
      );
    }
    if (child.localName === 'Override') {
      const partName = normalizeContentTypePartName(
        requiredAttribute(child, 'PartName', null, 'content type Override '),
      );
      const contentType = requiredAttribute(
        child,
        'ContentType',
        null,
        'content type Override ',
      );
      const foldedPartName = partName.toLowerCase();
      if (overrides.has(foldedPartName))
        throw new Error(
          `Excel [Content_Types].xml 含重复 Override「/${partName}」`,
        );
      overrides.set(foldedPartName, contentType);
      if (SHEETJS_WORKBOOK_CONTENT_TYPES.has(contentType)) {
        workbookParts.push(foldedPartName);
      }
    } else if (child.localName === 'Default') {
      const extension = requiredAttribute(
        child,
        'Extension',
        null,
        'content type Default ',
      ).toLowerCase();
      const contentType = requiredAttribute(
        child,
        'ContentType',
        null,
        'content type Default ',
      );
      if (defaults.has(extension))
        throw new Error(
          `Excel [Content_Types].xml 含重复 Default「${extension}」`,
        );
      defaults.set(extension, contentType);
    }
  }
  if (
    workbookParts.length !== 1 ||
    workbookParts[0] !== 'xl/workbook.xml' ||
    overrides.get('xl/workbook.xml') !== WORKBOOK_CONTENT_TYPE
  ) {
    throw new Error(
      'Excel [Content_Types].xml 必须唯一指定标准 /xl/workbook.xml 工作簿部件',
    );
  }
  const filename = worksheetEntryName.slice(
    worksheetEntryName.lastIndexOf('/') + 1,
  );
  const dot = filename.lastIndexOf('.');
  const extension =
    dot >= 0 && dot < filename.length - 1
      ? filename.slice(dot + 1).toLowerCase()
      : null;
  const contentType =
    overrides.get(worksheetEntryName.toLowerCase()) ??
    (extension ? defaults.get(extension) : undefined);
  if (contentType !== WORKSHEET_CONTENT_TYPE) {
    throw new Error(
      `Excel 首表部件「${worksheetEntryName}」缺少有效 worksheet content type`,
    );
  }
}

async function resolveFirstWorksheetEntry(
  zip: JSZip,
  entriesByName: ReadonlyMap<string, XlsxArchiveEntryBudget>,
  signal?: AbortSignal,
): Promise<string> {
  // 元数据有独立的小容量上限；串行等待使取消后不会遗留其他未结束的读取。
  const workbookXml = await readPackageMetadata(zip, entriesByName, 'xl/workbook.xml', signal);
  const workbookRelsXml = await readPackageMetadata(zip, entriesByName, 'xl/_rels/workbook.xml.rels', signal);
  const contentTypesXml = await readPackageMetadata(zip, entriesByName, '[Content_Types].xml', signal);
  checkImportCancelled(signal);
  const relationshipIds = worksheetRelationshipIds(workbookXml);
  const worksheetEntryName = firstWorksheetTarget(
    workbookRelsXml,
    relationshipIds,
  );
  const worksheetEntry = zip.files[worksheetEntryName];
  if (
    !entriesByName.has(worksheetEntryName) ||
    !worksheetEntry ||
    worksheetEntry.dir
  ) {
    throw new Error(
      `Excel 首表 relationship 指向缺失部件「${worksheetEntryName}」`,
    );
  }
  assertWorksheetContentType(contentTypesXml, worksheetEntryName);
  return worksheetEntryName;
}

function columnNumber(letters: string): number {
  let value = 0;
  for (const raw of letters.toUpperCase()) {
    const code = raw.charCodeAt(0) - 64;
    if (code < 1 || code > 26) return Number.NaN;
    value = value * 26 + code;
  }
  return value;
}

function cellAddress(address: string): { row: number; column: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(address.trim());
  if (!match) return null;
  const row = Number(match[2]);
  const column = columnNumber(match[1]);
  return Number.isSafeInteger(row) &&
    row >= 1 &&
    Number.isSafeInteger(column) &&
    column >= 1
    ? { row, column }
    : null;
}

interface WorksheetOpenElement {
  qualifiedName: string;
  localName: string;
  namespaceUri: string | null;
  namespaces: Map<string, string>;
}

/**
 * Streaming worksheet-XML budget gate.  It deliberately counts the real row
 * and cell elements and their addresses; `<dimension>` is only an additional
 * early hint and can never make a forged, undersized range pass.
 */
class WorksheetXmlBudgetScanner {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private insideTag = false;
  private tag = '';
  private quote = '';
  private seenRoot = false;
  private finishedRoot = false;
  private seenXmlDeclaration = false;
  private sheetDataCount = 0;
  private readonly stack: WorksheetOpenElement[] = [];
  private rows = 0;
  private cells = 0;

  constructor(private readonly entryName: string) {}

  push(chunk: Uint8Array): void {
    this.scan(this.decoder.decode(chunk, { stream: true }));
  }

  finish(): void {
    this.scan(this.decoder.decode());
    if (this.insideTag)
      throw new Error(`Excel 内部工作表「${this.entryName}」 XML 标签未完整`);
    if (
      !this.seenRoot ||
      !this.finishedRoot ||
      this.stack.length !== 0 ||
      this.sheetDataCount !== 1
    ) {
      throw new Error(`Excel 内部工作表「${this.entryName}」 XML 结构无效`);
    }
  }

  private scan(text: string): void {
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (!this.insideTag) {
        if (char === '<') {
          this.insideTag = true;
          this.tag = '<';
          this.quote = '';
        } else if (this.stack.length === 0 && !/\s/.test(char)) {
          throw new Error(
            `Excel 内部工作表「${this.entryName}」 XML 根元素外含非空白内容`,
          );
        }
        continue;
      }
      if (this.quote) {
        this.tag += char;
        if (char === this.quote) this.quote = '';
        if (this.tag.length > 65_536) {
          throw new Error(
            `Excel 内部工作表「${this.entryName}」含超长 XML 标签`,
          );
        }
        continue;
      }
      if (char === '"' || char === "'") {
        this.quote = char;
        this.tag += char;
        continue;
      }
      if (char === '<')
        throw new Error(
          `Excel 内部工作表「${this.entryName}」 XML 标签结构无效`,
        );
      this.tag += char;
      if (this.tag.length > 65_536) {
        throw new Error(`Excel 内部工作表「${this.entryName}」含超长 XML 标签`);
      }
      if (char === '>') {
        this.inspectTag(this.tag);
        this.insideTag = false;
        this.tag = '';
      }
    }
  }

  private inspectTag(tag: string): void {
    if (/^<\?xml(?:\s|\?)/.test(tag)) {
      if (this.seenXmlDeclaration || this.seenRoot || this.stack.length !== 0) {
        throw new Error(
          `Excel 内部工作表「${this.entryName}」 XML 声明位置无效`,
        );
      }
      this.seenXmlDeclaration = true;
      return;
    }
    if (/^<\s*[!?]/.test(tag)) {
      throw new Error(
        `Excel 内部工作表「${this.entryName}」 XML 不得包含注释、CDATA 或处理指令`,
      );
    }
    if (/^<\s*\//.test(tag)) {
      const closingName = tag
        .replace(/^<\s*\/\s*/, '')
        .replace(/>\s*$/, '')
        .trim();
      splitXmlName(closingName, `内部工作表「${this.entryName}」`);
      const current = this.stack.pop();
      if (!current || current.qualifiedName !== closingName) {
        throw new Error(
          `Excel 内部工作表「${this.entryName}」 XML 闭合标签不匹配`,
        );
      }
      if (this.stack.length === 0) this.finishedRoot = true;
      return;
    }

    const parentNamespaces =
      this.stack[this.stack.length - 1]?.namespaces ??
      new Map<string, string>();
    const parsed = parseXmlStartTag(
      tag.slice(1, -1),
      parentNamespaces,
      `内部工作表「${this.entryName}」`,
    );
    const element = parsed.element;
    const parent = this.stack[this.stack.length - 1];
    if (!this.seenRoot) {
      if (
        element.localName !== 'worksheet' ||
        !element.namespaceUri ||
        !SPREADSHEET_NAMESPACES.has(element.namespaceUri)
      ) {
        throw new Error(`Excel 内部工作表「${this.entryName}」根元素无效`);
      }
      this.seenRoot = true;
    } else if (!parent || this.finishedRoot) {
      throw new Error(`Excel 内部工作表「${this.entryName}」 XML 含多个根元素`);
    }

    const kind = element.localName.toLowerCase();
    if (kind === 'sheetdata') {
      if (
        element.localName !== 'sheetData' ||
        !element.namespaceUri ||
        !SPREADSHEET_NAMESPACES.has(element.namespaceUri) ||
        parent?.localName !== 'worksheet' ||
        parent.namespaceUri !== element.namespaceUri
      ) {
        throw new Error(
          `Excel 内部工作表「${this.entryName}」含非规范 sheetData`,
        );
      }
      this.sheetDataCount++;
      if (this.sheetDataCount > 1) {
        throw new Error(
          `Excel 内部工作表「${this.entryName}」含重复 sheetData`,
        );
      }
    } else if (kind === 'dimension') {
      if (
        element.localName !== 'dimension' ||
        !element.namespaceUri ||
        !SPREADSHEET_NAMESPACES.has(element.namespaceUri) ||
        parent?.localName !== 'worksheet' ||
        parent.namespaceUri !== element.namespaceUri
      ) {
        throw new Error(
          `Excel 内部工作表「${this.entryName}」含非规范 dimension`,
        );
      }
      this.inspectDimension(element);
    } else if (kind === 'row') {
      this.inspectRow(element, parent);
    } else if (kind === 'c') {
      this.inspectCell(element, parent);
    }

    if (!parsed.selfClosing) {
      if (this.stack.length >= 256) {
        throw new Error(`Excel 内部工作表「${this.entryName}」 XML 嵌套过深`);
      }
      this.stack.push({
        qualifiedName: element.qualifiedName,
        localName: element.localName,
        namespaceUri: element.namespaceUri,
        namespaces: parsed.namespaces,
      });
    } else if (!parent) {
      this.finishedRoot = true;
    }
  }

  private inspectDimension(element: ParsedXmlElement): void {
    const ref = requiredAttribute(element, 'ref', null, '工作表 dimension ');
    const endpoints = ref.split(':');
    if (endpoints.length > 2) {
      throw new Error(
        `Excel 内部工作表「${this.entryName}」 dimension 范围无效`,
      );
    }
    const start = cellAddress(endpoints[0]);
    const end = cellAddress(endpoints[endpoints.length - 1]);
    if (!start || !end) {
      throw new Error(
        `Excel 内部工作表「${this.entryName}」 dimension 地址无效`,
      );
    }
    this.assertAddress(
      Math.max(start.row, end.row),
      Math.max(start.column, end.column),
    );
  }

  private inspectRow(
    element: ParsedXmlElement,
    parent: WorksheetOpenElement | undefined,
  ): void {
    if (
      element.localName !== 'row' ||
      !element.namespaceUri ||
      !SPREADSHEET_NAMESPACES.has(element.namespaceUri) ||
      parent?.localName !== 'sheetData' ||
      parent.namespaceUri !== element.namespaceUri
    ) {
      throw new Error(`Excel 内部工作表「${this.entryName}」含非规范 row`);
    }
    const rowText = requiredAttribute(element, 'r', null, '工作表 row ');
    if (!/^\d+$/.test(rowText)) {
      throw new Error(`Excel 内部工作表「${this.entryName}」 row 地址无效`);
    }
    const row = Number(rowText);
    if (!Number.isSafeInteger(row) || row < 1) {
      throw new Error(`Excel 内部工作表「${this.entryName}」 row 地址无效`);
    }
    this.rows++;
    if (this.rows > XLSX_WORKSHEET_LIMITS.rows) {
      throw new Error(
        `Excel 内部工作表「${this.entryName}」实际行数超过 ${XLSX_WORKSHEET_LIMITS.rows} 行导入上限`,
      );
    }
    this.assertAddress(row, 1);
  }

  private inspectCell(
    element: ParsedXmlElement,
    parent: WorksheetOpenElement | undefined,
  ): void {
    if (
      element.localName !== 'c' ||
      !element.namespaceUri ||
      !SPREADSHEET_NAMESPACES.has(element.namespaceUri) ||
      parent?.localName !== 'row' ||
      parent.namespaceUri !== element.namespaceUri
    ) {
      throw new Error(
        `Excel 内部工作表「${this.entryName}」含非规范 cell 结构`,
      );
    }
    const ref = requiredAttribute(element, 'r', null, '工作表 cell ');
    const address = cellAddress(ref);
    if (!address) {
      throw new Error(`Excel 内部工作表「${this.entryName}」 cell 地址无效`);
    }
    this.cells++;
    if (this.cells > XLSX_WORKSHEET_LIMITS.cells) {
      throw new Error(
        `Excel 内部工作表「${this.entryName}」实际单元格数超过 ${XLSX_WORKSHEET_LIMITS.cells} 个导入上限`,
      );
    }
    this.assertAddress(address.row, address.column);
  }

  private assertAddress(row: number, column: number): void {
    if (row > XLSX_WORKSHEET_LIMITS.rows) {
      throw new Error(
        `Excel 内部工作表「${this.entryName}」实际包含第 ${row} 行，超过 ${XLSX_WORKSHEET_LIMITS.rows} 行导入上限`,
      );
    }
    if (column > XLSX_WORKSHEET_LIMITS.columns) {
      throw new Error(
        `Excel 内部工作表「${this.entryName}」实际包含第 ${column} 列，超过 ${XLSX_WORKSHEET_LIMITS.columns} 列导入上限`,
      );
    }
  }
}

/**
 * 中央目录只能证明“声明的”展开边界。本步骤在 SheetJS 前逐项实际解压，分块核对
 * 实际字节数与 CRC；不拼接条目内容，并定期让出事件循环，避免校验本身形成长任务。
 */
export async function verifyXlsxArchiveContents(
  bytes: Uint8Array,
  entries: readonly XlsxArchiveEntryBudget[],
  signal?: AbortSignal,
): Promise<void> {
  checkImportCancelled(signal);
  await yieldToMainThread();
  checkImportCancelled(signal);
  const zip = await JSZip.loadAsync(bytes, {
    checkCRC32: false,
    createFolders: false,
  });
  checkImportCancelled(signal);
  const loadedNames = Object.keys(zip.files);
  if (loadedNames.length !== entries.length) {
    throw new Error('Excel ZIP 实际条目数与中央目录声明不一致');
  }
  const sheetJsLookupNames = new Map<string, string>();
  for (const name of loadedNames) {
    const foldedName = name.toLowerCase();
    const previous = sheetJsLookupNames.get(foldedName);
    if (previous && previous !== name) {
      throw new Error(
        `Excel ZIP 条目「${previous}」与「${name}」在 SheetJS 查找中大小写冲突`,
      );
    }
    sheetJsLookupNames.set(foldedName, name);
  }
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
  const firstWorksheetEntryName = await resolveFirstWorksheetEntry(
    zip,
    entriesByName,
    signal,
  );
  checkImportCancelled(signal);

  let actualTotal = 0;
  for (const [index, expected] of entries.entries()) {
    checkImportCancelled(signal);
    const item = zip.files[expected.name] as StreamingZipObject | undefined;
    if (!item)
      throw new Error(
        `Excel ZIP 第 ${index + 1} 个条目「${expected.name}」无法读取`,
      );

    // 导入契约只读 workbook.xml 声明的首表。关系解析得到的部件可以
    // 是自定义路径，也可以合法地没有 .xml 扩展名；其他工作表仍会执行
    // 实际展开量、CRC 与累计字节校验，但不应套用首表行列契约。
    const worksheetScanner =
      expected.name === firstWorksheetEntryName
        ? new WorksheetXmlBudgetScanner(expected.name)
        : null;

    await new Promise<void>((resolve, reject) => {
      const stream = item.internalStream('uint8array');
      let actual = 0;
      let crc = 0xffffffff;
      let nextYieldAt = 1024 * 1024;
      let settled = false;
      let resumeTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanUp = () => {
        signal?.removeEventListener('abort', onAbort);
        if (resumeTimer !== undefined) clearTimeout(resumeTimer);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        stream.pause();
        cleanUp();
        reject(error);
      };
      const onAbort = () => fail(new DOMException('已取消 Excel 导入', 'AbortError'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }

      stream.on('data', (chunk) => {
        if (settled) return;
        actual += chunk.byteLength;
        actualTotal += chunk.byteLength;
        if (actual > expected.uncompressedBytes) {
          fail(
            new Error(
              `Excel ZIP 条目「${expected.name}」实际展开大小超过中央目录声明`,
            ),
          );
          return;
        }
        if (actual > MAX_XLSX_ENTRY_BYTES) {
          fail(
            new Error(
              `Excel ZIP 条目「${expected.name}」实际展开大小超过单项上限`,
            ),
          );
          return;
        }
        if (actualTotal > MAX_XLSX_TOTAL_BYTES) {
          fail(new Error('Excel ZIP 实际展开累计大小超过总量上限'));
          return;
        }
        crc = updateCrc32(crc, chunk);
        try {
          worksheetScanner?.push(chunk);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (actual >= nextYieldAt) {
          nextYieldAt = actual + 1024 * 1024;
          stream.pause();
          resumeTimer = setTimeout(() => {
            if (!settled) stream.resume();
          }, 0);
        }
      });
      stream.on('error', (error) =>
        fail(
          new Error(
            `Excel ZIP 条目「${expected.name}」解压失败：${errText(error)}`,
          ),
        ),
      );
      stream.on('end', () => {
        if (settled) return;
        try {
          worksheetScanner?.finish();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const actualCrc = (crc ^ 0xffffffff) >>> 0;
        if (actual !== expected.uncompressedBytes) {
          fail(
            new Error(
              `Excel ZIP 条目「${expected.name}」实际展开大小与中央目录声明不一致`,
            ),
          );
          return;
        }
        if (actualCrc !== expected.crc32) {
          fail(
            new Error(
              `Excel ZIP 条目「${expected.name}」实际内容 CRC 与中央目录不一致`,
            ),
          );
          return;
        }
        settled = true;
        cleanUp();
        resolve();
      });
      stream.resume();
    });
  }
}

export function worksheetLimitError(
  sheet: XLSX.WorkSheet,
  sheetName: string,
): string | null {
  // sheetRows 发生截断时 SheetJS 把原始范围保存在 !fullref，必须用它判定“过大”，
  // 否则会把前 200001 行误当成完整工作表。
  const ref = sheet['!fullref'] ?? sheet['!ref'];
  if (!ref) return null;

  let range: XLSX.Range;
  try {
    range = XLSX.utils.decode_range(ref);
  } catch {
    return `工作表「${sheetName}」的数据范围无效`;
  }
  const rows = range.e.r - range.s.r + 1;
  const columns = range.e.c - range.s.c + 1;
  if (rows > XLSX_WORKSHEET_LIMITS.rows) {
    return `工作表「${sheetName}」共 ${rows} 行，超过 ${XLSX_WORKSHEET_LIMITS.rows} 行导入上限`;
  }
  if (columns > XLSX_WORKSHEET_LIMITS.columns) {
    return `工作表「${sheetName}」共 ${columns} 列，超过 ${XLSX_WORKSHEET_LIMITS.columns} 列导入上限`;
  }
  const cells = rows * columns;
  if (cells > XLSX_WORKSHEET_LIMITS.cells) {
    return `工作表「${sheetName}」的数据范围共 ${cells} 个单元格，超过 ${XLSX_WORKSHEET_LIMITS.cells} 个导入上限`;
  }

  // 不用 Object.entries，避免在大表上再分配一份庞大的键值数组。
  let textCharacters = 0;
  for (const address in sheet) {
    if (
      !Object.prototype.hasOwnProperty.call(sheet, address) ||
      address.startsWith('!')
    )
      continue;
    const value = (sheet[address] as XLSX.CellObject).v;
    if (
      typeof value === 'string' &&
      value.length > XLSX_WORKSHEET_LIMITS.stringLength
    ) {
      return `工作表「${sheetName}」单元格 ${address} 的文本长度超过 ${XLSX_WORKSHEET_LIMITS.stringLength} 字符上限`;
    }
    if (typeof value === 'string') {
      textCharacters += value.length;
      if (textCharacters > XLSX_WORKSHEET_LIMITS.textCharacters) {
        return `工作表「${sheetName}」文本内容超过 ${XLSX_WORKSHEET_LIMITS.textCharacters} 字符累计上限`;
      }
    }
  }
  return null;
}

export async function xlsxBytesToCsv(
  bytes: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<{ csv: string; sheetName: string } | { error: string }> {
  const previous = excelImportTail;
  let release!: () => void;
  excelImportTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await parseExcelBytes(bytes, options.signal);
  } finally {
    release();
  }
}

async function parseExcelBytes(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ csv: string; sheetName: string } | { error: string }> {
  try {
    checkImportCancelled(signal);
    assertXlsxImportSize(bytes.byteLength);
    const container = detectExcelContainer(bytes);
    if (!container)
      throw new Error(
        'Excel 文件格式无法识别（仅支持 OOXML .xlsx 或 BIFF8 .xls）',
      );
    if (container === 'ooxml-zip') {
      // 蜂群 P2-04:**解压前**按 ZIP 中央目录做规模预检——70 KB 的高压缩 xlsx 可展开出
      // 2620 万字符,后置限制生效前 RSS 已涨 130 MiB。BIFF8/OLE 不是 ZIP，分流后交给 SheetJS。
      const entries = assertXlsxArchiveBudget(bytes);
      await verifyXlsxArchiveContents(bytes, entries, signal);
    } else if (bytes.byteLength > MAX_BIFF8_IMPORT_BYTES) {
      throw new Error(
        `旧版 .xls 文件超过 ${MAX_BIFF8_IMPORT_BYTES / 1024 / 1024} MB 安全导入上限；请先另存为 .xlsx`,
      );
    }
  } catch (error) {
    if (signal?.aborted) return { error: '已取消 Excel 导入' };
    return { error: errText(error) };
  }
  try {
    checkImportCancelled(signal);
    // 只读首个工作表，并多读 1 行作为超限哨兵；检测到哨兵后整表拒绝，不静默截断。
    const wb = XLSX.read(bytes, {
      type: 'array',
      sheets: 0,
      sheetRows: XLSX_WORKSHEET_LIMITS.rows + 1,
      // 保住日期语义:配合 sheet_to_csv 的 rawNumbers,数字取原始值、日期仍出日期文本
      cellDates: true,
    });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { error: '工作簿为空' };
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return { error: `无法读取工作表「${sheetName}」` };
    const limitError = worksheetLimitError(sheet, sheetName);
    if (limitError) return { error: limitError };
    // 第三轮 P3:按原始数值而非「显示格式文本」导出——千分位格式(#,##0)曾把整列
    // 静默降成文本列、超 11 位有效数字被格式截断;cellDates 已在读入层保住日期语义
    const csv = XLSX.utils.sheet_to_csv(sheet, { rawNumbers: true });
    if (csv.trim() === '') return { error: `工作表「${sheetName}」没有数据` };
    return { csv, sheetName };
  } catch (e) {
    if (signal?.aborted) return { error: '已取消 Excel 导入' };
    return { error: '工作簿解析失败：' + errText(e) };
  }
}
