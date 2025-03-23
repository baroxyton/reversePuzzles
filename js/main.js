// ------------------
// Global Configuration & State
// ------------------

// Check for WebAssembly support
const wasmSupported =
  typeof WebAssembly === 'object' &&
  WebAssembly.validate(
    Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
  );

// Stockfish worker initialization
const stockfishWorker = new Worker(
  wasmSupported ? 'js/stockfish.wasm.js' : 'js/stockfish.js'
);

let stockfishLoaded = false;
let stockfishOnLoadCallback = null;
const stockfishMessageResolvers = [];

// Chessboard config constant; must be declared before loadGame uses it.
const archconf = {
  pieceTheme: 'img/chesspieces/wikipedia/{piece}.png',
};

// Puzzle and rating state
let puzzles = [];
let currentPuzzle = null;
let rating = localStorage.getItem("rating");
if (!rating) {
  rating = 1200;
  localStorage.setItem("rating", rating);
}
const NUM_MOVES = 3;

// Board and game state
let board = null; // Will be initialized in loadGame
let currentGame = null;
let currentBoard = new Chess();
let moveSelected = null;
let playedMove = null;
let whiteTurn = true;
let ourColor = true;

// ------------------
// Stockfish Communication
// ------------------

stockfishWorker.onmessage = function (event) {
  const data = event.data;
  if (data === "loaded") {
    console.log("Stockfish loaded");
    stockfishLoaded = true;
    if (stockfishOnLoadCallback) {
      stockfishOnLoadCallback();
      stockfishOnLoadCallback = null;
    }
    return;
  }
  // Process any waiting resolvers
  for (let i = 0; i < stockfishMessageResolvers.length; i++) {
    const { condition, resolve } = stockfishMessageResolvers[i];
    if (condition(data)) {
      resolve(data);
      stockfishMessageResolvers.splice(i, 1);
      i--;
    }
  }
};

function waitForStockfish() {
  return new Promise((resolve) => {
    if (stockfishLoaded) {
      resolve();
    } else {
      stockfishOnLoadCallback = resolve;
    }
  });
}

function sendStockfishCommand(command) {
  stockfishWorker.postMessage(command);
}

function awaitStockfishCondition(condition) {
  return new Promise((resolve) => {
    stockfishMessageResolvers.push({ condition, resolve });
  });
}

async function sfMove(fen) {
  await waitForStockfish();
  sendStockfishCommand('position fen ' + fen);
  sendStockfishCommand('go depth 11');
  const data = await awaitStockfishCondition((d) => d.startsWith("bestmove"));
  return data.split(" ")[1];
}

async function sfEval(fen) {
  const whiteTurnForEval = fen.split(" ")[1] === "w";
  await waitForStockfish();
  sendStockfishCommand('position fen ' + fen);
  sendStockfishCommand('go depth 10');
  let latestEval = null;

  while (true) {
    const data = await awaitStockfishCondition(
      (d) => d.includes("bestmove") || d.includes(" score ")
    );

    if (data.includes(" cp ")) {
      const match = data.match(/score cp (-?\d+)/);
      if (match) {
        latestEval = parseInt(match[1]);
      }
    }
    if (data.includes("mate ")) {
      const match = data.match(/mate (-?\d+)/);
      if (match) {
        latestEval = parseInt(match[1]) > 0 ? 10000 : -10000;
      }
    }
    if (data.startsWith("bestmove")) {
      if (!whiteTurnForEval) {
        latestEval = -latestEval;
      }
      return latestEval;
    }
  }
}

async function delayResult(ms, result) {
  return new Promise((resolve) => setTimeout(() => resolve(result), ms));
}

function winRate(centipawn) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * centipawn)) - 1);
}

// ------------------
// Puzzle & Game Initialization
// ------------------

function getPuzzle() {
  // Filter out any empty lines (which would be undefined)
  const validPuzzles = puzzles.filter((p) => p && p.length > 1);
  let availablePuzzles = validPuzzles.filter((p) => Math.abs(p[1] - rating) < 100);
  if (availablePuzzles.length === 0) {
    availablePuzzles = validPuzzles;
  }
  currentPuzzle = availablePuzzles[Math.floor(Math.random() * availablePuzzles.length)];
  return currentPuzzle;
}

function nextPuzzle() {
  const p = getPuzzle();
  if (!p) {
    console.error("No valid puzzle found.");
    return;
  }
  const fen = p[0];
  const turn = fen.split(" ")[1];
  if (turn === "w") {
    whiteTurn = true;
    ourColor = true;
  } else {
    whiteTurn = false;
    ourColor = false;
  }
  currentGame = { moves: [], initialFen: fen };
  currentBoard = new Chess(fen);
  loadGame(currentGame);
}

async function loadPuzzles() {
  const response = await fetch("rated_reverse_puzzles.tsv");
  const text = await response.text();
  // Split by newlines, filtering out empty lines
  puzzles = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((l) => l.split("\t"));
}

// ------------------
// UI Rendering & Board Setup
// ------------------

function redrawMoves() {
  const movesContainer = document.getElementById("moves");
  movesContainer.innerHTML = "<br><br>";
  let doubleMove = [];
  currentGame.moves.forEach((move, index) => {
    doubleMove.push(move);
    // Wait for a pair unless it's the last single move.
    if (doubleMove.length < 2 && index !== currentGame.moves.length - 1) return;

    const el = document.createElement("div");
    el.className = "doublemove";

    const subel1 = document.createElement("div");
    const subel2 = document.createElement("div");
    const successBox = document.createElement("div");
    successBox.className = "successbox";
    successBox.innerText = "✅";

    subel1.className = "singlemove";
    subel2.className = "singlemove";
    subel1.innerText = doubleMove[0];
    if (doubleMove[1]) {
      subel2.innerText = doubleMove[1].from + " " + doubleMove[1].to;
    }
    el.appendChild(subel1);
    if (doubleMove[1]) {
      el.appendChild(subel2);
      el.appendChild(successBox);
      doubleMove = [];
    }
    movesContainer.appendChild(el);
  });
}

async function drawEvalBar(isInitial) {
  const evalBarInner = document.getElementById("evalbar-inner");
  if (isInitial) {
    evalBarInner.style.transition = "none";
  }
  const sfeval = await sfEval(currentBoard.fen());
  const centipawn = parseInt(sfeval);
  const rate = winRate(centipawn);
  evalBarInner.style.height = rate + "%";
  evalBarInner.style.top = ourColor ? (100 - rate) + "%" : "0%";

  const timeout = isInitial ? 100 : 0;
  if (ourColor) {
    setTimeout(() => (evalBarInner.style.transition = "top 0.5s, height 0.5s"), timeout);
  } else {
    setTimeout(() => (evalBarInner.style.transition = "height 0.5s"), timeout);
  }
}

function loadGame(game) {
  const config = {
    position: currentBoard.fen(),
    pieceTheme: archconf.pieceTheme,
    draggable: Boolean(currentGame),
    onDragStart: onDragStart,
    onDrop: onDrop,
    onSnapEnd: onSnapEnd,
  };
  board = Chessboard('playboard', config);
  board.orientation(ourColor ? "white" : "black");
  redrawMoves();
  playedMove = null;
  moveSelected = currentGame.moves.length;
  updateButtonActivation();
  drawBoard();
  drawEvalBar(true);
}

function updateButtonActivation() {
  document.querySelector(".singlemove.active")?.classList.remove("active");
  document.querySelectorAll(".singlemove")[moveSelected - 1]?.classList.add("active");
}

function drawBoard() {
  const moves = currentGame.moves.slice(0, moveSelected);
  currentBoard.load(currentGame.initialFen);
  moves.forEach((m) => currentBoard.move(m));
  board.position(currentBoard.fen(), true);
  drawEvalBar();
}

// ------------------
// Game Moves & Interaction
// ------------------

function playMove(move) {
  whiteTurn = !whiteTurn;
  playedMove = move;
  currentGame.moves.push(playedMove);
  moveSelected = currentGame.moves.length;
  redrawMoves();
  updateButtonActivation();
  stockfishMove();
  drawEvalBar();
}

function stockfishMove() {
  whiteTurn = !whiteTurn;
  const fen = currentBoard.fen();
  delayResult(500, sfMove(fen)).then((m) => {
    const startPos = m.slice(0, 2);
    const endPos = m.slice(2, 4);
    const move = { from: startPos, to: endPos, promotion: 'q' };
    currentBoard.move(move);
    board.position(currentBoard.fen(), true);
    playedMove = m;
    currentGame.moves.push(move);
    moveSelected = currentGame.moves.length;
    redrawMoves();
    updateButtonActivation();
    drawEvalBar();
  });
}

function onDrop(source, target) {
  const move = currentBoard.move({
    from: source,
    to: target,
    promotion: 'q',
  });
  if (move === null) return 'snapback';
  const movePGN = currentBoard.pgn().split(" ").slice(-1)[0];
  playMove(movePGN);
}

function onDragStart(source, piece, position, orientation) {
  if (playedMove) {
    // Optionally prevent dragging if a move was already played
  }
  if (moveSelected !== currentGame.moves.length) return false;
  if (currentBoard.game_over()) return false;
  if (
    (currentBoard.turn() === 'w' && piece.search(/^b/) !== -1) ||
    (currentBoard.turn() === 'b' && piece.search(/^w/) !== -1)
  )
    return false;
}

function onSnapEnd() {
  board.position(currentBoard.fen());
}

// ------------------
// Keyboard Navigation
// ------------------

document.body.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") {
    if (moveSelected === currentGame.moves.length) return;
    moveSelected++;
    updateButtonActivation();
    drawBoard();
  } else if (e.key === "ArrowLeft") {
    if (moveSelected === 0) return;
    moveSelected--;
    updateButtonActivation();
    drawBoard();
  }
});

// ------------------
// Initialization
// ------------------

async function initGame() {
  await loadPuzzles();
  // Now that puzzles are loaded, start with the first puzzle.
  nextPuzzle();
  // Update rating display if needed.
  document.getElementById("ratingnum").innerText = rating;
}

initGame();

