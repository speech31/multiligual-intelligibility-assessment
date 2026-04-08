/**
 * words.js — Multi-language word list data and selection helpers.
 *
 * Sources:
 *   English: Multilingual Intelligibility Test, English Version
 *   Korean:  Multilingual Intelligibility Test, Korean Version
 *
 * Both lists: 50 sets × 12 words = 600 words per language.
 *
 * WORD_DATA[lang][rowIndex][colIndex]   (row/col both 0-based)
 * LANGUAGES                             { code → display label }
 * getSessionWords(subsection, lang)     subsection is 1-based (1–12)
 * getCanonical(wordId, lang)            wordId format: "set01_col03"
 */

const LANGUAGES = {
  en: "English",
  ko: "Korean",
};

const WORD_DATA = {

  en: [
    /* set 01 */ ["lease","knees","tea","free","bee","trees","flee","need","peace","three","key","freeze"],
    /* set 02 */ ["lamb","glad","slam","swam","bad","cab","track","dad","trap","grab","black","lap"],
    /* set 03 */ ["chair","spare","space","chase","change","pair","park","part","mark","spark","chart","share"],
    /* set 04 */ ["fact","pad","beg","bat","bag","bet","mad","back","pact","pack","pass","pet"],
    /* set 05 */ ["slide","buy","hide","thigh","high","side","bite","sky","pine","sigh","sign","guide"],
    /* set 06 */ ["grim","twist","risk","rib","rip","twin","trip","grip","grin","wrist","chip","chin"],
    /* set 07 */ ["feed","feet","feel","film","field","beef","fill","bill","leaf","drill","pill","still"],
    /* set 08 */ ["patch","path","bath","bunch","bench","fetch","lunch","catch","match","sketch","snatch","stretch"],
    /* set 09 */ ["send","damp","lack","bank","stamp","lamp","land","band","bend","lend","dance","grand"],
    /* set 10 */ ["sweep","sweet","sleep","steep","bid","bin","lid","lit","neat","slip","knit","big"],
    /* set 11 */ ["pit","dig","stiff","pig","stick","sit","quit","pick","sniff","pitch","quick","pin"],
    /* set 12 */ ["boat","coat","cope","goat","hope","rope","code","toast","ghost","top","pop","hop"],
    /* set 13 */ ["mix","tip","thick","miss","sick","six","trick","fix","kick","kit","dip","kiss"],
    /* set 14 */ ["size","prize","site","keep","seek","deed","seat","heap","meet","cheek","deep","cheap"],
    /* set 15 */ ["mail","face","main","lace","nail","trail","pale","name","lane","late","pay","ace"],
    /* set 16 */ ["fate","tile","bit","fight","fade","file","faith","mate","made","blade","fail","fit"],
    /* set 17 */ ["lump","crowd","crown","cloud","proud","loud","pump","dump","duck","down","brown","doubt"],
    /* set 18 */ ["tight","pie","white","wide","light","sight","ride","tide","pipe","life","wife","write"],
    /* set 19 */ ["spill","spin","wit","wing","hit","sink","skill","win","swing","hill","skin","pink"],
    /* set 20 */ ["bound","mouth","hall","sound","small","south","mile","mild","round","pound","smile","mind"],
    /* set 21 */ ["cold","rule","road","rude","role","home","nose","hole","rose","crude","hold","crew"],
    /* set 22 */ ["hair","shell","hate","rate","rail","rare","help","sell","swell","swear","spell","smell"],
    /* set 23 */ ["mug","mud","dug","rug","come","cup","club","rub","run","cut","shrug","shut"],
    /* set 24 */ ["snake","cake","sake","shake","lake","stake","state","stay","blame","flame","lay","tray"],
    /* set 25 */ ["call","stall","tall","cause","bond","fond","pond","false","fault","ball","fall","crawl"],
    /* set 26 */ ["cash","brass","gas","mass","pan","fan","glass","grass","crash","smash","ban","grasp"],
    /* set 27 */ ["school","pool","moon","thumb","stool","skull","sum","soon","tool","cool","numb","sun"],
    /* set 28 */ ["ring","reach","clean","rich","mean","bean","teach","beach","beat","cling","beam","preach"],
    /* set 29 */ ["fox","sock","box","block","luck","clock","suck","rock","stuck","boss","loss","cross"],
    /* set 30 */ ["shirt","skirt","dirt","ward","burst","shore","sword","burn","first","born","war","score"],
    /* set 31 */ ["limb","ship","sheep","lip","shed","leap","dead","breed","bread","leave","breeze","creep"],
    /* set 32 */ ["wheel","seal","seed","weep","scene","speak","steam","speed","steal","lean","wheat","weak"],
    /* set 33 */ ["straw","draw","law","soul","saw","goal","gold","fold","sold","told","go","bold"],
    /* set 34 */ ["short","sport","sort","fork","storm","warm","form","horn","store","port","force","corn"],
    /* set 35 */ ["stare","care","cheer","dear","pier","fear","wear","sheer","clear","hear","gear","fair"],
    /* set 36 */ ["wake","wait","straight","grade","came","pain","wage","grain","game","great","gate","gain"],
    /* set 37 */ ["cave","tape","brave","page","pace","race","cage","waste","taste","rage","wave","take"],
    /* set 38 */ ["play","faint","shade","shape","paint","say","fame","trade","shame","saint","grey","frame"],
    /* set 39 */ ["tore","host","four","boast","court","coast","post","pose","core","door","floor","poor"],
    /* set 40 */ ["screen","scream","stream","street","deem","deal","green","gene","greet","seen","meal","cream"],
    /* set 41 */ ["rain","strain","man","strange","ram","brain","vein","van","ran","train","plane","plan"],
    /* set 42 */ ["test","rest","best","text","red","bed","nest","tent","rent","neck","chest","check"],
    /* set 43 */ ["firm","learn","earn","earth","herb","worm","birth","term","worth","bird","word","work"],
    /* set 44 */ ["foot","fool","took","pull","bull","cook","wool","wolf","full","wood","book","bush"],
    /* set 45 */ ["dog","dot","fog","log","shot","lost","dock","knock","shock","stock","knot","lock"],
    /* set 46 */ ["rat","tap","sack","hat","sand","scrap","can","cat","brand","hand","wrap","sad"],
    /* set 47 */ ["king","team","sing","sin","thing","thin","think","kid","seem","tin","dream","drink"],
    /* set 48 */ ["clay","day","base","case","grace","place","safe","sail","claim","trace","bay","tail"],
    /* set 49 */ ["suit","group","soup","root","boot","food","mood","troop","shoot","loop","loose","news"],
    /* set 50 */ ["slow","blow","snow","pole","low","coach","coal","soap","grow","show","slope","flow"],
  ],

  ko: [
    /* set 01 */ ["계절","거절","기절","구절","시절","기질","기저","기적","기점","기척","기억","시설"],
    /* set 02 */ ["고치","꼬치","꽁치","코치","꼴지","까치","토지","교체","고체","고리","골치","고리"],
    /* set 03 */ ["사모","사부","사수","사주","사고","식구","식후","시루","시조","산후","잡지","당시"],
    /* set 04 */ ["짝수","박수","착수","낙서","특수","악수","작사","폭소","산후","폭소","음치","악수"],
    /* set 05 */ ["여기","역기","열기","연기","얘기","옷깃","암기","용기","아기","오기","요기","악수"],
    /* set 06 */ ["사망","사방","사상","사당","사랑","사탕","사장","자랑","타당","다방","사항","사항"],
    /* set 07 */ ["고비","고삐","고시","고지","공시","공지","공기","공식","고시","공기","공식","고체"],
    /* set 08 */ ["각지","낙지","착지","깍지","악기","각시","낚시","잡지","상시","잡지","당시","교체"],
    /* set 09 */ ["위치","이치","아치","어치","의치","여치","메주","예치","배우","메주","여치","완치"],
    /* set 10 */ ["배구","배추","배수","맥주","배우","페루","백수","폐수","매수","매부","백기","빗길"],
    /* set 11 */ ["감사","감시","감수","검사","검소","검수","간사","강사","감세","감소","겸사","금수"],
    /* set 12 */ ["나비","자비","아비","마비","차비","달빛","갈비","장비","학비","설비","택배","패배"],
    /* set 13 */ ["가루","나루","마루","자루","하루","보루","머루","벼루","만루","이루","블루","만루"],
    /* set 14 */ ["추석","추억","추천","추첨","초청","초점","초석","조선","조절","조청","조서","조성"],
    /* set 15 */ ["뿌리","부리","구리","수리","비리","우리","추리","보리","꼬리","도리","조리","피리"],
    /* set 16 */ ["삼촌","사촌","산촌","식초","상처","삼치","신체","상추","사채","상처","새치","시체"],
    /* set 17 */ ["잡무","잘못","장맛","장만","자막","자만","작문","자문","자모","작물","자막","자정"],
    /* set 18 */ ["악어","약어","언어","연어","인어","잉어","용어","영어","잉어","원어","은어","영어"],
    /* set 19 */ ["표지","표기","표시","포기","보기","빼기","패기","핏기","백기","필기","포기","파기"],
    /* set 20 */ ["시장","소장","심장","실장","산장","송장","선장","상장","성장","새장","초장","곤장"],
    /* set 21 */ ["톱밥","텃밭","태반","탐방","타박","달밤","대박","답방","닭발","뜻밖","다발","단발"],
    /* set 22 */ ["감자","각자","강자","단자","난자","낭자","박자","판자","한자","학자","외자","의자"],
    /* set 23 */ ["씨앗","시음","사업","사연","사옥","사육","서양","세월","사기","쓰기","사기","차기"],
    /* set 24 */ ["공장","농장","고장","통장","분장","순장","초장","훈장","곤장","촌장","순장","훈장"],
    /* set 25 */ ["반팔","반말","반달","반란","반상","반장","반찬","반항","반감","반반","반발","반납"],
    /* set 26 */ ["한국","난국","만국","판국","강국","당국","항구","강구","안구","당구","짱구","강구"],
    /* set 27 */ ["기름","이름","지름","그림","트림","씨름","보름","소름","여름","크림","주름","노름"],
    /* set 28 */ ["토기","도끼","토끼","동기","특기","등기","돌기","떨기","딸기","모기","뙈기","듣기"],
    /* set 29 */ ["모기","모피","모시","모이","모터","모찌","모자","모두","모녀","몰래","목화","모터"],
    /* set 30 */ ["가전","가정","장정","사전","감전","사정","다전","대박","자전","감정","상점","감정"],
    /* set 31 */ ["액자","양자","왕자","외자","원자","의자","여자","야자","임자","약자","유자","이자"],
    /* set 32 */ ["여신","외신","운신","위신","육신","유신","헌신","임신","화신","회신","확신","혼신"],
    /* set 33 */ ["조기","초기","후기","쓰기","사기","파기","투기","차기","후기","자기","우기","크기"],
    /* set 34 */ ["높이","논리","놀이","노비","녹지","논의","농지","농민","농민","노인","노기","노크"],
    /* set 35 */ ["장미","장마","장가","장구","장사","장소","장수","장치","장기","장모","장기","장수"],
    /* set 36 */ ["수유","수요","수재","수해","수지","수치","수초","수의","수위","수호","수화","수호"],
    /* set 37 */ ["소리","소비","사지","소지","수기","수비","사리","사비","사시","사이","사치","사리"],
    /* set 38 */ ["인간","민간","인자","인감","인상","인장","인사","인가","민가","인하","민사","인가"],
    /* set 39 */ ["경기","경시","경비","경지","경치","경고","경로","경보","경추","경도","경호","경이"],
    /* set 40 */ ["후식","주식","구식","무식","수식","무직","구직","추진","누진","수직","무진","후진"],
    /* set 41 */ ["식당","식빵","신랑","신탁","신장","신상","신방","신당","신앙","신망","신방","신당"],
    /* set 42 */ ["야인","여인","의의","요인","유인","애인","위인","의인","아이","어이","오이","예의"],
    /* set 43 */ ["머리","물욕","무리","물리","물음","미라","미래","미로","미련","밀림","무료","무료"],
    /* set 44 */ ["고정","도정","수정","조정","요정","교정","투정","추정","부정","표정","부정","우정"],
    /* set 45 */ ["유지","휴지","규제","구제","유죄","부재","유제","추정","무지","투지","부재","무지"],
    /* set 46 */ ["대추","대수","대구","대두","대부","대꾸","대포","대조","대로","대우","데모","데코"],
    /* set 47 */ ["유언","우연","우의","유의","우유","우울","우애","유일","유연","유아","우정","유예"],
    /* set 48 */ ["외모","외무","외부","외투","외교","표정","최고","최소","최초","최후","최저","회수"],
    /* set 49 */ ["가위","고위","가요","기와","기요","거의","구유","고의","거위","과외","교우","지조"],
    /* set 50 */ ["기도","기소","기호","기조","기로","기초","기포","지로","지조","진로","지도","기로"],
  ],

};

const NUM_SETS        = WORD_DATA.en.length;          // 50
const NUM_SUBSECTIONS = WORD_DATA.en[0].length;       // 12

/**
 * Return (or create) a shuffled column order for a speaker.
 * Stored in localStorage as "colOrder_{lang}_{speaker}" → JSON array of 1-based col indices.
 * Generated once on first subsection; reused for all subsequent subsections.
 */
function getColOrder(lang, speaker) {
  const key      = `colOrder_${lang}_${speaker}`;
  const stored   = localStorage.getItem(key);
  if (stored) return JSON.parse(stored);
  // Fisher-Yates shuffle of [1..NUM_SUBSECTIONS]
  const order = Array.from({ length: NUM_SUBSECTIONS }, (_, i) => i + 1);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  localStorage.setItem(key, JSON.stringify(order));
  return order;
}

/**
 * Return 50 word_ids for a subsection session.
 * The column assigned to each subsection is drawn from the speaker's
 * shuffled column order, so all 600 words are covered in random order.
 * Word_id format: "set01_col07"  (1-indexed in both parts)
 */
function getSessionWords(subsection, lang = "en", speaker = "") {
  if (subsection < 1 || subsection > NUM_SUBSECTIONS) {
    throw new RangeError(`subsection must be 1–${NUM_SUBSECTIONS}`);
  }
  const col  = getColOrder(lang, speaker)[subsection - 1];
  const data = WORD_DATA[lang] || WORD_DATA.en;
  return data.map((_, rowIdx) =>
    `set${String(rowIdx + 1).padStart(2, "0")}_col${String(col).padStart(2, "0")}`
  );
}

/**
 * Look up the canonical word for a word_id like "set01_col03".
 * Falls back to the word_id itself if parsing fails.
 */
function getCanonical(wordId, lang = "en") {
  const m = /^set(\d+)_col(\d+)$/.exec(wordId);
  if (!m) return wordId;
  const row  = parseInt(m[1], 10) - 1;
  const col  = parseInt(m[2], 10) - 1;
  const data = WORD_DATA[lang] || WORD_DATA.en;
  return (data[row] && data[row][col]) ?? wordId;
}
