var wasmSupported = typeof WebAssembly === 'object' && WebAssembly.validate(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));

var stockfish = new Worker(wasmSupported ? 'js/stockfish.wasm.js' : 'js/stockfish.js');

let stockfishLoaded = false;

stockfish.onmessage = function(event){
  if(event.data == "loaded"){
    console.log("Stockfish loaded")
    stockfishLoaded = true;
  }
}
async function waitForStockfish(){
  return new Promise((resolve, reject)=>{
    if(stockfishLoaded){
      resolve()
    }
    else{
      stockfish.addEventListener('message', function (e) {
        if(e.data == "loaded"){
          //setTimeout(()=>resolve(), 1000)
          resolve()
        }
      });
    }
  })
}

async function sfMove(fen){
  await waitForStockfish();
  stockfish.postMessage('position fen ' + fen);
  stockfish.postMessage('go depth 11');
  return new Promise((resolve, reject)=>{
    stockfish.addEventListener('message', function (e) {
      if(e.data.startsWith("bestmove")){
        resolve(e.data.split(" ")[1])
      }
    });
  })
}

async function delayResult(ms, result){
  return new Promise((resolve, reject)=>{
    setTimeout(()=>resolve(result), ms)
  })
}

function winRate(centipawn){
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * centipawn)) - 1) // https://lichess.org/page/accuracy
}

async function sfEval(fen){
  let whiteTurn = fen.split(" ")[1] == "w";
  console.log(whiteTurn)
  await waitForStockfish();
  stockfish.postMessage('position fen ' + fen);
  stockfish.postMessage('go depth 10');
  return new Promise((resolve, reject)=>{
    let latestEval = null;
    stockfish.addEventListener('message', function (e) {
      if(e.data.includes(" cp ")) {
        const match = e.data.match(/score cp (-?\d+)/);
        if (match) {
          console.log("CURRENT RATING", match[1])
          latestEval = match[1];
        }
      }
      if(e.data.includes("mate ")){
        const match = e.data.match(/mate (-?\d+)/);
        if (match) {
          if(match[1] > 0){
            latestEval = 10000;
          }
          else{
            latestEval = -10000;
          }
        }
      }
      if(e.data.includes("bestmove")){
        if(whiteTurn == false){
          latestEval = -latestEval;
        }
          console.log("FINAL RATING", latestEval)
        resolve(latestEval)
      }
    });
  })
}


let rating = localStorage.getItem("rating")
const NUM_MOVES = 3;

if(!rating){
  rating = 1200;
  localStorage.setItem("rating", rating)
}
const puzzles = await fetch("rated_reverse_puzzles.tsv").then(r=>r.text()).then(t=>t.split("\n").map(l=>l.split("\t")))
let currentPuzzle = null;

// Choose random puzzle based on rating
function getPuzzle(){
  let availablePuzzles = puzzles.filter(p=>Math.abs(p[1]-rating) < 100);
  if(availablePuzzles.length == 0){
    availablePuzzles = puzzles;
  }
  currentPuzzle = availablePuzzles[Math.floor(Math.random()*availablePuzzles.length)];
  return currentPuzzle;
}

let board = Chessboard('playboard')
let currentGame = null;
let currentBoard = new Chess()
let moveSelected = null;
let playedMove = null;
let whiteTurn = true;
let ourColor = true;

function nextPuzzle(){
  let p = getPuzzle();
  let fen = p[0];
  let turn = p[0].split(" ")[1];
  if(turn == "w"){
    whiteTurn = true;
    ourColor = true;
  }
  else{
    whiteTurn = false;
    ourColor = false;
  }
  currentGame = {moves: []};
  currentGame.initialFen = fen;
  currentBoard = new Chess(fen);
  loadGame(currentGame);
}
nextPuzzle();

document.getElementById("ratingnum").innerText = rating;

function redrawMoves(){

  let doubleMove = [];
  document.getElementById("moves").innerHTML = "<br><br>";
  for(let i = 0; i < currentGame.moves.length; i++){
    doubleMove.push(currentGame.moves[i]);
    if(doubleMove.length < 2 && i != currentGame.moves.length - 1){
      continue;
    }
    console.log(doubleMove)
    let el = document.createElement("div");
    el.className = "doublemove";
    let subel1 = document.createElement("div");
    let subel2 = document.createElement("div");

    subel1.className = subel2.className = "singlemove";
    subel1.innerText = doubleMove[0];
    if(doubleMove[1]){
    subel2.innerText = doubleMove[1].from + " " + doubleMove[1].to;
    }

    el.appendChild(subel1)
    if(doubleMove[1]){
      el.appendChild(subel2)
      doubleMove = []
    }

    document.getElementById("moves").appendChild(el);
  }

}
async function drawEvalBar(isInitial){
  if(isInitial){
    document.getElementById("evalbar-inner").style.transition = "none";
  }
  let sfeval = await sfEval(currentBoard.fen());
  let centipawn = parseInt(sfeval);
  let winrate = winRate(centipawn);
  document.getElementById("evalbar-inner").style.height = winrate + "%";
  if(ourColor){
    document.getElementById("evalbar-inner").style.top = (100-winrate) + "%";
  }
  else{
    document.getElementById("evalbar-inner").style.top = "0%";
  }
  let timeout = 0;
  if(isInitial){
  timeout = 100;
  }
  if(ourColor){
    setTimeout(()=>document.getElementById("evalbar-inner").style.transition = "top 0.5s, height 0.5s", timeout);
  }
  else{
    setTimeout(()=>document.getElementById("evalbar-inner").style.transition = "height 0.5s", timeout);
  }
}

const archconf = {
  pieceTheme: 'img/chesspieces/wikipedia/{piece}.png',
}

function loadGame(game){
  const config = {
    position: currentBoard.fen(),
    pieceTheme: 'img/chesspieces/wikipedia/{piece}.png',
    draggable: Boolean(currentGame),
    onDragStart: onDragStart,
    onDrop: onDrop,
    onSnapEnd: onSnapEnd
  }
  board = Chessboard('playboard', config);
  board.orientation(ourColor?"white":"black")
  redrawMoves();

  playedMove = null;
  moveSelected = currentGame.moves.length

  updateButtonActivation();
  drawBoard()
  drawEvalBar(true);
}

function playMove(move){
  whiteTurn = !whiteTurn;
  playedMove = move;
  currentGame.moves.push(playedMove)
  moveSelected = currentGame.moves.length
  redrawMoves();
  updateButtonActivation();
  stockfishMove();
  drawEvalBar();
}
function stockfishMove(){
  whiteTurn = !whiteTurn;
  let fen = currentBoard.fen();
  delayResult(500, sfMove(fen)).then(m=>{
    let startPos = m.slice(0, 2);
    let endPos = m.slice(2, 4);
    let move = {from: startPos, to: endPos, promotion: 'q'};
    currentBoard.move(move);
    board.position(currentBoard.fen(), true)
    playedMove = m;
    currentGame.moves.push(move)
    moveSelected = currentGame.moves.length
    redrawMoves();
    updateButtonActivation();
    drawEvalBar();
  })
}

function onDrop (source, target) {
  // see if the move is legal
  var move = currentBoard.move({
    from: source,
    to: target,
    promotion: 'q' 
  })


  // illegal move
  if (move === null){
    return 'snapback'
  }

  let movePGN = currentBoard.pgn().split(" ").slice(-1)[0];
  playMove(movePGN);

}
function updateButtonActivation(){
  document.querySelector(".singlemove.active")?.classList.remove("active");
  document.querySelectorAll(".singlemove")[moveSelected-1]?.classList.add("active")
}
function drawBoard(){
  let moves = currentGame.moves.slice(0, moveSelected);
  currentBoard.load(currentGame.initialFen);
  moves.forEach(m=>{
    currentBoard.move(m);
  })
  board.position(currentBoard.fen(), true)
  drawEvalBar();
}

function onDragStart (source, piece, position, orientation) {
  if(playedMove){
    //return false;
  }
  if(moveSelected != currentGame.moves.length){
    return false;
  }
  if(currentGame.id == -1){
    return false;
  }
  // do not pick up pieces if the game is over
  if (currentBoard.game_over()) return false

  // only pick up pieces for the side to move
  if ((currentBoard.turn() === 'w' && piece.search(/^b/) !== -1) ||
    (currentBoard.turn() === 'b' && piece.search(/^w/) !== -1)) {
    return false
  }
}
function onSnapEnd () {
  board.position(currentBoard.fen())
}

document.body.addEventListener("keydown", e=>{
  if(e.key == "ArrowRight"){
    if(moveSelected == currentGame.moves.length){
      return
    }
    moveSelected++;
    updateButtonActivation();
    drawBoard();
  }
  else if(e.key == "ArrowLeft"){
    if(moveSelected == 0){
      return;
    }
    moveSelected--;
    updateButtonActivation();
    drawBoard();
  }
})
