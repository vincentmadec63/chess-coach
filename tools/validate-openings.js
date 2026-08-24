const fs = require('fs');
const path = require('path');
const { Chess } = require('./chess-node.js');

const dataPath = path.join(__dirname, '..', 'js', 'openings-data.js');
const src = fs.readFileSync(dataPath, 'utf8');

// openings-data.js declares `const OPENINGS = [...]` as a browser global — eval it here
// in an isolated function scope and grab the value back out.
const OPENINGS = new Function(src + '\nreturn OPENINGS;')();

let totalVariations = 0;
let totalMoves = 0;
let failures = [];

for (const family of OPENINGS) {
  for (const variation of family.variations) {
    totalVariations++;
    const chess = new Chess();
    for (let i = 0; i < variation.moves.length; i++) {
      const san = variation.moves[i].s;
      totalMoves++;
      const result = chess.move(san, { sloppy: true });
      if (!result) {
        failures.push({
          family: family.family,
          variation: variation.name,
          moveIndex: i,
          san,
          fenBefore: chess.fen(),
          movesSoFar: variation.moves.slice(0, i).map((m) => m.s).join(' '),
        });
        break;
      }
    }
  }
}

console.log('Families:', OPENINGS.length);
console.log('Variations:', totalVariations);
console.log('Moves checked:', totalMoves);
console.log('Failures:', failures.length);
if (failures.length) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
