import { normalizeText } from './text.js';

/**
 * Which category a product belongs to, read from the words its seller wrote (the title, then the tags made from it).
 * The name of each category is a clue; so are the other ways sellers write the same garment. The longest clue wins
 * ("شلوار جین" over "شلوار", "شلوارک" over "شلوار"), and when two categories carry the same name (کاپشن is a top and
 * winter outerwear) the first group listed wins unless the text says it is the winter kind.
 *
 * Returns the category *slug*, or null when the words name no garment at all - "مدل کد ۱۱۲" says nothing, and a
 * wrong guess is worse than none.
 */
const SYNONYMS = {
  blazer: ['جکت', 'بلیزر'],
  tshirt: ['تی شرت', 'تیشرت'],
  hoodie: ['هودی', 'هود'],
  pullover: ['پلیور', 'پولیور'],
  cardigan: ['کاردیگان', 'ژاکت'],
  jacket: ['بامبر', 'کاپشن', 'کاپشن'],
  overcoat: ['پالتو', 'نیمتنه'],
  jeans: ['جین'],
  'baggy-pants': ['بگ'],
  'slash-pants': ['اسلش'],
  supporter: ['ساپورت'],
  leggings: ['لگ', 'ساق'],
  skirt: ['دامن'],
  manteau: ['مانتو'],
  overalls: ['اورال', 'اورآل', 'سرهمی'],
  jumpsuit: ['جامپ سوت', 'جامپسوت'],
  'evening-dress': ['لباس مجلسی', 'مجلسی'],
  dress: ['پیراهن یکسره', 'پیراهن یک سره'],
  sarafan: ['سارافون', 'سرافون'],
  puffer: ['پافر'],
  windbreaker: ['بادگیر'],
  raincoat: ['بارانی'],
  poncho: ['پانچو'],
  cape: ['شنل'],
  sleepwear: ['لباس خواب', 'پیژامه'],
  'lounge-set': ['ست راحتی'],
  'lounge-pants': ['شلوار راحتی'],
  'lounge-tshirt': ['تیشرت راحتی'],
  homewear: ['لباس خانگی'],
  'sport-set': ['ست ورزشی'],
  'sport-leggings': ['لگ ورزشی'],
  'sport-top': ['تاپ ورزشی'],
  'sport-shorts': ['شلوارک ورزشی'],
  'sport-hoodie': ['هودی ورزشی'],
  undershirt: ['زیرپوش'],
  bra: ['سوتین', 'نیم تنه ورزشی'],
  shapewear: ['گن'],
  corset: ['کورست'],
  fishnet: ['فیشنت'],
  briefs: ['بریف'],
  underpants: ['زیرشلواری'],
  headscarf: ['روسری'],
  shawl: ['شال'],
};

const WINTER_HINT = /پافر|زمستان|پاییزه|پر\s*دار|ضدآب|بادگیر/;
// "کت" is two letters: it only counts as its own word, never inside another ("کتانی", "کتان")
const OWN_WORD = new Set(['کت', 'گن', 'لگ', 'هود', 'بگ', 'جین']);

export function buildCategoryGuesser(leaves) {
  const clues = [];
  const add = (slug, text, rank) => {
    const clue = normalizeText(text).replace(/\s+/g, ' ').trim();
    if (clue.length >= 2) clues.push({ slug, clue, rank });
  };
  leaves.forEach((leaf, rank) => {
    if (leaf.nameFa) add(leaf.slug, leaf.nameFa, rank);
    for (const word of SYNONYMS[leaf.slug] || []) add(leaf.slug, word, rank);
  });
  clues.sort((a, b) => b.clue.length - a.clue.length || a.rank - b.rank);

  const has = (hay, clue) => {
    if (!OWN_WORD.has(clue)) return hay.includes(clue);
    return new RegExp(`(^|[^\\p{L}])${clue}($|[^\\p{L}])`, 'u').test(hay);
  };

  function inText(text) {
    const hay = ` ${normalizeText(text).replace(/\s+/g, ' ')} `;
    const hits = clues.filter((c) => has(hay, c.clue));
    if (!hits.length) return null;
    const best = hits[0];
    // "کاپشن پافر": the specific kind of outerwear beats the generic word for a coat
    const specific = hits.find((c) => ['puffer', 'windbreaker', 'raincoat', 'poncho', 'cape'].includes(c.slug));
    if (specific && /کاپشن|پالتو|جکت/.test(best.clue)) return specific.slug;
    // the same word names both a top and a winter coat: the winter one only when the text says winter
    const same = hits.filter((c) => c.clue === best.clue);
    if (same.length > 1) {
      const winter = same.find((c) => /autumn|outer|puffer|wind|rain/.test(c.slug));
      if (winter && WINTER_HINT.test(hay)) return winter.slug;
      return same.find((c) => !/outer/.test(c.slug))?.slug || best.slug;
    }
    return best.slug;
  }

  return ({ title = '', description = '', tags = [], properties = [] } = {}) => {
    // the title (and the tags made from it) only: a property line like "ساپورت می‌کند" (it stretches) is not a garment
    return inText(title) || inText((tags || []).join(' ')) || null;
  };
}
