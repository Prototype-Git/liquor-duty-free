// 면세 기준 데이터. 기준이 바뀌면 이 파일만 고친다.
// verifiedAt: 마지막으로 출처를 확인한 날짜 / confidence: official(공식 출처 확인) | secondary(2차 출처) | conflict(출처 간 불일치, 보수적으로 적용)

const RULES_META = {
  verifiedAt: '2026-10-27',
  staleAfterDays: 60,
};

// 주종: 한국 세율(관세 d, 주세 l(비율) 또는 lPerL(원/L), 교육세 e)과 기본 도수
const LIQUOR_TYPES = {
  whisky:    { label: '위스키',            abv: 40, kr: { d: 0.20, l: 0.72, e: 0.30 } },
  brandy:    { label: '브랜디·코냑',       abv: 40, kr: { d: 0.20, l: 0.72, e: 0.30 } },
  vodka:     { label: '보드카',            abv: 40, kr: { d: 0.20, l: 0.72, e: 0.30 } },
  gin:       { label: '진',                abv: 40, kr: { d: 0.20, l: 0.72, e: 0.30 } },
  rum:       { label: '럼',                abv: 40, kr: { d: 0.20, l: 0.72, e: 0.30 } },
  tequila:   { label: '데킬라',            abv: 40, kr: { d: 0.20, l: 0.72, e: 0.30 } },
  liqueur:   { label: '리큐르',            abv: 25, kr: { d: 0.20, l: 0.72, e: 0.30 } },
  baijiu:    { label: '고량주·백주',       abv: 52, kr: { d: 0.30, l: 0.72, e: 0.30 } },
  shochu:    { label: '증류식 소주·쇼추',  abv: 25, kr: { d: 0.30, l: 0.72, e: 0.30 } },
  wine:      { label: '와인(스틸)',        abv: 13, kr: { d: 0.15, l: 0.30, e: 0.10 } },
  sparkling: { label: '스파클링·샴페인',   abv: 12, kr: { d: 0.15, l: 0.30, e: 0.10 } },
  fortified: { label: '주정강화(포트·셰리)', abv: 19, kr: { d: 0.15, l: 0.30, e: 0.10 } },
  sake:      { label: '사케·청주',         abv: 15, kr: { d: 0.15, l: 0.30, e: 0.10 } },
  beer:      { label: '맥주',              abv: 5,  kr: { d: 0.30, lPerL: 885.7, e: 0.30, estimate: true } },
};

const SPIRIT_TYPES = ['whisky', 'brandy', 'vodka', 'gin', 'rum', 'tequila', 'liqueur', 'baijiu', 'shochu'];

// 항공 위험물 규정(IATA/ICAO): 70% 초과 반입 불가, 24% 초과~70% 이하는 1인 합계 5L까지
const AIRLINE = {
  bannedAbvOver: 70,
  limitedAbvOver: 24,
  limitedMlPerPerson: 5000,
};

// pools: 모든 pool이 만족되어야 면세. pool 안의 components는 (사용량 / 한도)의 합이 1 이하여야 한다.
//   unit: 'ml' | 'usd' | 'bottles'
//   match(b): 이 병이 해당 component에 들어가는지 (b = { type, abv, ml, usd })
// options: 여러 조합 중 하나라도 만족하면 면세 (싱가포르처럼 선택형인 경우)
// perBottleMaxMl: 병 1개가 넘으면 안 되는 용량
// overflow: 'declare'(신고 후 과세) | 'destroy'(납부 불가, 폐기)
// wholeCategory: 한도를 넘으면 초과분이 아니라 해당 범주 전체가 과세되는 경우
const all = () => true;

const DESTINATIONS = {
  KR: {
    name: '대한민국 (입국)', currency: 'KRW', minAge: 19, confidence: 'official',
    summary: '1인당 주류 합계 2L 이하 + 총 미화 400달러 이하 (병 수 제한 없음, 2025-03-21~)',
    options: [[
      { label: '용량', components: [{ unit: 'ml', limit: 2000, match: all }] },
      { label: '금액', components: [{ unit: 'usd', limit: 400, match: all }] },
    ]],
    overflow: 'declare',
    notes: [
      '한도를 넘는 병은 초과분만이 아니라 그 병 가격 전체에 세금이 붙습니다.',
      '주류는 일반 면세한도(미화 800달러)와 별도예요. 19세 미만은 주류 면세가 없는데, 세관은 출생연도로 따지므로 올해 19세가 되는 사람(만 18세 포함)도 면세 대상일 수 있어요. 이 계산은 입력한 만 나이로 보수적으로 판정합니다.',
      '자진신고하면 관세의 30%(1인 20만원 한도)를 감면받고, 미신고 적발 시 납부세액의 40% 가산세가 붙습니다.',
    ],
    sources: [
      { label: '인천공항세관 – 입국 시 휴대품 면세범위', url: 'https://www.customs.go.kr/incheon_airport/cm/cntnts/cntntsView.do?mi=12546&cntntsId=6689' },
      { label: '관세청 여행자 휴대품 예상세액 조회', url: 'https://www.customs.go.kr/kcs/ad/tax/ItemTaxCalculation.do' },
    ],
  },
  JP: {
    name: '일본', currency: 'JPY', minAge: 20, confidence: 'official',
    summary: '성인 1인당 3병 (1병 약 760ml 기준 → 합계 약 2,280ml)',
    options: [[{ label: '3병(약 2,280ml)', components: [{ unit: 'ml', limit: 2280, match: all }] }]],
    overflow: 'declare',
    jpTaxPerL: { whisky: 800, brandy: 800, rum: 500, gin: 500, vodka: 500, liqueur: 400, baijiu: 300, shochu: 300, tequila: 300 },
    jpTaxDefault: 200,
    notes: [
      '760ml가 아닌 병은 용량 합계(약 2,280ml) 기준으로 계산했습니다. 애매하면 세관에 신고하세요.',
      '초과분에는 간이세율(위스키·브랜디 ¥800/L, 럼·진·보드카 ¥500/L, 리큐르 ¥400/L, 증류주 ¥300/L, 와인·맥주 등 ¥200/L)이 적용됩니다.',
    ],
    sources: [{ label: 'Japan Customs – Passenger duty-free allowance', url: 'https://www.customs.go.jp/english/summary/passenger.htm' }],
  },
  US: {
    name: '미국 (본토·하와이)', currency: 'USD', minAge: 21, confidence: 'secondary',
    summary: '만 21세 이상 1인당 1L',
    options: [[{ label: '1L', components: [{ unit: 'ml', limit: 1000, match: all }] }]],
    overflow: 'declare',
    notes: [
      '1L를 넘어도 반입은 가능하지만 신고 후 관세·연방 주세를 냅니다.',
      '도착하는 주(州)의 법이 더 엄격하면 그 기준이 적용됩니다. 만 21세 미만은 주류 반입 불가.',
    ],
    sources: [{ label: 'CBP – Know Before You Go', url: 'https://www.cbp.gov/travel/us-citizens/know-before-you-go' }],
  },
  GU: {
    name: '괌', currency: 'USD', minAge: 21, confidence: 'secondary',
    summary: '만 21세 이상 1인당 1갤런(약 3.78L)',
    options: [[{ label: '1갤런', components: [{ unit: 'ml', limit: 3785, match: all }] }]],
    overflow: 'declare',
    notes: ['1갤런 초과분은 신고 대상이며 주류 면허가 필요할 수 있습니다.'],
    sources: [{ label: 'Guam Customs and Quarantine Agency', url: 'https://cqa.guam.gov/' }],
  },
  CN: {
    name: '중국 (본토)', currency: 'CNY', minAge: 18, confidence: 'conflict',
    summary: '도수 12% 이상 주류 1인당 1.5L',
    options: [[{ label: '12% 이상 1.5L', components: [{ unit: 'ml', limit: 1500, match: b => b.abv >= 12 }] }]],
    overflow: 'declare',
    notes: [
      '일부 자료는 1L로 안내합니다. 1.5L를 넘기지 않는 걸 권합니다.',
      '도수 12% 미만은 개인 사용 범위의 합리적 수량이면 됩니다. 나이 기준은 보수적으로 18세로 적용했습니다.',
    ],
    sources: [{ label: '중국 해관총서', url: 'http://english.customs.gov.cn/' }],
  },
  TW: {
    name: '대만', currency: 'TWD', minAge: 18, confidence: 'official',
    summary: '1인당 1.5L (2025-01-25부터 1L → 1.5L)',
    options: [[{ label: '1.5L', components: [{ unit: 'ml', limit: 1500, match: all }] }]],
    overflow: 'declare',
    notes: ['초과분을 신고하지 않으면 몰수·벌금 대상입니다.'],
    sources: [{ label: '대만 관무서', url: 'https://web.customs.gov.tw/' }],
  },
  HK: {
    name: '홍콩', currency: 'HKD', minAge: 18, confidence: 'secondary',
    summary: '도수 30% 초과 주류 1인당 1L (30% 이하 와인·맥주는 세금 없음)',
    options: [[{ label: '30% 초과 1L', components: [{ unit: 'ml', limit: 1000, match: b => b.abv > 30 }] }]],
    overflow: 'declare',
    notes: ['홍콩 거주자는 24시간 이상 해외 체류 후 입경할 때만 해당됩니다.'],
    sources: [{ label: 'Hong Kong Customs', url: 'https://www.customs.gov.hk/' }],
  },
  VN: {
    name: '베트남', currency: 'VND', minAge: 18, confidence: 'official',
    summary: '20% 이상 1.5L 또는 20% 미만 2L 또는 맥주 3L (비율로 나눠 사용)',
    options: [[{
      label: '1.5L / 2L / 맥주 3L',
      components: [
        { unit: 'ml', limit: 1500, match: b => b.type !== 'beer' && b.abv >= 20 },
        { unit: 'ml', limit: 2000, match: b => b.type !== 'beer' && b.abv < 20 },
        { unit: 'ml', limit: 3000, match: b => b.type === 'beer' },
      ],
    }]],
    overflow: 'declare',
    notes: [
      '법령(Decree 134/2016)은 세 가지 중 하나를 고르는 방식이라, 섞어 가져가면 비율 합계로 계산했습니다.',
      '한도를 넘더라도 그 병이 1L 이하면 병 전체가 면세, 1L를 넘는 병은 초과 용량만 과세됩니다.',
    ],
    sources: [{ label: 'Decree 134/2016/ND-CP Article 6', url: 'https://english.luatvietnam.vn/decree-no-134-2016-nd-cp-dated-september-01-2016-of-the-government-on-guiding-the-law-on-export-and-import-duties-108922-doc1.html' }],
  },
  TH: {
    name: '태국', currency: 'THB', minAge: 20, confidence: 'conflict',
    summary: '1인당 1L',
    options: [[{ label: '1L', components: [{ unit: 'ml', limit: 1000, match: all }] }]],
    overflow: 'declare',
    notes: ['나이 기준은 자료마다 18세/20세로 달라 보수적으로 20세로 적용했습니다.'],
    sources: [{ label: 'Thai Customs', url: 'https://www.customs.go.th/' }],
  },
  ID: {
    name: '인도네시아 (발리 등)', currency: 'IDR', minAge: 21, confidence: 'official',
    summary: '만 21세 이상 1인당 1L — 초과분은 세금 납부 불가, 폐기',
    options: [[{ label: '1L', components: [{ unit: 'ml', limit: 1000, match: all }] }]],
    overflow: 'destroy',
    notes: ['초과분은 돈을 내고 찾을 수 없고 현장에서 폐기됩니다 (PMK 203/2017 및 개정).'],
    sources: [{ label: 'Bea Cukai (인도네시아 관세청)', url: 'https://www.beacukai.go.id/' }],
  },
  SG: {
    name: '싱가포르', currency: 'SGD', minAge: 18, confidence: 'secondary',
    summary: '증류주1L+와인1L+맥주1L / 와인2L+맥주1L / 와인1L+맥주2L 중 택1',
    options: [
      [{ label: '증류주1L', components: [{ unit: 'ml', limit: 1000, match: b => isSpirit(b) }] },
       { label: '와인1L',  components: [{ unit: 'ml', limit: 1000, match: b => !isSpirit(b) && b.type !== 'beer' }] },
       { label: '맥주1L',  components: [{ unit: 'ml', limit: 1000, match: b => b.type === 'beer' }] }],
      [{ label: '증류주 0', components: [{ unit: 'ml', limit: 0.0001, match: b => isSpirit(b) }] },
       { label: '와인2L',  components: [{ unit: 'ml', limit: 2000, match: b => !isSpirit(b) && b.type !== 'beer' }] },
       { label: '맥주1L',  components: [{ unit: 'ml', limit: 1000, match: b => b.type === 'beer' }] }],
      [{ label: '증류주 0', components: [{ unit: 'ml', limit: 0.0001, match: b => isSpirit(b) }] },
       { label: '와인1L',  components: [{ unit: 'ml', limit: 1000, match: b => !isSpirit(b) && b.type !== 'beer' }] },
       { label: '맥주2L',  components: [{ unit: 'ml', limit: 2000, match: b => b.type === 'beer' }] }],
    ],
    overflow: 'declare',
    notes: ['싱가포르 밖에서 48시간 이상 체류했고 말레이시아에서 오는 게 아닐 때만 해당됩니다.'],
    sources: [{ label: 'Singapore Customs', url: 'https://www.customs.gov.sg/' }],
  },
  AU: {
    name: '호주', currency: 'AUD', minAge: 18, confidence: 'official',
    summary: '1인당 2.25L',
    options: [[{ label: '2.25L', components: [{ unit: 'ml', limit: 2250, match: all }] }]],
    overflow: 'declare', wholeCategory: true,
    notes: ['한도를 넘으면 초과분만이 아니라 주류 전체에 세금이 붙습니다.'],
    sources: [{ label: 'Australian Border Force – Duty-free', url: 'https://www.abf.gov.au/entering-and-leaving-australia/duty-free' }],
  },
  EU: {
    name: 'EU 국가 (프랑스·독일·이탈리아 등)', currency: 'EUR', minAge: 17, confidence: 'official',
    summary: '22% 초과 1L 또는 22% 이하 2L(비율 혼합) + 스틸와인 4L + 맥주 16L',
    options: [[
      { label: '증류주1L/22%이하2L', components: [
        { unit: 'ml', limit: 1000, match: b => b.abv > 22 },
        { unit: 'ml', limit: 2000, match: b => b.abv <= 22 && b.type !== 'wine' && b.type !== 'beer' },
      ] },
      { label: '스틸와인 4L', components: [{ unit: 'ml', limit: 4000, match: b => b.type === 'wine' && b.abv <= 22 }] },
      { label: '맥주 16L', components: [{ unit: 'ml', limit: 16000, match: b => b.type === 'beer' }] },
    ]],
    overflow: 'declare',
    notes: ['나이 기준(17세)은 회원국마다 다를 수 있습니다.'],
    sources: [{ label: 'Your Europe – Alcohol, tobacco and cash', url: 'https://europa.eu/youreurope/citizens/travel/carry/alcohol-tobacco-cash/index_en.htm' }],
  },
  GB: {
    name: '영국', currency: 'GBP', minAge: 18, confidence: 'official',
    summary: '22% 초과 4L 또는 22% 이하 9L(비율 혼합) + 스틸와인 18L + 맥주 42L',
    options: [[
      { label: '증류주4L/22%이하9L', components: [
        { unit: 'ml', limit: 4000, match: b => b.abv > 22 },
        { unit: 'ml', limit: 9000, match: b => b.abv <= 22 && b.type !== 'wine' && b.type !== 'beer' },
      ] },
      { label: '스틸와인 18L', components: [{ unit: 'ml', limit: 18000, match: b => b.type === 'wine' && b.abv <= 22 }] },
      { label: '맥주 42L', components: [{ unit: 'ml', limit: 42000, match: b => b.type === 'beer' }] },
    ]],
    overflow: 'declare', wholeCategory: true,
    notes: ['한 범주에서 한도를 넘으면 그 범주 전체에 세금이 붙습니다.'],
    sources: [{ label: 'GOV.UK – Bringing goods into the UK', url: 'https://www.gov.uk/duty-free-goods' }],
  },
  PH: {
    name: '필리핀', currency: 'PHP', minAge: 18, confidence: 'conflict',
    summary: '1인당 2병, 1병 1L 이하 (자료 간 불일치 → 보수적 기준)',
    options: [[{ label: '2병', components: [{ unit: 'bottles', limit: 2, match: all }] }]],
    perBottleMaxMl: 1000,
    overflow: 'declare',
    notes: ['자료마다 2병·1.5L·2L 등으로 다릅니다. 가장 엄격한 기준(2병, 병당 1L 이하)으로 계산했습니다.'],
    sources: [{ label: 'Bureau of Customs', url: 'https://customs.gov.ph/' }],
  },
};

function isSpirit(b) {
  return SPIRIT_TYPES.includes(b.type) || b.abv > 22;
}
