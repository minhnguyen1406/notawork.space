// Trivia night: ten questions, fifteen seconds each, faster right answers score more.
// Rules only: no browser or server code in this file.
// The browser must only `import type` from here, so the answers below never reach a browser.

export type TriviaCategory = 'Geography' | 'Science' | 'Food' | 'Sport' | 'Film and music' | 'Vietnam';
/** Category, question, the right answer, then three wrong ones. The order is shuffled before anyone sees it. */
export type TriviaQuestion = readonly [cat: TriviaCategory, q: string, right: string, wrong1: string, wrong2: string, wrong3: string];

export const QUESTIONS: readonly TriviaQuestion[] = [
  // Geography
  ['Geography', 'What is the capital of Australia?', 'Canberra', 'Sydney', 'Melbourne', 'Perth'],
  ['Geography', 'Which is the largest ocean on Earth?', 'The Pacific', 'The Atlantic', 'The Indian', 'The Arctic'],
  ['Geography', 'On which continent is the Sahara desert?', 'Africa', 'Asia', 'Australia', 'South America'],
  ['Geography', 'What is the capital of Canada?', 'Ottawa', 'Toronto', 'Vancouver', 'Montreal'],
  ['Geography', 'Which country is famously shaped like a boot?', 'Italy', 'Portugal', 'Greece', 'Norway'],
  ['Geography', 'Which river flows through Cairo?', 'The Nile', 'The Amazon', 'The Danube', 'The Ganges'],
  ['Geography', 'In which country are the cities of Osaka and Kyoto?', 'Japan', 'China', 'South Korea', 'Thailand'],
  ['Geography', 'In which country is Mount Kilimanjaro?', 'Tanzania', 'Kenya', 'Ethiopia', 'Uganda'],
  ['Geography', 'Which is the smallest continent by land area?', 'Australia', 'Europe', 'Antarctica', 'South America'],
  ['Geography', 'What is the capital of Thailand?', 'Bangkok', 'Phuket', 'Chiang Mai', 'Vientiane'],
  ['Geography', 'Which of these countries has no coastline?', 'Laos', 'Cambodia', 'Malaysia', 'Myanmar'],
  ['Geography', 'The Great Barrier Reef lies off the coast of which country?', 'Australia', 'Brazil', 'India', 'Mexico'],
  ['Geography', 'Which US state is a chain of islands in the Pacific?', 'Hawaii', 'Florida', 'Alaska', 'Oregon'],
  ['Geography', 'What is the capital of Brazil?', 'Brasília', 'Rio de Janeiro', 'São Paulo', 'Salvador'],
  // Science
  ['Science', 'What is the chemical symbol for gold?', 'Au', 'Ag', 'Go', 'Gd'],
  ['Science', 'Which planet is known as the Red Planet?', 'Mars', 'Venus', 'Jupiter', 'Mercury'],
  ['Science', 'Which gas do plants take from the air to make food?', 'Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'],
  ['Science', 'How many bones does an adult human normally have?', '206', '106', '186', '306'],
  ['Science', 'Which is the hardest natural material?', 'Diamond', 'Quartz', 'Granite', 'Iron'],
  ['Science', 'What is the chemical formula of water?', 'H2O', 'CO2', 'O2', 'NaCl'],
  ['Science', 'Which planet is closest to the Sun?', 'Mercury', 'Venus', 'Earth', 'Mars'],
  ['Science', 'Which force pulls things towards the ground?', 'Gravity', 'Magnetism', 'Friction', 'Static electricity'],
  ['Science', 'Which organ pumps blood around the body?', 'The heart', 'The liver', 'The lungs', 'The kidneys'],
  ['Science', 'At sea level, at what temperature does water boil?', '100 °C', '90 °C', '120 °C', '212 °C'],
  ['Science', 'Which is the largest planet in the solar system?', 'Jupiter', 'Saturn', 'Neptune', 'Uranus'],
  ['Science', 'What do bees turn into honey?', 'Nectar', 'Tree sap', 'Dew', 'Resin'],
  ['Science', 'How many legs does a spider have?', 'Eight', 'Six', 'Ten', 'Twelve'],
  ['Science', 'Which blood cells carry oxygen?', 'Red blood cells', 'White blood cells', 'Platelets', 'Nerve cells'],
  ['Science', 'Roughly how fast does light travel?', '300,000 km a second', '3,000 km a second', '30,000 km a second', '3 million km a second'],
  ['Science', 'Which of these animals is a mammal?', 'Dolphin', 'Shark', 'Penguin', 'Crocodile'],
  ['Science', 'What is the centre of an atom called?', 'The nucleus', 'The electron', 'The shell', 'The molecule'],
  // Food
  ['Food', 'Which country does sushi come from?', 'Japan', 'China', 'Thailand', 'Indonesia'],
  ['Food', 'What is the main ingredient of guacamole?', 'Avocado', 'Green tomato', 'Peas', 'Cucumber'],
  ['Food', 'Which country gave the world pizza?', 'Italy', 'France', 'Greece', 'Spain'],
  ['Food', 'What is tofu made from?', 'Soybeans', 'Rice', 'Milk', 'Wheat'],
  ['Food', 'Kimchi is a traditional food of which country?', 'Korea', 'Japan', 'China', 'Thailand'],
  ['Food', 'What is hummus mainly made from?', 'Chickpeas', 'Lentils', 'Peanuts', 'Potatoes'],
  ['Food', 'Which costly spice comes from the crocus flower?', 'Saffron', 'Turmeric', 'Paprika', 'Cumin'],
  ['Food', 'Paella is a rice dish from which country?', 'Spain', 'Portugal', 'Mexico', 'Italy'],
  ['Food', 'Which pasta comes in long thin strings?', 'Spaghetti', 'Penne', 'Farfalle', 'Ravioli'],
  ['Food', 'Which fruit is dried to make raisins?', 'Grapes', 'Plums', 'Figs', 'Apricots'],
  ['Food', 'Chocolate is made from the seeds of which tree?', 'Cacao', 'Coffee', 'Vanilla', 'Carob'],
  ['Food', 'Tom yum soup comes from which country?', 'Thailand', 'Vietnam', 'Malaysia', 'India'],
  // Sport
  ['Sport', 'How many players does a football (soccer) team have on the pitch?', 'Eleven', 'Nine', 'Ten', 'Twelve'],
  ['Sport', 'In which sport is a score of 40-40 called deuce?', 'Tennis', 'Golf', 'Basketball', 'Rugby'],
  ['Sport', 'How many rings are on the Olympic flag?', 'Five', 'Four', 'Six', 'Seven'],
  ['Sport', 'About how long is a marathon?', '42 km', '21 km', '30 km', '50 km'],
  ['Sport', 'Which sport is played with a shuttlecock?', 'Badminton', 'Squash', 'Table tennis', 'Lacrosse'],
  ['Sport', 'How many points is a free throw worth in basketball?', 'One', 'Two', 'Three', 'Four'],
  ['Sport', 'In which sport do you knock down ten pins for a strike?', 'Bowling', 'Curling', 'Croquet', 'Darts'],
  ['Sport', 'How many players does a volleyball team have on court?', 'Six', 'Five', 'Seven', 'Nine'],
  ['Sport', 'Which Japanese martial art has a name meaning "gentle way"?', 'Judo', 'Taekwondo', 'Kung fu', 'Muay Thai'],
  ['Sport', 'How long is an Olympic swimming pool?', '50 metres', '25 metres', '75 metres', '100 metres'],
  ['Sport', 'In chess, which piece moves only diagonally?', 'The bishop', 'The rook', 'The knight', 'The king'],
  ['Sport', 'Which sport uses the words birdie and eagle?', 'Golf', 'Archery', 'Cricket', 'Polo'],
  // Film and music
  ['Film and music', 'How many strings does a standard guitar have?', 'Six', 'Four', 'Five', 'Eight'],
  ['Film and music', 'How many keys does a full-size piano have?', '88', '64', '72', '100'],
  ['Film and music', 'Which family of instruments does the trumpet belong to?', 'Brass', 'Woodwind', 'Percussion', 'Strings'],
  ['Film and music', 'Who leads an orchestra with a baton?', 'The conductor', 'The composer', 'The producer', 'The soloist'],
  ['Film and music', 'How many lines does a musical stave have?', 'Five', 'Four', 'Six', 'Seven'],
  ['Film and music', 'Which of these is a percussion instrument?', 'Snare drum', 'Cello', 'Oboe', 'Trombone'],
  ['Film and music', 'Which is the highest of these singing voices?', 'Soprano', 'Alto', 'Tenor', 'Bass'],
  ['Film and music', "What is a film's score?", 'Its music', 'Its ticket sales', 'Its running time', 'Its list of actors'],
  ['Film and music', 'Which music style was born in Jamaica?', 'Reggae', 'Samba', 'Flamenco', 'Polka'],
  ['Film and music', 'Which animation technique photographs models one small move at a time?', 'Stop motion', 'Slow motion', 'Green screen', 'Time lapse'],
  ['Film and music', 'What does "forte" tell a musician to do?', 'Play loudly', 'Play softly', 'Play quickly', 'Play slowly'],
  ['Film and music', 'K-pop comes from which country?', 'South Korea', 'Japan', 'China', 'Thailand'],
  ['Film and music', 'What is a sequel?', 'A film that carries on an earlier story', 'A film with no dialogue', 'A film shot in one take', 'A film made for television'],
  ['Film and music', 'What is a cameo in a film?', 'A brief appearance by someone well known', 'The final scene', 'A deleted scene', 'The opening titles'],
  // Vietnam
  ['Vietnam', 'What is the capital of Vietnam?', 'Hà Nội', 'Hồ Chí Minh City', 'Đà Nẵng', 'Huế'],
  ['Vietnam', 'Which river forms the great delta of southern Vietnam?', 'The Mekong', 'The Red River', 'The Perfume River', 'The Hàn River'],
  ['Vietnam', 'Which city was the capital of the Nguyễn emperors?', 'Huế', 'Hà Nội', 'Hội An', 'Đà Lạt'],
  ['Vietnam', 'What is the traditional Vietnamese long dress called?', 'Áo dài', 'Kimono', 'Hanbok', 'Sari'],
  ['Vietnam', 'Which noodles go into a bowl of phở?', 'Flat rice noodles', 'Egg noodles', 'Glass noodles', 'Wheat noodles'],
  ['Vietnam', 'What is the Vietnamese Lunar New Year called?', 'Tết', 'Trung Thu', 'Vu Lan', 'Giỗ Tổ'],
  ['Vietnam', 'In which province is Hạ Long Bay?', 'Quảng Ninh', 'Khánh Hòa', 'Nghệ An', 'Lâm Đồng'],
  ['Vietnam', 'Which is the highest mountain in Vietnam?', 'Fansipan', 'Bà Đen', 'Lang Biang', 'Bạch Mã'],
  ['Vietnam', "Which is Vietnam's largest island?", 'Phú Quốc', 'Cát Bà', 'Côn Đảo', 'Lý Sơn'],
  ['Vietnam', 'Which sauce is the base of nước chấm?', 'Fish sauce', 'Soy sauce', 'Oyster sauce', 'Hoisin sauce'],
  ['Vietnam', 'In which year did the Vietnam War end?', '1975', '1945', '1954', '1986'],
  ['Vietnam', "Who read Vietnam's Declaration of Independence in 1945?", 'Hồ Chí Minh', 'Võ Nguyên Giáp', 'Bảo Đại', 'Lê Duẩn'],
  ['Vietnam', 'Which 1954 battle ended French rule in Vietnam?', 'Điện Biên Phủ', 'Khe Sanh', 'Bạch Đằng', 'Chi Lăng'],
  ['Vietnam', 'What is a bánh mì served in?', 'A baguette', 'A steamed bun', 'Rice paper', 'A lotus leaf'],
  ['Vietnam', 'Which blossom is the classic Tết decoration in northern Vietnam?', 'Peach blossom', 'Lotus', 'Orchid', 'Sunflower'],
  ['Vietnam', 'Which central Vietnamese town is famous for its lantern-lit old trading port?', 'Hội An', 'Sa Pa', 'Đà Lạt', 'Vũng Tàu'],
  ['Vietnam', "What is on Vietnam's national flag?", 'A yellow star on red', 'A red star on yellow', 'A white lotus on red', 'Three red stripes on yellow'],
  ['Vietnam', 'Which traditional Vietnamese art is performed over a pool of water?', 'Water puppetry', 'Chèo', 'Cải lương', 'Ca trù'],
  ['Vietnam', 'What is stirred into coffee to make cà phê sữa đá?', 'Condensed milk and ice', 'Coconut water', 'Egg yolk', 'Lime juice'],
  ['Vietnam', 'The Trưng sisters led an uprising against which rulers?', 'The Chinese Han', 'The French', 'The Mongols', 'The Japanese'],
  ['Vietnam', 'What was Hồ Chí Minh City called before 1976?', 'Sài Gòn', 'Thăng Long', 'Phú Xuân', 'Faifo'],
  ['Vietnam', 'How many strings does the đàn bầu have?', 'One', 'Two', 'Four', 'Sixteen'],
];

export const TRIVIA_MIN = 1;
/** Questions in one game. */
export const ROUNDS = 10;
export const QUESTION_MS = 15_000;
export const REVEAL_MS = 5_000;
/** How long the final ranking stays up before the lobby returns. */
export const FINAL_MS = 12_000;
/** A right answer scores from MIN_POINTS (at the buzzer) to MAX_POINTS (at once). */
export const MIN_POINTS = 500;
export const MAX_POINTS = 1000;

export interface TriviaGame {
  /** Who is playing, in the order they joined. Scores only change at a reveal. */
  players: { id: string; name: string; score: number }[];
  phase: 'lobby' | 'question' | 'reveal' | 'final';
  /** Indexes into QUESTIONS for this game, and which one we are on. */
  deck: number[];
  round: number;
  /** The four options in the shuffled order shown, and where the right one landed. */
  options: string[];
  correct: number;
  /** Who may answer this question: the people who were in when it was asked. */
  playing: string[];
  /** One answer each. Points are worked out on arrival but only added at the reveal. */
  answers: Record<string, { choice: number; points: number }>;
  /** When the current phase ends (server clock). */
  until: number;
  /** Questions already asked, so games don't repeat until the bank runs out. */
  used: number[];
}

export const newTrivia = (): TriviaGame => ({ players: [], phase: 'lobby', deck: [], round: 0, options: [], correct: -1, playing: [], answers: {}, until: 0, used: [] });

/** Fisher-Yates, with an injectable `rnd` so tests are repeatable. */
function shuffled<T>(list: readonly T[], rnd: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rnd() * (i + 1)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The options of one question in a random order, and the index the right answer ended up at. */
export function shuffleOptions(q: TriviaQuestion, rnd: () => number = Math.random): { options: string[]; correct: number } {
  const order = shuffled([0, 1, 2, 3], rnd);
  return { options: order.map((i) => q[2 + i]), correct: order.indexOf(0) };
}

/** Points for a right answer given with `left` milliseconds on the clock. */
export const pointsFor = (left: number) => MIN_POINTS + Math.round((MAX_POINTS - MIN_POINTS) * Math.min(1, Math.max(0, left / QUESTION_MS)));

export function triviaJoin(g: TriviaGame, p: { id: string; name: string }): boolean {
  if (g.players.some((x) => x.id === p.id)) return false;
  // Someone joining mid-game is not added to `playing`, so they start with the next question.
  g.players.push({ id: p.id, name: p.name, score: 0 });
  return true;
}

function ask(g: TriviaGame, now: number, rnd: () => number) {
  Object.assign(g, shuffleOptions(QUESTIONS[g.deck[g.round]], rnd));
  g.playing = g.players.map((p) => p.id);
  g.answers = {};
  g.phase = 'question';
  g.until = now + QUESTION_MS;
}

function reveal(g: TriviaGame, now: number) {
  for (const p of g.players) p.score += g.answers[p.id]?.points ?? 0;
  g.phase = 'reveal';
  g.until = now + REVEAL_MS;
}

const everyoneAnswered = (g: TriviaGame) => g.playing.every((id) => g.answers[id]);

/** Start a game: anyone who has joined may, from the lobby or the final ranking. */
export function triviaStart(g: TriviaGame, by: string, now: number, rnd: () => number = Math.random): boolean {
  if (g.phase === 'question' || g.phase === 'reveal' || g.players.length < TRIVIA_MIN || !g.players.some((p) => p.id === by)) return false;
  let fresh = QUESTIONS.map((_, i) => i).filter((i) => !g.used.includes(i));
  if (fresh.length < ROUNDS) {
    g.used = [];
    fresh = QUESTIONS.map((_, i) => i);
  }
  g.deck = shuffled(fresh, rnd).slice(0, ROUNDS);
  g.used.push(...g.deck);
  g.round = 0;
  for (const p of g.players) p.score = 0;
  ask(g, now, rnd);
  return true;
}

/** One answer each, no changing. `choice` comes straight from a browser, so check everything. */
export function triviaAnswer(g: TriviaGame, by: string, choice: unknown, now: number): boolean {
  if (g.phase !== 'question' || now >= g.until || !g.playing.includes(by) || g.answers[by]) return false;
  if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice > 3) return false;
  g.answers[by] = { choice, points: choice === g.correct ? pointsFor(g.until - now) : 0 };
  if (everyoneAnswered(g)) reveal(g, now);
  return true;
}

/** Someone left the game or the room. Returns true if anything changed. */
export function triviaLeave(g: TriviaGame, id: string, now: number): boolean {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return false;
  g.players.splice(i, 1);
  g.playing = g.playing.filter((x) => x !== id);
  delete g.answers[id];
  if (!g.players.length) Object.assign(g, { phase: 'lobby', deck: [], round: 0, options: [], correct: -1, playing: [], answers: {}, until: 0 });
  // Don't keep waiting for an answer from someone who has gone.
  else if (g.phase === 'question' && everyoneAnswered(g)) reveal(g, now);
  return true;
}

/** Time passing: questions time out, reveals move on, the final ranking gives way to the lobby. */
export function triviaTick(g: TriviaGame, now: number, rnd: () => number = Math.random): boolean {
  if (g.phase === 'lobby' || now < g.until) return false;
  if (g.phase === 'question') reveal(g, now);
  else if (g.phase === 'reveal') {
    if (g.round + 1 < g.deck.length) {
      g.round++;
      ask(g, now, rnd);
    } else {
      g.phase = 'final';
      g.until = now + FINAL_MS;
    }
  } else g.phase = 'lobby'; // scores stay on show until the next game starts
  return true;
}

/** Whoever has the top score, if anyone scored at all. More than one on a tie. */
export function triviaWinners(g: TriviaGame): { id: string; name: string; score: number }[] {
  const top = Math.max(0, ...g.players.map((p) => p.score));
  return top > 0 ? g.players.filter((p) => p.score === top) : [];
}

/**
 * What one browser is shown. While a question is open this never says which option is right,
 * what anyone else chose, or anything that depends on those (scores only move at the reveal).
 */
export interface TriviaView {
  players: { id: string; name: string; score: number }[];
  phase: TriviaGame['phase'];
  /** Question number from 1, and how many there are. */
  round: number;
  total: number;
  category: TriviaCategory | null;
  question: string | null;
  options: string[];
  playing: string[];
  /** Who has answered (but not what). */
  answered: string[];
  /** Milliseconds left in this phase, and how long the phase is in all. */
  left: number;
  span: number;
  /** My own choice, only in the copy sent to me. */
  mine?: number;
  /** Reveal only: the right option, what everyone chose, and the points they just won. */
  correct?: number;
  picks?: Record<string, number>;
  gained?: Record<string, number>;
  /** Final ranking only. */
  winners?: string[];
}

const SPAN = { lobby: 0, question: QUESTION_MS, reveal: REVEAL_MS, final: FINAL_MS };

/** The public view, or with `forId` the copy for that one person (which adds their own choice). */
export function triviaView(g: TriviaGame, now: number, forId?: string): TriviaView {
  const asking = g.phase === 'question' || g.phase === 'reveal';
  const q = asking ? QUESTIONS[g.deck[g.round]] : null;
  const v: TriviaView = {
    players: g.players.map((p) => ({ ...p })),
    phase: g.phase,
    round: g.phase === 'lobby' ? 0 : g.round + 1,
    total: ROUNDS,
    category: q ? q[0] : null,
    question: q ? q[1] : null,
    options: asking ? [...g.options] : [],
    playing: asking ? [...g.playing] : [],
    answered: asking ? Object.keys(g.answers) : [],
    left: g.phase === 'lobby' ? 0 : Math.max(0, g.until - now),
    span: SPAN[g.phase],
  };
  if (asking && forId !== undefined && g.answers[forId]) v.mine = g.answers[forId].choice;
  if (g.phase === 'reveal') {
    v.correct = g.correct;
    v.picks = Object.fromEntries(Object.entries(g.answers).map(([id, a]) => [id, a.choice]));
    v.gained = Object.fromEntries(Object.entries(g.answers).map(([id, a]) => [id, a.points]));
  }
  if (g.phase === 'final') v.winners = triviaWinners(g).map((p) => p.id);
  return v;
}

/** What a browser may send. */
export type TriviaAction = { k: 'join' } | { k: 'leave' } | { k: 'start' } | { k: 'answer'; choice: number };
