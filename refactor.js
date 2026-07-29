const fs = require('fs');
const file = '/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts';
let code = fs.readFileSync(file, 'utf8');

// The paper block starts with "// 1. PAPER EXECUTION PATH"
// The live block starts with "// 2. LIVE EXECUTION PATH"

const paperStart = code.indexOf('    // 1. PAPER EXECUTION PATH');
const liveStart = code.indexOf('    // 2. LIVE EXECUTION PATH');
const execEnd = code.indexOf('    return liveResult || paperResult || { status: \'skipped\', reason: \'Unknown execution mode\' };');

if (paperStart === -1 || liveStart === -1 || execEnd === -1) {
  console.error('Could not find markers');
  process.exit(1);
}

const beforePaper = code.substring(0, paperStart);
const paperBlock = code.substring(paperStart, liveStart);
const liveBlock = code.substring(liveStart, execEnd);
const afterExec = code.substring(execEnd);

let newLiveBlock = liveBlock.replace('// 2. LIVE EXECUTION PATH', '// 1. LIVE EXECUTION PATH (Runs First in live+shadow)');
let newPaperBlock = paperBlock.replace('// 1. PAPER EXECUTION PATH', '// 2. PAPER / SHADOW EXECUTION PATH');

// Capture live trade ID
newLiveBlock = newLiveBlock.replace('let liveResult = null;', 'let liveResult: any = null;\n    let liveTradeId: string | null = null;');
newLiveBlock = newLiveBlock.replace('await persistTrade({', 'liveTradeId = await persistTrade({');
newLiveBlock = newLiveBlock.replace('await persistTrade({', 'liveTradeId = await persistTrade({'); // Replace for Robinhood
newLiveBlock = newLiveBlock.replace('await persistTrade({', 'liveTradeId = await persistTrade({'); // Replace for Polymarket

// Note: there are also skip-simulation persistTrade calls. Let's just blindly replace all 'await persistTrade({' with 'liveTradeId = await persistTrade({' in the live block.
newLiveBlock = newLiveBlock.replace(/await persistTrade\(\{/g, 'liveTradeId = await persistTrade({');

// For paper block, add try-catch around it so it fails independently, and use liveTradeId for shadowOf
newPaperBlock = newPaperBlock.replace(
  "if (execMode === 'paper' || execMode === 'live+shadow') {",
  "if (execMode === 'paper' || (execMode === 'live+shadow' && liveTradeId)) {\n      try {"
);

newPaperBlock = newPaperBlock.replace(
  "await persistTrade({",
  "await persistTrade({"
);

// We need to inject shadowOf: execMode === 'live+shadow' ? liveTradeId : undefined into paper's persistTrade.
newPaperBlock = newPaperBlock.replace(
  "jupiterFill\n      });",
  "jupiterFill,\n        shadowOf: execMode === 'live+shadow' ? liveTradeId : undefined\n      });"
);

// Close the try-catch for paper block
newPaperBlock = newPaperBlock.replace(
  "simulatedVia: jupiterFill ? 'jupiter' : 'spot-price'\n      };\n    }",
  "simulatedVia: jupiterFill ? 'jupiter' : 'spot-price'\n      };\n      } catch (paperErr: any) {\n        console.error(`[trade-executor] Shadow execution failed: ${paperErr.message}`);\n      }\n    }"
);

// Assemble
// Remember to move 'let paperResult = null;' and 'let liveResult = null;' to before the blocks.
// Wait, 'let paperResult = null;' is currently in beforePaper!
// Let's strip them from beforePaper and add them explicitly.

let finalCode = beforePaper.replace('let paperResult = null;\n    let liveResult = null;\n\n', '') + 
  'let paperResult: any = null;\n    let liveResult: any = null;\n    let liveTradeId: string | null = null;\n\n' +
  newLiveBlock + '\n' + newPaperBlock + '\n' + afterExec;

// Fix any potential double declaration of liveResult
finalCode = finalCode.replace('let liveResult: any = null;\n    let liveTradeId: string | null = null;\n    // 1. LIVE EXECUTION', '// 1. LIVE EXECUTION');

fs.writeFileSync(file, finalCode, 'utf8');
console.log('Refactor complete');
