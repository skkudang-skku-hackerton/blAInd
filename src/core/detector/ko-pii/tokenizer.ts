import { Tokenizer } from '@huggingface/tokenizers';
import { PiiError } from '../../api/errors';
import type { DetectorTokenizer, TokenizedInput } from '../types';

interface TokenizerMetadata {
  normalizer: { type: string };
  pre_tokenizer: { type: string; pretokenizers: { type: string }[] };
  model: { type: string; unk_token: string; continuing_subword_prefix: string };
  added_tokens: { id: number; content: string; normalized: boolean; single_word: boolean; lstrip: boolean; rstrip: boolean }[];
  post_processor: { type: string; single: ({ SpecialToken: { id: string } } | { Sequence: { id: string } })[]; special_tokens: Record<string, { ids: number[] }> };
}

/** tokenizers.js supplies IDs/tokens, but deliberately exposes no offsets.
 * Track canonical-decomposition provenance through NFC, then consume WordPiece tokens
 * within each exact BERT pre-token. Never search decoded strings in the source.
 */
export class KoPiiTokenizer implements DetectorTokenizer {
  private readonly engine: Tokenizer;
  private readonly metadata: TokenizerMetadata;
  private readonly wrappers: [number, number];
  constructor(tokenizerJson: unknown, tokenizerConfig: unknown) {
    this.metadata = tokenizerJson as TokenizerMetadata;
    const m = this.metadata;
    if (m.normalizer?.type !== 'NFC' || m.model?.type !== 'WordPiece' ||
        m.pre_tokenizer?.type !== 'Sequence' || m.pre_tokenizer.pretokenizers.length !== 1 ||
        m.pre_tokenizer.pretokenizers[0]?.type !== 'BertPreTokenizer' ||
        m.added_tokens.some(t => t.normalized || t.single_word || t.lstrip || t.rstrip) ||
        m.post_processor?.type !== 'TemplateProcessing') throw new Error('Unsupported tokenizer metadata');
    const template = m.post_processor.single;
    const [first, sequence, last] = template;
    if (template.length !== 3 || !first || !sequence || !last ||
        !('SpecialToken' in first) || !('Sequence' in sequence) || !('SpecialToken' in last)) {
      throw new Error('Unsupported tokenizer special-token template');
    }
    const startId = m.post_processor.special_tokens[first.SpecialToken.id]?.ids[0];
    const endId = m.post_processor.special_tokens[last.SpecialToken.id]?.ids[0];
    if (startId !== 0 || endId !== 1) throw new Error('Unexpected model special token IDs');
    this.wrappers = [startId, endId];
    this.engine = new Tokenizer(tokenizerJson as object, tokenizerConfig as object);
  }

  encode(text: string, addSpecialTokens = true): TokenizedInput {
    if (typeof text !== 'string') throw new PiiError('INVALID_INPUT', 'Text must be a string');
    const input: TokenizedInput = { ids: [], offsets: [], attentionMask: [], specialTokensMask: [] };
    const append = (id: number, start: number, end: number) => {
      input.ids.push(id); input.offsets.push([start, end]); input.attentionMask.push(1); input.specialTokensMask.push(0);
    };
    const added = [...this.metadata.added_tokens].sort((a, b) => b.content.length - a.content.length);
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const specialPattern = new RegExp(added.map(t => escape(t.content)).join('|'), 'gu');
    const ordinary = (source: string, base: number) => {
      let normalized = '';
      const mapping: [number, number][] = [];
      for (const part of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(source)) {
        const nfc = part.segment.normalize('NFC');
        normalized += nfc;
        // Composition unions source ranges; canonical reordering moves provenance
        // with the character. Do not assign an entire emoji/combining cluster to
        // each output character, which would overextend subword spans.
        const origins = new Map<string, { ranges: [number, number][]; next: number }>();
        let sourceIndex = base + part.index;
        for (const character of part.segment) {
          for (const atom of character.normalize('NFD')) {
            const origin = origins.get(atom) ?? { ranges: [], next: 0 };
            origin.ranges.push([sourceIndex, sourceIndex + character.length]);
            origins.set(atom, origin);
          }
          sourceIndex += character.length;
        }
        for (const character of nfc) {
          let start = Infinity;
          let end = 0;
          for (const atom of character.normalize('NFD')) {
            const origin = origins.get(atom);
            const range = origin?.ranges[origin.next++];
            if (!range) throw new PiiError('MODEL_LOAD_FAILED', 'NFC source mapping failed');
            start = Math.min(start, range[0]);
            end = Math.max(end, range[1]);
          }
          for (let i = 0; i < character.length; i++) mapping.push([start, end]);
        }
      }
      // BERT punctuation = Unicode P plus all ASCII punctuation (including $,+,^ etc.).
      const pattern = /[^\s\p{P}\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+|[\p{P}\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/gu;
      for (const match of normalized.matchAll(pattern)) {
        const word = match[0];
        const encoded = this.engine.encode(word, { add_special_tokens: false });
        let cursor = 0;
        for (let i = 0; i < encoded.ids.length; i++) {
          const token = encoded.tokens[i];
          const id = encoded.ids[i];
          if (token === undefined || id === undefined) throw new PiiError('MODEL_LOAD_FAILED', 'Incomplete tokenizer encoding');
          const piece = token === this.metadata.model.unk_token ? word :
            (i > 0 && token.startsWith(this.metadata.model.continuing_subword_prefix) ? token.slice(this.metadata.model.continuing_subword_prefix.length) : token);
          if (!word.startsWith(piece, cursor) || !piece.length) throw new PiiError('MODEL_LOAD_FAILED', 'Tokenizer source alignment failed');
          const start = match.index + cursor;
          cursor += piece.length;
          let sourceStart = Infinity;
          let sourceEnd = 0;
          for (let position = start; position < match.index + cursor; position++) {
            const range = mapping[position];
            if (!range) throw new PiiError('MODEL_LOAD_FAILED', 'Missing tokenizer source range');
            sourceStart = Math.min(sourceStart, range[0]);
            sourceEnd = Math.max(sourceEnd, range[1]);
          }
          append(id, sourceStart, sourceEnd);
        }
        if (cursor !== word.length) throw new PiiError('MODEL_LOAD_FAILED', 'Incomplete tokenizer source alignment');
      }
    };
    let cursor = 0;
    for (const match of text.matchAll(specialPattern)) {
      ordinary(text.slice(cursor, match.index), cursor);
      append(added.find(t => t.content === match[0])!.id, match.index, match.index + match[0].length);
      cursor = match.index + match[0].length;
    }
    ordinary(text.slice(cursor), cursor);
    // Fail closed if package behavior ever diverges from our source decomposition.
    const expected = this.engine.encode(text, { add_special_tokens: false }).ids;
    if (expected.length !== input.ids.length || expected.some((id, i) => id !== input.ids[i])) {
      throw new PiiError('MODEL_LOAD_FAILED', 'Tokenizer ID/source mapping mismatch');
    }
    return addSpecialTokens ? this.prepare(input) : input;
  }

  prepare(input: TokenizedInput): TokenizedInput {
    if (input.ids.length !== input.offsets.length || input.ids.length !== input.attentionMask.length ||
        input.ids.length !== input.specialTokensMask.length || input.specialTokensMask.some(Boolean)) {
      throw new PiiError('INVALID_INPUT', 'prepare requires aligned content tokens without sequence wrappers');
    }
    return {
      ids: [this.wrappers[0], ...input.ids, this.wrappers[1]],
      attentionMask: [1, ...input.attentionMask, 1],
      offsets: [[0, 0], ...input.offsets.map(([start, end]): [number, number] => [start, end]), [0, 0]],
      specialTokensMask: [1, ...input.specialTokensMask, 1],
    };
  }
}
