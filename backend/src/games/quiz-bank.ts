/**
 * Built-in Quiz Battle bank.
 *
 * A session may bring its own questions (a host writing a room quiz), and this bank is
 * what a game gets when nobody does. Kept in code rather than a table because these are
 * content, not configuration: an operator tuning entry fees should not have to edit
 * questions, and a room host has no business adding rows to a shared catalogue.
 *
 * `answer` is the index into `options` as authored here. The driver shuffles both the
 * question order and each question's options with the server's CSPRNG and remaps the
 * answer, so the correct letter is not always the first one.
 */
export type BankQuestion = {
  prompt: string;
  options: [string, string, string, string];
  answer: 0 | 1 | 2 | 3;
};

export const QUIZ_BANK: readonly BankQuestion[] = [
  { prompt: 'Which planet is closest to the Sun?', options: ['Venus', 'Mercury', 'Mars', 'Jupiter'], answer: 1 },
  { prompt: 'How many bits are in one byte?', options: ['4', '8', '16', '32'], answer: 1 },
  { prompt: 'What is the capital of Australia?', options: ['Sydney', 'Melbourne', 'Canberra', 'Perth'], answer: 2 },
  { prompt: 'Which ocean is the deepest?', options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], answer: 3 },
  { prompt: 'What gas do plants absorb from the air?', options: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Hydrogen'], answer: 1 },
  { prompt: 'Who painted the Mona Lisa?', options: ['Van Gogh', 'Picasso', 'Leonardo da Vinci', 'Michelangelo'], answer: 2 },
  { prompt: 'How many continents are there?', options: ['5', '6', '7', '8'], answer: 2 },
  { prompt: 'Which element has the symbol Fe?', options: ['Fluorine', 'Iron', 'Lead', 'Francium'], answer: 1 },
  { prompt: 'What year did the second World War end?', options: ['1918', '1939', '1945', '1950'], answer: 2 },
  { prompt: 'Which language has the most native speakers?', options: ['English', 'Hindi', 'Spanish', 'Mandarin Chinese'], answer: 3 },
  { prompt: 'What is the largest mammal on Earth?', options: ['African elephant', 'Blue whale', 'Giraffe', 'Polar bear'], answer: 1 },
  { prompt: 'How many strings does a standard guitar have?', options: ['4', '5', '6', '7'], answer: 2 },
  { prompt: 'Which city hosts the Stock Exchange named Sensex?', options: ['Delhi', 'Mumbai', 'Dubai', 'Singapore'], answer: 1 },
  { prompt: 'What does the HTTP status 404 mean?', options: ['Server error', 'Not found', 'Unauthorized', 'Bad gateway'], answer: 1 },
  { prompt: 'Which vitamin does sunlight help the body make?', options: ['Vitamin A', 'Vitamin C', 'Vitamin D', 'Vitamin K'], answer: 2 },
  { prompt: 'What is the smallest prime number?', options: ['0', '1', '2', '3'], answer: 2 },
];
