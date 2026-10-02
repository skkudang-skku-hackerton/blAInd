import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { unzipSync, zipSync } from 'fflate';
import type { TextSegment } from '../../../core/api/types';
import type { SegmentMasks } from '../shared/types';
import type { DocxLimits, OpenDocx } from './types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
type XmlElement = Element & { localName: string };
type XmlDocument = Document & { documentElement: XmlElement };
type XmlNode = Node;
type Piece = { element: XmlElement; start: number; end: number; text: string; kind: 'text' | 'tab' | 'break' };
type Paragraph = { id: string; text: string; pieces: Piece[] };
type Entry = { name: string; size: number; compressed: number; crc: number; method: number; offset: number; flags: number };

function fail(message: string): never { throw new Error(`DOCX: ${message}`); }
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('DOCX operation cancelled', 'AbortError');
}
function elements(node: NonNullable<XmlNode>): XmlElement[] {
  const result: XmlElement[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child as XmlElement);
  }
  return result;
}
function walk(node: XmlElement, visit: (element: XmlElement) => void): void {
  // Iteration also bounds our own stack use for attacker-controlled XML nesting.
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    visit(current);
    const children = elements(current);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
}

/** Validate central AND local headers before fflate can allocate decompressed data.
 * ZIP64, split archives, encryption, noncanonical paths, prepended/trailing data,
 * and overlapping entries are intentionally outside this engine's subset.
 */
function inspectZip(bytes: Uint8Array, limits: DocxLimits): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) fail('invalid ZIP end record');
  const count = u16(end + 10), centralSize = u32(end + 12), centralOffset = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || count === 0xffff ||
      centralOffset === 0xffffffff || centralSize === 0xffffffff || centralOffset + centralSize !== end) {
    fail('split, ZIP64 or malformed ZIP archive');
  }
  if (!count || count > limits.maxEntries) fail('ZIP entry limit exceeded');
  const entries: Entry[] = [], names = new Set<string>();
  let at = centralOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) fail('invalid central directory');
    const flags = u16(at + 8), method = u16(at + 10), compressed = u32(at + 20), size = u32(at + 24);
    const nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end || u16(at + 34) || (flags & ~0x080e) || (method !== 0 && method !== 8)) fail('unsupported ZIP entry');
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // ASCII package names avoid Unicode, URI-encoding and case aliases between ZIP and OPC consumers.
    if (!/^[A-Za-z0-9_\-.[\]/]+$/.test(name) || name.startsWith('/') || name.endsWith('/') ||
        name.split('/').some(part => !part || part === '.' || part === '..') || names.has(name.toLowerCase())) {
      fail('duplicate or unsafe ZIP entry path');
    }
    names.add(name.toLowerCase());
    total += size;
    if (size === 0xffffffff || compressed === 0xffffffff || total > limits.maxUncompressedBytes) fail('expanded ZIP size limit exceeded');
    entries.push({ name, size, compressed, crc: u32(at + 16), method, flags, offset: u32(at + 42) });
    at = next;
  }
  if (at !== end) fail('unexpected central directory data');
  let localEnd = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    const start = entry.offset;
    if (start !== localEnd || start + 30 > centralOffset || u32(start) !== 0x04034b50) fail('overlapping or invalid ZIP entry');
    const nameLength = u16(start + 26), extraLength = u16(start + 28);
    const data = start + 30 + nameLength + extraLength;
    if (data + entry.compressed > centralOffset || u16(start + 6) !== entry.flags || u16(start + 8) !== entry.method ||
        decoder.decode(bytes.subarray(start + 30, start + 30 + nameLength)) !== entry.name) fail('inconsistent ZIP headers');
    if (!(entry.flags & 8) && (u32(start + 14) !== entry.crc || u32(start + 18) !== entry.compressed || u32(start + 22) !== entry.size)) {
      fail('inconsistent ZIP sizes');
    }
    localEnd = data + entry.compressed;
    if (entry.flags & 8) {
      if (localEnd + 12 > centralOffset) fail('missing ZIP data descriptor');
      if (u32(localEnd) === 0x08074b50) localEnd += 4;
      if (localEnd + 12 > centralOffset || u32(localEnd) !== entry.crc || u32(localEnd + 4) !== entry.compressed || u32(localEnd + 8) !== entry.size) {
        fail('invalid ZIP data descriptor');
      }
      localEnd += 12;
    }
  }
  if (localEnd !== centralOffset) fail('unexpected ZIP local data');
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]!;
  return (value ^ 0xffffffff) >>> 0;
}

function parse(bytes: Uint8Array, name: string): XmlDocument {
  const text = decoder.decode(bytes);
  // xmldom does not fetch external resources; reject declarations rather than relying on that behavior.
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text) || /<\?xml[^?]*encoding\s*=\s*['"](?!utf-8['"])/i.test(text)) fail(`unsupported XML declaration in ${name}`);
  let bad = false;
  const document = new DOMParser({ onError: () => { bad = true; } }).parseFromString(text, 'application/xml');
  if (bad || !document.documentElement || elements(document).length !== 1) fail(`malformed XML in ${name}`);
  const stack: Array<{ node: NonNullable<XmlNode>; depth: number }> = [{ node: document, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > 128) fail('XML nesting limit exceeded');
    for (let child = node.firstChild; child;) {
      const next = child.nextSibling;
      // Comments and processing instructions can themselves contain unreviewed personal data.
      if (child.nodeType === 7 || child.nodeType === 8) node.removeChild(child);
      else if (child.nodeType === 1) stack.push({ node: child, depth: depth + 1 });
      else if (child.nodeType !== 3 && child.nodeType !== 4) fail(`unsupported XML node in ${name}`);
      child = next;
    }
  }
  return document as XmlDocument;
}

const storyPath = /^word\/(?:document|header[0-9]+|footer[0-9]+|footnotes|endnotes)\.xml$/;
const auxiliaryPath = /^word\/(?:styles|numbering|theme\/theme[0-9]+)\.xml$/;
const discardPath = /^(?:docProps\/(?:core|app|custom)\.xml|word\/(?:comments|commentsExtended|commentsIds|people|settings|webSettings|fontTable)\.xml)$/;
function relationshipSource(name: string): string | undefined {
  if (name === '_rels/.rels') return '';
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(name);
  return match ? `${match[1]}/${match[2]}` : undefined;
}
function resolveTarget(source: string, target: string): string {
  if (!target || /[\\%?#:\s]/.test(target)) fail('unsupported relationship target');
  const path = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const part of target.replace(/^\//, '').split('/')) {
    if (part === '..') { if (!path.length) fail('relationship escapes package'); path.pop(); }
    else if (part !== '.') { if (!part) fail('invalid relationship path'); path.push(part); }
  }
  return path.join('/');
}
const relationshipParts: Record<string, RegExp> = {
  officeDocument: /^word\/document\.xml$/,
  header: /^word\/header[0-9]+\.xml$/, footer: /^word\/footer[0-9]+\.xml$/,
  footnotes: /^word\/footnotes\.xml$/, endnotes: /^word\/endnotes\.xml$/,
  styles: /^word\/styles\.xml$/, numbering: /^word\/numbering\.xml$/,
  theme: /^word\/theme\/theme[0-9]+\.xml$/,
};
const discardedRelationships = new Set([
  `${REL}/metadata/core-properties`, `${R}/extended-properties`, `${R}/custom-properties`,
  ...['comments', 'settings', 'webSettings', 'fontTable'].map(name => `${R}/${name}`),
  'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
  'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds',
  'http://schemas.microsoft.com/office/2011/relationships/people',
]);

// Closed vocabulary: images, VML/text boxes, embedded objects, fields, tracked
// changes, content controls/custom XML, math and extension/AlternateContent are
// rejected. They can carry visible or hidden PII outside the reviewed w:t stream.
const wordElements = new Set(`document body hdr ftr footnotes footnote endnotes endnote
  p pPr r rPr t tab br cr lastRenderedPageBreak noBreakHyphen softHyphen
  tbl tblPr tblGrid gridCol tr trPr tc tcPr
  pStyle keepNext keepLines pageBreakBefore widowControl numPr ilvl numId suppressLineNumbers
  pBdr top left bottom right between bar shd tabs spacing ind contextualSpacing mirrorIndents
  suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN
  bidi adjustRightInd snapToGrid jc textDirection textAlignment outlineLvl divId cnfStyle
  rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint
  noProof vanish webHidden color sz szCs highlight u effect bdr fitText vertAlign rtl cs em lang
  eastAsianLayout specVanish oMath kern position w
  tblStyle tblpPr tblOverlap bidiVisual tblStyleRowBandSize tblStyleColBandSize tblW tblCellSpacing
  tblInd tblBorders insideH insideV start end tblLayout tblCellMar tblLook tblCaption tblDescription
  gridBefore gridAfter wBefore wAfter cantSplit trHeight tblHeader hidden
  tcW gridSpan hMerge vMerge tcBorders noWrap tcMar textDirection tcFitText vAlign hideMark
  sectPr headerReference footerReference footnotePr endnotePr type pgSz pgMar paperSrc pgBorders
  lnNumType pgNumType cols col formProt vAlign noEndnote titlePg textDirection bidi rtlGutter
  docGrid printerSettings numFmt numStart numRestart pos
  footnoteReference endnoteReference footnoteRef endnoteRef separator continuationSeparator continuationNotice
  styles docDefaults rPrDefault pPrDefault latentStyles lsdException style name aliases basedOn next link
  autoRedefine qFormat uiPriority semiHidden unhideWhenUsed locked personal personalCompose personalReply
  rsid tblStylePr numbering abstractNum nsid multiLevelType tmpl lvl start numFmt lvlRestart pStyle
  isLgl suff lvlText lvlPicBulletId legacy lvlJc num numIdMacAtCleanup abstractNumId lvlOverride startOverride
  bookmarkStart bookmarkEnd proofErr commentRangeStart commentRangeEnd commentReference`.split(/\s+/));
const removeWordElements = new Set('bookmarkStart bookmarkEnd proofErr commentRangeStart commentRangeEnd commentReference lastRenderedPageBreak name aliases latentStyles lsdException personal personalCompose personalReply rsid nsid tmpl tblCaption tblDescription printerSettings'.split(' '));
const wordAttributes = new Set(`val type id styleId default customStyle ascii hAnsi eastAsia cs bidi hint asciiTheme hAnsiTheme eastAsiaTheme cstheme
  themeColor themeTint themeShade fill themeFill themeFillTint themeFillShade color space shadow frame sz
  before after beforeLines afterLines beforeAutospacing afterAutospacing line lineRule left right start end firstLine hanging
  leftChars rightChars firstLineChars hangingChars top bottom header footer gutter w h orient code first next num fmt
  pos leader count sep equalWidth numId abstractNumId ilvl tplc tentative multiLevelType
  anchor lock wrap hAnchor vAnchor horzAnchor vertAnchor tblpX tblpY tblpXSpec tblpYSpec topFromText bottomFromText leftFromText rightFromText
  width length hRule rule clear restart distance suppressOverlap allowOverlap fullDate calendar
  firstRow lastRow firstColumn lastColumn noHBand noVBand oddHBand evenHBand oddVBand evenVBand
  firstRowFirstColumn firstRowLastColumn lastRowFirstColumn lastRowLastColumn
  eastAsianLayoutId combine combineBrackets vert vertCompress leftFromText rightFromText
  char linePitch charSpace pitch lines legacy legacySpace legacyIndent element uri`.split(/\s+/));
const themeAttributes = new Set(`val lastClr typeface panose pitchFamily charset script idx rot pos ang scaled path l t r b
  flip rotWithShape w cap cmpd algn prst lim len rad blurRad dist dir sx sy kx ky algn grow
  stA endA stPos endPos fadeDir h fov zoom lat lon rev rig z extrusionH contourW prstMaterial
  anchor anchorCtr wrap lIns tIns rIns bIns numCol spcCol rtlCol fromWordArt forceAA compatLnSpc
  horzOverflow vertOverflow upright spcFirstLastPara useSpcPct normalEastAsianBreak`.split(/\s+/));
const themeElements = new Set(`theme themeElements clrScheme dk1 lt1 dk2 lt2 accent1 accent2 accent3 accent4 accent5 accent6 hlink folHlink
  sysClr srgbClr scrgbClr hslClr schemeClr prstClr tint shade comp inv gray alpha alphaOff alphaMod hue hueOff hueMod sat satOff satMod lum lumOff lumMod red redOff redMod green greenOff greenMod blue blueOff blueMod gamma invGamma
  fontScheme majorFont minorFont latin ea cs font fmtScheme fillStyleLst solidFill gradFill gsLst gs pos lin path fillToRect tileRect
  lnStyleLst ln prstDash custDash ds round bevel miter headEnd tailEnd effectStyleLst effectStyle effectLst outerShdw innerShdw glow softEdge reflection blur
  scene3d camera lightRig rot backdrop anchor norm up sp3d bevelT bevelB extrusionClr contourClr bgFillStyleLst noFill objectDefaults spDef lnDef txDef
  spPr bodyPr lstStyle extraClrSchemeLst`.split(/\s+/));

function sanitizeContent(document: XmlDocument, path: string): void {
  const theme = path.startsWith('word/theme/');
  const expectedRoot = theme ? 'theme' : path === 'word/styles.xml' ? 'styles' : path === 'word/numbering.xml' ? 'numbering' :
    path === 'word/document.xml' ? 'document' : /\/header/.test(path) ? 'hdr' : /\/footer/.test(path) ? 'ftr' : /\/footnotes/.test(path) ? 'footnotes' : 'endnotes';
  if (document.documentElement.localName !== expectedRoot) fail(`invalid root in ${path}`);
  walk(document.documentElement, element => {
    const namespace = element.namespaceURI, local = element.localName;
    if (namespace !== (theme ? A : W) || !(theme ? themeElements : wordElements).has(local)) fail(`unsupported content ${element.nodeName} in ${path}`);
    if (!theme && removeWordElements.has(local)) { element.parentNode?.removeChild(element); return; }
    if (!theme && ['noBreakHyphen', 'softHyphen', 'continuationNotice', 'lvlPicBulletId', 'oMath'].includes(local)) fail(`unsupported text surface ${local}`);
    if (!theme && local === 'lvlText' && !/^[%0-9\s.()\[\]{}\-–—•◦▪●○■□◆◇]*$/u.test(element.getAttributeNS(W, 'val') ?? '')) fail('custom numbering text is unsupported');
    if (!theme && local === 't' && !storyPath.test(path)) fail('text in an auxiliary part');
    for (const child of elements(element)) {
      if (local === 't') fail('nested content in text node');
      if (child.localName === 'p' && local !== 'body' && local !== 'tc' && local !== 'hdr' && local !== 'ftr' && local !== 'footnote' && local !== 'endnote') fail('unsupported paragraph container');
    }
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if ((child.nodeType === 3 || child.nodeType === 4) && local !== 't' && child.nodeValue?.trim()) fail(`unmapped text in ${path}`);
    }
    for (let i = element.attributes.length - 1; i >= 0; i--) {
      const attribute = element.attributes.item(i)!;
      if (attribute.namespaceURI === XMLNS) {
        // Unused extension namespace URIs are not text surfaces and need not be
        // copied. xmldom serializes required namespace bindings automatically.
        if (![W, R, A, XML].includes(attribute.value)) element.removeAttributeNode(attribute);
        continue;
      }
      if (attribute.namespaceURI === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && attribute.localName === 'Ignorable') {
        element.removeAttributeNode(attribute); continue;
      }
      if ((!theme && /^rsid/.test(attribute.localName ?? '')) ||
          attribute.namespaceURI === 'http://schemas.microsoft.com/office/word/2010/wordml' && ['paraId', 'textId'].includes(attribute.localName ?? '') ||
          theme && attribute.localName === 'name') { element.removeAttributeNode(attribute); continue; }
      if (theme ? !!attribute.namespaceURI : ![W, R, XML].includes(attribute.namespaceURI ?? '')) fail(`unsupported attribute ${attribute.nodeName}`);
      if (theme && !themeAttributes.has(attribute.localName ?? '') || attribute.namespaceURI === W && !wordAttributes.has(attribute.localName ?? '')) fail(`unsupported attribute ${attribute.nodeName}`);
      if (local === 't' && attribute.namespaceURI !== XML) fail('unsupported text-node attribute');
      if (attribute.namespaceURI === XML && (attribute.localName !== 'space' || !['preserve', 'default'].includes(attribute.value))) fail('unsupported XML attribute');
      if (attribute.namespaceURI === R && !['headerReference', 'footerReference'].includes(local)) fail('unsupported relationship-bearing content');
    }
  });
}

function paragraphs(document: XmlDocument, path: string): Paragraph[] {
  const result: Paragraph[] = [];
  let mappedText = 0;
  walk(document.documentElement, element => {
    if (element.localName !== 'p') return;
    const paragraph: Paragraph = { id: `docx:${path}:p${result.length}`, text: '', pieces: [] };
    walk(element, child => {
      if (child !== element && child.localName === 'p') fail('nested paragraphs');
      let text: string, kind: Piece['kind'];
      if (child.localName === 't') { text = child.textContent ?? ''; kind = 'text'; mappedText++; }
      else if (child.localName === 'tab' && child.parentNode?.localName === 'r') { text = '\t'; kind = 'tab'; }
      else if (child.localName === 'br' || child.localName === 'cr') { text = '\n'; kind = 'break'; }
      else return;
      if (child.parentNode?.localName !== 'r') fail('text outside a run');
      paragraph.pieces.push({ element: child, start: paragraph.text.length, end: paragraph.text.length + text.length, text, kind });
      paragraph.text += text;
    });
    result.push(paragraph);
  });
  if (mappedText !== document.getElementsByTagNameNS(W, 't').length) fail('text outside reviewed paragraphs');
  return result;
}

const partMime = (path: string): string | undefined => {
  const base = 'application/vnd.openxmlformats-officedocument.';
  if (path === 'word/document.xml') return `${base}wordprocessingml.document.main+xml`;
  if (/^word\/header/.test(path)) return `${base}wordprocessingml.header+xml`;
  if (/^word\/footer/.test(path)) return `${base}wordprocessingml.footer+xml`;
  if (/^word\/theme\//.test(path)) return `${base}theme+xml`;
  const match = /^word\/(styles|numbering|footnotes|endnotes)\.xml$/.exec(path);
  return match ? `${base}wordprocessingml.${match[1]}+xml` : undefined;
};

function packageDocuments(raw: Record<string, Uint8Array>): Map<string, XmlDocument> {
  const documents = new Map<string, XmlDocument>();
  for (const [path, bytes] of Object.entries(raw)) {
    const source = relationshipSource(path);
    if (discardPath.test(path) || source !== undefined && discardPath.test(source)) continue;
    if (path !== '[Content_Types].xml' && !storyPath.test(path) && !auxiliaryPath.test(path) && source === undefined) fail(`unsupported package part ${path}`);
    documents.set(path, parse(bytes, path));
  }
  if (!documents.has('word/document.xml') || !documents.has('[Content_Types].xml') || !documents.has('_rels/.rels')) fail('missing required DOCX part');
  const relationships = new Map<string, Map<string, string>>();
  const reachable = new Set<string>();
  for (const [path, document] of documents) {
    const source = relationshipSource(path);
    if (source === undefined) continue;
    if (source && !documents.has(source)) fail('orphan relationship part');
    const root = document.documentElement;
    if (root.namespaceURI !== REL || root.localName !== 'Relationships') fail('invalid relationships XML');
    const ids = new Map<string, string>();
    relationships.set(source, ids);
    for (const relationship of elements(root)) {
      if (relationship.namespaceURI !== REL || relationship.localName !== 'Relationship' || elements(relationship).length) fail('invalid relationship');
      const id = relationship.getAttribute('Id'), type = relationship.getAttribute('Type'), target = relationship.getAttribute('Target');
      if (!id || !type || !target || ids.has(id)) fail('invalid or duplicate relationship ID');
      const resolved = resolveTarget(source, target);
      // Discarded parts and their relationships must be removed together: keeping
      // the original ZIP bytes would retain author names, comment text, document
      // variables, mail merge settings, thumbnails or other unreviewed metadata.
      if (discardedRelationships.has(type)) {
        if (!discardPath.test(resolved)) fail('unexpected metadata target');
        ids.set(id, ''); root.removeChild(relationship); continue;
      }
      if (relationship.hasAttribute('TargetMode') && relationship.getAttribute('TargetMode') !== 'Internal') fail('external relationships are unsupported');
      const kind = type.startsWith(`${R}/`) ? type.slice(R.length + 1) : '';
      if (!relationshipParts[kind]?.test(resolved) || !documents.has(resolved)) fail(`unsupported relationship ${type}`);
      if (source === '' && kind !== 'officeDocument' || source !== '' && kind === 'officeDocument') fail('misplaced document relationship');
      ids.set(id, resolved);
      // Recreate attributes to eliminate non-schema metadata and normalize targets.
      while (relationship.attributes.length) relationship.removeAttributeNode(relationship.attributes.item(0)!);
      while (relationship.firstChild) relationship.removeChild(relationship.firstChild);
      relationship.setAttribute('Id', id); relationship.setAttribute('Type', type); relationship.setAttribute('Target', `/${resolved}`);
    }
    // Recreate the root too: only relationships and namespace declarations belong here.
    while (root.attributes.length) root.removeAttributeNode(root.attributes.item(0)!);
    root.setAttribute('xmlns', REL);
    for (let child = root.firstChild; child;) {
      const next = child.nextSibling;
      if (child.nodeType !== 1) root.removeChild(child);
      child = next;
    }
  }
  const rootTargets = [...(relationships.get('')?.values() ?? [])].filter(Boolean);
  if (rootTargets.length !== 1 || rootTargets[0] !== 'word/document.xml') fail('invalid root document relationship');
  const pending = [...rootTargets];
  while (pending.length) {
    const path = pending.pop()!;
    if (reachable.has(path)) continue;
    reachable.add(path);
    pending.push(...[...(relationships.get(path)?.values() ?? [])].filter(Boolean));
  }
  for (const [path, document] of documents) {
    if (!storyPath.test(path) && !auxiliaryPath.test(path)) continue;
    if (!reachable.has(path)) fail(`unreferenced content part ${path}`);
    sanitizeContent(document, path);
    walk(document.documentElement, element => {
      for (let i = 0; i < element.attributes.length; i++) {
        const attribute = element.attributes.item(i)!;
        if (attribute.namespaceURI === R) {
          const target = relationships.get(path)?.get(attribute.value);
          if (!target || element.localName === 'headerReference' && !/^word\/header/.test(target) || element.localName === 'footerReference' && !/^word\/footer/.test(target)) fail('invalid story reference');
        }
      }
    });
  }
  // Custom style names can contain author-entered personal information. Replace
  // their internal identifiers consistently, retaining the actual style rules.
  const styleIds = new Map<string, string>();
  const opaqueStyle = (id: string): string => {
    if (!styleIds.has(id)) styleIds.set(id, `style${styleIds.size}`);
    return styleIds.get(id)!;
  };
  for (const [path, document] of documents) {
    if (!storyPath.test(path) && path !== 'word/styles.xml' && path !== 'word/numbering.xml') continue;
    walk(document.documentElement, element => {
      if (element.localName === 'style' && element.hasAttributeNS(W, 'styleId')) element.setAttributeNS(W, 'w:styleId', opaqueStyle(element.getAttributeNS(W, 'styleId')!));
      if (['pStyle', 'rStyle', 'tblStyle', 'basedOn', 'next', 'link'].includes(element.localName) && element.hasAttributeNS(W, 'val')) element.setAttributeNS(W, 'w:val', opaqueStyle(element.getAttributeNS(W, 'val')!));
    });
  }
  const types = documents.get('[Content_Types].xml')!;
  if (types.documentElement.namespaceURI !== CT || types.documentElement.localName !== 'Types') fail('invalid content types');
  const defaults = new Map<string, string>(), overrides = new Map<string, string>();
  for (const element of elements(types.documentElement)) {
    const mime = element.getAttribute('ContentType');
    if (element.namespaceURI !== CT || !mime) fail('invalid content type');
    if (element.localName === 'Default') {
      const extension = element.getAttribute('Extension');
      if (!extension || defaults.has(extension)) fail('duplicate content type');
      defaults.set(extension, mime);
    } else if (element.localName === 'Override') {
      const name = element.getAttribute('PartName');
      if (!name?.startsWith('/') || overrides.has(name.slice(1))) fail('duplicate or invalid content type');
      overrides.set(name.slice(1), mime);
    } else fail('unsupported content type element');
  }
  for (const path of documents.keys()) {
    if (path === '[Content_Types].xml') continue;
    const expected = relationshipSource(path) !== undefined ? 'application/vnd.openxmlformats-package.relationships+xml' : partMime(path);
    if ((overrides.get(path) ?? defaults.get(path.split('.').pop()!)) !== expected) fail(`unsupported content type for ${path}`);
  }
  // Build a minimal manifest, never copy stale metadata/unsupported declarations.
  const manifest = parse(encoder.encode(`<Types xmlns="${CT}"/>`), '[Content_Types].xml');
  const relDefault = manifest.createElementNS(CT, 'Default');
  relDefault.setAttribute('Extension', 'rels'); relDefault.setAttribute('ContentType', 'application/vnd.openxmlformats-package.relationships+xml');
  manifest.documentElement.appendChild(relDefault);
  for (const path of documents.keys()) {
    const mime = partMime(path);
    if (!mime) continue;
    const override = manifest.createElementNS(CT, 'Override');
    override.setAttribute('PartName', `/${path}`); override.setAttribute('ContentType', mime);
    manifest.documentElement.appendChild(override);
  }
  documents.set('[Content_Types].xml', manifest);
  return documents;
}

function normalizedSpans(masks: SegmentMasks[], byId: Map<string, Paragraph>): Map<string, Array<{ start: number; end: number }>> {
  const result = new Map<string, Array<{ start: number; end: number }>>();
  if (masks.length !== byId.size) fail('incomplete mask segments');
  for (const mask of masks) {
    const paragraph = byId.get(mask.segmentId);
    if (!paragraph) fail('unknown mask segment');
    if (result.has(mask.segmentId)) fail('duplicate mask segment');
    const spans: Array<{ start: number; end: number }> = [];
    for (const span of mask.spans) {
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > paragraph.text.length) fail('invalid mask range');
      // Never widen the approved range. Reject split scalars just like the public review validator.
      const { start, end } = span;
      for (const offset of [start, end]) {
        if (offset > 0 && offset < paragraph.text.length && /[\uD800-\uDBFF]/.test(paragraph.text.charAt(offset - 1)) &&
            /[\uDC00-\uDFFF]/.test(paragraph.text.charAt(offset))) fail('mask splits Unicode character');
      }
      spans.push({ start, end });
    }
    result.set(mask.segmentId, spans);
  }
  for (const [id, spans] of result) {
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: typeof spans = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    result.set(id, merged);
  }
  return result;
}

export const openDocx: OpenDocx = async (bytes, limits, signal) => {
  aborted(signal);
  for (const key of ['maxInputBytes', 'maxOutputBytes', 'maxEntries', 'maxUncompressedBytes', 'maxParagraphs', 'maxCharacters'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) fail(`invalid ${key}`);
  }
  if (bytes.byteLength > limits.maxInputBytes) fail('input size limit exceeded');
  const input = new Uint8Array(bytes), entries = inspectZip(input, limits);
  const expectedEntries = new Map(entries.map(entry => [entry.name, entry]));
  let expanded = 0, count = 0;
  const raw = unzipSync(input, { filter: entry => {
    aborted(signal);
    const expected = expectedEntries.get(entry.name);
    expanded += entry.originalSize; count++;
    if (!expected || expected.size !== entry.originalSize || expected.compressed !== entry.size || count > limits.maxEntries || expanded > limits.maxUncompressedBytes) fail('ZIP expansion limit or header mismatch');
    return true;
  } });
  if (Object.keys(raw).length !== entries.length) fail('missing ZIP entry');
  for (const entry of entries) {
    const data = raw[entry.name];
    if (!data || data.length !== entry.size || crc32(data) !== entry.crc) fail('corrupt ZIP entry');
  }
  const documents = packageDocuments(raw);
  let originals = new Map<string, string>();
  const serializer = new XMLSerializer();
  const segments: TextSegment[] = [];
  let characterCount = 0;
  const paths = [...documents.keys()].filter(path => storyPath.test(path)).sort((a, b) => a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b));
  for (const path of paths) {
    aborted(signal);
    for (const paragraph of paragraphs(documents.get(path)!, path)) {
      characterCount += paragraph.text.length;
      if (segments.length >= limits.maxParagraphs || characterCount > limits.maxCharacters) fail('document text limit exceeded');
      segments.push({ id: paragraph.id, text: paragraph.text });
    }
  }
  for (const [path, document] of documents) originals.set(path, serializer.serializeToString(document));
  documents.clear();
  let closed = false;
  return {
    segments,
    async rebuild(masks, rebuildSignal) {
      aborted(rebuildSignal);
      if (closed) fail('session is closed');
      // Each rebuild starts from the sanitized immutable source; a cancelled or
      // repeated review cannot accidentally accumulate changes from an earlier pass.
      const rebuilt = new Map<string, XmlDocument>();
      for (const [path, xml] of originals) rebuilt.set(path, parse(encoder.encode(xml), path));
      const byId = new Map<string, Paragraph>();
      const paragraphCounts = new Map<string, number>();
      for (const path of paths) {
        const extracted = paragraphs(rebuilt.get(path)!, path);
        paragraphCounts.set(path, extracted.length);
        for (const paragraph of extracted) byId.set(paragraph.id, paragraph);
      }
      const selected = normalizedSpans(masks, byId), expectedText = new Map<string, string>();
      for (const paragraph of byId.values()) {
        aborted(rebuildSignal);
        const spans = selected.get(paragraph.id) ?? [];
        let expected = '', cursor = 0;
        for (const span of spans) { expected += paragraph.text.slice(cursor, span.start) + '█'.repeat(span.end - span.start); cursor = span.end; }
        expected += paragraph.text.slice(cursor); expectedText.set(paragraph.id, expected);
        for (const piece of paragraph.pieces) {
          const overlaps = spans.filter(span => span.start < piece.end && span.end > piece.start);
          if (!overlaps.length) continue;
          let replacement = '', position = piece.start;
          for (const span of overlaps) {
            const start = Math.max(span.start, piece.start), end = Math.min(span.end, piece.end);
            replacement += piece.text.slice(position - piece.start, start - piece.start) + '█'.repeat(end - start); position = end;
          }
          replacement += piece.text.slice(position - piece.start);
          if (piece.kind === 'text') { piece.element.textContent = replacement; piece.element.setAttributeNS(XML, 'xml:space', 'preserve'); }
          else {
            const text = piece.element.ownerDocument!.createElementNS(W, 'w:t');
            text.setAttributeNS(XML, 'xml:space', 'preserve'); text.textContent = replacement;
            piece.element.parentNode!.replaceChild(text, piece.element);
          }
        }
      }
      const output: Record<string, Uint8Array> = Object.create(null);
      let outputExpanded = 0;
      for (const [path, document] of rebuilt) {
        const encoded = encoder.encode(serializer.serializeToString(document));
        outputExpanded += encoded.length;
        if (outputExpanded > limits.maxUncompressedBytes) fail('regenerated XML size limit exceeded');
        // Parse the exact serialized bytes, not only the mutated in-memory DOM.
        const checked = parse(encoded, path);
        if (storyPath.test(path)) {
          const verified = paragraphs(checked, path);
          if (verified.length !== paragraphCounts.get(path)) fail('regenerated paragraph count mismatch');
          for (const paragraph of verified) if (paragraph.text !== expectedText.get(paragraph.id)) fail('regenerated text mismatch');
        }
        output[path] = encoded;
      }
      aborted(rebuildSignal);
      const zipped = zipSync(output, { level: 6 });
      if (zipped.byteLength > limits.maxOutputBytes) fail('output size limit exceeded');
      aborted(rebuildSignal);
      // A fresh owned ArrayBuffer also makes worker transfer safe with newer TS typed-array generics.
      return new Uint8Array(zipped);
    },
    close() { closed = true; originals.clear(); originals = new Map(); segments.length = 0; },
  };
};
