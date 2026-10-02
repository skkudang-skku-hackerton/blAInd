/** Exact pinned tokenizer structure and a reduced vocabulary with original IDs.
 * The reduction intentionally exercises WordPiece and whole-word UNK behavior.
 */
export const tokenizerFixture = {
  version: '1.0', truncation: null, padding: null,
  added_tokens: [
    { id: 0, content: '<s>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    { id: 1, content: '<\\s>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    { id: 2, content: '<unk>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    { id: 3, content: '<sep>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    { id: 5, content: '<cls>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
  ],
  normalizer: { type: 'NFC' },
  pre_tokenizer: { type: 'Sequence', pretokenizers: [{ type: 'BertPreTokenizer' }] },
  post_processor: {
    type: 'TemplateProcessing',
    single: [{ SpecialToken: { id: '<s>', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, { SpecialToken: { id: '<\\s>', type_id: 0 } }],
    pair: [{ SpecialToken: { id: '<s>', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, { SpecialToken: { id: '<\\s>', type_id: 0 } }, { Sequence: { id: 'B', type_id: 1 } }, { SpecialToken: { id: '<\\s>', type_id: 1 } }],
    special_tokens: { '<s>': { id: '<s>', ids: [0], tokens: ['<s>'] }, '<\\s>': { id: '<\\s>', ids: [1], tokens: ['<\\s>'] } },
  },
  decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
  model: {
    type: 'WordPiece', unk_token: '<unk>', continuing_subword_prefix: '##', max_input_chars_per_word: 100,
    vocab: { '<s>': 0, '<\\s>': 1, '<unk>': 2, '<sep>': 3, '<cls>': 5,
      '김': 13483, '##민': 20369, '##수': 20311, '가': 13161, '각': 13162,
      'é': 202, '##é': 20293, 'e': 105, '##e': 20221, 'a': 101, '##a': 20229,
      'A': 69, '1': 53, '0': 52, '-': 49, '.': 50, '@': 68, '😀': 19754,
      '한': 18383, '##국': 20298, '##어': 20382, '전화': 31693, '번호': 32074, '010': 37779 },
  },
};
export const tokenizerConfigFixture = {
  backend: 'tokenizers', bos_token: '<s>', clean_up_tokenization_spaces: true,
  cls_token: '<cls>', do_lower_case: false, eos_token: '<\\s>', is_local: true,
  local_files_only: false, mask_token: '<mask>', model_max_length: 1024,
  pad_token: '<pad>', sep_token: '<sep>', strip_accents: null,
  tokenize_chinese_chars: true, tokenizer_class: 'BertTokenizerFast', unk_token: '<unk>',
};

/** Vocabulary projection for snapshots empirically checked against all 50,000
 * pinned entries. Every entry retains its real ID; no tokenizer retraining.
 */
export const auditTokenizerFixture = {
  ...tokenizerFixture,
  added_tokens: [...tokenizerFixture.added_tokens,
    { id: 4, content: '<mask>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    { id: 49999, content: '<pad>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
  ],
  model: { ...tokenizerFixture.model, vocab: { ...tokenizerFixture.model.vocab,
    '<mask>': 4, '<pad>': 49999, '김민': 34455, '한국어': 34898, '한글': 35220,
    '##의': 20528, '##번': 21157, '##호': 20364, '##는': 20430,
    '123': 38683, '##4': 20320, '56': 33924, '##78': 43614, '##입니다': 35634,
    'c': 103, '##af': 34707, 'á': 194, '##̧': 23934, '##́': 23761,
    '̈': 498, '̧': 523, '́': 491, 'Å': 166, 'Ω': 602, '##️': 23797,
    '🇰': 19234, '##🇷': 25369, '👍': 19536, '##🏽': 27244,
    '🛸': 19897, '##🛸': 29587, '##un': 32137, '##k': 20255, '##now': 35681, '##n': 20219,
  } },
};
